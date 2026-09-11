import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

export type ProviderName = "cursor" | "grok";
export type AgentMode = "ask" | "plan" | "agent";
export type TaskMode = "review" | "plan" | "implement";
export type RunEvent =
  | { type: "started"; provider: ProviderName; sessionId?: string }
  | { type: "text"; text: string }
  | { type: "activity"; label: string; detail?: string }
  | { type: "permission"; requestId: string; description: string }
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
};

export type RpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string; code?: number };
};

export interface LineTransport {
  write(line: string): void;
  onLine(listener: (line: string) => void): void;
  onExit(listener: (code: number | null) => void): void;
  terminate(): void;
}

export class ChildProcessTransport implements LineTransport {
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    // ACP reserves stdout for JSON-RPC. Discard diagnostic stderr so that it
    // cannot block a long-lived provider and is never persisted by this plugin.
    this.child.stderr.resume();
  }

  write(line: string): void {
    this.child.stdin.write(line);
  }

  onLine(listener: (line: string) => void): void {
    readline.createInterface({ input: this.child.stdout }).on("line", listener);
  }

  onExit(listener: (code: number | null) => void): void {
    this.child.on("exit", listener);
    this.child.on("error", () => listener(null));
  }

  terminate(): void {
    this.child.kill();
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
    transport.onExit((code) => {
      for (const request of this.pending.values()) {
        request.reject(new Error(`ACP process exited (${code ?? "signal"})`));
      }
      this.pending.clear();
    });
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  respondError(id: number | string, code: number, message: string): void {
    this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
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
      if (message.error) pending.reject(new Error(message.error.message ?? "ACP request failed"));
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
  abstract authenticationMethod(initialized: Record<string, unknown>): string | undefined;

  discover(): ProviderAvailability {
    const result = spawnSync(this.executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      env: baseEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
    const output = typeof result.stdout === "string"
      ? sanitizeVersion(result.stdout)
      : undefined;
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
      env: this.environment(),
    }));
  }

  protected environment(): NodeJS.ProcessEnv {
    return baseEnvironment();
  }
}

export function normalizeAcpEvent(provider: ProviderName, message: RpcMessage): RunEvent[] {
  const params = message.params ?? {};
  if (message.method === "session/update") {
    const update = (params.update ?? {}) as Record<string, unknown>;
    const kind = String(update.sessionUpdate ?? "");
    const content = (update.content ?? {}) as Record<string, unknown>;
    if (kind === "agent_message_chunk" && typeof content.text === "string") {
      return [{ type: "text", text: content.text }];
    }
    if (kind.includes("tool") || kind.includes("plan") || kind.includes("todo")) {
      return [{ type: "activity", label: "Agent reported progress" }];
    }
    if (typeof update.path === "string") {
      return [{ type: "file_change", path: update.path, kind: "modify" }];
    }
  }
  if (message.method === "session/request_permission") {
    return [{ type: "permission", requestId: `rpc-${message.id}`, description: "Agent requests permission to continue." }];
  }
  if (message.method === "cursor/update_todos" || message.method === "cursor/task") {
    return [{ type: "activity", label: "Cursor reported progress" }];
  }
  if (message.method === "cursor/ask_question" || message.method === "cursor/create_plan") {
    return [{ type: "permission", requestId: `rpc-${message.id}`, description: "Cursor requires a user decision." }];
  }
  if (message.method === "acp/invalid_message") {
    return [{ type: "error", message: "Provider emitted an invalid ACP JSON message." }];
  }
  return [];
}

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") return false;
  if (message.method !== undefined && typeof message.method !== "string") return false;
  if (message.params !== undefined && (!message.params || typeof message.params !== "object" || Array.isArray(message.params))) return false;
  if (message.result !== undefined && (!message.result || typeof message.result !== "object" || Array.isArray(message.result))) return false;
  if (message.error !== undefined && (!message.error || typeof message.error !== "object" || Array.isArray(message.error))) return false;
  return message.method !== undefined || message.id !== undefined;
}

export function baseEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "TMPDIR", "TMP", "TEMP", "TERM", "COLORTERM", "NO_COLOR",
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
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

function sanitizeVersion(value: string): string | undefined {
  const firstLine = value.split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return firstLine || undefined;
}
