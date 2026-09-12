import assert from "node:assert/strict";
import test from "node:test";
import {
  AcpProvider,
  baseEnvironment,
  JsonRpcPeer,
  normalizeAcpEvent,
  type LineTransport,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "../src/acp/provider.ts";
import { RunController } from "../src/run-controller.ts";
import { WorkspacePolicy } from "../src/policy.ts";
import { RunStore } from "../src/run-store.ts";
import { CursorProvider, type CursorProbe, type CursorProbeResult } from "../src/acp/cursor.ts";
import { GrokProvider } from "../src/acp/grok.ts";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

class FakeTransport implements LineTransport {
  writes: string[] = [];
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
    for (const listener of this.exits) listener(0);
  }
  emit(message: unknown): void {
    for (const listener of this.lines) listener(JSON.stringify(message));
  }
  emitStderr(chunk: string): void {
    for (const listener of this.stderr) listener(chunk);
  }
}

test("JSON-RPC peer resolves requests and normalizes provider events", async () => {
  const transport = new FakeTransport();
  const events: string[] = [];
  const peer = new JsonRpcPeer(transport, (message) => events.push(message.method ?? ""), () => {});
  const response = peer.request("initialize", {});
  assert.equal(JSON.parse(transport.writes[0]).method, "initialize");
  transport.emit({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  assert.deepEqual(await response, { protocolVersion: 1 });

  const normalized = normalizeAcpEvent("cursor", {
    method: "session/update",
    params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "hello" } } },
  });
  assert.deepEqual(normalized, [{ type: "text", text: "hello" }]);
  transport.emit({ jsonrpc: "2.0", method: "cursor/update_todos", params: {} });
  transport.emit(null);
  assert.deepEqual(events, ["cursor/update_todos", "acp/invalid_message"]);
});

test("model arguments are passed only through documented provider capabilities", () => {
  const cursor = new CursorProvider();
  assert.throws(
    () => cursor.command({ cwd: "/project", prompt: "task", mode: "review", model: "model-x" }),
    /Model selection unavailable/,
  );
  assert.deepEqual(
    new GrokProvider().command({ cwd: "/project", prompt: "task", mode: "plan", model: "grok-build" }),
    ["--no-auto-update", "agent", "--model", "grok-build", "stdio"],
  );
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
    return this.fixtures[`${executable} ${args.join(" ")}`] ?? {
      status: null,
      error: new Error("not found"),
    };
  }
}

test("Cursor discovery selects only cursor-agent with ACP argv", () => {
  const probe = new FixtureCursorProbe({
    "cursor-agent --version": { status: 0, stdout: "Cursor Agent 1.2.3\n" },
    "cursor-agent acp --help": { status: 0, stdout: "Usage: cursor-agent acp\n" },
  });
  const provider = new CursorProvider(probe);
  const discovery = provider.discover();
  assert.equal(discovery.available, true);
  assert.equal(discovery.executable, "cursor-agent");
  assert.match(discovery.note ?? "", /cursor-agent acp/);
  assert.deepEqual(provider.command({ cwd: "/project", prompt: "task", mode: "review" }), ["acp"]);
  assert.deepEqual(probe.calls.map((call) => call.executable), ["cursor-agent", "cursor-agent"]);
});

test("Cursor discovery does not fall back to cursor or agent", () => {
  const probe = new FixtureCursorProbe({
    "cursor --version": { status: 0, stdout: "unrelated cursor\n" },
    "cursor acp --help": { status: 0, stdout: "acp\n" },
    "agent --version": { status: 0, stdout: "blocked agent\n" },
    "agent acp --help": { status: 0, stdout: "acp\n" },
  });
  const provider = new CursorProvider(probe);
  assert.equal(provider.discover().available, false);
  assert.deepEqual(probe.calls, [{ executable: "cursor-agent", args: ["--version"] }]);
});

test("Cursor discovery reports cursor-agent clearly when its ACP entry is unusable", () => {
  const provider = new CursorProvider(new FixtureCursorProbe({}));
  const discovery = provider.discover();
  assert.equal(discovery.available, false);
  assert.match(discovery.note ?? "", /cursor-agent was not found/);
  assert.throws(
    () => provider.command({ cwd: "/project", prompt: "task", mode: "review" }),
    /intentionally does not fall back/,
  );
});

test("Cursor authentication accepts methodId and never authenticates terminal methods", () => {
  const provider = new CursorProvider(new FixtureCursorProbe({}));
  assert.deepEqual(
    provider.authenticationMethod({ authMethods: [{ methodId: "cursor_login" }] }),
    { methodId: "cursor_login", type: undefined },
  );
  assert.deepEqual(
    provider.authenticationMethod({ authMethods: [{ id: "cursor_login", type: "terminal" }] }),
    { methodId: "cursor_login", type: "terminal" },
  );
});

test("Cursor ACP inherits the launcher environment by default", () => {
  class InspectableCursorProvider extends CursorProvider {
    inspectEnvironment(): NodeJS.ProcessEnv {
      return this.environment();
    }
  }
  const priorMode = process.env.EXTERNAL_ACP_ENV_MODE;
  const priorMarker = process.env.CURSOR_SESSION_MARKER;
  process.env.CURSOR_SESSION_MARKER = "available-to-cursor";
  try {
    const provider = new InspectableCursorProvider(new FixtureCursorProbe({}));
    assert.equal(provider.inspectEnvironment().CURSOR_SESSION_MARKER, "available-to-cursor");
    process.env.EXTERNAL_ACP_ENV_MODE = "allowlist";
    assert.equal(provider.inspectEnvironment().CURSOR_SESSION_MARKER, undefined);
  } finally {
    if (priorMode === undefined) delete process.env.EXTERNAL_ACP_ENV_MODE;
    else process.env.EXTERNAL_ACP_ENV_MODE = priorMode;
    if (priorMarker === undefined) delete process.env.CURSOR_SESSION_MARKER;
    else process.env.CURSOR_SESSION_MARKER = priorMarker;
  }
});

test("provider environment is allowlisted and does not inherit unrelated secrets", () => {
  const previous = process.env.UNRELATED_TEST_SECRET;
  process.env.UNRELATED_TEST_SECRET = "do-not-forward";
  try {
    assert.equal(baseEnvironment().UNRELATED_TEST_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.UNRELATED_TEST_SECRET;
    else process.env.UNRELATED_TEST_SECRET = previous;
  }
});

class MockProvider extends AcpProvider {
  readonly name: ProviderName = "grok";
  readonly executable = "mock-grok";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };
  readonly transport = new FakeTransport();
  private permissionRequested = false;
  private readonly completeBeforePermission: boolean;
  private readonly withoutModes: boolean;
  private readonly rejectedMethod?: string;
  private readonly rejectionMessage?: string;
  private readonly sessionFirstFails: boolean;
  private readonly authenticationInvalidParams: boolean;
  private readonly authMethods: unknown[];
  private readonly stderrOnRejected?: string;
  private sessionAttempts = 0;

  constructor(options: {
    completeBeforePermission?: boolean;
    withoutModes?: boolean;
    rejectedMethod?: string;
    rejectionMessage?: string;
    sessionFirstFails?: boolean;
    authenticationInvalidParams?: boolean;
    authMethods?: unknown[];
    stderrOnRejected?: string;
  } = {}) {
    super();
    this.completeBeforePermission = options.completeBeforePermission ?? false;
    this.withoutModes = options.withoutModes ?? false;
    this.rejectedMethod = options.rejectedMethod;
    this.rejectionMessage = options.rejectionMessage;
    this.sessionFirstFails = options.sessionFirstFails ?? false;
    this.authenticationInvalidParams = options.authenticationInvalidParams ?? false;
    this.authMethods = options.authMethods ?? [{ id: "cached_token" }];
    this.stderrOnRejected = options.stderrOnRejected;
  }

  command(_options: StartOptions): string[] {
    return ["agent", "stdio"];
  }
  authenticationMethod(initialized: Record<string, unknown>) {
    return Array.isArray(initialized.authMethods)
      && initialized.authMethods.some((method) => (
        typeof method === "object" && method !== null && (method as { id?: string }).id === "cached_token"
      ))
      ? { methodId: "cached_token" }
      : undefined;
  }
  createTransport(): LineTransport {
    const originalWrite = this.transport.write.bind(this.transport);
    this.transport.write = (line) => {
      originalWrite(line);
      const message = JSON.parse(line);
      if (!message.method) {
        if (message.id === 90 && !this.permissionRequested) {
          this.permissionRequested = true;
          this.transport.emit({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
        }
        return;
      }
      const results: Record<string, unknown> = {
        initialize: { authMethods: this.authMethods },
        authenticate: {},
        "session/new": this.withoutModes ? { sessionId: "mock-session" } : {
          sessionId: "mock-session",
          configOptions: [{
            id: "mode",
            category: "mode",
            options: [{ value: "plan" }],
          }],
        },
        "session/set_config_option": {},
      };
      if (message.method === this.rejectedMethod) {
        if (this.stderrOnRejected) this.transport.emitStderr(this.stderrOnRejected);
        this.transport.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: this.rejectionMessage } });
        return;
      }
      if (message.method === "session/new" && this.sessionFirstFails && this.sessionAttempts++ === 0) {
        this.transport.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "authentication required" } });
        return;
      }
      if (message.method === "authenticate" && this.authenticationInvalidParams) {
        this.transport.emit({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Invalid params" } });
        return;
      }
      if (message.method === "session/prompt") {
        this.transport.emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "mocked answer" } } } });
        this.transport.emit({ jsonrpc: "2.0", id: 90, method: "session/request_permission", params: {} });
        if (this.completeBeforePermission) {
          this.transport.emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        }
        return;
      }
      this.transport.emit({ jsonrpc: "2.0", id: message.id, result: results[message.method] ?? {} });
    };
    return this.transport;
  }
}

test("controller leaves permission pending and safely cancels without auto-approval", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const file = join(workspace, "runs.json");
  const provider = new MockProvider();
  const controller = new RunController(new RunStore(file), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "do not persist this", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const waiting = controller.status(run.id);
  assert.equal(waiting.status, "waiting_permission");
  assert.deepEqual(waiting.pendingRequests, ["rpc-90"]);
  assert.throws(
    () => controller.resume({ runId: run.id, followUp: "continue" }),
    /Only a completed/,
  );

  assert.equal(
    provider.transport.writes.some((line) => JSON.parse(line).id === 90 && !JSON.parse(line).method),
    false,
  );
  const cancelled = await controller.cancel(run.id);
  assert.equal(cancelled.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.result(run.id).status, "cancelled");
});

test("controller skips authenticate when no agent auth method is selected", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider({ authMethods: [] });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "review", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.status(run.id).status, "waiting_permission");
  assert.equal(provider.transport.writes.some((line) => JSON.parse(line).method === "authenticate"), false);
  await controller.cancel(run.id);
});

test("controller does not authenticate terminal auth methods", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  class TerminalAuthProvider extends MockProvider {
    authenticationMethod() {
      return { methodId: "open_browser", type: "terminal" };
    }
  }
  const provider = new TerminalAuthProvider();
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "review", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.status(run.id).status, "waiting_permission");
  assert.equal(provider.transport.writes.some((line) => JSON.parse(line).method === "authenticate"), false);
  await controller.cancel(run.id);
});

test("pre-authenticated Cursor fallback retries session after authenticate invalid params", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  class PreauthenticatedCursorProvider extends MockProvider {
    prefersSessionBeforeAuthentication(): boolean {
      return true;
    }
    allowsPreauthenticatedSessionFallback(): boolean {
      return true;
    }
    authenticationMethod() {
      return { methodId: "cursor_login" };
    }
  }
  const provider = new PreauthenticatedCursorProvider({
    sessionFirstFails: true,
    authenticationInvalidParams: true,
  });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "review", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = controller.status(run.id);
  assert.equal(status.status, "waiting_permission");
  assert.equal(provider.transport.writes.filter((line) => JSON.parse(line).method === "session/new").length, 2);
  assert.equal(provider.transport.writes.filter((line) => JSON.parse(line).method === "authenticate").length, 1);
  await controller.cancel(run.id);
});

test("controller terminates a provider that completes while permission remains pending", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider({ completeBeforePermission: true });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "test", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(controller.status(run.id).status, "failed");
});

test("review proceeds with a provider default mode when mode metadata is absent", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider({ withoutModes: true });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "review only", mode: "review" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = controller.status(run.id);
  assert.equal(status.status, "waiting_permission");
  assert.ok((status.liveEvents as Array<{ type: string; label?: string }>).some((event) => (
    event.type === "activity" && event.label?.includes("not advertised")
  )));
  await controller.cancel(run.id);
});

test("failure status and result retain sanitized ACP stage diagnostics", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider({
    rejectedMethod: "session/new",
    rejectionMessage: "token=super-secret; prompt: sensitive request; /outside/private/path unavailable",
    stderrOnRejected: "cursor detail authorization=hidden-value /outside/keychain",
  });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "sensitive request", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = controller.status(run.id);
  const result = controller.result(run.id);
  assert.match(String(status.error), /ACP session\/new was rejected/);
  assert.match(String(result.error), /token=\[REDACTED\]/);
  assert.equal(String(result.error).includes("super-secret"), false);
  assert.equal(String(result.error).includes("sensitive request"), false);
  assert.equal(String(result.error).includes("/outside/private/path"), false);
  assert.match(String(result.error), /Provider stderr:/);
  assert.equal(String(result.error).includes("hidden-value"), false);
});

test("authenticate failures include only safe advertised auth method summaries", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider({
    rejectedMethod: "authenticate",
    rejectionMessage: "authorization=hidden-value",
  });
  const controller = new RunController(new RunStore(join(workspace, "runs.json")), new WorkspacePolicy(workspace), [provider]);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "review", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const error = String(controller.result(run.id).error);
  assert.match(error, /ACP authenticate was rejected/);
  assert.match(error, /Advertised auth methods: cached_token/);
  assert.equal(error.includes("hidden-value"), false);
});

test("controller terminates an ACP run that exceeds its configured lifetime", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-controller-"));
  const provider = new MockProvider();
  const controller = new RunController(
    new RunStore(join(workspace, "runs.json")),
    new WorkspacePolicy(workspace),
    [provider],
    false,
    5,
  );
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "test", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.status(run.id).status, "failed");
});
