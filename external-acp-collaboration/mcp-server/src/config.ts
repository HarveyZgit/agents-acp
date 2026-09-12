import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type EnvMode = "session" | "inherit" | "minimal";

export type PluginConfig = {
  workspace?: string;
  allowedSubtrees: string[];
  allowUnsandboxedImplement: boolean;
  enablePermissionResponses: boolean;
  maxRunMs: number;
  idleTimeoutMs: number;
  storePath?: string;
  envMode: EnvMode;
  cursorEnvPassthrough: string[];
  enableFake: boolean;
  configPath: string;
  configLoaded: boolean;
};

const DEFAULT_MAX_RUN_MS = 7_200_000;
const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

/**
 * Codex launches bundled MCP servers itself, so a plugin cannot assume the
 * user's shell environment is present. Configuration therefore comes from a
 * stable on-disk file first; `env_vars` forwarded by Codex override it.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const configPath = resolveConfigPath(env);
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
    storePath: trimmed(env.EXTERNAL_ACP_STORE_PATH) ?? trimmed(file.storePath),
    envMode: envMode(trimmed(env.EXTERNAL_ACP_ENV_MODE) ?? trimmed(file.envMode)),
    cursorEnvPassthrough: env.EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH !== undefined
      ? splitNames(env.EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH)
      : stringArray(file.cursorEnvPassthrough),
    enableFake: booleanSetting(env.EXTERNAL_ACP_ENABLE_FAKE, file.enableFake),
    configPath,
    configLoaded: file.loaded,
  };
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = trimmed(env.AGENTS_ACP_CONFIG);
  if (explicit) return path.resolve(explicit);
  const pluginData = trimmed(env.PLUGIN_DATA) ?? trimmed(env.CLAUDE_PLUGIN_DATA);
  if (pluginData) return path.join(path.resolve(pluginData), "config.json");
  return path.join(homedir(), ".codex", "agents-acp", "config.json");
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
