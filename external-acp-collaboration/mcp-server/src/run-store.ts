import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderName, RunEvent, TaskMode } from "./acp/provider.ts";

export type RunStatus = "starting" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled" | "interrupted";
export type RunRecord = {
  id: string;
  provider: ProviderName;
  cwd: string;
  workspace: string;
  mode: TaskMode;
  ownerPid: number;
  status: RunStatus;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  lastActivity?: string;
  changedFiles: Array<{ path: string; kind: "create" | "modify" | "delete" }>;
  error?: string;
  completed?: { exitCode?: number; stopReason?: string };
  events: Array<Exclude<RunEvent, { type: "text" }>>;
};

type StoreData = { runs: RunRecord[] };

export class RunStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath = join(homedir(), ".codex", "external-acp-collaboration", "runs.json")) {
    this.filePath = filePath;
    this.data = this.load();
    this.reconcileInterruptedRuns();
  }

  create(input: Pick<RunRecord, "provider" | "cwd" | "workspace" | "mode">): RunRecord {
    return this.mutate(() => {
      markDeadOwnersInterrupted(this.data.runs);
      if (input.mode === "implement" && this.data.runs.some((run) => (
        run.workspace === input.workspace && run.mode === "implement" && isActive(run.status)
      ))) {
        throw new Error("An implement run is already active for this workspace.");
      }
      const now = new Date().toISOString();
      const record: RunRecord = {
        id: randomUUID(),
        ...input,
        ownerPid: process.pid,
        status: "starting",
        startedAt: now,
        updatedAt: now,
        changedFiles: [],
        events: [],
      };
      this.data.runs.push(record);
      pruneTerminalRuns(this.data.runs);
      return structuredClone(record);
    });
  }

  get(id: string): RunRecord {
    this.data = this.load();
    const record = this.data.runs.find((run) => run.id === id);
    if (!record) throw new Error(`Unknown run: ${id}`);
    return structuredClone(record);
  }

  findBySession(provider: ProviderName, sessionId: string): RunRecord | undefined {
    this.data = this.load();
    const record = this.data.runs.find((run) => run.provider === provider && run.sessionId === sessionId);
    return record && structuredClone(record);
  }

  update(id: string, update: Partial<Omit<RunRecord, "id" | "events" | "changedFiles">>): RunRecord {
    return this.mutate(() => {
      const record = this.require(id);
      Object.assign(record, update, { updatedAt: new Date().toISOString() });
      return structuredClone(record);
    });
  }

  appendEvent(id: string, event: RunEvent): RunRecord {
    return this.mutate(() => {
      const record = this.require(id);
      // Text can contain user-provided material echoed by a provider. Keep it
      // in the in-memory controller only; never persist it to the session file.
      if (event.type !== "text") {
        record.events.push(persistedEvent(event));
        if (record.events.length > 500) record.events.splice(0, record.events.length - 500);
      }
      if (event.type === "activity") record.lastActivity = "Agent reported progress";
      if (event.type === "file_change" && record.changedFiles.length < 500) {
        record.changedFiles.push({ path: event.path, kind: event.kind });
      }
      if (event.type === "error") record.error = storedDiagnostic(event.message);
      if (event.type === "completed") {
        record.status = "completed";
        record.completed = { exitCode: event.exitCode };
      }
      record.updatedAt = new Date().toISOString();
      return structuredClone(record);
    });
  }

  listActiveImplementRuns(workspace: string): RunRecord[] {
    this.data = this.load();
    this.reconcileInterruptedRuns();
    return this.data.runs
      .filter((run) => run.workspace === workspace && run.mode === "implement" && ["starting", "running", "waiting_permission"].includes(run.status))
      .map((run) => structuredClone(run));
  }

  private require(id: string): RunRecord {
    const record = this.data.runs.find((run) => run.id === id);
    if (!record) throw new Error(`Unknown run: ${id}`);
    return record;
  }

  private load(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreData;
      if (!Array.isArray(parsed.runs)) throw new Error("Invalid run store format.");
      return { runs: parsed.runs.filter(validRunRecord).map(sanitizeRunRecord) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { runs: [] };
    }
  }

  private mutate<T>(operation: () => T): T {
    const lock = this.acquireLock();
    try {
      this.data = this.load();
      const result = operation();
      this.saveUnlocked();
      return result;
    } finally {
      closeSync(lock);
      unlinkSync(`${this.filePath}.lock`);
    }
  }

  private saveUnlocked(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  private acquireLock(): number {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        writeFileSync(descriptor, String(process.pid));
        return descriptor;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 1) {
          throw new Error("Run store is busy; retry the request.");
        }
        const owner = Number(readFileSync(lockPath, "utf8"));
        if (!Number.isInteger(owner) || !isProcessAlive(owner)) unlinkSync(lockPath);
      }
    }
    throw new Error("Run store is busy; retry the request.");
  }

  private reconcileInterruptedRuns(): void {
    if (!this.data.runs.some((run) => isActive(run.status) && run.ownerPid !== process.pid && !isProcessAlive(run.ownerPid))) return;
    this.mutate(() => {
      markDeadOwnersInterrupted(this.data.runs);
    });
  }
}

function validRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false;
  const run = value as Partial<RunRecord>;
  return typeof run.id === "string"
    && (run.provider === "cursor" || run.provider === "grok" || run.provider === "fake")
    && typeof run.cwd === "string"
    && typeof run.workspace === "string"
    && (run.mode === "review" || run.mode === "plan" || run.mode === "implement")
    && typeof run.ownerPid === "number"
    && typeof run.status === "string"
    && Array.isArray(run.changedFiles)
    && Array.isArray(run.events);
}

function sanitizeRunRecord(record: RunRecord): RunRecord {
  return {
    ...record,
    changedFiles: record.changedFiles
      .filter((file) => file && typeof file.path === "string" && ["create", "modify", "delete"].includes(file.kind))
      .map((file) => ({ path: file.path.slice(0, 4_096), kind: file.kind })),
    events: record.events
      .filter((event) => event && typeof event === "object" && event.type !== "text")
      .map((event) => persistedEvent(event)),
    error: record.error ? storedDiagnostic(record.error) : undefined,
  };
}

function persistedEvent(event: Exclude<RunEvent, { type: "text" }>): Exclude<RunEvent, { type: "text" }> {
  switch (event.type) {
    case "started":
      return { type: "started", provider: event.provider, sessionId: event.sessionId?.slice(0, 512) };
    case "activity":
      return { type: "activity", label: "Agent reported progress" };
    case "permission":
      return { type: "permission", requestId: event.requestId.slice(0, 128), description: "Agent requires a user decision." };
    case "file_change":
      return { type: "file_change", path: event.path.slice(0, 4_096), kind: event.kind };
    case "error":
      return { type: "error", message: "Provider reported an error." };
    case "completed":
      return { type: "completed", summary: "Provider completed.", exitCode: event.exitCode };
  }
}

function storedDiagnostic(value: string): string {
  // Only the controller's allowlisted ACP stage diagnostics are persisted.
  // Provider-provided JSON-RPC messages, prompts, and stderr never reach here.
  return value.startsWith("ACP ")
    ? value.replace(/(?:api[_ -]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").slice(0, 500)
    : "Provider reported an error.";
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isActive(status: RunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting_permission";
}

function markDeadOwnersInterrupted(runs: RunRecord[]): void {
  const now = new Date().toISOString();
  for (const run of runs) {
    if (isActive(run.status) && run.ownerPid !== process.pid && !isProcessAlive(run.ownerPid)) {
      run.status = "interrupted";
      run.updatedAt = now;
    }
  }
}

function pruneTerminalRuns(runs: RunRecord[]): void {
  const maximumRuns = 200;
  if (runs.length <= maximumRuns) return;
  const terminal = runs
    .filter((run) => !isActive(run.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  while (runs.length > maximumRuns && terminal.length > 0) {
    const oldest = terminal.shift();
    const index = runs.findIndex((run) => run.id === oldest?.id);
    if (index >= 0) runs.splice(index, 1);
  }
}
