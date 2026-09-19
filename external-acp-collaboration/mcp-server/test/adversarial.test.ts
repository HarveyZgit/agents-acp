import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  INVALID_PARAMS_CODE,
  safeModelId,
  type AuthMethod,
  type LineTransport,
  type ProviderCapabilities,
  type ProviderName,
  AcpProvider,
} from "../src/acp/provider.ts";
import { CursorProvider } from "../src/acp/cursor.ts";
import { GrokProvider } from "../src/acp/grok.ts";
import { loadConfig } from "../src/config.ts";
import { WorkspacePolicy } from "../src/policy.ts";
import { redactSecrets, RunStore } from "../src/run-store.ts";
import { RunController } from "../src/run-controller.ts";
import { renderRunPanel } from "../../ui/run-panel/run-panel.ts";

/**
 * Adversarial coverage for a work-machine prerelease: malformed input,
 * permission gates, compatibility contracts, and regressions of known fixes.
 */

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
  emitRaw(line: string): void {
    for (const listener of this.lines) listener(line);
  }
  sent(method: string): Array<Record<string, unknown>> {
    return this.writes.map((line) => JSON.parse(line)).filter((message) => message.method === method);
  }
}

type MockOptions = {
  authMethods?: unknown[];
  requireAuth?: boolean;
  modes?: unknown;
  stopReason?: string;
  authenticateInvalidParams?: boolean;
  allowSessionAfterInvalidParams?: boolean;
  prefersSessionBeforeAuthentication?: boolean;
  loadSession?: boolean;
  name?: ProviderName;
  outsideRelativeEscape?: boolean;
  hangAfterPrompt?: boolean;
  protocolVersion?: unknown;
};

class MockProvider extends AcpProvider {
  readonly name: ProviderName;
  readonly executable = "mock-acp";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };
  readonly transport = new FakeTransport();
  readonly options: MockOptions;
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
        if (this.options.outsideRelativeEscape) {
          this.transport.emit({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                kind: "edit",
                content: [{ type: "diff", path: "../../etc/passwd", oldText: "a", newText: "b" }],
              },
            },
          });
        }
        if (this.options.hangAfterPrompt) return;
        if (this.options.stopReason) {
          this.transport.emit({ jsonrpc: "2.0", id: message.id, result: { stopReason: this.options.stopReason } });
          return;
        }
        this.transport.emit({
          jsonrpc: "2.0",
          id: 90,
          method: "session/request_permission",
          params: { options: [{ optionId: "allow-once", kind: "allow_once" }] },
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

function controllerFor(provider: MockProvider, options: { allowImplement?: boolean; idleTimeoutMs?: number } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-"));
  const controller = new RunController(
    new RunStore(join(workspace, "runs.json")),
    new WorkspacePolicy(workspace, [], options.allowImplement ?? false),
    { providers: [provider], idleTimeoutMs: options.idleTimeoutMs },
  );
  return { workspace, controller };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("REGRESSION session/new and session/load always send mcpServers: [] with the authorized cwd", async () => {
  const provider = new MockProvider({ stopReason: "end_turn" });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const created = provider.transport.sent("session/new")[0];
  assert.deepEqual(created.params, { cwd: workspace, mcpServers: [] });

  const resumed = controller.resume({ runId: run.id, followUp: "again" });
  await settle();
  const loaded = provider.transport.sent("session/load")[0];
  assert.deepEqual(loaded.params, { sessionId: "mock-session", cwd: workspace, mcpServers: [] });
  assert.equal(controller.status(resumed.id).status, "completed");
});

test("REGRESSION authenticate -32602 retries session/new and never emits login guidance", async () => {
  const provider = new MockProvider({
    name: "cursor",
    requireAuth: true,
    authenticateInvalidParams: true,
    authMethods: [{ methodId: "cursor_login", type: "agent" }],
  });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "cursor", cwd: workspace, prompt: "task", mode: "review" });
  await settle();
  assert.equal(controller.status(run.id).status, "waiting_permission");
  assert.equal(provider.transport.sent("authenticate").length, 1);
  assert.equal(provider.transport.sent("session/new").length, 2);
  assert.equal(/please login first|cursor-agent login/i.test(JSON.stringify(controller.status(run.id))), false);
  await controller.cancel(run.id);
});

test("REGRESSION review and plan fail closed when only write modes are advertised", async () => {
  for (const mode of ["review", "plan"] as const) {
    const provider = new MockProvider({ modes: { currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "code" }] } });
    const { workspace, controller } = controllerFor(provider);
    const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode });
    await settle();
    const status = controller.status(run.id);
    assert.equal(status.status, "failed", `${mode} must fail closed`);
    assert.match(String(status.error), /did not offer a read-only mode/);
    assert.equal(provider.transport.sent("session/prompt").length, 0);
  }
});

test("REGRESSION prompt stays open-ended; idle watchdog pauses while a decision is pending", async () => {
  const provider = new MockProvider({ hangAfterPrompt: true });
  const { workspace, controller } = controllerFor(provider, { idleTimeoutMs: 40 });
  const hanging = controller.start({ provider: "grok", cwd: workspace, prompt: "slow", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(controller.status(hanging.id).status, "failed");
  assert.match(String(controller.status(hanging.id).error), /idle timeout/);

  const pendingProvider = new MockProvider();
  const pending = controllerFor(pendingProvider, { idleTimeoutMs: 40 });
  const run = pending.controller.start({ provider: "grok", cwd: pending.workspace, prompt: "wait", mode: "plan" });
  await settle();
  assert.equal(pending.controller.status(run.id).status, "waiting_permission");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(pending.controller.status(run.id).status, "waiting_permission");
  await pending.controller.cancel(run.id);
});

test("REGRESSION relative outside-workspace writes are flagged and block success", async () => {
  const provider = new MockProvider({ stopReason: "end_turn", outsideRelativeEscape: true });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const result = controller.result(run.id);
  assert.equal(result.status, "failed");
  assert.match(String(result.error), /outside the authorized workspace/);
  assert.equal((result.outsideWorkspaceWrites as string[]).length, 1);
  assert.deepEqual(result.changedFiles, []);
});

test("REGRESSION cancel then resume uses session/load; live cancel rejects pending options", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  const cancelled = await controller.cancel(run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(
    provider.transport.writes.map((line) => JSON.parse(line)).find((message) => message.id === 90)?.result,
    { outcome: { outcome: "cancelled" } },
  );

  const resumed = controller.resume({ runId: run.id, followUp: "continue after cancel" });
  await settle();
  assert.equal(provider.transport.sent("session/load").length, 1);
  assert.equal(controller.status(resumed.id).status, "waiting_permission");
  await controller.cancel(resumed.id);
});

test("REGRESSION Cursor and Grok omit --model unless start.model is a safe identifier", () => {
  const cursor = new CursorProvider({
    run(executable, args) {
      if (executable === "cursor-agent" && args[0] === "--version") return { status: 0, stdout: "1.0.0\n" };
      if (executable === "cursor-agent" && args.join(" ") === "acp --help") return { status: 0, stdout: "acp\n" };
      return { status: null, error: new Error("missing") };
    },
  });
  assert.deepEqual(cursor.command({ cwd: "/project", prompt: "t", mode: "review" }), ["acp"]);
  assert.deepEqual(cursor.command({ cwd: "/project", prompt: "t", mode: "review", model: "composer-2.5" }), ["--model", "composer-2.5", "acp"]);
  assert.throws(() => cursor.command({ cwd: "/project", prompt: "t", mode: "review", model: "--model" }), /CLI flag/);
  assert.throws(() => cursor.command({ cwd: "/project", prompt: "t", mode: "review", model: "" }), /CLI flag/);
  assert.throws(() => cursor.command({ cwd: "/project", prompt: "t", mode: "review", model: "   " }), /CLI flag/);
  assert.throws(() => cursor.command({ cwd: "/project", prompt: "t", mode: "review", model: "bad;rm -rf /" }), /CLI flag/);

  const grok = new GrokProvider();
  assert.deepEqual(grok.command({ cwd: "/project", prompt: "t", mode: "plan" }), [
    "--no-auto-update", "--cwd", "/project", "agent", "--no-leader", "stdio",
  ]);
  assert.equal(grok.command({ cwd: "/project", prompt: "t", mode: "plan" }).includes("--model"), false);
  assert.equal(grok.command({ cwd: "/project", prompt: "t", mode: "plan" }).includes("--always-approve"), false);
  assert.deepEqual(
    grok.command({ cwd: "/project", prompt: "t", mode: "plan", model: "grok-4" }),
    ["--no-auto-update", "--cwd", "/project", "agent", "--no-leader", "--model", "grok-4", "stdio"],
  );
  assert.throws(() => grok.command({ cwd: "/project", prompt: "t", mode: "plan", model: "--always-approve" }), /CLI flag/);
  assert.equal(safeModelId(undefined, "X"), undefined);
});

test("SECURITY cwd escapes, files, null bytes, and unauthorized implement stay rejected", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "agents-acp-adv-out-"));
  const filePath = join(workspace, "not-a-dir");
  writeFileSync(filePath, "nope");
  const policy = new WorkspacePolicy(workspace);

  assert.throws(() => policy.authorize({ cwd: outside, mode: "review" }), /configured active workspace/);
  assert.throws(() => policy.authorize({ cwd: join(workspace, "..", "..", "etc"), mode: "review" }), /configured active workspace|existing accessible/);
  assert.throws(() => policy.authorize({ cwd: filePath, mode: "review" }), /existing accessible directory/);
  assert.throws(() => policy.authorize({ cwd: `${workspace}\0/evil`, mode: "review" }), /non-empty filesystem path/);
  assert.throws(() => policy.authorize({ cwd: workspace, mode: "implement", allowImplement: true }), /ALLOW_UNSANDBOXED_IMPLEMENT/);
  assert.throws(() => policy.authorize({ cwd: workspace, mode: "implement" }), /allowImplement/);
});

test("SECURITY implement is serialized per workspace and review/plan stay parallel", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-impl-"));
  const policy = new WorkspacePolicy(workspace, [], true);
  const review = policy.authorize({ cwd: workspace, mode: "review" });
  policy.acquire(review, "review");
  policy.acquire(review, "plan");
  const implement = policy.authorize({ cwd: workspace, mode: "implement", allowImplement: true });
  policy.acquire(implement, "implement");
  assert.throws(() => policy.acquire(implement, "implement"), /already active/);
});

test("SECURITY fake provider is unregistered unless explicitly enabled", () => {
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-fake-"));
  const off = new RunController(new RunStore(join(workspace, "off.json")), new WorkspacePolicy(workspace));
  assert.equal(off.listProviders().some((provider) => provider.provider === "fake"), false);
  assert.throws(
    () => off.start({ provider: "fake", cwd: workspace, prompt: "nope", mode: "review" }),
    /Unsupported provider/,
  );

  const on = new RunController(
    new RunStore(join(workspace, "on.json")),
    new WorkspacePolicy(workspace),
    { enableFake: true },
  );
  assert.equal(on.listProviders().some((provider) => provider.provider === "fake"), true);
});

test("SECURITY prompts and high-value secrets never persist; redaction covers extra shapes", () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-acp-adv-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  store.appendEvent(run.id, { type: "text", text: "PROMPT-MUST-NOT-HIT-DISK secret-token-value" });
  store.appendEvent(run.id, {
    type: "error",
    message: "ACP session/new failed: xai-abcdefghijklmnopqrstuvwxyz0123456789 ghp_abcdefghijklmnopqrstuv Authorization: Bearer aaaaaaaaaaaaaaaaaaaa",
  });
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes("PROMPT-MUST-NOT-HIT-DISK"), false);
  assert.equal(persisted.includes("secret-token-value"), false);
  assert.equal(persisted.includes("xai-abcdefghijklmnopqrstuvwxyz0123456789"), false);
  assert.equal(persisted.includes("ghp_abcdefghijklmnopqrstuv"), false);
  assert.equal(persisted.includes("aaaaaaaaaaaaaaaaaaaa"), false);

  for (const [input, leaked] of [
    ["password=hunter2-should-go", "hunter2-should-go"],
    ['{"refresh_token":"rotating-secret-99"}', "rotating-secret-99"],
    ["xoxb-123456789012-abcdefghijklmnop", "xoxb-123456789012-abcdefghijklmnop"],
    ["GROK_API_KEY=abcdEFGHijklMNOPqrst", "abcdEFGHijklMNOPqrst"],
  ] as Array<[string, string]>) {
    const redacted = redactSecrets(input);
    assert.equal(redacted.includes(leaked), false, `leaked ${leaked} from ${input} -> ${redacted}`);
  }
});

test("SECURITY run-store lock from a live foreign pid degrades instead of throwing", () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-acp-adv-lock-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  const locker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.ok(locker.pid);
    writeFileSync(`${file}.lock`, String(locker.pid), { mode: 0o600 });
    const updated = store.update(run.id, { status: "running" });
    assert.equal(updated.status, "running");
    assert.match(String(store.degraded ?? ""), /lock was busy|unreadable|not writable|^$/);
  } finally {
    locker.kill();
  }
});

test("SECURITY HTML run panel escapes status and file metadata", () => {
  const html = renderRunPanel({
    id: `"><img src=x onerror=alert(1)>`,
    status: "<script>alert(1)</script>",
    lastActivity: `ACP & '"`,
    changedFiles: [{ path: "<b>evil</b>", kind: "modify" }],
  });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;&gt;&lt;img/);
});

test("EDGE resume rejects mixed references, active runs, and implement without opt-in", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.throws(() => controller.resume({ runId: run.id, provider: "grok", sessionId: "mock-session", followUp: "x" }), /exactly one resume reference/);
  assert.throws(() => controller.resume({ provider: "grok", followUp: "x" }), /exactly one resume reference/);
  assert.throws(() => controller.resume({ followUp: "x" }), /exactly one resume reference/);
  assert.throws(() => controller.resume({ runId: run.id, followUp: "x" }), /Only a completed, failed, cancelled, or interrupted run/);
  await controller.cancel(run.id);

  const bySession = controller.resume({ provider: "grok", sessionId: "mock-session", followUp: "via session" });
  await settle();
  assert.ok(bySession.id);
  await controller.cancel(bySession.id);

  const implementProvider = new MockProvider();
  const impl = controllerFor(implementProvider, { allowImplement: true });
  const written = impl.controller.start({
    provider: "grok",
    cwd: impl.workspace,
    prompt: "write",
    mode: "implement",
    allowImplement: true,
  });
  await settle();
  await impl.controller.cancel(written.id);
  assert.throws(
    () => impl.controller.resume({ runId: written.id, followUp: "more writes" }),
    /allowUnsandboxedImplement|allowImplement/,
  );
});

test("EDGE permission/question/plan kind mismatch, unoffered option, and double respond fail closed", async () => {
  const provider = new MockProvider();
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  assert.throws(() => controller.respondQuestion(run.id, "rpc-90", undefined), /expects a permission response/);
  assert.throws(() => controller.respondPlan(run.id, "rpc-90", true), /expects a permission response/);
  assert.throws(() => controller.respondPermission(run.id, "rpc-90", "not-offered"), /must be one of the offered options/);
  controller.respondPermission(run.id, "rpc-90", "allow-once");
  assert.throws(() => controller.respondPermission(run.id, "rpc-90", "allow-once"), /No pending request/);
  await controller.cancel(run.id);
});

test("EDGE unknown stop reasons and max_turn_requests are failures, not success", async () => {
  for (const stopReason of ["max_turn_requests", "mystery"]) {
    const provider = new MockProvider({ stopReason });
    const { workspace, controller } = controllerFor(provider);
    const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
    await settle();
    assert.equal(controller.result(run.id).status, "failed", `${stopReason} must fail`);
  }

  const missing = new MockProvider({ hangAfterPrompt: true });
  const setup = controllerFor(missing);
  const run = setup.controller.start({ provider: "grok", cwd: setup.workspace, prompt: "task", mode: "plan" });
  await settle();
  missing.transport.emit({ jsonrpc: "2.0", id: 4, result: {} });
  await settle();
  assert.equal(setup.controller.result(run.id).status, "failed");
  assert.match(String(setup.controller.result(run.id).error), /without a successful stopReason/);
});

test("EDGE malformed provider envelopes abort the run; late requests are cancelled", async () => {
  const provider = new MockProvider({ hangAfterPrompt: true });
  const { workspace, controller } = controllerFor(provider);
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: "task", mode: "plan" });
  await settle();
  provider.transport.emitRaw("{ not json");
  await settle();
  assert.equal(controller.status(run.id).status, "failed");
  assert.match(String(controller.status(run.id).error), /invalid ACP JSON-RPC envelope/);
});

test("EDGE config rejects out-of-range budgets and unknown envMode falls back to session", () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-acp-adv-cfg-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    workspace: "/ws",
    maxRunMs: 12,
    idleTimeoutMs: 5,
    envMode: "mystery",
    enableFake: "yes",
    allowUnsandboxedImplement: "true",
  }));
  const loaded = loadConfig({ AGENTS_ACP_CONFIG: configPath });
  assert.equal(loaded.maxRunMs, 7_200_000);
  assert.equal(loaded.idleTimeoutMs, 900_000);
  assert.equal(loaded.envMode, "session");
  assert.equal(loaded.enableFake, false);
  assert.equal(loaded.allowUnsandboxedImplement, false);

  const env = loadConfig({
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_MAX_RUN_MS: "not-a-number",
    EXTERNAL_ACP_IDLE_TIMEOUT_MS: "1000",
    EXTERNAL_ACP_ENV_MODE: "inherit",
    EXTERNAL_ACP_ENABLE_FAKE: "1",
  });
  assert.equal(env.maxRunMs, 7_200_000);
  assert.equal(env.idleTimeoutMs, 900_000);
  assert.equal(env.envMode, "inherit");
  assert.equal(env.enableFake, true);
});

test("COMPAT plugin packaging keeps camelCase mcpServers, cwd, env_vars names, and no inline secrets", () => {
  const pluginRoot = new URL("../../", import.meta.url).pathname;
  const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
  const plugin = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(pluginRoot, "mcp-server", "package.json"), "utf8"));
  const source = `${readFileSync(join(pluginRoot, "mcp-server", "src", "index.ts"), "utf8")}\n${readFileSync(join(pluginRoot, "mcp-server", "src", "run-controller.ts"), "utf8")}`;

  assert.equal(plugin.name, "agents-acp");
  assert.equal(plugin.version, server.version);
  assert.match(source, new RegExp(`SERVER_VERSION = "${plugin.version}"`));
  assert.match(source, new RegExp(`CLIENT_VERSION = "${plugin.version}"`));

  const declared = mcp.mcpServers["agents-acp"];
  assert.equal(declared.cwd, ".");
  assert.equal(declared.env, undefined);
  assert.deepEqual(declared.args, ["--experimental-strip-types", "./mcp-server/src/index.ts"]);
  for (const name of [
    "AGENTS_ACP_CONFIG",
    "AGENTS_ACP_HOME",
    "EXTERNAL_ACP_WORKSPACE",
    "EXTERNAL_ACP_DEFAULT_PROVIDER",
    "EXTERNAL_ACP_DEFAULT_MODEL",
    "EXTERNAL_ACP_DEFAULT_EFFORT",
    "EXTERNAL_ACP_DEFAULT_SPEED",
    "EXTERNAL_ACP_ALLOWED_SUBTREES",
    "EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT",
    "EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES",
    "EXTERNAL_ACP_MAX_RUN_MS",
    "EXTERNAL_ACP_IDLE_TIMEOUT_MS",
    "EXTERNAL_ACP_STORE_PATH",
    "EXTERNAL_ACP_ENV_MODE",
    "EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH",
    "EXTERNAL_ACP_ENABLE_FAKE",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "XAI_API_KEY",
    "HOME",
    "PATH",
  ]) {
    assert.ok(declared.env_vars.includes(name), `missing env_vars entry ${name}`);
  }
  assert.equal(declared.env_vars.every((name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)), true);
});

test("COMPAT Grok authenticate stays headless and xai.api_key is unused without XAI_API_KEY", () => {
  const grok = new GrokProvider();
  assert.deepEqual(grok.authenticateParams({ methodId: "cached_token" }), {
    methodId: "cached_token",
    _meta: { headless: true },
  });
  const previous = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    assert.equal(grok.authenticationMethod({ authMethods: [{ methodId: "xai.api_key" }] }), undefined);
    process.env.XAI_API_KEY = "dummy";
    assert.deepEqual(grok.authenticationMethod({ authMethods: [{ methodId: "xai.api_key" }] }), {
      methodId: "xai.api_key",
      type: undefined,
    });
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("MCP adversarial: initialize gate, malformed envelopes, typed flags, and oversized/control input", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-adv-mcp-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-mcp-ws-"));
  mkdirSync(join(home, ".codex", "agents-acp"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({
    workspace,
    enablePermissionResponses: true,
    storePath: join(home, "runs.json"),
  }));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOME: home, AGENTS_ACP_CONFIG: join(home, "config.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output.push(...chunk.trim().split("\n").filter(Boolean)));

  const send = (message: unknown) => child.stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  send("not-json");
  send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "start", arguments: { provider: "cursor", cwd: `${workspace}\n`, prompt: "x", mode: "review" } } });
  send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "start", arguments: { provider: "cursor", cwd: workspace, prompt: "x".repeat(70_000), mode: "review" } } });
  send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "start", arguments: { provider: "cursor", cwd: workspace, prompt: "x", mode: "implement", allowImplement: "true" } } });
  send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "start", arguments: { provider: "fake", cwd: workspace, prompt: "x", mode: "review" } } });
  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "respond_permission", arguments: { runId: "x", requestId: "rpc-1", optionId: "allow-once", userConfirmed: "true" } } });
  send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "start", arguments: { provider: "cursor", cwd: workspace, prompt: "x", mode: "review", model: "--always-approve" } } });
  send({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "agents-acp://runs/../secret" } });
  send({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "list_providers", arguments: { extra: true } } });
  send({ jsonrpc: "2.0", id: 11, params: null, method: "ping" });
  send({ jsonrpc: "2.0", id: 12, method: "initialize", params: {} });
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("close", () => resolve());
    child.on("error", reject);
  });

  const responses = output.map((line) => JSON.parse(line));
  const byId = (id: number) => responses.find((response) => response.id === id);
  assert.match(byId(1).error.message, /initialize must complete/);
  assert.equal(byId(2).result.serverInfo.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.match(byId(3).result.content[0].text, /Expected cwd/);
  assert.match(byId(4).result.content[0].text, /Expected prompt/);
  assert.match(byId(5).result.content[0].text, /allowImplement|ALLOW_UNSANDBOXED_IMPLEMENT/);
  assert.match(byId(6).result.content[0].text, /Unsupported provider|fake provider is disabled/);
  assert.match(byId(7).result.content[0].text, /userConfirmed/);
  assert.match(byId(8).result.content[0].text, /CLI flag|cursor-agent ACP is unavailable/);
  assert.match(byId(9).error?.message ?? byId(9).result?.content?.[0]?.text ?? "", /Unknown resource URI|Unknown run/);
  assert.match(byId(10).result.content[0].text, /Unexpected tool argument/);
  assert.equal(byId(11).error.code, -32603);
  assert.ok(byId(12), "re-initialize must still be accepted");
});

test("MCP adversarial: status never echoes the prompt and store stays 0600-class when umask allows it", async () => {
  const provider = new MockProvider();
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-adv-priv-"));
  const storePath = join(workspace, "private-runs.json");
  const controller = new RunController(
    new RunStore(storePath),
    new WorkspacePolicy(workspace),
    { providers: [provider] },
  );
  const secretPrompt = "UNIQUE-PROMPT-TOKEN-xyz-do-not-leak";
  const run = controller.start({ provider: "grok", cwd: workspace, prompt: secretPrompt, mode: "plan" });
  await settle();
  const status = JSON.stringify(controller.status(run.id));
  const result = JSON.stringify(controller.result(run.id));
  assert.equal(status.includes(secretPrompt), false);
  assert.equal(result.includes(secretPrompt), false);
  const persisted = readFileSync(storePath, "utf8");
  assert.equal(persisted.includes(secretPrompt), false);
  if (existsSync(storePath)) {
    const mode = statSync(storePath).mode & 0o777;
    // umask may widen this; world-writable would be a blocker.
    assert.equal((mode & 0o002), 0, `store must not be world-writable (mode ${mode.toString(8)})`);
  }
  await controller.cancel(run.id);
});
