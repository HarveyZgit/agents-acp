import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspace = mkdtempSync(join(tmpdir(), "agents-acp-smoke-workspace-"));
const dataHome = mkdtempSync(join(tmpdir(), "agents-acp-smoke-home-"));
const configPath = join(dataHome, "config.json");

// The config file is the primary configuration surface, exactly as an
// installed plugin would use it when Codex forwards no environment variables.
writeFileSync(configPath, JSON.stringify({
  workspace,
  enablePermissionResponses: true,
  enableFake: true,
  storePath: join(dataHome, "runs.json"),
}));

const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
  cwd: serverRoot,
  env: { PATH: process.env.PATH, HOME: dataHome, AGENTS_ACP_CONFIG: configPath },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
let nextId = 1;
const errors = [];
const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  const deferred = pending.get(message.id);
  if (!deferred) return;
  pending.delete(message.id);
  message.error ? deferred.reject(new Error(message.error.message)) : deferred.resolve(message.result);
});
child.stderr.on("data", (chunk) => errors.push(String(chunk)));

function request(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function call(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  assert.equal(result.isError, undefined, `${name} failed: ${result.content?.[0]?.text} ${errors.join("")}`);
  return JSON.parse(result.content[0].text);
}

async function callExpectingError(name, args) {
  const result = await request("tools/call", { name, arguments: args });
  assert.equal(result.isError, true, `${name} unexpectedly succeeded`);
  return JSON.parse(result.content[0].text).error;
}

async function waitFor(runId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await call("status", { runId });
    if (status.status === expected) return status;
    if (["failed", "completed", "cancelled"].includes(status.status) && status.status !== expected) {
      throw new Error(`Run ${runId} reached ${status.status} instead of ${expected}: ${status.error ?? ""}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} did not reach ${expected}. stderr: ${errors.join("")}`);
}

try {
  await request("initialize", {});
  const tools = await request("tools/list", {});
  const toolNames = tools.tools.map((tool) => tool.name);
  for (const expected of ["list_providers", "get_config", "configure", "start", "status", "cancel", "resume", "result", "respond_permission"]) {
    assert.ok(toolNames.includes(expected), `missing tool ${expected}`);
  }

  const snapshot = await call("get_config", { suggestedWorkspace: workspace });
  assert.equal(snapshot.runtimeDir, dataHome);
  assert.equal(snapshot.configPath, configPath);
  assert.equal(snapshot.writesProjectRuntimeDir, false);
  assert.equal(snapshot.workspace, workspace);

  const discovery = await call("list_providers", {});
  assert.equal(discovery.configLoaded, true);
  assert.ok(discovery.providers.some((provider) => provider.provider === "fake" && provider.available));
  assert.ok(discovery.providers.every((provider) => provider.launch?.spawn === "direct"));
  assert.ok(snapshot.setupQuestions.some((question) => question.id === "confirmedLaunch"));

  // Read-only review must negotiate a read-only ACP mode, not the default agent mode.
  const first = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Exercise the deterministic ACP smoke flow.",
    mode: "review",
  });
  const waiting = await waitFor(first.id, "waiting_permission");
  assert.ok(waiting.liveEvents.some((event) => event.type === "text"));
  assert.ok(waiting.liveEvents.some((event) => event.type === "activity" && /selected ask/.test(event.label ?? "")));
  assert.ok(waiting.liveEvents.some((event) => event.type === "file_change" && event.path === "fake-output.txt"));
  assert.equal(waiting.pendingRequests.length, 1);
  const [permission] = waiting.pendingRequests;
  assert.equal(permission.kind, "permission");
  assert.deepEqual(permission.options.map((option) => option.optionId), ["allow-once", "reject-once"]);

  const rejected = await callExpectingError("respond_permission", {
    runId: first.id,
    requestId: permission.requestId,
    optionId: "not-offered",
    userConfirmed: true,
  });
  assert.match(rejected, /must be one of the offered options/);

  await call("respond_permission", {
    runId: first.id,
    requestId: permission.requestId,
    optionId: "allow-once",
    userConfirmed: true,
  });
  await waitFor(first.id, "completed");
  const completed = await call("result", { runId: first.id });
  assert.equal(completed.stopReason, "end_turn");
  assert.match(completed.summary, /Fake ACP/);
  assert.deepEqual(completed.changedFiles, [{ path: "fake-output.txt", kind: "modify" }]);

  // Resume uses session/load, which may return a null result.
  const resumed = await call("resume", { runId: first.id, followUp: "Resume the fake session." });
  const resumedWaiting = await waitFor(resumed.id, "waiting_permission");
  await call("respond_permission", {
    runId: resumed.id,
    requestId: resumedWaiting.pendingRequests[0].requestId,
    optionId: "reject-once",
    userConfirmed: true,
  });
  await waitFor(resumed.id, "completed");

  const cancellable = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Start a cancellable fake run.",
    mode: "plan",
  });
  await waitFor(cancellable.id, "waiting_permission");
  const cancelled = await call("cancel", { runId: cancellable.id });
  assert.equal(cancelled.status, "cancelled");

  // A leftover lock from a dead writer must be reclaimed, not fatal.
  writeFileSync(`${join(dataHome, "runs.json")}.lock`, "2147483646", { mode: 0o600 });
  const contended = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Run while the store lock is contended.",
    mode: "plan",
  });
  const contendedWaiting = await waitFor(contended.id, "waiting_permission");
  await call("respond_permission", {
    runId: contended.id,
    requestId: contendedWaiting.pendingRequests[0].requestId,
    optionId: "allow-once",
    userConfirmed: true,
  });
  await waitFor(contended.id, "completed");

  // Implement must stay blocked without the explicit local opt-in.
  const blocked = await callExpectingError("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Attempt a write run.",
    mode: "implement",
    allowImplement: true,
  });
  assert.match(blocked, /allowUnsandboxedImplement/);

  // A live provider must not be orphaned when the transport closes.
  const orphan = await call("start", {
    provider: "fake",
    cwd: workspace,
    prompt: "Start a run that outlives the client.",
    mode: "plan",
  });
  await waitFor(orphan.id, "waiting_permission");
  const providerPids = childPids(child.pid);
  assert.ok(providerPids.length > 0, "expected a live provider child process");

  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const survivors = providerPids.filter(isAlive);
  assert.deepEqual(survivors, [], `provider processes were orphaned: ${survivors.join(", ")}`);

  console.log("PASS: agents-acp main flow (providers, review mode negotiation, streaming, permission options, result, resume, cancel, store contention, implement gate, orphan cleanup).");
} finally {
  lines.close();
  child.kill();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(dataHome, { recursive: true, force: true });
}

function childPids(parentPid) {
  const result = spawnSync("pgrep", ["-P", String(parentPid)], { encoding: "utf8" });
  return (result.stdout ?? "").split("\n").map((line) => Number(line.trim())).filter(Number.isInteger).filter(Boolean);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
