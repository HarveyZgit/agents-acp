import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const catalogFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor-catalog.json");

test("MCP server fails closed for absent workspace configuration and malformed tool input", async () => {
  const home = mkdtempSync(join(tmpdir(), "external-acp-mcp-home-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOME: home, AGENTS_ACP_CONFIG: join(home, "absent.json") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output.push(...chunk.trim().split("\n").filter(Boolean)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  child.stdin.write("null\n");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "start",
    arguments: { provider: "grok", cwd: "/tmp", prompt: "test", mode: "review" },
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "start",
    arguments: ["not-an-object"],
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "status",
    arguments: { runId: "x", unexpected: true },
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: "respond_permission",
    arguments: { runId: "x", requestId: "rpc-1", optionId: "allow-once", userConfirmed: true },
  } })}\n`);
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("close", () => resolve());
    child.on("error", reject);
  });

  const responses = output.map((line) => JSON.parse(line));
  const configured = responses.find((response) => response.id === 1);
  const malformed = responses.find((response) => response.id === 2);
  const unexpected = responses.find((response) => response.id === 3);
  const disabledResponse = responses.find((response) => response.id === 4);
  assert.ok(configured, errors.join(""));
  assert.ok(malformed, errors.join(""));
  assert.equal(configured.result.isError, true);
  assert.match(configured.result.content[0].text, /No workspace is configured/);
  assert.equal(malformed.error.code, -32603);
  assert.equal(unexpected.result.isError, true);
  assert.match(unexpected.result.content[0].text, /Unexpected tool argument/);
  assert.equal(disabledResponse.result.isError, true);
  assert.match(disabledResponse.result.content[0].text, /Responses are disabled/);
});

test("MCP get_config and configure write centralized defaults, not project .agents-acp", async () => {
  const home = mkdtempSync(join(tmpdir(), "external-acp-setup-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-setup-ws-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      PATH: process.env.PATH,
      HOME: home,
      EXTERNAL_ACP_ENABLE_FAKE: "1",
      EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output.push(...chunk.trim().split("\n").filter(Boolean)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));

  const send = (id: number, name: string, args: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })}\n`);
  };

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
  send(1, "get_config", { suggestedWorkspace: workspace });
  send(5, "configure", {
    workspace,
    defaultProvider: "cursor",
    userConfirmed: false,
  });
  send(2, "configure", {
    workspace,
    defaultProvider: "cursor",
    defaultModel: "composer 2.5",
    defaultEffort: "high",
    defaultSpeed: "fast",
    enablePermissionResponses: true,
    userConfirmed: true,
  });
  send(3, "start", { provider: "fake", cwd: workspace, prompt: "task", mode: "review" });
  send(4, "start", { cwd: workspace, prompt: "task", mode: "review" });
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("close", () => resolve());
    child.on("error", reject);
  });

  const responses = output.map((line) => JSON.parse(line));
  const preview = responses.find((response) => response.id === 1);
  const saved = responses.find((response) => response.id === 2);
  const fakeStart = responses.find((response) => response.id === 3);
  const defaultStart = responses.find((response) => response.id === 4);
  const unconfirmed = responses.find((response) => response.id === 5);
  assert.ok(preview, errors.join(""));
  assert.ok(saved, errors.join(""));
  assert.ok(unconfirmed, errors.join(""));
  assert.equal(unconfirmed.result.isError, true);
  assert.match(unconfirmed.result.content[0].text, /userConfirmed/);
  const before = JSON.parse(preview.result.content[0].text);
  assert.equal(before.needsSetup, true);
  assert.equal(before.host, "codex");
  assert.equal(before.runtimeDir, join(home, ".codex", "agents-acp"));
  assert.equal(before.writesProjectRuntimeDir, false);
  assert.ok(Array.isArray(before.catalogs));
  assert.ok(before.setupQuestions.some((question: { id: string }) => question.id === "defaultProvider"));
  assert.ok(before.setupQuestions.some((question: { id: string }) => question.id === "defaultEffort"));
  assert.ok(before.setupQuestions.some((question: { id: string }) => question.id === "defaultSpeed"));

  const after = JSON.parse(saved.result.content[0].text);
  assert.equal(after.needsSetup, false);
  assert.equal(after.defaultProvider, "cursor");
  assert.equal(after.defaultModel, "composer-2.5");
  assert.equal(after.defaultEffort, "high");
  assert.equal(after.defaultSpeed, "fast");
  assert.equal(after.launchModel, "composer-2.5-high-fast");
  assert.equal(after.resolved?.catalogId, "composer-2.5");
  assert.equal(after.workspace, workspace);
  assert.equal(existsSync(join(workspace, ".agents-acp")), false);
  assert.ok(fakeStart);
  assert.ok(!fakeStart.result.isError, fakeStart.result.content[0].text);
  assert.ok(defaultStart);
  assert.equal(/No default provider/i.test(defaultStart.result.content[0].text), false);
});
