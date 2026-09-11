import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ProviderName, RunEvent, TaskMode } from "./acp/provider.ts";

export type RunStatus = "starting" | "running" | "waiting_permission" | "completed" | "failed" | "cancelled";
export type RunRecord = {
  id: string;
  provider: ProviderName;
  cwd: string;
  workspace: string;
  mode: TaskMode;
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
  }

  create(input: Pick<RunRecord, "provider" | "cwd" | "workspace" | "mode">): RunRecord {
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: randomUUID(),
      ...input,
      status: "starting",
      startedAt: now,
      updatedAt: now,
      changedFiles: [],
      events: [],
    };
    this.data.runs.push(record);
    this.save();
    return record;
  }

  get(id: string): RunRecord {
    const record = this.data.runs.find((run) => run.id === id);
    if (!record) throw new Error(`Unknown run: ${id}`);
    return structuredClone(record);
  }

  findBySession(provider: ProviderName, sessionId: string): RunRecord | undefined {
    const record = this.data.runs.find((run) => run.provider === provider && run.sessionId === sessionId);
    return record && structuredClone(record);
  }

  update(id: string, update: Partial<Omit<RunRecord, "id" | "events" | "changedFiles">>): RunRecord {
    const record = this.require(id);
    Object.assign(record, update, { updatedAt: new Date().toISOString() });
    this.save();
    return structuredClone(record);
  }

  appendEvent(id: string, event: RunEvent): RunRecord {
    const record = this.require(id);
    // Text can contain user-provided material echoed by a provider. Keep it
    // in the in-memory controller only; never persist it to the session file.
    if (event.type !== "text") record.events.push(event);
    if (event.type === "activity") record.lastActivity = event.label;
    if (event.type === "file_change") record.changedFiles.push({ path: event.path, kind: event.kind });
    if (event.type === "error") record.error = "Provider reported an error; inspect the live result for details.";
    if (event.type === "completed") {
      record.status = "completed";
      record.completed = { exitCode: event.exitCode };
    }
    record.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(record);
  }

  listActiveImplementRuns(workspace: string): RunRecord[] {
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
      return Array.isArray(parsed.runs) ? { runs: parsed.runs } : { runs: [] };
    } catch {
      return { runs: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
