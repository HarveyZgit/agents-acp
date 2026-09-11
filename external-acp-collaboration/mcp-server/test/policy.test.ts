import assert from "node:assert/strict";
import test from "node:test";
import { WorkspacePolicy } from "../src/policy.ts";

test("review and plan are parallel while implement is opt-in and serialized", () => {
  const policy = new WorkspacePolicy("/workspace/project", ["/workspace/project/packages"]);
  const review = policy.authorize({ cwd: "/workspace/project/packages/app", mode: "plan" });
  policy.acquire(review, "plan");
  policy.acquire(review, "plan");

  assert.throws(
    () => policy.authorize({ cwd: "/workspace/project", mode: "implement" }),
    /allowImplement/,
  );

  const implement = policy.authorize({ cwd: "/workspace/project", mode: "implement", allowImplement: true });
  policy.acquire(implement, "implement");
  assert.throws(() => policy.acquire(implement, "implement"), /already active/);
  policy.release(implement.workspace, "implement");
  policy.acquire(implement, "implement");
});

test("policy refuses cwd outside configured workspace roots", () => {
  const policy = new WorkspacePolicy("/workspace/project");
  assert.throws(
    () => policy.authorize({ cwd: "/workspace/other", mode: "review" }),
    /configured active workspace/,
  );
});
