import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunStore } from "../src/run-store.ts";

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
