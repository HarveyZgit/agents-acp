import path from "node:path";
import { realpathSync } from "node:fs";
import type { TaskMode } from "./acp/provider.ts";

export type PolicyRequest = {
  cwd: string;
  mode: TaskMode;
  allowImplement?: boolean;
};

export type PolicyDecision = {
  cwd: string;
  workspace: string;
  readOnly: boolean;
};

export class WorkspacePolicy {
  private readonly implementingWorkspaces = new Set<string>();
  private readonly workspace: string;
  private readonly allowedRoots: string[];

  constructor(workspace: string, authorizedSubtrees: string[] = []) {
    this.workspace = canonical(workspace);
    this.allowedRoots = [this.workspace, ...authorizedSubtrees.map(canonical)];
  }

  authorize(request: PolicyRequest): PolicyDecision {
    const cwd = canonical(request.cwd);
    const root = this.allowedRoots.find((candidate) => inside(candidate, cwd));
    if (!root) {
      throw new Error("cwd must be the configured active workspace or an explicitly authorized subtree.");
    }
    if (request.mode === "implement" && request.allowImplement !== true) {
      throw new Error("Implement mode requires explicit allowImplement: true.");
    }
    return { cwd, workspace: this.workspace, readOnly: request.mode !== "implement" };
  }

  acquire(decision: PolicyDecision, mode: TaskMode): void {
    if (mode !== "implement") return;
    if (this.implementingWorkspaces.has(decision.workspace)) {
      throw new Error("An implement run is already active for this workspace.");
    }
    this.implementingWorkspaces.add(decision.workspace);
  }

  release(workspace: string, mode: TaskMode): void {
    if (mode === "implement") this.implementingWorkspaces.delete(workspace);
  }
}

function canonical(value: string): string {
  if (!value || value.includes("\0")) throw new Error("cwd must be a non-empty filesystem path.");
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    // A missing cwd will be rejected by process spawn. Keep the resolved value
    // here so policy failures remain deterministic before launch.
    return resolved;
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
