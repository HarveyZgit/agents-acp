import path from "node:path";
import { realpathSync, statSync } from "node:fs";
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
  private readonly allowUnsandboxedImplement: boolean;

  constructor(workspace: string, authorizedSubtrees: string[] = [], allowUnsandboxedImplement = false) {
    this.workspace = canonical(workspace);
    this.allowedRoots = [this.workspace, ...authorizedSubtrees.map(canonical)];
    this.allowUnsandboxedImplement = allowUnsandboxedImplement;
    if (this.allowedRoots.some((root) => !inside(this.workspace, root))) {
      throw new Error("Each authorized subtree must be inside the configured active workspace.");
    }
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
    if (request.mode === "implement" && !this.allowUnsandboxedImplement) {
      throw new Error('Implement mode is disabled until "allowUnsandboxedImplement": true is set in the agents-acp config file or EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT=1 is forwarded.');
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
    const real = realpathSync(resolved);
    if (!statSync(real).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new Error("cwd must be an existing accessible directory.");
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
