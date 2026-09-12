import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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
  outsideWorkspaceWrites?: boolean;
  error?: string;
  completed?: { exitCode?: number; stopReason?: string };
  events: Array<Exclude<RunEvent, { type: "text" }>>;
};

type StoreData = { runs: RunRecord[] };

/** Bounded to roughly 300ms so a contended lock degrades instead of stalling. */
const LOCK_ATTEMPTS = 12;
const LOCK_BACKOFF_MS = [1, 2, 3, 5, 8, 13, 21, 34, 55];
const STALE_LOCK_MS = 30_000;

export class RunStore {
  private readonly filePath: string;
  private data: StoreData;
  private degradedReason?: string;

  constructor(filePath = join(homedir(), ".codex", "agents-acp", "runs.json")) {
    this.filePath = filePath;
    this.data = this.load();
    this.reconcileInterruptedRuns();
  }

  /** Non-empty when the on-disk store is unusable and runs are memory-only. */
  get degraded(): string | undefined {
    return this.degradedReason;
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
    this.refresh();
    const record = this.data.runs.find((run) => run.id === id);
    if (!record) throw new Error(`Unknown run: ${id}`);
    return structuredClone(record);
  }

  findBySession(provider: ProviderName, sessionId: string): RunRecord | undefined {
    this.refresh();
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
    // Streamed text is never persisted, so it must not trigger a lock or a
    // full store rewrite on every chunk.
    if (event.type === "text") return this.get(id);
    return this.mutate(() => {
      const record = this.require(id);
      record.events.push(persistedEvent(event));
      if (record.events.length > 500) record.events.splice(0, record.events.length - 500);
      if (event.type === "activity") record.lastActivity = safeLabel(event.label);
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
    this.refresh();
    this.reconcileInterruptedRuns();
    return this.data.runs
      .filter((run) => run.workspace === workspace && run.mode === "implement" && isActive(run.status))
      .map((run) => structuredClone(run));
  }

  private require(id: string): RunRecord {
    const record = this.data.runs.find((run) => run.id === id);
    if (!record) throw new Error(`Unknown run: ${id}`);
    return record;
  }

  /** A read failure must never break an in-flight run; keep memory state. */
  private refresh(): void {
    try {
      this.data = this.load();
      this.degradedReason = undefined;
    } catch (error) {
      this.degradedReason = `Run store is unreadable; using in-memory state (${(error as Error).message}).`;
    }
  }

  private load(): StoreData {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreData;
      if (!Array.isArray(parsed.runs)) throw new Error("Invalid run store format.");
      return { runs: parsed.runs.filter(validRunRecord).map(sanitizeRunRecord) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { runs: [] };
      if (error instanceof SyntaxError || code === undefined) {
        // A corrupt file must not wedge the server: quarantine and restart empty.
        this.quarantine();
        return { runs: [] };
      }
      throw error;
    }
  }

  private quarantine(): void {
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      this.degradedReason = "The previous run store was corrupt and was moved aside.";
    } catch {
      this.degradedReason = "The previous run store was corrupt and could not be moved aside.";
    }
  }

  private mutate<T>(operation: () => T): T {
    const lock = this.acquireLock();
    try {
      this.refresh();
      const result = operation();
      this.saveUnlocked();
      return result;
    } finally {
      this.releaseLock(lock);
    }
  }

  private saveUnlocked(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      renameSync(temporary, this.filePath);
      this.degradedReason = undefined;
    } catch (error) {
      // Persistence is best-effort; the live run continues from memory.
      this.degradedReason = `Run store is not writable; state is in-memory only (${(error as Error).message}).`;
    }
  }

  private acquireLock(): number | undefined {
    const lockPath = `${this.filePath}.lock`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch {
      return undefined;
    }
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        writeFileSync(descriptor, String(process.pid));
        return descriptor;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
        if (this.reclaimStaleLock(lockPath)) continue;
        sleep(LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)]);
      }
    }
    // Proceeding unlocked is safer than throwing out of an event callback: the
    // write itself stays atomic via a unique temp file plus rename.
    this.degradedReason = "Run store lock was busy; the last write was not serialized.";
    return undefined;
  }

  private reclaimStaleLock(lockPath: string): boolean {
    try {
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      const age = Date.now() - statSync(lockPath).mtimeMs;
      const ownerDead = !Number.isInteger(owner) || owner <= 0 || !isProcessAlive(owner);
      if (owner === process.pid || ownerDead || age > STALE_LOCK_MS) {
        unlinkSync(lockPath);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  private releaseLock(descriptor: number | undefined): void {
    if (descriptor === undefined) return;
    try {
      closeSync(descriptor);
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(`${this.filePath}.lock`);
    } catch {
      // Another process already reclaimed it.
    }
  }

  private reconcileInterruptedRuns(): void {
    if (!this.data.runs.some((run) => isActive(run.status) && run.ownerPid !== process.pid && !isProcessAlive(run.ownerPid))) return;
    this.mutate(() => {
      markDeadOwnersInterrupted(this.data.runs);
    });
  }
}

function sleep(milliseconds: number): void {
  // The store API is synchronous and is called from JSON-RPC callbacks.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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
      return { type: "activity", label: safeLabel(event.label) };
    case "permission":
      return {
        type: "permission",
        requestId: event.requestId.slice(0, 128),
        description: "Agent requires a user decision.",
        kind: event.kind,
        options: event.options?.slice(0, 20).map((option) => ({ optionId: option.optionId.slice(0, 128), kind: option.kind })),
      };
    case "file_change":
      return { type: "file_change", path: event.path.slice(0, 4_096), kind: event.kind };
    case "error":
      return { type: "error", message: storedDiagnostic(event.message) };
    case "completed":
      return { type: "completed", summary: "Provider completed.", exitCode: event.exitCode };
  }
}

/**
 * Only the controller's own ACP stage diagnostics are persisted; they are
 * already sanitized, and this is a second, independent redaction pass.
 */
export function storedDiagnostic(value: string): string {
  if (!value.startsWith("ACP ")) return "Provider reported an error.";
  return redactSecrets(value).slice(0, 600);
}

/** Agent-authored text is replaced; adapter-authored notes are preserved. */
function safeLabel(label: string): string {
  return label.startsWith("ACP ") ? redactSecrets(label).slice(0, 200) : "Agent reported progress";
}

/**
 * Structured, fail-closed secret removal. The final high-entropy sweep catches
 * credential shapes that the named patterns do not anticipate.
 */
export function redactSecrets(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(authorization|proxy-authorization|www-authenticate)\b\s*[:=]\s*[^\n;]+/gi, "$1=[REDACTED]")
    .replace(/\b(basic|bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\bset-cookie\b\s*[:=]\s*[^\n]+/gi, "set-cookie=[REDACTED]")
    .replace(/\bcookie\b\s*[:=]\s*[^\n;]+/gi, "cookie=[REDACTED]")
    .replace(/"?\b(?:access_token|refresh_token|id_token|session_token|auth_token|api[_-]?key|apikey|client_secret|secret|password|passwd|credential)\b"?\s*[:=]\s*"?[^"\s,;}]+"?/gi, "[REDACTED CREDENTIAL]")
    .replace(/\b[A-Za-z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi, "[REDACTED CREDENTIAL]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[REDACTED JWT]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|xai|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}/gi, "[REDACTED KEY]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[REDACTED SECRET]")
    .replace(/\s+/g, " ")
    .trim();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
