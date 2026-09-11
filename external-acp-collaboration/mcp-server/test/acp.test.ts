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
import { CursorProvider } from "../src/acp/cursor.ts";
import { GrokProvider } from "../src/acp/grok.ts";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

class FakeTransport implements LineTransport {
  writes: string[] = [];
  private lines: Array<(line: string) => void> = [];
  private exits: Array<(code: number | null) => void> = [];

  write(line: string): void {
    this.writes.push(line);
  }
  onLine(listener: (line: string) => void): void {
    this.lines.push(listener);
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
  assert.deepEqual(events, ["cursor/update_todos"]);
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

  command(_options: StartOptions): string[] {
    return ["agent", "stdio"];
  }
  authenticationMethod(): string | undefined {
    return "cached_token";
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
        initialize: { authMethods: [{ id: "cached_token" }] },
        authenticate: {},
        "session/new": { sessionId: "mock-session" },
      };
      if (message.method === "session/prompt") {
        this.transport.emit({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "mocked answer" } } } });
        this.transport.emit({ jsonrpc: "2.0", id: 90, method: "session/request_permission", params: {} });
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
  assert.equal(controller.result(run.id).status, "cancelled");
});
