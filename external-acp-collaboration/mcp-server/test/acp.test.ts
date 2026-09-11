import assert from "node:assert/strict";
import test from "node:test";
import {
  AcpProvider,
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

test("controller handles mocked ACP lifecycle and waits for explicit permission response", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "external-acp-controller-")), "runs.json");
  const controller = new RunController(new RunStore(file), new WorkspacePolicy("/project"), [new MockProvider()]);
  const run = controller.start({ provider: "grok", cwd: "/project", prompt: "do not persist this", mode: "plan" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const waiting = controller.status(run.id);
  assert.equal(waiting.status, "waiting_permission");
  assert.deepEqual(waiting.pendingRequests, ["rpc-90"]);

  controller.respond(run.id, "rpc-90", { outcome: { outcome: "selected", optionId: "reject-once" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = controller.result(run.id);
  assert.equal(result.status, "completed");
  assert.equal(result.summary, "mocked answer");
});
