import { CursorProvider } from "./acp/cursor.ts";
import { FakeProvider } from "./acp/fake.ts";
import { GrokProvider } from "./acp/grok.ts";
import path from "node:path";
import {
  AcpProcessExitError,
  AcpProvider,
  AcpRpcError,
  AcpTimeoutError,
  JsonRpcPeer,
  normalizeAcpEvent,
  type PermissionDecision,
  type ProviderName,
  type RpcMessage,
  type RunEvent,
  type TaskMode,
} from "./acp/provider.ts";
import { WorkspacePolicy } from "./policy.ts";
import { RunStore, type RunRecord } from "./run-store.ts";

export type StartRequest = {
  provider: ProviderName;
  cwd: string;
  prompt: string;
  mode: TaskMode;
  allowImplement?: boolean;
  model?: string;
  sessionId?: string;
};

type RuntimeRun = {
  peer: JsonRpcPeer;
  provider: AcpProvider;
  mode: TaskMode;
  workspace: string;
  events: RunEvent[];
  pendingRequests: Map<string, RpcMessage>;
  resultText: string;
  prompt?: string;
  error?: string;
  authMethodsSummary?: string;
  stage: LifecycleStage;
  timeout?: NodeJS.Timeout;
};

type LifecycleStage = "spawn" | "initialize" | "authenticate" | "session/new" | "session/load" | "mode" | "session/prompt" | "cancel";

export class RunController {
  private readonly store: RunStore;
  private readonly policy: WorkspacePolicy;
  private readonly providers: Map<ProviderName, AcpProvider>;
  private readonly maxRunMs: number;
  private readonly runtime = new Map<string, RuntimeRun>();

  constructor(
    store: RunStore,
    policy: WorkspacePolicy,
    providers?: AcpProvider[],
    enableFake = false,
    maxRunMs = 7_200_000,
  ) {
    this.store = store;
    this.policy = policy;
    this.maxRunMs = maxRunMs;
    this.providers = new Map((providers ?? [
      new CursorProvider(),
      new GrokProvider(),
      ...(enableFake ? [new FakeProvider()] : []),
    ]).map((provider) => [provider.name, provider]));
  }

  listProviders(): ReturnType<AcpProvider["discover"]>[] {
    return [...this.providers.values()].map((provider) => provider.discover());
  }

  start(request: StartRequest): RunRecord {
    const provider = this.providers.get(request.provider);
    if (!provider) throw new Error(`Unsupported provider: ${request.provider}`);
    const decision = this.policy.authorize(request);
    if (request.mode === "implement" && this.store.listActiveImplementRuns(decision.workspace).length > 0) {
      throw new Error("An implement run is already active for this workspace.");
    }
    this.policy.acquire(decision, request.mode);

    let record: RunRecord | undefined;
    try {
      provider.command(request); // Validate optional model before creating a run.
      record = this.store.create({
        provider: request.provider,
        cwd: decision.cwd,
        workspace: decision.workspace,
        mode: request.mode,
      });
      const transport = provider.createTransport({ ...request, cwd: decision.cwd });
      const current = record;
      const runtime: RuntimeRun = {
        peer: undefined as unknown as JsonRpcPeer,
        provider,
        mode: request.mode,
        workspace: decision.workspace,
        events: [],
        pendingRequests: new Map(),
        resultText: "",
        prompt: request.prompt,
        stage: "spawn",
      };
      const peer = new JsonRpcPeer(
        transport,
        (message) => this.handleProviderMessage(current.id, message, false),
        (message) => this.handleProviderMessage(current.id, message, true),
      );
      runtime.peer = peer;
      this.runtime.set(current.id, runtime);
      runtime.timeout = setTimeout(() => {
        if (this.isActive(current.id)) {
          this.fail(current.id, new Error("ACP run exceeded its configured maximum duration."));
          runtime.peer.terminate();
        }
      }, this.maxRunMs);
      transport.onExit((code, errorCode) => this.handleExit(current.id, code, errorCode));
      void this.initialize(current.id, request);
      return current;
    } catch (error) {
      this.policy.release(decision.workspace, request.mode);
      if (record) this.fail(record.id, error);
      throw error;
    }
  }

  status(id: string): Record<string, unknown> {
    const record = this.store.get(id);
    const runtime = this.runtime.get(id);
    return {
      ...record,
      error: runtime?.error ?? record.error,
      stage: runtime?.stage,
      authMethods: runtime?.authMethodsSummary,
      elapsedMs: Date.now() - new Date(record.startedAt).getTime(),
      liveEvents: runtime?.events.slice(-30) ?? [],
      pendingRequests: [...(runtime?.pendingRequests.keys() ?? [])],
    };
  }

  result(id: string): Record<string, unknown> {
    const record = this.store.get(id);
    const runtime = this.runtime.get(id);
    return {
      runId: id,
      status: record.status,
      summary: runtime?.resultText || (record.status === "completed"
        ? "The provider completed. Transcript text is available only while the local MCP server remains running."
        : undefined),
      changedFiles: record.changedFiles,
      error: runtime?.error ?? record.error,
      verificationAdvice: "Review the changed-file summary and run project-specific checks before adopting edits.",
    };
  }

  async cancel(id: string): Promise<RunRecord> {
    const record = this.store.get(id);
    const runtime = this.requireRuntime(id);
    if (isTerminal(record.status)) return record;
    try {
      if (record.sessionId) {
        runtime.stage = "cancel";
        await runtime.peer.request("session/cancel", { sessionId: record.sessionId }, 5_000);
      }
    } finally {
      // Set terminal state before killing the process so an exit callback
      // cannot rewrite a cancelled run as failed.
      const cancelled = this.store.update(id, { status: "cancelled" });
      this.policy.release(runtime.workspace, runtime.mode);
      runtime.prompt = undefined;
      this.clearTimeout(runtime);
      runtime.peer.terminate();
      return cancelled;
    }
  }

  resume(input: { runId?: string; provider?: ProviderName; sessionId?: string; followUp: string; allowImplement?: boolean }): RunRecord {
    const hasRunId = input.runId !== undefined;
    const hasProviderSession = input.provider !== undefined || input.sessionId !== undefined;
    if (hasRunId === hasProviderSession || (hasProviderSession && (!input.provider || !input.sessionId))) {
      throw new Error("Provide exactly one resume reference: runId or both provider and sessionId.");
    }
    const previous = hasRunId
      ? this.store.get(input.runId as string)
      : this.store.findBySession(input.provider as ProviderName, input.sessionId as string);
    if (!previous?.sessionId) throw new Error("A prior run with a provider session ID is required to resume.");
    if (!isTerminal(previous.status)) throw new Error("Only a completed, failed, cancelled, or interrupted run may be resumed.");
    return this.start({
      provider: previous.provider,
      cwd: previous.cwd,
      prompt: input.followUp,
      mode: previous.mode,
      allowImplement: input.allowImplement,
      sessionId: previous.sessionId,
    });
  }

  respondPermission(id: string, requestId: string, decision: PermissionDecision): RunRecord {
    const record = this.store.get(id);
    if (isTerminal(record.status)) throw new Error("Cannot respond to a terminal run.");
    const runtime = this.requireRuntime(id);
    const request = runtime.pendingRequests.get(requestId);
    if (!request || request.method !== "session/request_permission" || request.id === undefined) {
      throw new Error("No pending ACP permission request with that ID.");
    }
    const response = runtime.provider.permissionResponse(decision);
    if (!response) throw new Error(`Explicit ACP permission responses are not documented for ${runtime.provider.name}.`);
    // Remove the gate before replying: a fast provider can synchronously
    // complete its prompt as soon as it receives this JSON-RPC response.
    runtime.pendingRequests.delete(requestId);
    this.store.update(id, { status: "running" });
    runtime.peer.respond(request.id, response);
    return this.store.get(id);
  }

  private async initialize(id: string, request: StartRequest): Promise<void> {
    const runtime = this.requireRuntime(id);
    try {
      runtime.stage = "initialize";
      const initialized = await runtime.peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agents-acp", version: "0.1.10" },
      });
      if (!this.isActive(id)) return;
      runtime.authMethodsSummary = summarizeAuthMethods(initialized);
      const authMethod = runtime.provider.authenticationMethod(initialized);
      let session: Record<string, unknown>;
      if (runtime.provider.prefersSessionBeforeAuthentication()) {
        try {
          session = await this.createSession(runtime, request);
        } catch (sessionError) {
          if (!shouldAuthenticate(authMethod)) throw sessionError;
          this.acceptEvent(id, {
            type: "activity",
            label: "ACP session creation requested authentication; trying the advertised protocol method.",
          });
          try {
            await this.authenticate(id, runtime, authMethod);
          } catch (authError) {
            if (!runtime.provider.allowsPreauthenticatedSessionFallback() || !isInvalidParams(authError)) throw authError;
            this.acceptEvent(id, {
              type: "activity",
              label: "ACP authenticate returned invalid parameters; retrying the pre-authenticated session.",
            });
          }
          session = await this.createSession(runtime, request);
        }
      } else {
        if (shouldAuthenticate(authMethod)) {
          try {
            await this.authenticate(id, runtime, authMethod);
          } catch (authError) {
            if (!runtime.provider.allowsPreauthenticatedSessionFallback() || !isInvalidParams(authError)) throw authError;
            this.acceptEvent(id, {
              type: "activity",
              label: "ACP authenticate returned invalid parameters; retrying the pre-authenticated session.",
            });
          }
        }
        session = await this.createSession(runtime, request);
      }
      const sessionId = String(session.sessionId ?? "");
      if (!sessionId) throw new Error("ACP provider did not return a session ID.");
      if (!this.isActive(id)) return;
      this.store.update(id, { sessionId, status: "running" });
      this.acceptEvent(id, { type: "started", provider: request.provider, sessionId });
      runtime.stage = "mode";
      const modeSelected = await this.setModeIfAdvertised(runtime, sessionId, request.mode, session);
      if (!modeSelected && request.mode === "implement") {
        throw new Error("Provider did not advertise the required agent mode for implement.");
      }
      if (!modeSelected) {
        this.acceptEvent(id, {
          type: "activity",
          label: `ACP mode: ${request.mode} is not advertised; proceeding with the provider default session mode.`,
        });
      }
      if (!this.isActive(id)) return;
      runtime.stage = "session/prompt";
      await runtime.peer.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      });
      if (!this.isActive(id)) return;
      if (runtime.pendingRequests.size > 0) {
        throw new Error("Provider completed while a user decision was still pending.");
      }
      this.acceptEvent(id, {
        type: "completed",
        summary: "Provider completed.",
      });
      this.policy.release(runtime.workspace, runtime.mode);
      runtime.prompt = undefined;
      this.clearTimeout(runtime);
      runtime.peer.terminate();
      this.pruneRuntime();
    } catch (error) {
      this.fail(id, error);
      runtime.peer.terminate();
    }
  }

  private async authenticate(id: string, runtime: RuntimeRun, method: { methodId: string }): Promise<void> {
    runtime.stage = "authenticate";
    await runtime.peer.request("authenticate", { methodId: method.methodId });
    if (!this.isActive(id)) throw new Error("Run was cancelled during authentication.");
  }

  private async createSession(runtime: RuntimeRun, request: StartRequest): Promise<Record<string, unknown>> {
    runtime.stage = request.sessionId ? "session/load" : "session/new";
    return request.sessionId
      ? runtime.peer.request("session/load", { sessionId: request.sessionId, cwd: request.cwd })
      : runtime.peer.request("session/new", { cwd: request.cwd, mcpServers: [] });
  }

  private async setModeIfAdvertised(
    runtime: RuntimeRun,
    sessionId: string,
    mode: TaskMode,
    session: Record<string, unknown>,
  ): Promise<boolean> {
    const configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
    const modeOption = configOptions.find((option) => (
      typeof option === "object" && option !== null && (option as { category?: string }).category === "mode"
    )) as { id?: string; options?: Array<{ value?: string }> } | undefined;
    const providerMode = mode === "implement" ? "agent" : mode === "review" ? "ask" : "plan";
    if (modeOption?.id && modeOption.options?.some((option) => option.value === providerMode)) {
      await runtime.peer.request("session/set_config_option", { sessionId, configId: modeOption.id, value: providerMode });
      return true;
    }
    const modes = Array.isArray(session.availableModes)
      ? session.availableModes
      : Array.isArray(session.modes) ? session.modes : [];
    if (modes.some((available) => (
      typeof available === "object" && available !== null && (available as { id?: string }).id === providerMode
    ))) {
      await runtime.peer.request("session/set_mode", { sessionId, modeId: providerMode });
      return true;
    }
    return false;
  }

  private handleProviderMessage(id: string, message: RpcMessage, isRequest: boolean): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    if (message.method === "acp/invalid_message") {
      this.fail(id, new Error("Provider emitted an invalid ACP JSON-RPC envelope."));
      runtime.peer.terminate();
      return;
    }
    for (const event of normalizeAcpEvent(runtime.provider.name, message)) this.acceptEvent(id, event);
    if (isRequest && message.id !== undefined && requiresUserDecision(message.method)) {
      const requestId = `rpc-${message.id}`;
      runtime.pendingRequests.set(requestId, message);
      this.store.update(id, { status: "waiting_permission" });
    } else if (isRequest && message.id !== undefined) {
      runtime.peer.respondError(message.id, -32601, "This ACP client does not support that request.");
    }
  }

  private acceptEvent(id: string, event: RunEvent): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    if (!this.isActive(id) && event.type !== "completed") return;
    const safeEvent = sanitizeEvent(event, runtime.workspace);
    if (!safeEvent) return;
    runtime.events.push(safeEvent);
    if (runtime.events.length > 500) runtime.events.splice(0, runtime.events.length - 500);
    if (safeEvent.type === "text") runtime.resultText = `${runtime.resultText}${safeEvent.text}`.slice(-1_000_000);
    if (safeEvent.type === "error") {
      const diagnostic = describeFailure(
        runtime.stage,
        new Error(safeEvent.message),
        runtime.workspace,
        runtime.prompt,
        runtime.authMethodsSummary,
      );
      runtime.error = diagnostic;
      safeEvent.message = diagnostic;
    }
    this.store.appendEvent(id, safeEvent);
  }

  private handleExit(id: string, code: number | null, errorCode?: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    const record = this.store.get(id);
    if (["completed", "cancelled", "failed", "interrupted"].includes(record.status)) return;
    this.fail(id, new AcpProcessExitError(code, errorCode));
  }

  private fail(id: string, error: unknown, fallbackStage: LifecycleStage = "spawn"): void {
    const record = this.store.get(id);
    if (isTerminal(record.status)) return;
    const runtime = this.runtime.get(id);
    const diagnostic = describeFailure(
      runtime?.stage ?? fallbackStage,
      error,
      runtime?.workspace,
      runtime?.prompt,
      runtime?.authMethodsSummary,
    );
    if (runtime) {
      runtime.error = diagnostic;
      runtime.prompt = undefined;
      this.policy.release(runtime.workspace, runtime.mode);
      this.clearTimeout(runtime);
    }
    this.store.update(id, { status: "failed", error: diagnostic });
    this.store.appendEvent(id, { type: "error", message: diagnostic });
  }

  private requireRuntime(id: string): RuntimeRun {
    const runtime = this.runtime.get(id);
    if (!runtime) throw new Error("The run is not active in this MCP server process.");
    return runtime;
  }

  private isActive(id: string): boolean {
    return !isTerminal(this.store.get(id).status);
  }

  private pruneRuntime(): void {
    const terminal = [...this.runtime.entries()]
      .filter(([id]) => isTerminal(this.store.get(id).status));
    while (this.runtime.size > 200 && terminal.length > 0) {
      const [id] = terminal.shift() as [string, RuntimeRun];
      this.runtime.delete(id);
    }
  }

  private clearTimeout(runtime: RuntimeRun): void {
    if (runtime.timeout) clearTimeout(runtime.timeout);
    runtime.timeout = undefined;
  }
}

function isTerminal(status: RunRecord["status"]): boolean {
  return ["completed", "cancelled", "failed", "interrupted"].includes(status);
}

function requiresUserDecision(method: string | undefined): boolean {
  return method === "session/request_permission"
    || method === "cursor/ask_question"
    || method === "cursor/create_plan";
}

function shouldAuthenticate(method: { methodId: string; type?: string } | undefined): boolean {
  return method !== undefined && method.type?.toLowerCase() !== "terminal";
}

function isInvalidParams(error: unknown): boolean {
  return error instanceof AcpRpcError && error.code === -32602;
}

function summarizeAuthMethods(initialized: Record<string, unknown>): string | undefined {
  const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  const summary = methods.flatMap((method) => {
    if (!method || typeof method !== "object") return [];
    const descriptor = method as { id?: unknown; methodId?: unknown; type?: unknown };
    const id = typeof descriptor.methodId === "string"
      ? descriptor.methodId
      : typeof descriptor.id === "string" ? descriptor.id : undefined;
    if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) return [];
    const type = typeof descriptor.type === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(descriptor.type)
      ? `:${descriptor.type}`
      : "";
    return [`${id}${type}`];
  });
  return summary.length > 0 ? summary.join(", ") : undefined;
}

function sanitizeEvent(event: RunEvent, workspace: string): RunEvent | undefined {
  if (event.type !== "file_change") return event;
  if (event.path.includes("\0")) return undefined;
  const absolute = path.resolve(workspace, event.path);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { ...event, path: relative || "." };
}

function describeFailure(
  stage: LifecycleStage,
  error: unknown,
  workspace?: string,
  prompt?: string,
  authMethodsSummary?: string,
): string {
  if (error instanceof AcpTimeoutError) return withAuthSummary(`ACP ${stage} timed out.`, stage, authMethodsSummary);
  if (error instanceof AcpProcessExitError) {
    if (error.errorCode) return withAuthSummary(`ACP ${stage} failed: provider process error ${error.errorCode}.`, stage, authMethodsSummary);
    return withAuthSummary(`ACP ${stage} failed: provider process exited (${error.exitCode ?? "signal"}).`, stage, authMethodsSummary);
  }
  if (error instanceof AcpRpcError) {
    const code = error.code === undefined ? "unknown" : String(error.code);
    const detail = error.providerMessage
      ? ` ${sanitizeDiagnosticText(error.providerMessage, workspace, prompt)}`
      : "";
    return withAuthSummary(`ACP ${stage} was rejected by the provider (JSON-RPC code ${code}).${detail}`.slice(0, 500), stage, authMethodsSummary);
  }
  const message = error instanceof Error ? error.message : "Unexpected internal adapter error.";
  return withAuthSummary(`ACP ${stage} failed: ${sanitizeDiagnosticText(message, workspace, prompt)}`.slice(0, 500), stage, authMethodsSummary);
}

function withAuthSummary(message: string, stage: LifecycleStage, summary?: string): string {
  return stage === "authenticate" && summary
    ? `${message} Advertised auth methods: ${summary}.`.slice(0, 500)
    : message;
}

function sanitizeDiagnosticText(value: string, workspace?: string, prompt?: string): string {
  let result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (prompt) result = result.split(prompt).join("[REDACTED PROMPT]");
  result = result
    .replace(/\b(bearer)\s+[^\s]+/gi, "$1 [REDACTED]")
    .replace(/\b(api[_ -]?key|token|secret|password|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  result = result.replace(/\/[^\s"'`]+/g, (candidate) => redactPath(candidate, workspace));
  return result || "Provider returned no diagnostic text.";
}

function redactPath(candidate: string, workspace?: string): string {
  if (!workspace) return "[REDACTED PATH]";
  const absolute = path.resolve(candidate);
  const relative = path.relative(workspace, absolute);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative ? `<workspace>/${relative}` : "<workspace>";
  }
  return "[REDACTED PATH]";
}
