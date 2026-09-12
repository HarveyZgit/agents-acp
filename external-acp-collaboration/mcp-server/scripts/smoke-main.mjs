import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = mkdtempSync(join(tmpdir(), "external-acp-smoke-workspace-"));
const dataHome = mkdtempSync(join(tmpdir(), "external-acp-smoke-home-"));
const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
  cwd: serverRoot,
  env: {
    PATH: process.env.PATH,
    HOME: dataHome,
    EXTERNAL_ACP_WORKSPACE: workspace,
    EXTERNAL_ACP_ENABLE_FAKE: "1",
    EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
const output = [];
const errors = [];
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const deferred = pending.get(message.id);
  if (deferred) {
    pending.delete(message.id);
    message.error ? deferred.reject(new Error(message.error.message)) : deferred.resolve(message.result);
  } else {
    output.push(message);
  }
});
child.stderr.on("data", (chunk) => errors.push(String(chunk)));

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  assert.equal(result.isError, undefined, `${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

async function waitFor(runId, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const status = await call("status", { runId });
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} did not reach ${expected}. stderr: ${errors.join("")}`);
}

try {
  await request("initialize", {});
  const tools = await request("tools/list", {});
  assert.ok(tools.tools.some((tool) => tool.name === "respond_permission"));

  const providers = await call("list_providers", {});
  assert.ok(providers.some((provider) => provider.provider === "fake" && provider.available));

  const first = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Exercise the deterministic ACP smoke flow.",
    mode: "plan",
  });
  const waiting = await waitFor(first.id, "waiting_permission");
  assert.ok(waiting.liveEvents.some((event) => event.type === "text"));
  assert.ok(waiting.liveEvents.some((event) => event.type === "activity"));
  assert.ok(waiting.liveEvents.some((event) => event.type === "file_change"));
  assert.deepEqual(waiting.pendingRequests, ["rpc-900"]);

  await call("respond_permission", {
    runId: first.id,
    requestId: "rpc-900",
    decision: "allow-once",
    userConfirmed: true,
  });
  await waitFor(first.id, "completed");
  const completed = await call("result", { runId: first.id });
  assert.match(completed.summary, /Fake ACP/);
  assert.deepEqual(completed.changedFiles, [{ path: "fake-output.txt", kind: "modify" }]);

  const resumed = await call("resume", {
    runId: first.id,
    followUp: "Resume the fake session.",
  });
  const resumedWaiting = await waitFor(resumed.id, "waiting_permission");
  await call("respond_permission", {
    runId: resumed.id,
    requestId: resumedWaiting.pendingRequests[0],
    decision: "reject-once",
    userConfirmed: true,
  });
  await waitFor(resumed.id, "completed");

  const cancellable = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Start a cancellable fake run.",
    mode: "review",
  });
  await waitFor(cancellable.id, "waiting_permission");
  const cancelled = await call("cancel", { runId: cancellable.id });
  assert.equal(cancelled.status, "cancelled");

  console.log("PASS: bundled fake ACP main flow completed (start, permission, response, result, resume, cancel).");
} finally {
  lines.close();
  child.kill();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataHome, { recursive: true, force: true });
}
