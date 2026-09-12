import { CursorProvider } from "./acp/cursor.ts";
import { FakeProvider } from "./acp/fake.ts";
import { GrokProvider } from "./acp/grok.ts";
import path from "node:path";
import {
  AcpProvider,
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
  error?: string;
  timeout?: NodeJS.Timeout;
};

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
      transport.onExit((code) => this.handleExit(current.id, code));
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
        await runtime.peer.request("session/cancel", { sessionId: record.sessionId }, 5_000);
      }
    } finally {
      // Set terminal state before killing the process so an exit callback
      // cannot rewrite a cancelled run as failed.
      const cancelled = this.store.update(id, { status: "cancelled" });
      this.policy.release(runtime.workspace, runtime.mode);
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
      const initialized = await runtime.peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "external-acp-collaboration", version: "0.1.6" },
      });
      if (!this.isActive(id)) return;
      const authMethod = runtime.provider.authenticationMethod(initialized);
      if (!authMethod) throw new Error(`No supported local authentication method was advertised by ${request.provider}.`);
      await runtime.peer.request("authenticate", { methodId: authMethod });
      if (!this.isActive(id)) return;
      const session = request.sessionId
        ? await runtime.peer.request("session/load", { sessionId: request.sessionId, cwd: request.cwd })
        : await runtime.peer.request("session/new", { cwd: request.cwd, mcpServers: [] });
      const sessionId = String(session.sessionId ?? "");
      if (!sessionId) throw new Error("ACP provider did not return a session ID.");
      if (!this.isActive(id)) return;
      this.store.update(id, { sessionId, status: "running" });
      this.acceptEvent(id, { type: "started", provider: request.provider, sessionId });
      const modeSelected = await this.setModeIfAdvertised(runtime, sessionId, request.mode, session);
      if (!modeSelected) throw new Error(`Provider did not advertise the required ${request.mode} mode.`);
      if (!this.isActive(id)) return;
      const completion = await runtime.peer.request("session/prompt", {
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
      this.clearTimeout(runtime);
      runtime.peer.terminate();
      this.pruneRuntime();
    } catch (error) {
      this.fail(id, error);
      runtime.peer.terminate();
    }
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
    const modes = Array.isArray(session.availableModes) ? session.availableModes : [];
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
    if (safeEvent.type === "error") runtime.error = "Provider error; inspect the provider's local diagnostics.";
    this.store.appendEvent(id, safeEvent);
  }

  private handleExit(id: string, code: number | null): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    const record = this.store.get(id);
    if (["completed", "cancelled", "failed"].includes(record.status)) return;
    this.fail(id, new Error(`ACP process exited (${code ?? "signal"}) before completion.`));
  }

  private fail(id: string, error: unknown): void {
    const record = this.store.get(id);
    if (isTerminal(record.status)) return;
    const runtime = this.runtime.get(id);
    if (runtime) {
      runtime.error = "Provider error; inspect the provider's local diagnostics.";
      this.policy.release(runtime.workspace, runtime.mode);
      this.clearTimeout(runtime);
    }
    this.store.update(id, { status: "failed" });
    this.store.appendEvent(id, { type: "error", message: "Provider failure; inspect the live result for details." });
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

function sanitizeEvent(event: RunEvent, workspace: string): RunEvent | undefined {
  if (event.type !== "file_change") return event;
  if (event.path.includes("\0")) return undefined;
  const absolute = path.resolve(workspace, event.path);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { ...event, path: relative || "." };
}
