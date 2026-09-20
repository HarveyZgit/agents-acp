import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Confirmed ACP spawn. The host child always uses `spawn(file, args, {shell:false})`.
 * User aliases, functions, and colliding PATH files are reported and never followed.
 */

export type InspectableProvider = "cursor" | "grok" | "antigravity";

/** Official CLI names plus common user wrappers, inspected for every provider. */
export const CLI_WRAPPER_NAMES: Record<InspectableProvider, readonly string[]> = {
  cursor: ["cursor-agent", "cursor", "agent"],
  grok: ["grok"],
  antigravity: ["agy_acp_server.par", "antigravity-acp", "agy", "antigravity"],
};

export function collisionNamesFor(provider: InspectableProvider): string[] {
  return [...CLI_WRAPPER_NAMES[provider]];
}
export type LaunchSource = "env" | "managed" | "path" | "missing";

export type LaunchCollisionKind = "function" | "alias" | "file" | "builtin" | "keyword" | "unknown";

export type LaunchCollision = {
  name: string;
  kind: LaunchCollisionKind;
  path?: string;
  followed: false;
};

export type LaunchInspection = {
  executable?: string;
  args: string[];
  argv: string;
  source: LaunchSource;
  spawn: "direct";
  ignoredWrappers: LaunchCollision[];
  /** rc files are read as text; they are never sourced or executed. */
  wrapperDetection: "rc-scan";
};

export type CommandClass = {
  kind: LaunchCollisionKind;
  path?: string;
};

export interface CommandClassifier {
  classify(name: string, env?: NodeJS.ProcessEnv): CommandClass | undefined;
  classifyMany?(names: string[], env?: NodeJS.ProcessEnv): Map<string, CommandClass | undefined>;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._+-]{0,63}$/;
const MAX_RC_FILES = 16;
const MAX_RC_BYTES = 256_000;
const cache = new Map<string, LaunchCollision[]>();
const rcCache = new Map<string, Map<string, CommandClass>>();

export function inspectLaunch(options: {
  executable?: string;
  args: string[];
  source: LaunchSource;
  collisionNames: string[];
  env?: NodeJS.ProcessEnv;
  classifier?: CommandClassifier;
}): LaunchInspection {
  const executable = options.executable;
  return {
    executable,
    args: options.args,
    argv: formatArgv(executable, options.args),
    source: options.source,
    spawn: "direct",
    wrapperDetection: "rc-scan",
    ignoredWrappers: inspectCollisions(options.collisionNames, {
      officialExecutable: executable,
      env: options.env,
      classifier: options.classifier,
    }),
  };
}

export function inspectCollisions(
  names: string[],
  options: {
    officialExecutable?: string;
    env?: NodeJS.ProcessEnv;
    classifier?: CommandClassifier;
  } = {},
): LaunchCollision[] {
  const env = options.env ?? process.env;
  const key = cacheKey(names, options.officialExecutable, env, Boolean(options.classifier));
  const cached = cache.get(key);
  if (cached && !options.classifier) return cached;

  const found: LaunchCollision[] = [];
  const seen = new Set<string>();
  const classifier = options.classifier ?? defaultClassifier;
  const classifiedByName = classifyAll(classifier, names, env);
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    for (const file of findAllOnPath(name, env)) {
      if (samePath(file, options.officialExecutable)) continue;
      addCollision(found, seen, { name, kind: "file", path: file, followed: false });
    }
    const classified = classifiedByName.get(name);
    if (!classified) continue;
    if (classified.kind === "file") {
      if (!classified.path || samePath(classified.path, options.officialExecutable)) continue;
      addCollision(found, seen, { name, kind: "file", path: classified.path, followed: false });
      continue;
    }
    addCollision(found, seen, {
      name,
      kind: classified.kind,
      ...(classified.path ? { path: classified.path } : {}),
      followed: false,
    });
  }
  if (!options.classifier) cache.set(key, found);
  return found;
}

export function resolveOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (path.isAbsolute(name) && isExecutableFile(name)) return name;
  return findAllOnPath(name, env)[0];
}

/**
 * Official CLI file only. `envName` (CURSOR_AGENT_BIN / GROK_BIN / AGY_ACP_BIN)
 * wins when it is an absolute existing file. PATH is last.
 */
export function resolveOfficialCli(
  name: string,
  options: { envName?: string; env?: NodeJS.ProcessEnv } = {},
): { executable: string; source: LaunchSource } | undefined {
  if (!SAFE_NAME.test(name) && !path.isAbsolute(name)) return undefined;
  const env = options.env ?? process.env;
  const envName = options.envName;
  const explicit = envName ? env[envName]?.trim() : undefined;
  if (explicit) {
    if (!path.isAbsolute(explicit) || explicit.includes("\0")) {
      throw new Error(`${envName} must be an absolute filesystem path to the official CLI.`);
    }
    if (!isExecutableFile(explicit)) return undefined;
    return { executable: explicit, source: "env" };
  }
  const fromPath = findAllOnPath(name, env)[0];
  return fromPath ? { executable: fromPath, source: "path" } : undefined;
}

export function findAllOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!SAFE_NAME.test(name) && !path.isAbsolute(name)) return [];
  if (path.isAbsolute(name)) return isExecutableFile(name) ? [name] : [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathEntries(env.PATH)) {
    const candidate = path.join(directory, name);
    if (!isExecutableFile(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    found.push(candidate);
  }
  return found;
}

export function pathEntries(value: string | undefined): string[] {
  return (value ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

export function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function formatArgv(executable: string | undefined, args: string[]): string {
  return [executable, ...args].filter((part) => part !== undefined && part !== "").join(" ");
}

export function selectedLaunchNote(launch: LaunchInspection): string {
  const wrappers = launch.ignoredWrappers
    .map((wrapper) => `${wrapper.name} (${wrapper.kind})`)
    .join(", ");
  return wrappers
    ? `Selected ACP launch: ${launch.argv} (shell:false). Ignored user wrappers: ${wrappers}.`
    : `Selected ACP launch: ${launch.argv} (shell:false). User shell functions, aliases, and colliding PATH files for this CLI are not followed.`;
}

export function resetLaunchInspectCache(): void {
  cache.clear();
  rcCache.clear();
}

const defaultClassifier: CommandClassifier = {
  classify(name, env = process.env) {
    return classifyShellCommand(name, env);
  },
  classifyMany(names, env = process.env) {
    return classifyShellCommands(names, env);
  },
};

/**
 * Classify user wrappers by reading rc files as text. Never source the rc
 * and never invoke the command — a network check inside `agy()` / `grok()`
 * / `cursor-agent()` must not run during setup.
 */
export function classifyShellCommand(name: string, env: NodeJS.ProcessEnv = process.env): CommandClass | undefined {
  return classifyShellCommands([name], env).get(name);
}

export function classifyShellCommands(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, CommandClass | undefined> {
  const classified = new Map<string, CommandClass | undefined>();
  const safe = names.filter((name) => SAFE_NAME.test(name));
  if (safe.length === 0) return classified;
  const scanned = scanRcWrappers(env);
  for (const name of safe) {
    const found = scanned.get(name);
    if (found) classified.set(name, found);
  }
  return classified;
}

function classifyAll(
  classifier: CommandClassifier,
  names: string[],
  env: NodeJS.ProcessEnv,
): Map<string, CommandClass | undefined> {
  if (classifier.classifyMany) return classifier.classifyMany(names, env);
  const classified = new Map<string, CommandClass | undefined>();
  for (const name of names) classified.set(name, classifier.classify(name, env));
  return classified;
}

function scanRcWrappers(env: NodeJS.ProcessEnv): Map<string, CommandClass> {
  const key = `${env.HOME ?? ""}|${env.ZDOTDIR ?? ""}`;
  const cached = rcCache.get(key);
  if (cached) return cached;
  const found = new Map<string, CommandClass>();
  const visited = new Set<string>();
  const queue = rcSeedFiles(env);
  while (queue.length > 0 && visited.size < MAX_RC_FILES) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const text = readRcText(file);
    if (!text) continue;
    for (const wrapper of parseRcWrappers(text)) {
      const previous = found.get(wrapper.name);
      if (!previous || (previous.kind === "alias" && wrapper.kind === "function")) {
        found.set(wrapper.name, { kind: wrapper.kind });
      }
    }
    for (const sourced of parseRcSources(text, env)) {
      if (!visited.has(sourced)) queue.push(sourced);
    }
  }
  rcCache.set(key, found);
  return found;
}

function rcSeedFiles(env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim();
  const zdot = env.ZDOTDIR?.trim() || home;
  const files: string[] = [];
  if (home) {
    files.push(
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".bash_aliases"),
      path.join(home, ".profile"),
    );
  }
  if (zdot) {
    files.push(path.join(zdot, ".zshrc"), path.join(zdot, ".zshenv"), path.join(zdot, ".zprofile"));
  }
  return files;
}

function readRcText(file: string): string | undefined {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return undefined;
    const text = readFileSync(file, { encoding: "utf8" });
    return text.length > MAX_RC_BYTES ? text.slice(0, MAX_RC_BYTES) : text;
  } catch {
    return undefined;
  }
}

function parseRcWrappers(text: string): Array<{ name: string; kind: "function" | "alias" }> {
  const found: Array<{ name: string; kind: "function" | "alias" }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*#.*$/, "").trim();
    if (!line) continue;
    const fn = /^(?:function\s+)([A-Za-z][A-Za-z0-9._+-]*)(?:\s*\(\))?/.exec(line)
      ?? /^([A-Za-z][A-Za-z0-9._+-]*)\s*\(\)/.exec(line);
    if (fn && SAFE_NAME.test(fn[1])) {
      found.push({ name: fn[1], kind: "function" });
      continue;
    }
    const alias = /^alias\s+(?:--\s+)?([A-Za-z][A-Za-z0-9._+-]*)=/.exec(line);
    if (alias && SAFE_NAME.test(alias[1])) found.push({ name: alias[1], kind: "alias" });
  }
  return found;
}

function parseRcSources(text: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME?.trim();
  if (!home) return [];
  const files: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:source|\.)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(raw);
    if (!match) continue;
    const spec = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!spec || /[;|`$()\\]/.test(spec)) continue;
    const resolved = spec.startsWith("~/")
      ? path.join(home, spec.slice(2))
      : spec === "~"
        ? home
        : spec.startsWith("$HOME/")
          ? path.join(home, spec.slice(6))
          : spec;
    if (!path.isAbsolute(resolved)) continue;
    const normalized = path.resolve(resolved);
    if (!normalized.startsWith(path.resolve(home) + path.sep) && normalized !== path.resolve(home)) continue;
    files.push(normalized);
  }
  return files;
}

function addCollision(found: LaunchCollision[], seen: Set<string>, collision: LaunchCollision): void {
  const key = `${collision.name}:${collision.kind}:${collision.path ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  found.push(collision);
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function cacheKey(
  names: string[],
  official: string | undefined,
  env: NodeJS.ProcessEnv,
  customClassifier: boolean,
): string {
  return [names.join(","), official ?? "", env.HOME ?? "", env.PATH ?? "", env.SHELL ?? "", env.ZDOTDIR ?? "", customClassifier ? "c" : "d"].join("|");
}
