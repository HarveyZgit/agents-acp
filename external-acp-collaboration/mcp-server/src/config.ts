import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeEffort, safeSpeed, type EffortLevel, type SpeedLevel } from "./models.ts";

export type EnvMode = "session" | "inherit" | "minimal";
export type DefaultProviderName = "cursor" | "grok";
export type HostKind = "claude" | "codex";

export type PluginConfig = {
  workspace?: string;
  allowedSubtrees: string[];
  allowUnsandboxedImplement: boolean;
  enablePermissionResponses: boolean;
  maxRunMs: number;
  idleTimeoutMs: number;
  storePath: string;
  envMode: EnvMode;
  cursorEnvPassthrough: string[];
  enableFake: boolean;
  defaultProvider?: DefaultProviderName;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  defaultSpeed?: SpeedLevel;
  runtimeDir: string;
  configPath: string;
  configLoaded: boolean;
  host: HostKind;
};

export type ConfigureRequest = {
  workspace?: string;
  defaultProvider?: DefaultProviderName;
  defaultModel?: string | null;
  defaultEffort?: EffortLevel | null;
  defaultSpeed?: SpeedLevel | null;
  enablePermissionResponses?: boolean;
};

const DEFAULT_MAX_RUN_MS = 7_200_000;
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;
const CENTRAL_DIR_NAME = "agents-acp";

/**
 * Codex launches bundled MCP servers itself, so a plugin cannot assume the
 * user's shell environment is present. Configuration therefore comes from a
 * stable on-disk file first; `env_vars` forwarded by Codex override it.
 *
 * Runtime files stay under ~/.codex/agents-acp or ~/.claude/agents-acp
 * (or AGENTS_ACP_HOME / AGENTS_ACP_CONFIG). Claude Code is detected from
 * CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA. Project-local `.agents-acp`
 * directories and PLUGIN_DATA that would land there are ignored so the
 * plugin never creates workspace runtime files.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const configPath = resolveConfigPath(env);
  const runtimeDir = path.dirname(configPath);
  const file = readConfigFile(configPath);
  return {
    workspace: trimmed(env.EXTERNAL_ACP_WORKSPACE) ?? trimmed(file.workspace),
    allowedSubtrees: env.EXTERNAL_ACP_ALLOWED_SUBTREES !== undefined
      ? splitPaths(env.EXTERNAL_ACP_ALLOWED_SUBTREES)
      : stringArray(file.allowedSubtrees),
    allowUnsandboxedImplement: booleanSetting(
      env.EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT,
      file.allowUnsandboxedImplement,
    ),
    enablePermissionResponses: booleanSetting(
      env.EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES,
      file.enablePermissionResponses,
    ),
    maxRunMs: boundedInteger(env.EXTERNAL_ACP_MAX_RUN_MS, file.maxRunMs, DEFAULT_MAX_RUN_MS, 60_000, 86_400_000),
    idleTimeoutMs: boundedInteger(
      env.EXTERNAL_ACP_IDLE_TIMEOUT_MS,
      file.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      30_000,
      86_400_000,
    ),
    storePath: resolveStorePath(
      trimmed(env.EXTERNAL_ACP_STORE_PATH) ?? trimmed(file.storePath),
      runtimeDir,
      env,
    ),
    envMode: envMode(trimmed(env.EXTERNAL_ACP_ENV_MODE) ?? trimmed(file.envMode)),
    cursorEnvPassthrough: env.EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH !== undefined
      ? splitNames(env.EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH)
      : stringArray(file.cursorEnvPassthrough),
    enableFake: booleanSetting(env.EXTERNAL_ACP_ENABLE_FAKE, file.enableFake),
    defaultProvider: providerName(trimmed(env.EXTERNAL_ACP_DEFAULT_PROVIDER) ?? file.defaultProvider),
    defaultModel: safeStoredModel(trimmed(env.EXTERNAL_ACP_DEFAULT_MODEL) ?? file.defaultModel),
    defaultEffort: ignoreInvalid(() => optionalEnum(safeEffort(trimmed(env.EXTERNAL_ACP_DEFAULT_EFFORT) ?? file.defaultEffort))),
    defaultSpeed: ignoreInvalid(() => optionalEnum(safeSpeed(trimmed(env.EXTERNAL_ACP_DEFAULT_SPEED) ?? file.defaultSpeed))),
    runtimeDir,
    configPath,
    configLoaded: file.loaded,
    host: detectHost(env),
  };
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trimmed(env.AGENTS_ACP_CONFIG);
  if (explicit) {
    const resolved = path.resolve(explicit);
    return isProjectLocalRuntimeDir(path.dirname(resolved))
      ? path.join(centralRuntimeDir(env), "config.json")
      : resolved;
  }
  const home = trimmed(env.AGENTS_ACP_HOME);
  if (home) {
    const resolved = path.resolve(home);
    return isProjectLocalRuntimeDir(resolved)
      ? path.join(centralRuntimeDir(env), "config.json")
      : path.join(resolved, "config.json");
  }
  return path.join(centralRuntimeDir(env), "config.json");
}

export function detectHost(env: NodeJS.ProcessEnv = process.env): HostKind {
  return trimmed(env.CLAUDE_PLUGIN_ROOT) || trimmed(env.CLAUDE_PLUGIN_DATA)
    ? "claude"
    : "codex";
}

export function centralRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const homeName = detectHost(env) === "claude" ? ".claude" : ".codex";
  return path.join(homedirFrom(env), homeName, CENTRAL_DIR_NAME);
}

export function isProjectLocalRuntimeDir(directory: string): boolean {
  return path.basename(path.resolve(directory)) === ".agents-acp";
}

export function persistConfig(updates: ConfigureRequest, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const configPath = resolveConfigPath(env);
  if (isProjectLocalRuntimeDir(path.dirname(configPath))) {
    throw new Error("agents-acp refuses to write a project-local .agents-acp directory. Runtime files stay in ~/.codex/agents-acp or ~/.claude/agents-acp.");
  }
  const existing = readConfigFile(configPath);
  const next: Record<string, unknown> = persistableFields(existing);
  if (updates.workspace !== undefined) next.workspace = existingDirectory(updates.workspace);
  if (updates.defaultProvider !== undefined) {
    const provider = providerName(updates.defaultProvider);
    if (!provider) throw new Error('defaultProvider must be "cursor" or "grok".');
    next.defaultProvider = provider;
  }
  if (updates.defaultModel !== undefined) {
    const model = safeStoredModel(updates.defaultModel);
    if (model) {
      if (/\s/.test(model)) {
        throw new Error("defaultModel must be a catalog id resolved from the agent model list, not a raw keyword.");
      }
      next.defaultModel = model;
    } else {
      delete next.defaultModel;
      delete next.defaultEffort;
      delete next.defaultSpeed;
    }
  }
  if (updates.defaultEffort !== undefined) {
    const effort = safeEffort(updates.defaultEffort);
    if (effort) next.defaultEffort = effort;
    else delete next.defaultEffort;
  }
  if (updates.defaultSpeed !== undefined) {
    const speed = safeSpeed(updates.defaultSpeed);
    if (speed) next.defaultSpeed = speed;
    else delete next.defaultSpeed;
  }
  if (updates.enablePermissionResponses !== undefined) {
    next.enablePermissionResponses = updates.enablePermissionResponses === true;
  }
  atomicWrite(configPath, next);
  return loadConfig(env);
}

type FileConfig = Partial<Record<keyof PluginConfig, unknown>> & { loaded: boolean };

function readConfigFile(configPath: string): FileConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configuration file must contain a JSON object.");
    }
    return { ...(parsed as Record<string, unknown>), loaded: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { loaded: false };
    throw new Error(`Unable to read agents-acp configuration at ${configPath}: ${(error as Error).message}`);
  }
}

function persistableFields(file: FileConfig): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of [
    "workspace",
    "allowedSubtrees",
    "allowUnsandboxedImplement",
    "enablePermissionResponses",
    "maxRunMs",
    "idleTimeoutMs",
    "storePath",
    "envMode",
    "cursorEnvPassthrough",
    "enableFake",
    "defaultProvider",
    "defaultModel",
    "defaultEffort",
    "defaultSpeed",
  ] as const) {
    if (file[key] !== undefined) next[key] = file[key];
  }
  return next;
}

function atomicWrite(configPath: string, value: Record<string, unknown>): void {
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath);
}

function resolveStorePath(value: string | undefined, runtimeDir: string, env: NodeJS.ProcessEnv): string {
  if (!value) return path.join(runtimeDir, "runs.json");
  const resolved = path.isAbsolute(value) ? path.resolve(value) : path.resolve(runtimeDir, value);
  return isProjectLocalRuntimeDir(path.dirname(resolved))
    ? path.join(centralRuntimeDir(env), "runs.json")
    : resolved;
}

function existingDirectory(value: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new Error("workspace must be an absolute filesystem path.");
  }
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("workspace must be an existing accessible directory.");
  }
  return resolved;
}

function providerName(value: unknown): DefaultProviderName | undefined {
  return value === "cursor" || value === "grok" ? value : undefined;
}

function safeStoredModel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("defaultModel must be a string.");
  const model = value.trim();
  if (!model) return undefined;
  if (model.startsWith("-") || !/^[A-Za-z0-9._:/\- ]{1,128}$/.test(model)) {
    throw new Error("defaultModel must be a documented model identifier and cannot be interpreted as a CLI flag.");
  }
  return model;
}

function homedirFrom(env: NodeJS.ProcessEnv): string {
  return trimmed(env.HOME) ?? homedir();
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => (trimmed(entry) ? [trimmed(entry) as string] : [])) : [];
}

function splitPaths(value: string): string[] {
  return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function splitNames(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function booleanSetting(envValue: string | undefined, fileValue: unknown): boolean {
  if (envValue !== undefined) return envValue === "1" || envValue.toLowerCase() === "true";
  return fileValue === true;
}

function boundedInteger(
  envValue: string | undefined,
  fileValue: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  for (const candidate of [envValue, fileValue]) {
    if (candidate === undefined) continue;
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  }
  return fallback;
}

function envMode(value: string | undefined): EnvMode {
  return value === "inherit" || value === "minimal" ? value : "session";
}

function optionalEnum<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function ignoreInvalid<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
