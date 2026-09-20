import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactSecrets, RunStore } from "../src/run-store.ts";

test("run store keeps Antigravity runs after a reload", () => {
  const file = join(mkdtempSync(join(tmpdir(), "external-acp-store-")), "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "antigravity", cwd: "/project", workspace: "/project", mode: "review" });
  store.update(run.id, { sessionId: "agy-session" });
  const restored = new RunStore(file).get(run.id);
  assert.equal(restored.provider, "antigravity");
  assert.equal(restored.sessionId, "agy-session");
});

test("run store persists lifecycle metadata but never streamed text", () => {
  const file = join(mkdtempSync(join(tmpdir(), "external-acp-store-")), "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "cursor", cwd: "/project", workspace: "/project", mode: "plan" });
  store.appendEvent(run.id, { type: "started", provider: "cursor", sessionId: "session-1" });
  store.appendEvent(run.id, { type: "text", text: "prompt secret must not be persisted" });
  store.appendEvent(run.id, { type: "file_change", path: "src/index.ts", kind: "modify" });

  const restored = new RunStore(file).get(run.id);
  assert.equal(restored.events.some((event) => event.type === "text"), false);
  assert.deepEqual(restored.changedFiles, [{ path: "src/index.ts", kind: "modify" }]);
  assert.equal(readFileSync(file, "utf8").includes("prompt secret"), false);
});

test("run store redacts event detail", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  store.appendEvent(run.id, { type: "activity", label: "token=super-secret", detail: "authorization=secret" });
  store.appendEvent(run.id, { type: "completed", summary: "secret output", exitCode: 0 });
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes("super-secret"), false);
  assert.equal(persisted.includes("secret output"), false);
});

test("run store survives a stale lock left behind by a dead writer", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });

  // A PID that cannot exist, as if a previous server was killed mid-write.
  writeFileSync(`${file}.lock`, "2147483646", { mode: 0o600 });
  const updated = store.update(run.id, { status: "running" });
  assert.equal(updated.status, "running");
  assert.equal(existsSync(`${file}.lock`), false);
});

test("run store survives a lock left behind by this live process", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });

  // A leftover lock naming a live PID must not wedge the server.
  writeFileSync(`${file}.lock`, String(process.pid), { mode: 0o600 });
  assert.doesNotThrow(() => store.appendEvent(run.id, { type: "activity", label: "ACP mode: selected ask." }));
  assert.equal(store.get(run.id).lastActivity, "ACP mode: selected ask.");
});

test("run store recovers from a corrupt file instead of throwing", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  writeFileSync(file, "{ not json", { mode: 0o600 });
  const store = new RunStore(file);
  assert.match(String(store.degraded), /corrupt/);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  assert.equal(store.get(run.id).status, "starting");
});

test("streamed text never locks or rewrites the store", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  const before = statSync(file).mtimeMs;

  // A live lock would block a real write; a text chunk must not attempt one.
  writeFileSync(`${file}.lock`, String(process.pid), { mode: 0o600 });
  store.appendEvent(run.id, { type: "text", text: "streamed chunk" });
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(existsSync(`${file}.lock`), true);
});

test("secret redaction covers headers, JSON credential fields, JWTs, and bare keys", () => {
  const cases: Array<[string, string]> = [
    ["Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1l", "YWxhZGRpbjpvcGVuc2VzYW1l"],
    ['{"access_token":"abc123def456"}', "abc123def456"],
    ["Cookie: session=abc123; other=def456", "abc123"],
    ["Set-Cookie: sid=zzz999; HttpOnly", "zzz999"],
    ["token eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeKKF2QT4", "eyJhbGciOi.eyJzdWIiOiI.SflKxwRJSMeKKF2QT4"],
    ["key sk-abcdefghijklmnop", "sk-abcdefghijklmnop"],
    ["CURSOR_AUTH_TOKEN=abcdefghijklmnop", "abcdefghijklmnop"],
    ["opaque AKIAIOSFODNN7EXAMPLEabcdefghijklmnopqrstuvwxyz0123", "AKIAIOSFODNN7EXAMPLEabcdefghijklmnopqrstuvwxyz0123"],
  ];
  for (const [input, secret] of cases) {
    const redacted = redactSecrets(input);
    assert.equal(redacted.includes(secret), false, `leaked from: ${input} -> ${redacted}`);
  }
});

test("diagnostics written to disk are redacted independently of the caller", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const file = join(directory, "runs.json");
  const store = new RunStore(file);
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  store.appendEvent(run.id, {
    type: "error",
    message: 'ACP session/new failed: {"access_token":"leaked-value-123"} Cookie: sid=leaked-cookie',
  });
  const persisted = readFileSync(file, "utf8");
  assert.equal(persisted.includes("leaked-value-123"), false);
  assert.equal(persisted.includes("leaked-cookie"), false);
  assert.match(store.get(run.id).error ?? "", /ACP session\/new failed/);
});

test("run store bounds persisted events and changed-file summaries", () => {
  const directory = mkdtempSync(join(tmpdir(), "external-acp-store-"));
  const store = new RunStore(join(directory, "runs.json"));
  const run = store.create({ provider: "grok", cwd: directory, workspace: directory, mode: "review" });
  for (let index = 0; index < 510; index += 1) {
    store.appendEvent(run.id, { type: "file_change", path: `file-${index}`, kind: "modify" });
  }
  const record = store.get(run.id);
  assert.equal(record.events.length, 500);
  assert.equal(record.changedFiles.length, 500);
});
