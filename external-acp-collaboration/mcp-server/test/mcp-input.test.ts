import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("MCP server fails closed for absent workspace configuration and malformed tool input", async () => {
  const home = mkdtempSync(join(tmpdir(), "external-acp-mcp-home-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOME: home },
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
    name: "start_external_agent",
    arguments: { provider: "grok", cwd: "/tmp", prompt: "test", mode: "review" },
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "start_external_agent",
    arguments: ["not-an-object"],
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
    name: "get_external_agent_status",
    arguments: { runId: "x", unexpected: true },
  } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
    name: "respond_external_agent_permission",
    arguments: { runId: "x", requestId: "rpc-1", decision: "allow-once", userConfirmed: true },
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
  assert.match(configured.result.content[0].text, /EXTERNAL_ACP_WORKSPACE/);
  assert.equal(malformed.error.code, -32603);
  assert.equal(unexpected.result.isError, true);
  assert.match(unexpected.result.content[0].text, /Unexpected tool argument/);
  assert.equal(disabledResponse.result.isError, true);
  assert.match(disabledResponse.result.content[0].text, /ENABLE_PERMISSION_RESPONSES/);
});
