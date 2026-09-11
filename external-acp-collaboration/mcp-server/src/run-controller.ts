import { CursorProvider } from "./acp/cursor.ts";
import { GrokProvider } from "./acp/grok.ts";
import {
  AcpProvider,
  JsonRpcPeer,
  normalizeAcpEvent,
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
};

export class RunController {
  private readonly store: RunStore;
  private readonly policy: WorkspacePolicy;
  private readonly providers: Map<ProviderName, AcpProvider>;
  private readonly runtime = new Map<string, RuntimeRun>();

  constructor(store: RunStore, policy: WorkspacePolicy, providers?: AcpProvider[]) {
    this.store = store;
    this.policy = policy;
    this.providers = new Map((providers ?? [new CursorProvider(), new GrokProvider()]).map((provider) => [provider.name, provider]));
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
    if (!record.sessionId) throw new Error("Run has not created an ACP session yet.");
    await runtime.peer.request("session/cancel", { sessionId: record.sessionId });
    runtime.peer.terminate();
    this.policy.release(runtime.workspace, runtime.mode);
    return this.store.update(id, { status: "cancelled" });
  }

  resume(input: { runId?: string; provider?: ProviderName; sessionId?: string; followUp: string; allowImplement?: boolean }): RunRecord {
    const previous = input.runId
      ? this.store.get(input.runId)
      : input.provider && input.sessionId
        ? this.store.findBySession(input.provider, input.sessionId)
        : undefined;
    if (!previous?.sessionId) throw new Error("A prior run with a provider session ID is required to resume.");
    return this.start({
      provider: previous.provider,
      cwd: previous.cwd,
      prompt: input.followUp,
      mode: previous.mode,
      allowImplement: input.allowImplement,
      sessionId: previous.sessionId,
    });
  }

  respond(id: string, requestId: string, response: Record<string, unknown>): RunRecord {
    const runtime = this.requireRuntime(id);
    const message = runtime.pendingRequests.get(requestId);
    if (!message || message.id === undefined) throw new Error(`No pending request named ${requestId}.`);
    runtime.peer.respond(message.id, response);
    runtime.pendingRequests.delete(requestId);
    return this.store.update(id, { status: "running" });
  }

  private async initialize(id: string, request: StartRequest): Promise<void> {
    const runtime = this.requireRuntime(id);
    try {
      const initialized = await runtime.peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "external-acp-collaboration", version: "0.1.0" },
      });
      const authMethod = runtime.provider.authenticationMethod(initialized);
      if (!authMethod) throw new Error(`No supported local authentication method was advertised by ${request.provider}.`);
      await runtime.peer.request("authenticate", { methodId: authMethod });
      const session = request.sessionId
        ? await runtime.peer.request("session/load", { sessionId: request.sessionId, cwd: request.cwd })
        : await runtime.peer.request("session/new", { cwd: request.cwd, mcpServers: [] });
      const sessionId = String(session.sessionId ?? "");
      if (!sessionId) throw new Error("ACP provider did not return a session ID.");
      this.store.update(id, { sessionId, status: "running" });
      this.acceptEvent(id, { type: "started", provider: request.provider, sessionId });
      await this.setModeIfAdvertised(runtime, sessionId, request.mode, session);
      const completion = await runtime.peer.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      });
      this.acceptEvent(id, {
        type: "completed",
        summary: String(completion.stopReason ?? "Provider completed."),
      });
      this.policy.release(runtime.workspace, runtime.mode);
    } catch (error) {
      this.fail(id, error);
    }
  }

  private async setModeIfAdvertised(
    runtime: RuntimeRun,
    sessionId: string,
    mode: TaskMode,
    session: Record<string, unknown>,
  ): Promise<void> {
    const configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
    const modeOption = configOptions.find((option) => (
      typeof option === "object" && option !== null && (option as { category?: string }).category === "mode"
    )) as { id?: string; options?: Array<{ value?: string }> } | undefined;
    const providerMode = mode === "implement" ? "agent" : mode === "review" ? "ask" : "plan";
    if (modeOption?.id && modeOption.options?.some((option) => option.value === providerMode)) {
      await runtime.peer.request("session/set_config_option", { sessionId, configId: modeOption.id, value: providerMode });
      return;
    }
    const modes = Array.isArray(session.availableModes) ? session.availableModes : [];
    if (modes.some((available) => (
      typeof available === "object" && available !== null && (available as { id?: string }).id === providerMode
    ))) {
      await runtime.peer.request("session/set_mode", { sessionId, modeId: providerMode });
    }
  }

  private handleProviderMessage(id: string, message: RpcMessage, isRequest: boolean): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    for (const event of normalizeAcpEvent(runtime.provider.name, message)) this.acceptEvent(id, event);
    if (isRequest && message.id !== undefined) {
      const requestId = `rpc-${message.id}`;
      runtime.pendingRequests.set(requestId, message);
      this.store.update(id, { status: "waiting_permission" });
    }
  }

  private acceptEvent(id: string, event: RunEvent): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    runtime.events.push(event);
    if (event.type === "text") runtime.resultText += event.text;
    if (event.type === "error") runtime.error = event.message;
    this.store.appendEvent(id, event);
  }

  private handleExit(id: string, code: number | null): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    const record = this.store.get(id);
    if (["completed", "cancelled", "failed"].includes(record.status)) return;
    this.fail(id, new Error(`ACP process exited (${code ?? "signal"}) before completion.`));
  }

  private fail(id: string, error: unknown): void {
    const runtime = this.runtime.get(id);
    if (runtime) {
      runtime.error = error instanceof Error ? error.message : "Provider failure";
      this.policy.release(runtime.workspace, runtime.mode);
    }
    this.store.update(id, { status: "failed" });
    this.store.appendEvent(id, { type: "error", message: "Provider failure; inspect the live result for details." });
  }

  private requireRuntime(id: string): RuntimeRun {
    const runtime = this.runtime.get(id);
    if (!runtime) throw new Error("The run is not active in this MCP server process.");
    return runtime;
  }
}
