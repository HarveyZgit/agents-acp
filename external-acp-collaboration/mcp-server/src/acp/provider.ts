import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { EnvMode } from "../config.ts";

export type ProviderName = "cursor" | "grok" | "fake";
export type AgentMode = "ask" | "plan" | "agent";
export type TaskMode = "review" | "plan" | "implement";
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** ACP reserves -32000 for `auth_required`. */
export const AUTH_REQUIRED_CODE = -32000;

export type AuthMethod = {
  methodId: string;
  type?: string;
};

export type PermissionOption = {
  optionId: string;
  name?: string;
  kind?: string;
};

export type PendingRequestKind = "permission" | "question" | "plan";

export type RunEvent =
  | { type: "started"; provider: ProviderName; sessionId?: string }
  | { type: "text"; text: string }
  | { type: "activity"; label: string; detail?: string }
  | {
    type: "permission";
    requestId: string;
    description: string;
    kind: PendingRequestKind;
    options?: PermissionOption[];
  }
  | { type: "file_change"; path: string; kind: "create" | "modify" | "delete" }
  | { type: "error"; message: string }
  | { type: "completed"; summary: string; exitCode?: number };

export type ProviderCapabilities = {
  supportsModelSelection: boolean;
  modelSelection: "startup" | "session" | "config" | "none";
  supportedModes: AgentMode[];
};

export type ProviderAvailability = {
  provider: ProviderName;
  available: boolean;
  executable: string;
  version?: string;
  capabilities: ProviderCapabilities;
  note?: string;
};

export type StartOptions = {
  cwd: string;
  prompt: string;
  mode: TaskMode;
  model?: string;
  sessionId?: string;
  envMode?: EnvMode;
  envPassthrough?: string[];
};

export type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  error?: { message?: string; code?: number };
};

export interface LineTransport {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (code: number | null, errorCode?: string) => void): void;
  terminate(): void;
}

export class ChildProcessTransport implements LineTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private terminated = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
  }

  write(line: string): void {
    if (!this.child.stdin.destroyed) this.child.stdin.write(line);
  }

  onLine(listener: (line: string) => void): void {
    readline.createInterface({ input: this.child.stdout }).on("line", listener);
  }

  onStderr(listener: (chunk: string) => void): void {
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", listener);
  }

  onExit(listener: (code: number | null, errorCode?: string) => void): void {
    this.child.on("exit", listener);
    this.child.on("error", (error: NodeJS.ErrnoException) => listener(null, error.code));
    this.child.stdin.on("error", (error: NodeJS.ErrnoException) => listener(null, error.code));
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    // The provider may have spawned its own tool subprocesses; signal the whole
    // detached process group so nothing is left running after cancellation.
    this.signal("SIGTERM");
    const escalation = setTimeout(() => this.signal("SIGKILL"), 3_000);
    escalation.unref?.();
    this.child.once("exit", () => clearTimeout(escalation));
  }

  private signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    try {
      if (pid !== undefined) process.kill(-pid, signal);
      else this.child.kill(signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // The process already exited.
      }
    }
  }
}

export class AcpTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`ACP ${method} timed out`);
    this.method = method;
  }
}

export class AcpRpcError extends Error {
  readonly code: number | undefined;
  readonly providerMessage: string | undefined;

  constructor(code: number | undefined, providerMessage?: string) {
    super("ACP provider returned a JSON-RPC error");
    this.code = code;
    this.providerMessage = providerMessage;
  }
}

export class AcpProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly errorCode: string | undefined;

  constructor(exitCode: number | null, errorCode?: string) {
    super("ACP provider process exited");
    this.exitCode = exitCode;
    this.errorCode = errorCode;
  }
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly transport: LineTransport;
  private readonly onNotification: (message: RpcMessage) => void;
  private readonly onRequest: (message: RpcMessage) => void;
  private readonly pending = new Map<number | string, {
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    transport: LineTransport,
    onNotification: (message: RpcMessage) => void,
    onRequest: (message: RpcMessage) => void,
  ) {
    this.transport = transport;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    transport.onLine((line) => this.receive(line));
    transport.onExit((code, errorCode) => {
      for (const request of this.pending.values()) {
        request.reject(new AcpProcessExitError(code, errorCode));
      }
      this.pending.clear();
    });
  }

  /** `timeoutMs <= 0` disables the per-request timer for open-ended turns. */
  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          if (this.pending.delete(id)) reject(new AcpTimeoutError(method));
        }, timeoutMs)
        : undefined;
      this.pending.set(id, {
        resolve: (result) => {
          if (timer) clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        if (this.pending.delete(id)) {
          if (timer) clearTimeout(timer);
          reject(new AcpProcessExitError(null, "EPIPE"));
        }
      }
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    try {
      this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      // The provider process is gone; the exit handler reports the failure.
    }
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    try {
      this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } catch {
      // The provider process is gone; the exit handler reports the failure.
    }
  }

  respondError(id: number | string, code: number, message: string): void {
    try {
      this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
    } catch {
      // The provider process is gone; the exit handler reports the failure.
    }
  }

  terminate(): void {
    this.transport.terminate();
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.onNotification({ method: "acp/invalid_message" });
      return;
    }
    if (!isRpcMessage(message)) {
      this.onNotification({ method: "acp/invalid_message" });
      return;
    }

    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new AcpRpcError(message.error.code, message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method && message.id !== undefined) this.onRequest(message);
    else if (message.method) this.onNotification(message);
  }
}

export abstract class AcpProvider {
  abstract readonly name: ProviderName;
  abstract readonly executable: string;
  abstract readonly capabilities: ProviderCapabilities;
  abstract command(options: StartOptions): string[];
  abstract authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined;

  /** Cursor-style agents are commonly pre-authenticated by their own CLI login. */
  prefersSessionBeforeAuthentication(): boolean {
    return false;
  }

  discover(): ProviderAvailability {
    const result = spawnSync(this.executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: baseEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = typeof result.stdout === "string" ? sanitizeVersion(result.stdout) : undefined;
    return {
      provider: this.name,
      available: !result.error && result.status === 0,
      executable: this.executable,
      version: output,
      capabilities: this.capabilities,
      note: result.error ? "Executable was not found on PATH." : undefined,
    };
  }

  createTransport(options: StartOptions): LineTransport {
    const args = this.command(options);
    return new ChildProcessTransport(spawn(this.executable, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: this.environment(options),
    }));
  }

  protected environment(_options: StartOptions): NodeJS.ProcessEnv {
    return baseEnvironment();
  }
}

/**
 * Names a provider child may legitimately need. Everything else in the MCP
 * server's own environment is withheld. Values are never logged.
 */
const SESSION_ENVIRONMENT_NAMES = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "PWD", "SHLVL",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "NO_COLOR",
  "TMPDIR", "TMP", "TEMP",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS",
  "SECURITYSESSIONID", "XPC_SERVICE_NAME", "XPC_FLAGS", "__CF_USER_TEXT_ENCODING",
  "Apple_PubSub_Socket_Render",
  "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SystemRoot", "ComSpec",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

const BASE_ENVIRONMENT_NAMES = [
  "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "TMPDIR", "TMP", "TEMP", "TERM", "COLORTERM", "NO_COLOR",
];

export function baseEnvironment(): NodeJS.ProcessEnv {
  return pickEnvironment(BASE_ENVIRONMENT_NAMES);
}

/**
 * Builds the child environment for a provider that depends on an existing local
 * login (keychain, session sockets, CLI config). `inherit` is an explicit
 * escape hatch; the default stays an auditable allowlist.
 */
export function providerEnvironment(
  options: StartOptions,
  providerPrefixes: string[],
  providerNames: string[] = [],
): NodeJS.ProcessEnv {
  if (options.envMode === "inherit") return { ...process.env };
  if (options.envMode === "minimal") return pickEnvironment([...BASE_ENVIRONMENT_NAMES, ...providerNames]);
  const names = new Set([...SESSION_ENVIRONMENT_NAMES, ...providerNames, ...(options.envPassthrough ?? [])]);
  for (const name of Object.keys(process.env)) {
    if (providerPrefixes.some((prefix) => name.startsWith(prefix))) names.add(name);
  }
  return pickEnvironment([...names]);
}

export function addEnvironmentVariables(
  environment: NodeJS.ProcessEnv,
  names: string[],
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of names) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
}

function pickEnvironment(names: string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of names) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

/** Reads `SessionModeState` from a `session/new` or `session/load` response. */
export function readSessionModes(session: Record<string, unknown>): {
  availableModes: string[];
  currentModeId?: string;
  configOptionId?: string;
} {
  const modes = session.modes;
  if (modes && typeof modes === "object" && !Array.isArray(modes)) {
    const state = modes as { availableModes?: unknown; currentModeId?: unknown };
    return {
      availableModes: modeIds(state.availableModes),
      currentModeId: typeof state.currentModeId === "string" ? state.currentModeId : undefined,
    };
  }

  const configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
  const modeOption = configOptions.find((option) => (
    option !== null && typeof option === "object" && (option as { category?: unknown }).category === "mode"
  )) as { id?: unknown; configId?: unknown; currentValue?: unknown; options?: unknown } | undefined;
  if (modeOption) {
    const optionId = typeof modeOption.configId === "string"
      ? modeOption.configId
      : typeof modeOption.id === "string" ? modeOption.id : undefined;
    const values = Array.isArray(modeOption.options)
      ? modeOption.options.flatMap((option) => (
        option !== null && typeof option === "object" && typeof (option as { value?: unknown }).value === "string"
          ? [(option as { value: string }).value]
          : []
      ))
      : [];
    return {
      availableModes: values,
      currentModeId: typeof modeOption.currentValue === "string" ? modeOption.currentValue : undefined,
      configOptionId: optionId,
    };
  }

  // Deprecated v1 top-level shape, still emitted by some agents.
  return { availableModes: modeIds(session.availableModes) };
}

function modeIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((mode) => (
      mode !== null && typeof mode === "object" && typeof (mode as { id?: unknown }).id === "string"
        ? [(mode as { id: string }).id]
        : typeof mode === "string" ? [mode] : []
    ))
    : [];
}

const WRITING_TOOL_KINDS = new Set(["edit", "delete", "move"]);

export function normalizeAcpEvent(_provider: ProviderName, message: RpcMessage): RunEvent[] {
  const params = message.params ?? {};
  if (message.method === "session/update") {
    return normalizeSessionUpdate((params.update ?? {}) as Record<string, unknown>);
  }
  if (message.method === "session/request_permission") {
    return [{
      type: "permission",
      requestId: `rpc-${message.id}`,
      description: permissionTitle(params),
      kind: "permission",
      options: readPermissionOptions(params.options),
    }];
  }
  if (message.method === "cursor/ask_question") {
    return [{
      type: "permission",
      requestId: `rpc-${message.id}`,
      description: "Cursor asked a multiple-choice question.",
      kind: "question",
    }];
  }
  if (message.method === "cursor/create_plan") {
    return [{
      type: "permission",
      requestId: `rpc-${message.id}`,
      description: "Cursor requested plan approval.",
      kind: "plan",
    }];
  }
  if (message.method === "cursor/update_todos" || message.method === "cursor/task" || message.method === "cursor/generate_image") {
    return [{ type: "activity", label: "Provider reported progress" }];
  }
  if (message.method === "acp/invalid_message") {
    return [{ type: "error", message: "Provider emitted an invalid ACP JSON message." }];
  }
  return [];
}

function normalizeSessionUpdate(update: Record<string, unknown>): RunEvent[] {
  const kind = String(update.sessionUpdate ?? "");
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = (update.content ?? {}) as Record<string, unknown>;
    return typeof content.text === "string" ? [{ type: "text", text: content.text }] : [];
  }
  if (kind === "tool_call" || kind === "tool_call_update") {
    const events: RunEvent[] = [{ type: "activity", label: "Agent reported tool activity" }];
    for (const change of readFileChanges(update)) events.push(change);
    return events;
  }
  if (kind === "plan" || kind === "plan_update" || kind === "current_mode_update" || kind === "config_option_update") {
    return [{ type: "activity", label: "Agent reported progress" }];
  }
  return [];
}

function readFileChanges(update: Record<string, unknown>): RunEvent[] {
  const changes = new Map<string, RunEvent & { type: "file_change" }>();
  const content = Array.isArray(update.content) ? update.content : [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const block = entry as { type?: unknown; path?: unknown; oldText?: unknown; newText?: unknown };
    if (block.type !== "diff" || typeof block.path !== "string") continue;
    const kind = block.oldText === null || block.oldText === undefined
      ? "create"
      : block.newText === null ? "delete" : "modify";
    changes.set(block.path, { type: "file_change", path: block.path, kind });
  }

  const toolKind = typeof update.kind === "string" ? update.kind : undefined;
  if (toolKind && WRITING_TOOL_KINDS.has(toolKind)) {
    const locations = Array.isArray(update.locations) ? update.locations : [];
    for (const location of locations) {
      if (!location || typeof location !== "object") continue;
      const candidate = (location as { path?: unknown }).path;
      if (typeof candidate !== "string" || changes.has(candidate)) continue;
      changes.set(candidate, {
        type: "file_change",
        path: candidate,
        kind: toolKind === "delete" ? "delete" : "modify",
      });
    }
  }
  return [...changes.values()];
}

function permissionTitle(params: Record<string, unknown>): string {
  const toolCall = params.toolCall;
  const title = toolCall && typeof toolCall === "object"
    ? (toolCall as { title?: unknown }).title
    : undefined;
  return typeof title === "string" && title.trim()
    ? "Agent requested permission for a tool call."
    : "Agent requested permission to continue.";
}

export function readPermissionOptions(value: unknown): PermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const candidate = option as { optionId?: unknown; name?: unknown; kind?: unknown };
    if (typeof candidate.optionId !== "string") return [];
    return [{
      optionId: candidate.optionId,
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      kind: typeof candidate.kind === "string" ? candidate.kind : undefined,
    }];
  });
}

export function readStopReason(result: Record<string, unknown>): StopReason | undefined {
  const value = result.stopReason;
  return value === "end_turn" || value === "max_tokens" || value === "max_turn_requests"
    || value === "refusal" || value === "cancelled"
    ? value
    : undefined;
}

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if (message.id !== undefined && message.id !== null
    && typeof message.id !== "string" && typeof message.id !== "number") return false;
  if (message.method !== undefined && typeof message.method !== "string") return false;
  if (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params))) return false;
  if (message.result !== undefined && message.result !== null
    && (typeof message.result !== "object" || Array.isArray(message.result))) return false;
  if (message.error !== undefined && (!message.error || typeof message.error !== "object" || Array.isArray(message.error))) return false;
  return message.method !== undefined || message.id !== undefined;
}

function sanitizeVersion(value: string): string | undefined {
  const firstLine = value.split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return firstLine || undefined;
}
