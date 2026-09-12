import path from "node:path";
import { CursorProvider } from "./acp/cursor.ts";
import { FakeProvider } from "./acp/fake.ts";
import { GrokProvider } from "./acp/grok.ts";
import {
  AcpProcessExitError,
  AcpProvider,
  AcpRpcError,
  AcpTimeoutError,
  AUTH_REQUIRED_CODE,
  JsonRpcPeer,
  normalizeAcpEvent,
  readSessionModes,
  readStopReason,
  type AuthMethod,
  type PendingRequestKind,
  type PermissionOption,
  type ProviderName,
  type RpcMessage,
  type RunEvent,
  type StopReason,
  type TaskMode,
} from "./acp/provider.ts";
import { WorkspacePolicy } from "./policy.ts";
import { RunStore, type RunRecord } from "./run-store.ts";
import type { EnvMode } from "./config.ts";

const CLIENT_VERSION = "0.2.0";
const SHORT_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 5_000;

export type StartRequest = {
  provider: ProviderName;
  cwd: string;
  prompt: string;
  mode: TaskMode;
  allowImplement?: boolean;
  model?: string;
  sessionId?: string;
};

export type ControllerOptions = {
  providers?: AcpProvider[];
  enableFake?: boolean;
  maxRunMs?: number;
  idleTimeoutMs?: number;
  envMode?: EnvMode;
  envPassthrough?: string[];
};

type LifecycleStage =
  | "spawn" | "initialize" | "authenticate" | "session/new" | "session/load"
  | "mode" | "session/prompt" | "cancel";

type PendingRequest = {
  message: RpcMessage;
  kind: PendingRequestKind;
  options: PermissionOption[];
};

type RuntimeRun = {
  peer: JsonRpcPeer;
  provider: AcpProvider;
  mode: TaskMode;
  workspace: string;
  events: RunEvent[];
  pendingRequests: Map<string, PendingRequest>;
  resultText: string;
  prompt?: string;
  error?: string;
  authMethodsSummary?: string;
  stderrTail?: string;
  stage: LifecycleStage;
  preauthenticatedSessionAttempted: boolean;
  cancelRequested: boolean;
  runTimeout?: NodeJS.Timeout;
  idleTimeout?: NodeJS.Timeout;
};

/** Read-only task modes must land on a read-only ACP mode or fail. */
const ACCEPTABLE_MODES: Record<TaskMode, string[]> = {
  review: ["ask", "plan"],
  plan: ["plan", "ask"],
  implement: ["agent", "code"],
};

export class RunController {
  private readonly store: RunStore;
  private readonly policy: WorkspacePolicy;
  private readonly providers: Map<ProviderName, AcpProvider>;
  private readonly maxRunMs: number;
  private readonly idleTimeoutMs: number;
  private readonly envMode: EnvMode;
  private readonly envPassthrough: string[];
  private readonly runtime = new Map<string, RuntimeRun>();

  constructor(store: RunStore, policy: WorkspacePolicy, options: ControllerOptions = {}) {
    this.store = store;
    this.policy = policy;
    this.maxRunMs = options.maxRunMs ?? 7_200_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 900_000;
    this.envMode = options.envMode ?? "session";
    this.envPassthrough = options.envPassthrough ?? [];
    this.providers = new Map((options.providers ?? [
      new CursorProvider(),
      new GrokProvider(),
      ...(options.enableFake ? [new FakeProvider()] : []),
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
      const startOptions = {
        ...request,
        cwd: decision.cwd,
        envMode: this.envMode,
        envPassthrough: this.envPassthrough,
      };
      provider.command(startOptions); // Validate optional model before creating a run.
      record = this.store.create({
        provider: request.provider,
        cwd: decision.cwd,
        workspace: decision.workspace,
        mode: request.mode,
      });
      const current = record;
      const transport = provider.createTransport(startOptions);
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
        preauthenticatedSessionAttempted: false,
        cancelRequested: false,
      };
      runtime.peer = new JsonRpcPeer(
        transport,
        (message) => this.handleProviderMessage(current.id, message, false),
        (message) => this.handleProviderMessage(current.id, message, true),
      );
      this.runtime.set(current.id, runtime);
      transport.onStderr((chunk) => this.captureStderr(current.id, chunk));
      transport.onExit((code, errorCode) => this.handleExit(current.id, code, errorCode));
      runtime.runTimeout = this.schedule(
        () => this.abort(current.id, new Error("ACP run exceeded its configured maximum duration.")),
        this.maxRunMs,
      );
      this.resetIdleTimer(current.id);
      void this.run(current.id, { ...request, cwd: decision.cwd });
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
      diagnostic: runtime?.stderrTail,
      elapsedMs: Date.now() - new Date(record.startedAt).getTime(),
      liveEvents: runtime?.events.slice(-30) ?? [],
      pendingRequests: [...(runtime?.pendingRequests.entries() ?? [])].map(([requestId, pending]) => ({
        requestId,
        kind: pending.kind,
        options: pending.options,
      })),
    };
  }

  result(id: string): Record<string, unknown> {
    const record = this.store.get(id);
    const runtime = this.runtime.get(id);
    return {
      runId: id,
      status: record.status,
      stopReason: record.completed?.stopReason,
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
    if (isTerminal(record.status)) return record;
    const runtime = this.requireRuntime(id);
    runtime.cancelRequested = true;
    runtime.stage = "cancel";
    // ACP defines session/cancel as a notification; the agent answers the
    // in-flight prompt with stopReason "cancelled".
    if (record.sessionId) runtime.peer.notify("session/cancel", { sessionId: record.sessionId });
    this.rejectPendingRequests(runtime);
    await this.waitForTerminal(id, CANCEL_TIMEOUT_MS);

    const latest = this.store.get(id);
    const cancelled = isTerminal(latest.status) && latest.status !== "failed"
      ? latest
      : this.store.update(id, { status: "cancelled" });
    this.policy.release(runtime.workspace, runtime.mode);
    this.finishRuntime(runtime);
    return cancelled;
  }

  resume(input: {
    runId?: string;
    provider?: ProviderName;
    sessionId?: string;
    followUp: string;
    allowImplement?: boolean;
  }): RunRecord {
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

  respondPermission(id: string, requestId: string, optionId: string): RunRecord {
    const { runtime, pending } = this.takePending(id, requestId, "permission");
    if (!pending.options.some((option) => option.optionId === optionId)) {
      throw new Error(`optionId must be one of the offered options: ${pending.options.map((option) => option.optionId).join(", ")}`);
    }
    return this.answer(id, runtime, requestId, { outcome: { outcome: "selected", optionId } });
  }

  respondQuestion(
    id: string,
    requestId: string,
    answers: Array<{ questionId: string; selectedOptionIds: string[] }> | undefined,
  ): RunRecord {
    const { runtime } = this.takePending(id, requestId, "question");
    const outcome = answers && answers.length > 0
      ? { outcome: "answered", answers }
      : { outcome: "skipped", reason: "The user did not answer this question." };
    return this.answer(id, runtime, requestId, { outcome });
  }

  respondPlan(id: string, requestId: string, accept: boolean, reason?: string): RunRecord {
    const { runtime } = this.takePending(id, requestId, "plan");
    const outcome = accept
      ? { outcome: "accepted" }
      : { outcome: "rejected", reason: reason ?? "The user rejected this plan." };
    return this.answer(id, runtime, requestId, { outcome });
  }

  private answer(id: string, runtime: RuntimeRun, requestId: string, response: Record<string, unknown>): RunRecord {
    const pending = runtime.pendingRequests.get(requestId);
    if (!pending || pending.message.id === undefined) throw new Error(`No pending request with ID ${requestId}.`);
    // Clear the gate before replying: a fast provider can complete its prompt
    // synchronously once it receives this response.
    runtime.pendingRequests.delete(requestId);
    if (runtime.pendingRequests.size === 0) this.store.update(id, { status: "running" });
    this.resetIdleTimer(id);
    runtime.peer.respond(pending.message.id, response);
    return this.store.get(id);
  }

  private takePending(id: string, requestId: string, kind: PendingRequestKind): {
    runtime: RuntimeRun;
    pending: PendingRequest;
  } {
    const record = this.store.get(id);
    if (isTerminal(record.status)) throw new Error("Cannot respond to a terminal run.");
    const runtime = this.requireRuntime(id);
    const pending = runtime.pendingRequests.get(requestId);
    if (!pending) throw new Error(`No pending request with ID ${requestId}.`);
    if (pending.kind !== kind) throw new Error(`Request ${requestId} expects a ${pending.kind} response.`);
    return { runtime, pending };
  }

  private async run(id: string, request: StartRequest): Promise<void> {
    const runtime = this.requireRuntime(id);
    try {
      runtime.stage = "initialize";
      const initialized = await runtime.peer.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "agents-acp", version: CLIENT_VERSION },
      }, SHORT_TIMEOUT_MS);
      if (!this.isActive(id)) return;
      runtime.authMethodsSummary = summarizeAuthMethods(initialized);

      const session = await this.openSession(id, runtime, request, initialized);
      if (!this.isActive(id)) return;
      const sessionId = typeof session.sessionId === "string" && session.sessionId
        ? session.sessionId
        : request.sessionId;
      if (!sessionId) throw new Error("ACP provider did not return a session ID.");
      this.store.update(id, { sessionId, status: "running" });
      this.acceptEvent(id, { type: "started", provider: request.provider, sessionId });

      runtime.stage = "mode";
      await this.selectMode(id, runtime, sessionId, request.mode, session);
      if (!this.isActive(id)) return;

      runtime.stage = "session/prompt";
      // A prompt turn is open-ended; the run and idle watchdogs bound it.
      const completion = await runtime.peer.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: request.prompt }],
      }, 0);
      if (!this.isActive(id)) return;
      this.finishPrompt(id, runtime, completion);
    } catch (error) {
      this.fail(id, error);
    }
  }

  private async openSession(
    id: string,
    runtime: RuntimeRun,
    request: StartRequest,
    initialized: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const authMethod = runtime.provider.authenticationMethod(initialized);
    if (!runtime.provider.prefersSessionBeforeAuthentication() && isProtocolAuthMethod(authMethod)) {
      await this.authenticate(id, runtime, authMethod as AuthMethod);
      return this.createSession(runtime, request, initialized);
    }

    runtime.preauthenticatedSessionAttempted = true;
    try {
      return await this.createSession(runtime, request, initialized);
    } catch (error) {
      if (!isAuthRequired(error)) throw error;
      if (!isProtocolAuthMethod(authMethod)) {
        throw new Error(
          authMethod
            ? `The provider requires authentication but only advertises the terminal method "${authMethod.methodId}", which ACP forbids sending to authenticate. Run \`cursor-agent login\` in a terminal, then retry.`
            : "The provider requires authentication but advertised no protocol-driven auth method. Run `cursor-agent login` in a terminal, then retry.",
        );
      }
      this.acceptEvent(id, {
        type: "activity",
        label: "ACP session creation reported auth_required; authenticating with the advertised method.",
      });
      await this.authenticate(id, runtime, authMethod as AuthMethod);
      return this.createSession(runtime, request, initialized);
    }
  }

  private async authenticate(id: string, runtime: RuntimeRun, method: AuthMethod): Promise<void> {
    runtime.stage = "authenticate";
    await runtime.peer.request("authenticate", { methodId: method.methodId }, SHORT_TIMEOUT_MS);
    if (!this.isActive(id)) throw new Error("Run became inactive during authentication.");
  }

  private async createSession(
    runtime: RuntimeRun,
    request: StartRequest,
    initialized: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (request.sessionId) {
      if (!supportsLoadSession(initialized)) {
        throw new Error("The provider did not advertise the loadSession capability, so this session cannot be resumed.");
      }
      runtime.stage = "session/load";
      const loaded = await runtime.peer.request("session/load", {
        sessionId: request.sessionId,
        cwd: request.cwd,
        mcpServers: [],
      }, 0);
      // `session/load` may legitimately return null/empty.
      return { sessionId: request.sessionId, ...loaded };
    }
    runtime.stage = "session/new";
    return runtime.peer.request("session/new", { cwd: request.cwd, mcpServers: [] }, SHORT_TIMEOUT_MS);
  }

  private async selectMode(
    id: string,
    runtime: RuntimeRun,
    sessionId: string,
    mode: TaskMode,
    session: Record<string, unknown>,
  ): Promise<void> {
    const { availableModes, currentModeId, configOptionId } = readSessionModes(session);
    const acceptable = ACCEPTABLE_MODES[mode];

    if (currentModeId && acceptable.includes(currentModeId)) {
      this.acceptEvent(id, { type: "activity", label: `ACP mode: already in ${currentModeId}.` });
      return;
    }
    if (availableModes.length === 0 && !currentModeId) {
      // `session/load` may return no mode metadata. Confirm the mode by
      // setting it explicitly; a rejection fails the run closed.
      await runtime.peer.request("session/set_mode", { sessionId, modeId: acceptable[0] }, SHORT_TIMEOUT_MS);
      this.acceptEvent(id, { type: "activity", label: `ACP mode: confirmed ${acceptable[0]} for a session without advertised modes.` });
      return;
    }

    const target = acceptable.find((candidate) => availableModes.includes(candidate));
    if (target) {
      if (configOptionId) {
        await runtime.peer.request("session/set_config_option", {
          sessionId,
          configId: configOptionId,
          value: target,
        }, SHORT_TIMEOUT_MS);
      } else {
        await runtime.peer.request("session/set_mode", { sessionId, modeId: target }, SHORT_TIMEOUT_MS);
      }
      this.acceptEvent(id, { type: "activity", label: `ACP mode: selected ${target}.` });
      return;
    }

    // Never silently run a read-only request in a write-capable default mode.
    const advertised = availableModes.length > 0 ? availableModes.join(", ") : "none";
    throw new Error(
      `The provider did not offer a ${mode === "implement" ? "write" : "read-only"} mode for this task. Required one of: ${acceptable.join(", ")}. Advertised: ${advertised}. Current: ${currentModeId ?? "unknown"}.`,
    );
  }

  private finishPrompt(id: string, runtime: RuntimeRun, completion: Record<string, unknown>): void {
    const stopReason = readStopReason(completion);
    if (runtime.pendingRequests.size > 0) {
      this.fail(id, new Error("Provider completed while a user decision was still pending."));
      return;
    }
    if (stopReason === "cancelled" || runtime.cancelRequested) {
      this.store.update(id, { status: "cancelled", completed: { stopReason: stopReason ?? "cancelled" } });
      this.policy.release(runtime.workspace, runtime.mode);
      this.finishRuntime(runtime);
      return;
    }
    if (stopReason !== "end_turn") {
      this.fail(id, new Error(unsuccessfulStopReason(stopReason)), undefined, stopReason);
      return;
    }
    this.acceptEvent(id, { type: "completed", summary: "Provider completed." });
    this.store.update(id, { completed: { stopReason } });
    this.policy.release(runtime.workspace, runtime.mode);
    this.finishRuntime(runtime);
    this.pruneRuntime();
  }

  private handleProviderMessage(id: string, message: RpcMessage, isRequest: boolean): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    if (message.method === "acp/invalid_message") {
      this.abort(id, new Error("Provider emitted an invalid ACP JSON-RPC envelope."));
      return;
    }
    this.resetIdleTimer(id);
    const events = normalizeAcpEvent(runtime.provider.name, message);
    for (const event of events) this.acceptEvent(id, event);

    if (!isRequest || message.id === undefined) return;
    const gate = events.find((event) => event.type === "permission");
    if (gate && gate.type === "permission") {
      runtime.pendingRequests.set(gate.requestId, {
        message,
        kind: gate.kind,
        options: gate.options ?? [],
      });
      this.store.update(id, { status: "waiting_permission" });
      this.clearIdleTimer(runtime);
      return;
    }
    this.answerNotificationRequest(runtime, message);
  }

  /**
   * Cursor documents these as fire-and-forget notifications, but some versions
   * send them as requests. Reply with their documented acknowledgement shape
   * instead of a JSON-RPC error that would stall the turn.
   */
  private answerNotificationRequest(runtime: RuntimeRun, message: RpcMessage): void {
    const id = message.id as number | string;
    if (message.method === "cursor/update_todos") {
      const todos = Array.isArray(message.params?.todos) ? message.params?.todos : [];
      runtime.peer.respond(id, { outcome: { outcome: "accepted", todos } });
      return;
    }
    if (message.method === "cursor/task") {
      runtime.peer.respond(id, { outcome: { outcome: "rejected", reason: "agents-acp does not run nested subagent tasks." } });
      return;
    }
    if (message.method === "cursor/generate_image") {
      runtime.peer.respond(id, { outcome: { outcome: "rejected", reason: "agents-acp does not generate images." } });
      return;
    }
    runtime.peer.respondError(id, -32601, "This ACP client does not support that request.");
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
      const diagnostic = this.describe(runtime, new Error(safeEvent.message));
      runtime.error = diagnostic;
      safeEvent.message = diagnostic;
    }
    this.store.appendEvent(id, safeEvent);
  }

  private handleExit(id: string, code: number | null, errorCode?: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    if (isTerminal(this.store.get(id).status)) return;
    if (runtime.cancelRequested) {
      this.store.update(id, { status: "cancelled" });
      this.policy.release(runtime.workspace, runtime.mode);
      this.finishRuntime(runtime);
      return;
    }
    this.fail(id, new AcpProcessExitError(code, errorCode));
  }

  private abort(id: string, error: unknown): void {
    if (!this.isActive(id)) return;
    this.fail(id, error);
  }

  private fail(id: string, error: unknown, fallbackStage: LifecycleStage = "spawn", stopReason?: StopReason): void {
    const record = this.store.get(id);
    if (isTerminal(record.status)) return;
    const runtime = this.runtime.get(id);
    const diagnostic = runtime
      ? this.describe(runtime, error)
      : describeFailure(fallbackStage, error);
    // Record the terminal state before touching the process, so the exit
    // callback cannot replace the real cause with "process exited".
    this.store.update(id, { status: "failed", error: diagnostic, completed: stopReason ? { stopReason } : undefined });
    this.store.appendEvent(id, { type: "error", message: diagnostic });
    if (runtime) {
      runtime.error = diagnostic;
      runtime.prompt = undefined;
      this.policy.release(runtime.workspace, runtime.mode);
      this.rejectPendingRequests(runtime);
      this.finishRuntime(runtime);
    }
  }

  private describe(runtime: RuntimeRun, error: unknown): string {
    return describeFailure(
      runtime.stage,
      error,
      runtime.workspace,
      runtime.prompt,
      runtime.authMethodsSummary,
      runtime.stderrTail,
      runtime.provider.name === "cursor" && runtime.preauthenticatedSessionAttempted,
    );
  }

  private rejectPendingRequests(runtime: RuntimeRun): void {
    for (const [, pending] of runtime.pendingRequests) {
      if (pending.message.id === undefined) continue;
      runtime.peer.respond(pending.message.id, { outcome: { outcome: "cancelled" } });
    }
    runtime.pendingRequests.clear();
  }

  private async waitForTerminal(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isTerminal(this.store.get(id).status)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private requireRuntime(id: string): RuntimeRun {
    const runtime = this.runtime.get(id);
    if (!runtime) throw new Error("The run is not active in this MCP server process.");
    return runtime;
  }

  private isActive(id: string): boolean {
    return !isTerminal(this.store.get(id).status);
  }

  private schedule(action: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(action, delayMs);
    timer.unref?.();
    return timer;
  }

  private resetIdleTimer(id: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime) return;
    this.clearIdleTimer(runtime);
    runtime.idleTimeout = this.schedule(
      () => this.abort(id, new Error("ACP provider produced no output before the idle timeout.")),
      this.idleTimeoutMs,
    );
  }

  private clearIdleTimer(runtime: RuntimeRun): void {
    if (runtime.idleTimeout) clearTimeout(runtime.idleTimeout);
    runtime.idleTimeout = undefined;
  }

  private finishRuntime(runtime: RuntimeRun): void {
    if (runtime.runTimeout) clearTimeout(runtime.runTimeout);
    runtime.runTimeout = undefined;
    this.clearIdleTimer(runtime);
    runtime.prompt = undefined;
    runtime.peer.terminate();
  }

  private pruneRuntime(): void {
    const terminal = [...this.runtime.entries()].filter(([id]) => isTerminal(this.store.get(id).status));
    while (this.runtime.size > 200 && terminal.length > 0) {
      const [id] = terminal.shift() as [string, RuntimeRun];
      this.runtime.delete(id);
    }
  }

  private captureStderr(id: string, chunk: string): void {
    const runtime = this.runtime.get(id);
    if (!runtime || isTerminal(this.store.get(id).status)) return;
    const sanitized = sanitizeDiagnosticText(chunk, runtime.workspace, runtime.prompt);
    runtime.stderrTail = `${runtime.stderrTail ?? ""} ${sanitized}`.slice(-2_000).trim();
  }
}

function isTerminal(status: RunRecord["status"]): boolean {
  return ["completed", "cancelled", "failed", "interrupted"].includes(status);
}

function isProtocolAuthMethod(method: AuthMethod | undefined): boolean {
  // ACP forbids sending terminal-type methods to authenticate/auth.login.
  return method !== undefined && method.type?.toLowerCase() !== "terminal";
}

function isAuthRequired(error: unknown): boolean {
  if (!(error instanceof AcpRpcError)) return false;
  return error.code === AUTH_REQUIRED_CODE
    || /auth[_ -]?required|unauthenticated|not logged in/i.test(error.providerMessage ?? "");
}

function supportsLoadSession(initialized: Record<string, unknown>): boolean {
  const capabilities = initialized.agentCapabilities;
  if (!capabilities || typeof capabilities !== "object") return false;
  const candidate = capabilities as { loadSession?: unknown; session?: unknown };
  if (candidate.loadSession === true) return true;
  const session = candidate.session;
  return Boolean(session && typeof session === "object" && "load" in (session as Record<string, unknown>));
}

function unsuccessfulStopReason(stopReason: StopReason | undefined): string {
  switch (stopReason) {
    case "refusal":
      return "The provider refused the request (stopReason refusal).";
    case "max_tokens":
      return "The provider stopped at its token limit, so the answer is truncated (stopReason max_tokens).";
    case "max_turn_requests":
      return "The provider stopped at its turn-request limit, so the task is incomplete (stopReason max_turn_requests).";
    default:
      return `The provider ended the turn without a successful stopReason (${stopReason ?? "missing"}).`;
  }
}

function sanitizeEvent(event: RunEvent, workspace: string): RunEvent | undefined {
  if (event.type !== "file_change") return event;
  if (event.path.includes("\0")) return undefined;
  const absolute = path.resolve(workspace, event.path);
  const relative = path.relative(workspace, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return { ...event, path: relative || "." };
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

export function describeFailure(
  stage: LifecycleStage,
  error: unknown,
  workspace?: string,
  prompt?: string,
  authMethodsSummary?: string,
  stderrTail?: string,
  preauthenticatedCursorSession = false,
): string {
  let message: string;
  if (error instanceof AcpTimeoutError) {
    message = `ACP ${stage} timed out.`;
  } else if (error instanceof AcpProcessExitError) {
    message = error.errorCode
      ? `ACP ${stage} failed: provider process error ${error.errorCode}.`
      : `ACP ${stage} failed: provider process exited (${error.exitCode ?? "signal"}).`;
  } else if (error instanceof AcpRpcError) {
    const code = error.code === undefined ? "unknown" : String(error.code);
    const detail = error.providerMessage
      ? ` ${sanitizeDiagnosticText(error.providerMessage, workspace, prompt)}`
      : "";
    message = `ACP ${stage} was rejected by the provider (JSON-RPC code ${code}).${detail}`;
  } else {
    const raw = error instanceof Error ? error.message : "Unexpected internal adapter error.";
    message = `ACP ${stage} failed: ${sanitizeDiagnosticText(raw, workspace, prompt)}`;
  }
  if (preauthenticatedCursorSession && (stage === "session/new" || stage === "session/load")) {
    message = `ACP ${stage} failed after the pre-authenticated Cursor path: the ACP child could not reuse the logged-in Cursor CLI session. Start Codex from the same user login/keychain environment where cursor-agent status works. ${message}`;
  }
  if (stderrTail) message = `${message.slice(0, 320)} Provider stderr: ${stderrTail.slice(-140)}`;
  const withSummary = (stage === "authenticate" || preauthenticatedCursorSession) && authMethodsSummary
    ? `${message} Advertised auth methods: ${authMethodsSummary}.`
    : message;
  return withSummary.slice(0, 600);
}

export function sanitizeDiagnosticText(value: string, workspace?: string, prompt?: string): string {
  let result = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (prompt) result = result.split(prompt).join("[REDACTED PROMPT]");
  result = result
    .replace(/\b(bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b(authorization)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
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
