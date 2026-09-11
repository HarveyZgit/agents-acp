import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkspacePolicy } from "../src/policy.ts";

test("review and plan are parallel while implement is opt-in and serialized", () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-policy-"));
  const packages = join(workspace, "packages");
  const app = join(packages, "app");
  mkdirSync(app, { recursive: true });
  const policy = new WorkspacePolicy(workspace, [packages], true);
  const review = policy.authorize({ cwd: app, mode: "plan" });
  policy.acquire(review, "plan");
  policy.acquire(review, "plan");

  assert.throws(
    () => policy.authorize({ cwd: workspace, mode: "implement" }),
    /allowImplement/,
  );

  const implement = policy.authorize({ cwd: workspace, mode: "implement", allowImplement: true });
  policy.acquire(implement, "implement");
  assert.throws(() => policy.acquire(implement, "implement"), /already active/);
  policy.release(implement.workspace, "implement");
  policy.acquire(implement, "implement");
});

test("policy refuses cwd outside configured workspace roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-policy-"));
  const outside = mkdtempSync(join(tmpdir(), "external-acp-outside-"));
  const policy = new WorkspacePolicy(workspace);
  assert.throws(
    () => policy.authorize({ cwd: outside, mode: "review" }),
    /configured active workspace/,
  );
});

test("policy rejects symlink escapes and authorized roots outside the workspace", () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-policy-"));
  const outside = mkdtempSync(join(tmpdir(), "external-acp-outside-"));
  const escaped = join(workspace, "escaped");
  symlinkSync(outside, escaped);

  const policy = new WorkspacePolicy(workspace);
  assert.throws(
    () => policy.authorize({ cwd: escaped, mode: "review" }),
    /configured active workspace/,
  );
  assert.throws(
    () => new WorkspacePolicy(workspace, [outside]),
    /authorized subtree must be inside/,
  );
});

test("implement stays disabled without both explicit opt-ins", () => {
  const workspace = mkdtempSync(join(tmpdir(), "external-acp-policy-"));
  const policy = new WorkspacePolicy(workspace);
  assert.throws(
    () => policy.authorize({ cwd: workspace, mode: "implement", allowImplement: true }),
    /ALLOW_UNSANDBOXED_IMPLEMENT/,
  );
});
