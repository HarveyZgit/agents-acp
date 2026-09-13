import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpProvider,
  AcpRpcError,
  baseEnvironment,
  INVALID_PARAMS_CODE,
  JsonRpcPeer,
  normalizeAcpEvent,
  providerEnvironment,
  readModeDrift,
  readRequestDetail,
  readSessionModes,
  type AuthMethod,
  type LineTransport,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "../src/acp/provider.ts";
import { describeFailure, RunController } from "../src/run-controller.ts";
import { WorkspacePolicy } from "../src/policy.ts";
import { RunStore } from "../src/run-store.ts";
import { CursorProvider, type CursorProbe, type CursorProbeResult } from "../src/acp/cursor.ts";
import { GrokProvider } from "../src/acp/grok.ts";

class FakeTransport implements LineTransport {
  writes: string[] = [];
  terminated = false;
  private lines: Array<(line: string) => void> = [];
  private stderr: Array<(chunk: string) => void> = [];
  private exits: Array<(code: number | null) => void> = [];

  write(line: string): void {
    this.writes.push(line);
  }
  onLine(listener: (line: string) => void): void {
    this.lines.push(listener);
  }
  onStderr(listener: (chunk: string) => void): void {
    this.stderr.push(listener);
  }
  onExit(listener: (code: number | null) => void): void {
    this.exits.push(listener);
  }
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    for (const listener of this.exits) listener(0);
  }
  emit(message: unknown): void {
    for (const listener of this.lines) listener(JSON.stringify(message));
  }
  emitStderr(chunk: string): void {
    for (const listener of this.stderr) listener(chunk);
  }
  sent(method: string): Array<Record<string, unknown>> {
    return this.writes.map((line) => JSON.parse(line)).filter((message) => message.method === method);
  }
}

test("JSON-RPC peer resolves requests, honors no-timeout turns, and flags invalid envelopes", async () => {
  const transport = new FakeTransport();
  const events: string[] = [];
  const peer = new JsonRpcPeer(transport, (message) => events.push(message.method ?? ""), () => {});

  const response = peer.request("initialize", {});
  assert.equal(JSON.parse(transport.writes[0]).method, "initialize");
  transport.emit({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  assert.deepEqual(await response, { protocolVersion: 1 });

  // An open-ended prompt turn must not be killed by a default request timeout.
  const openEnded = peer.request("session/prompt", {}, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  transport.emit({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  assert.deepEqual(await openEnded, { stopReason: "end_turn" });

  // A default-timeout request must still be bounded.
  const timed = peer.request("initialize", {}, 15);
  await assert.rejects(timed, /timed out/);

  peer.notify("session/cancel", { sessionId: "s1" });
  assert.equal(transport.sent("session/cancel").length, 1);
  assert.equal(JSON.parse(transport.writes.at(-1) as string).id, undefined);

  transport.emit(null);
  assert.deepEqual(events, ["acp/invalid_message"]);
});

test("session update normalization derives changed files from tool call diffs and locations", () => {
  assert.deepEqual(
    normalizeAcpEvent("cursor", {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } },
    }),
    [{ type: "text", text: "hello" }],
  );

  const toolCall = normalizeAcpEvent("cursor", {
    method: "session/update",
    params: {
      update: {
        sessionUpdate: "tool_call",
        kind: "edit",
        locations: [{ path: "src/touched.ts" }],
        content: [
          { type: "diff", path: "src/created.ts", oldText: null, newText: "next" },
          { type: "diff", path: "src/removed.ts", oldText: "prior", newText: null },
        ],
      },
    },
  });
  assert.deepEqual(toolCall, [
    { type: "activity", label: "Agent reported tool activity" },
    { type: "file_change", path: "src/created.ts", kind: "create" },
    { type: "file_change", path: "src/removed.ts", kind: "delete" },
    { type: "file_change", path: "src/touched.ts", kind: "modify" },
  ]);

  // A read-only tool call must not be reported as a file change.
  assert.deepEqual(
    normalizeAcpEvent("cursor", {
      method: "session/update",
      params: { update: { sessionUpdate: "tool_call", kind: "read", locations: [{ path: "src/read.ts" }] } },
    }),
    [{ type: "activity", label: "Agent reported tool activity" }],
  );
});

test("permission requests relay offered option IDs and Cursor extensions stay distinct", () => {
  const [permission] = normalizeAcpEvent("cursor", {
    id: 7,
    method: "session/request_permission",
    params: { options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }] },
  });
  assert.deepEqual(permission, {
    type: "permission",
    requestId: "rpc-7",
    description: "Agent requested permission to continue.",
    kind: "permission",
    options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
  });

  const [question] = normalizeAcpEvent("cursor", { id: 8, method: "cursor/ask_question", params: {} });
  const [plan] = normalizeAcpEvent("cursor", { id: 9, method: "cursor/create_plan", params: {} });
  assert.equal(question.type === "permission" && question.kind, "question");
  assert.equal(plan.type === "permission" && plan.kind, "plan");
});

test("mode drift is read from current_mode_update and mode config options", () => {
  assert.equal(readModeDrift({
    method: "session/update",
    params: { update: { sessionUpdate: "current_mode_update", currentModeId: "agent" } },
  }), "agent");
  assert.equal(readModeDrift({
    method: "session/update",
    params: { update: { sessionUpdate: "config_option_update", configOption: { category: "mode", currentValue: "code" } } },
  }), "code");
  assert.equal(readModeDrift({
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk" } },
  }), undefined);
});

test("session modes are read from the ACP SessionModeState object", () => {
  assert.deepEqual(
    readSessionModes({
      modes: { currentModeId: "agent", availableModes: [{ id: "ask" }, { id: "plan" }, { id: "agent" }] },
    }),
    { availableModes: ["ask", "plan", "agent"], currentModeId: "agent" },
  );
  assert.deepEqual(
    readSessionModes({
      configOptions: [{ configId: "mode", category: "mode", currentValue: "code", options: [{ value: "ask" }, { value: "code" }] }],
    }),
    { availableModes: ["ask", "code"], currentModeId: "code", configOptionId: "mode" },
  );
  assert.deepEqual(readSessionModes({}), { availableModes: [] });
});

test("model arguments are optional and passed only as startup CLI flags", () => {
  const cursor = availableCursor();
  assert.deepEqual(
    cursor.command({ cwd: "/project", prompt: "task", mode: "review" }),
    ["acp"],
  );
  assert.deepEqual(
    cursor.command({ cwd: "/project", prompt: "task", mode: "review", model: "composer-2.5" }),
    ["--model", "composer-2.5", "acp"],
  );
  assert.equal(cursor.capabilities.supportsModelSelection, true);
  assert.equal(cursor.capabilities.modelSelection, "startup");
  assert.match(cursor.discover().note ?? "", /billing pool|selectedModel/);
  assert.throws(
    () => cursor.command({ cwd: "/project", prompt: "task", mode: "review", model: "--always-approve" }),
    /cannot be interpreted as a CLI flag/,
  );

  assert.deepEqual(
    new GrokProvider().command({ cwd: "/project", prompt: "task", mode: "plan" }),
    ["--no-auto-update", "--cwd", "/project", "agent", "--no-leader", "stdio"],
  );
  assert.deepEqual(
    new GrokProvider().command({ cwd: "/project", prompt: "task", mode: "plan", model: "grok-build" }),
    ["--no-auto-update", "--cwd", "/project", "agent", "--no-leader", "--model", "grok-build", "stdio"],
  );
  assert.deepEqual(
    new GrokProvider().authenticateParams({ methodId: "cached_token" }),
    { methodId: "cached_token", _meta: { headless: true } },
  );
  assert.equal(new GrokProvider().prefersSessionBeforeAuthentication(), true);
  assert.throws(
    () => new GrokProvider().command({ cwd: "/project", prompt: "task", mode: "plan", model: "--always-approve" }),
    /cannot be interpreted as a CLI flag/,
  );
});

class FixtureCursorProbe implements CursorProbe {
  calls: Array<{ executable: string; args: string[] }> = [];
  private readonly fixtures: Record<string, CursorProbeResult>;

  constructor(fixtures: Record<string, CursorProbeResult>) {
    this.fixtures = fixtures;
  }

  run(executable: string, args: string[]): CursorProbeResult {
    this.calls.push({ executable, args });
    return this.fixtures[`${executable} ${args.join(" ")}`] ?? { status: null, error: new Error("not found") };
  }
}

function availableCursor(): CursorProvider {
  return new CursorProvider(new FixtureCursorProbe({
    "cursor-agent --version": { status: 0, stdout: "Cursor Agent 1.2.3\n" },
    "cursor-agent acp --help": { status: 0, stdout: "Usage: cursor-agent acp\n" },
  }));
}

test("Cursor discovery selects only cursor-agent with ACP argv", () => {
  const provider = availableCursor();
  const discovery = provider.discover();
  assert.equal(discovery.available, true);
  assert.equal(discovery.executable, "cursor-agent");
  assert.match(discovery.note ?? "", /cursor-agent acp/);
  assert.deepEqual(provider.command({ cwd: "/project", prompt: "task", mode: "review" }), ["acp"]);
});

test("Cursor discovery does not fall back to cursor or agent", () => {
  const probe = new FixtureCursorProbe({
    "cursor --version": { status: 0, stdout: "unrelated cursor\n" },
    "cursor acp --help": { status: 0, stdout: "acp\n" },
    "agent --version": { status: 0, stdout: "colliding agent\n" },
    "agent acp --help": { status: 0, stdout: "acp\n" },
  });
  const provider = new CursorProvider(probe);
  assert.equal(provider.discover().available, false);
  assert.deepEqual(probe.calls, [{ executable: "cursor-agent", args: ["--version"] }]);
  assert.throws(
    () => provider.command({ cwd: "/project", prompt: "task", mode: "review" }),
    /intentionally does not fall back/,
  );
});

test("Cursor auth descriptors accept methodId or id and keep the terminal type", () => {
  const provider = new CursorProvider(new FixtureCursorProbe({}));
  assert.deepEqual(
    provider.authenticationMethod({ authMethods: [{ methodId: "cursor_login" }] }),
    { methodId: "cursor_login", type: undefined },
  );
  assert.deepEqual(
    provider.authenticationMethod({ authMethods: [{ id: "cursor_login", type: "terminal" }] }),
    { methodId: "cursor_login", type: "terminal" },
  );
  assert.equal(provider.authenticationMethod({ authMethods: [] }), undefined);
});

test("provider environment is an auditable allowlist with an explicit inherit escape hatch", () => {
  const previousMarker = process.env.CURSOR_SESSION_MARKER;
  const previousSecret = process.env.UNRELATED_TEST_SECRET;
  process.env.CURSOR_SESSION_MARKER = "cursor-scoped";
  process.env.UNRELATED_TEST_SECRET = "do-not-forward";
  try {
    const options: StartOptions = { cwd: "/project", prompt: "task", mode: "review", envMode: "session" };
    const session = providerEnvironment(options, ["CURSOR_"], ["CURSOR_API_KEY"]);
    assert.equal(session.CURSOR_SESSION_MARKER, "cursor-scoped");
    assert.equal(session.UNRELATED_TEST_SECRET, undefined);
    assert.equal(session.PATH, process.env.PATH);

    const minimal = providerEnvironment({ ...options, envMode: "minimal" }, ["CURSOR_"]);
    assert.equal(minimal.CURSOR_SESSION_MARKER, undefined);

    const inherited = providerEnvironment({ ...options, envMode: "inherit" }, ["CURSOR_"]);
    assert.equal(inherited.UNRELATED_TEST_SECRET, "do-not-forward");
    assert.equal(baseEnvironment().UNRELATED_TEST_SECRET, undefined);
  } finally {
    restore("CURSOR_SESSION_MARKER", previousMarker);
    restore("UNRELATED_TEST_SECRET", previousSecret);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type MockOptions = {
  authMethods?: unknown[];
  requireAuth?: boolean;
  modes?: unknown;
  stopReason?: string;
  completeBeforePermission?: boolean;
  rejectedMethod?: string;
  rejectionMessage?: string;
  stderrOnRejected?: string;
  loadSession?: boolean;
  driftToMode?: string;
  outsideWorkspaceWrite?: boolean;
  protocolVersion?: unknown;
  name?: ProviderName;
  cliSessionKnownGood?: boolean;
  authenticateInvalidParams?: boolean;
  allowSessionAfterInvalidParams?: boolean;
  prefersSessionBeforeAuthentication?: boolean;
  authenticateHeadless?: boolean;
};

class MockProvider extends AcpProvider {
  readonly name: ProviderName;
  readonly executable = "mock-grok";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };
  readonly transport = new FakeTransport();
  private readonly options: MockOptions;
  private authenticated: boolean;
  private cliSessionExists = false;
  private promptId: number | string | undefined;

  constructor(options: MockOptions = {}) {
    super();
    this.options = options;
    this.name = options.name ?? "grok";
    this.authenticated = options.requireAuth !== true;
  }

  command(): string[] {
    return ["agent", "stdio"];
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    const first = methods[0];
    if (!first || typeof first !== "object") return undefined;
    const descriptor = first as { methodId?: unknown; id?: unknown; type?: unknown };
    const methodId = typeof descriptor.methodId === "string"
      ? descriptor.methodId
      : typeof descriptor.id === "string" ? descriptor.id : undefined;
    return methodId ? { methodId, type: typeof descriptor.type === "string" ? descriptor.type : undefined } : undefined;
  }

  prefersSessionBeforeAuthentication(): boolean {
    return this.options.prefersSessionBeforeAuthentication !== false;
  }

  authenticateParams(method: AuthMethod): Record<string, unknown> {
    return this.options.authenticateHeadless
      ? { methodId: method.methodId, _meta: { headless: true } }
      : { methodId: method.methodId };
  }

  cliSessionKnownGood(): boolean {
    return this.options.cliSessionKnownGood === true;
  }

  createTransport(): LineTransport {
    const write = this.transport.write.bind(this.transport);
    this.transport.write = (line) => {
      write(line);
      const message = JSON.parse(line);
      if (!message.method) return;
      this.handle(message);
    };
    return this.transport;
  }

  private handle(message: { id?: number | string; method: string; params?: Record<string, unknown> }): void {
    if (message.method === this.options.rejectedMethod) {
      if (this.options.stderrOnRejected) this.transport.emitStderr(this.options.stderrOnRejected);
      this.transport.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: this.options.rejectionMessage } });
      return;
    }
    switch (message.method) {
      case "initialize":
        this.transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: this.options.protocolVersion ?? 1,
            agentCapabilities: { loadSession: this.options.loadSession ?? true },
            authMethods: this.options.authMethods ?? [{ methodId: "cached_token", type: "agent" }],
          },
        });
        return;
      case "authenticate":
        if (this.options.authenticateInvalidParams) {
          if (this.options.allowSessionAfterInvalidParams !== false) this.cliSessionExists = true;
          this.transport.emit({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: INVALID_PARAMS_CODE, message: "Invalid params" },
          });
          return;
        }
        this.authenticated = true;
        this.transport.emit({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      case "session/new":
        if (!this.authenticated && !this.cliSessionExists) {
          this.transport.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "auth_required" } });
          return;
        }
        this.transport.emit({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "mock-session",
            modes: this.options.modes ?? { currentModeId: "agent", availableModes: [{ id: "ask" }, { id: "plan" }, { id: "agent" }] },
          },
        });
        return;
      case "session/load":
        this.transport.emit({ jsonrpc: "2.0", id: message.id, result: null });
        return;
      case "session/set_mode":
      case "session/set_config_option":
        this.transport.emit({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      case "session/prompt":
        this.promptId = message.id;
        this.transport.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "mocked answer" } } },
        });
        if (this.options.driftToMode) {
          this.transport.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: { update: { sessionUpdate: "current_mode_update", currentModeId: this.options.driftToMode } },
          });
        }
        if (this.options.outsideWorkspaceWrite) {
          this.transport.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                kind: "edit",
                content: [{ type: "diff", path: "/etc/outside.conf", oldText: "a", newText: "b" }],
              },
            },
          });
        }
        if (this.options.completeBeforePermission) {
          this.transport.emit({ jsonrpc: "2.0", id: 90, method: "session/request_permission", params: { options: [{ optionId: "allow-once" }] } });
          this.transport.emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: this.options.stopReason ?? "end_turn" } });
          return;
        }
        if (this.options.stopReason && this.options.stopReason !== "pending") {
          this.transport.emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: this.options.stopReason } });
          return;
        }
        this.transport.emit({
          jsonrpc: "2.0",
          id: 90,
          method: "session/request_permission",
          params: { options: [{ optionId: "allow-once", kind: "allow_once" }, { optionId: "reject-once", kind: "reject_once" }] },
        });
        return;
      case "session/cancel":
        if (this.promptId !== undefined) {
          this.transport.emit({ jsonrpc: "2.0", id: this.promptId, result: { stopReason: "cancelled" } });
          this.promptId = undefined;
        }
        return;
      default:
        return;
    }
  }
}

function controllerFor(provider: MockProvider, options: { allowImplement?: boolean } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-controller-"));
  const controller = new RunController(
    new RunStore(join(workspace, "runs.json")),
    new WorkspacePolicy(workspace, [], options.allowImplement ?? false),
    { providers: [provider] },
  );
  return { workspace, controller };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("permission stays pending with offered options and cancel uses the ACP notification", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "do not persist this", mode: "plan" });
  await settle();

  const waiting = controller.status(run.id);
  assert.equal(waiting.status, "waiting_permission");
  assert.deepEqual(waiting.pendingRequests, [{
    requestId: "rpc-90",
    kind: "permission",
    description: "Agent requested permission to continue.",
    detail: undefined,
    options: [{ optionId: "allow-once", name: undefined, kind: "allow_once" }, { optionId: "reject-once", name: undefined, kind: "reject_once" }],
  }]);
  assert.equal(provider.transport.writes.some((line) => JSON.parse(line).id === 90), false);
  assert.throws(
    () => controller.respondPermission(run.id, "rpc-90", "not-offered"),
    /must be one of the offered options/,
  );

  const cancelled = await controller.cancel(run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(provider.transport.sent("session/cancel").length, 1);
  // The pending request must be answered as cancelled, not left dangling.
  const answered = provider.transport.writes.map((line) => JSON.parse(line)).find((message) => message.id === 90);
  assert.deepEqual(answered.result, { outcome: { outcome: "cancelled" } });
  assert.equal(provider.transport.terminated, true);
});

test("selected permission option is relayed verbatim to the provider", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  controller.respondPermission(run.id, "rpc-90", "reject-once");
  const answered = provider.transport.writes.map((line) => JSON.parse(line)).find((message) => message.id === 90);
  assert.deepEqual(answered.result, { outcome: { outcome: "selected", optionId: "reject-once" } });
  await controller.cancel(run.id);
});

test("auth_required triggers authenticate with a protocol method and retries session/new", async () => {
  const provider = new MockProvider({ requireAuth: true, authMethods: [{ methodId: "cursor_login", type: "agent" }] });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.equal(controller.status(run.id).status, "waiting_permission");
  assert.equal(provider.transport.sent("authenticate").length, 1);
  assert.equal(provider.transport.sent("session/new").length, 2);
  await controller.cancel(run.id);
});

test("terminal-only auth methods are never sent to authenticate", async () => {
  const provider = new MockProvider({
    name: "cursor",
    requireAuth: true,
    cliSessionKnownGood: true,
    authMethods: [{ methodId: "cursor_login", type: "terminal" }],
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "cursor", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const status = controller.status(run.id);
  assert.equal(status.status, "failed");
  assert.match(String(status.error), /terminal method/);
  assert.match(String(status.error), /could not reuse/);
  assert.equal(/please login first|cursor-agent login/i.test(String(status.error)), false);
  assert.equal(provider.transport.sent("authenticate").length, 0);
});

test("authenticate -32602 is treated as unnecessary and retries session without login guidance", async () => {
  const provider = new MockProvider({
    name: "cursor",
    requireAuth: true,
    cliSessionKnownGood: true,
    authenticateInvalidParams: true,
    authMethods: [{ methodId: "cursor_login", type: "agent" }],
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "cursor", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const status = controller.status(run.id);
  assert.equal(status.status, "waiting_permission");
  assert.equal(provider.transport.sent("authenticate").length, 1);
  assert.equal(provider.transport.sent("session/new").length, 2);
  const events = JSON.stringify(status.liveEvents ?? []);
  assert.match(events, /invalid or unnecessary/);
  assert.equal(/please login first|cursor-agent login/i.test(`${status.error ?? ""} ${events}`), false);
  await controller.cancel(run.id);
});

test("authenticate -32602 then a failed session retry never tells a logged-in Cursor user to login", async () => {
  const provider = new MockProvider({
    name: "cursor",
    requireAuth: true,
    cliSessionKnownGood: true,
    authenticateInvalidParams: true,
    allowSessionAfterInvalidParams: false,
    authMethods: [{ methodId: "cursor_login", type: "agent" }],
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "cursor", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const status = controller.status(run.id);
  assert.equal(status.status, "failed");
  assert.equal(provider.transport.sent("authenticate").length, 1);
  assert.equal(provider.transport.sent("session/new").length, 2);
  assert.match(String(status.error), /could not reuse the logged-in Cursor CLI session/);
  assert.equal(/please login first|cursor-agent login/i.test(String(status.error)), false);
});

test("Cursor CLI status is known good only when cursor-agent status reports a login", () => {
  const loggedIn = new CursorProvider(new FixtureCursorProbe({
    "cursor-agent status": { status: 0, stdout: "Logged in as user@example.com\n" },
  }));
  assert.equal(loggedIn.cliSessionKnownGood(), true);

  const loggedOut = new CursorProvider(new FixtureCursorProbe({
    "cursor-agent status": { status: 0, stdout: "Not logged in\n" },
  }));
  assert.equal(loggedOut.cliSessionKnownGood(), false);

  const missing = new CursorProvider(new FixtureCursorProbe({}));
  assert.equal(missing.cliSessionKnownGood(), false);
});

test("authenticate-first providers also retry session after -32602", async () => {
  const provider = new MockProvider({
    requireAuth: true,
    prefersSessionBeforeAuthentication: false,
    authenticateInvalidParams: true,
    authenticateHeadless: true,
    authMethods: [{ methodId: "cached_token", type: "agent" }],
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.equal(controller.status(run.id).status, "waiting_permission");
  const authenticate = provider.transport.sent("authenticate")[0];
  assert.deepEqual(authenticate.params, { methodId: "cached_token", _meta: { headless: true } });
  assert.equal(provider.transport.sent("session/new").length, 1);
  await controller.cancel(run.id);
});

test("session/new Permission denied names cwd and session-file access, not a bare EACCES", async () => {
  const provider = new MockProvider({
    name: "grok",
    rejectedMethod: "session/new",
    rejectionMessage: "Permission denied",
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const error = String(controller.result(run.id).error);
  assert.match(error, /Permission denied/);
  assert.match(error, /could not access the workspace or provider session files/);
  assert.equal(/please login first|cursor-agent login/i.test(error), false);
});

test("preauthenticated Cursor failures strip please-login guidance from diagnostics", () => {
  const error = new AcpRpcError(INVALID_PARAMS_CODE, "Invalid params; please login first and run cursor-agent login");
  const message = describeFailure("authenticate", error, "/workspace", undefined, "cursor_login:agent", undefined, true);
  assert.match(message, /could not reuse the logged-in Cursor CLI session/);
  assert.match(message, /JSON-RPC code -32602/);
  assert.equal(/please login first|cursor-agent login/i.test(message), false);
});

test("read-only modes fail closed when no read-only ACP mode is available", async () => {
  const provider = new MockProvider({ modes: { currentModeId: "agent", availableModes: [{ id: "agent" }] } });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "review" });
  await settle();
  const status = controller.status(run.id);
  assert.equal(status.status, "failed");
  assert.match(String(status.error), /did not offer a read-only mode/);
  assert.equal(provider.transport.sent("session/prompt").length, 0);
});

test("the prompt turn is not bounded by the short request timeout", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const prompt = provider.transport.writes
    .map((line) => JSON.parse(line))
    .find((message) => message.method === "session/prompt");
  assert.ok(prompt, "session/prompt must be sent");
  // The turn stays open while a decision is pending rather than timing out.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(controller.status(run.id).status, "waiting_permission");
  await controller.cancel(run.id);
});

test("read-only modes select an advertised read-only mode before prompting", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "review" });
  await settle();
  const modeCall = provider.transport.sent("session/set_mode")[0];
  assert.deepEqual((modeCall.params as { modeId: string }).modeId, "ask");
  const promptIndex = provider.transport.writes.findIndex((line) => JSON.parse(line).method === "session/prompt");
  const modeIndex = provider.transport.writes.findIndex((line) => JSON.parse(line).method === "session/set_mode");
  assert.ok(modeIndex < promptIndex, "mode must be selected before prompting");
  await controller.cancel(run.id);
});

test("non-successful stop reasons are not reported as success", async () => {
  for (const stopReason of ["refusal", "max_tokens"]) {
    const provider = new MockProvider({ stopReason });
    const { workspace, controller } = controllerFor(provider);
    const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
    await settle();
    const result = controller.result(run.id);
    assert.equal(result.status, "failed", `${stopReason} must not be success`);
    assert.equal(result.stopReason, stopReason);
  }
});

test("successful turn records end_turn and streamed text", async () => {
  const provider = new MockProvider({ stopReason: "end_turn" });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const result = controller.result(run.id);
  assert.equal(result.status, "completed");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.summary, "mocked answer");
});

test("resume loads a stored session even when session/load returns null", async () => {
  const provider = new MockProvider({ stopReason: "end_turn" });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const resumed = controller.resume({ runId: run.id, followUp: "continue" });
  await settle();
  assert.equal(controller.status(resumed.id).status, "completed");
  const load = provider.transport.sent("session/load")[0];
  assert.deepEqual(load.params, { sessionId: "mock-session", cwd: workspace, mcpServers: [] });
});

test("resume is refused when the provider does not advertise loadSession", async () => {
  const provider = new MockProvider({ stopReason: "end_turn", loadSession: false });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const resumed = controller.resume({ runId: run.id, followUp: "continue" });
  await settle();
  assert.match(String(controller.status(resumed.id).error), /loadSession capability/);
});

test("pending requests relay tool call titles, question options, and plan steps", () => {
  const permission = readRequestDetail({
    id: 1,
    method: "session/request_permission",
    params: {
      toolCall: { title: "Write src/app.ts", kind: "edit", locations: [{ path: "src/app.ts" }] },
      options: [{ optionId: "allow-once", name: "Allow once" }],
    },
  });
  assert.deepEqual(permission, {
    toolCallTitle: "Write src/app.ts",
    toolKind: "edit",
    locations: ["src/app.ts"],
  });
  const [permissionEvent] = normalizeAcpEvent("cursor", {
    id: 1,
    method: "session/request_permission",
    params: { toolCall: { title: "Write src/app.ts" }, options: [{ optionId: "allow-once", name: "Allow once" }] },
  });
  assert.equal(permissionEvent.type === "permission" && permissionEvent.description, "Agent requested permission for: Write src/app.ts");
  assert.deepEqual(
    permissionEvent.type === "permission" ? permissionEvent.options : undefined,
    [{ optionId: "allow-once", name: "Allow once", kind: undefined }],
  );

  assert.deepEqual(readRequestDetail({
    id: 2,
    method: "cursor/ask_question",
    params: {
      title: "Need input",
      questions: [{ id: "q1", prompt: "Which mode?", allowMultiple: false, options: [{ id: "agent", label: "Agent" }] }],
    },
  }), {
    title: "Need input",
    questions: [{
      questionId: "q1",
      prompt: "Which mode?",
      allowMultiple: false,
      options: [{ optionId: "agent", label: "Agent" }],
    }],
  });

  assert.deepEqual(readRequestDetail({
    id: 3,
    method: "cursor/create_plan",
    params: {
      name: "Refactor",
      overview: "Tighten layout",
      plan: "1. Inspect\n2. Update",
      todos: [{ id: "todo-1", content: "Inspect sizing", status: "pending" }],
    },
  }), {
    name: "Refactor",
    overview: "Tighten layout",
    plan: "1. Inspect 2. Update",
    steps: [{ id: "todo-1", content: "Inspect sizing", status: "pending" }],
  });
});

test("mid-turn mode drift aborts a read-only run", async () => {
  const provider = new MockProvider({ driftToMode: "agent" });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "review" });
  await settle();
  const status = controller.status(run.id);
  assert.equal(status.status, "failed");
  assert.match(String(status.error), /switched the session to mode "agent"/);
});

test("mid-turn mode drift within acceptable read-only modes continues", async () => {
  const provider = new MockProvider({ driftToMode: "plan" });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "review" });
  await settle();
  assert.equal(controller.status(run.id).status, "waiting_permission");
  await controller.cancel(run.id);
});

test("file changes outside the workspace are flagged and block clean success", async () => {
  const provider = new MockProvider({ stopReason: "end_turn", outsideWorkspaceWrite: true });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const result = controller.result(run.id);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /outside the authorized workspace/);
  assert.deepEqual(result.changedFiles, []);
  assert.equal((result.outsideWorkspaceWrites as string[]).length, 1);
});

test("an unsupported ACP protocol version fails the run closed", async () => {
  const provider = new MockProvider({ protocolVersion: 0 });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.match(String(controller.status(run.id).error), /unsupported ACP protocol version/);
});

test("a failing run store degrades the run without breaking run control", async () => {
  const provider = new MockProvider();
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-controller-"));
  const store = new RunStore(join(workspace, "runs.json"));
  const controller = new RunController(store, new WorkspacePolicy(workspace), { providers: [provider] });
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();

  const broken = new Error("simulated store outage");
  store.update = () => { throw broken; };
  store.appendEvent = () => { throw broken; };

  // Run control must still reach a terminal state and report the degradation.
  const cancelled = await controller.cancel(run.id);
  assert.ok(cancelled);
  const status = controller.status(run.id);
  assert.equal(status.status, "cancelled");
  assert.match(String(status.storeDegraded), /Run persistence failed/);
});

test("controller terminates a provider that completes while permission remains pending", async () => {
  const provider = new MockProvider({ completeBeforePermission: true });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.equal(controller.status(run.id).status, "failed");
});

test("failure diagnostics keep the ACP stage but redact prompts, credentials, and outside paths", async () => {
  const provider = new MockProvider({
    rejectedMethod: "session/new",
    rejectionMessage: "CURSOR_AUTH_TOKEN=super-secret; prompt: sensitive request; /outside/private/path unavailable",
    stderrOnRejected: "cursor detail authorization=hidden-value",
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "sensitive request", mode: "plan" });
  await settle();
  const error = String(controller.result(run.id).error);
  assert.match(error, /ACP session\/new was rejected/);
  assert.match(error, /Provider stderr:/);
  for (const secret of ["super-secret", "sensitive request", "/outside/private/path", "hidden-value"]) {
    assert.equal(error.includes(secret), false, `leaked ${secret}`);
  }
});

test("authenticate failures include only safe advertised auth method summaries", async () => {
  const provider = new MockProvider({
    requireAuth: true,
    authMethods: [{ methodId: "cursor_login", type: "agent" }],
    rejectedMethod: "authenticate",
    rejectionMessage: "authorization=hidden-value",
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const error = String(controller.result(run.id).error);
  assert.match(error, /ACP authenticate was rejected/);
  assert.match(error, /Advertised auth methods: cursor_login:agent/);
  assert.equal(error.includes("hidden-value"), false);
  assert.equal(/please login first|cursor-agent login/i.test(error), false);
});

test("controller terminates an ACP run that exceeds its configured lifetime", async () => {
  const provider = new MockProvider();
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-controller-"));
  const controller = new RunController(
    new RunStore(join(workspace, "runs.json")),
    new WorkspacePolicy(workspace),
    { providers: [provider], maxRunMs: 5 },
  );
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.equal(controller.status(run.id).status, "failed");
});
