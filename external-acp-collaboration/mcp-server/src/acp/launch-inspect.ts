import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Confirmed ACP spawn. The host child always uses `spawn(file, args, {shell:false})`.
 * User aliases, functions, and colliding PATH files are reported and never followed.
 */
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
};

export type CommandClass = {
  kind: LaunchCollisionKind;
  path?: string;
};

export interface CommandClassifier {
  classify(name: string, env?: NodeJS.ProcessEnv): CommandClass | undefined;
}

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._+-]{0,63}$/;
const SHELL_PROBE_MS = 1_200;
const cache = new Map<string, LaunchCollision[]>();

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
  for (const name of names) {
    if (!SAFE_NAME.test(name)) continue;
    for (const file of findAllOnPath(name, env)) {
      if (samePath(file, options.officialExecutable)) continue;
      addCollision(found, seen, { name, kind: "file", path: file, followed: false });
    }
    const classified = classifier.classify(name, env);
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

export function resetLaunchInspectCache(): void {
  cache.clear();
}

const defaultClassifier: CommandClassifier = {
  classify(name, env = process.env) {
    return classifyShellCommand(name, env);
  },
};

/**
 * Classify a command the way the user's interactive shell would, without
 * invoking it. `agy` as a function that checks the network must never run.
 */
export function classifyShellCommand(name: string, env: NodeJS.ProcessEnv = process.env): CommandClass | undefined {
  if (!SAFE_NAME.test(name) || process.platform === "win32") return undefined;
  for (const shell of probeShells(env)) {
    const classified = classifyWithShell(shell, name, env);
    if (classified) return classified;
  }
  return undefined;
}

function probeShells(env: NodeJS.ProcessEnv): string[] {
  const shells: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || seen.has(value) || !isExecutableFile(value)) return;
    seen.add(value);
    shells.push(value);
  };
  add(env.SHELL?.trim());
  add(resolveOnPath("bash", env));
  add(resolveOnPath("zsh", env));
  return shells.slice(0, 1);
}

function classifyWithShell(shell: string, name: string, env: NodeJS.ProcessEnv): CommandClass | undefined {
  const flavor = path.basename(shell) === "zsh" ? "zsh" : "bash";
  const args = flavor === "zsh"
    ? ["-ic", `whence -w -- ${name}`]
    : ["-ic", `type -t -- ${name}`];
  const result = spawnSync(shell, args, {
    encoding: "utf8",
    timeout: SHELL_PROBE_MS,
    windowsHide: true,
    shell: false,
    env: {
      HOME: env.HOME,
      PATH: env.PATH,
      USER: env.USER,
      LOGNAME: env.LOGNAME,
      SHELL: shell,
      TERM: "dumb",
      PS1: "\\$ ",
      ZDOTDIR: env.ZDOTDIR,
    },
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) return undefined;
  const output = typeof result.stdout === "string" ? result.stdout : "";
  return flavor === "zsh" ? parseZshWhence(output) : parseBashType(output);
}

function parseBashType(output: string): CommandClass | undefined {
  for (const line of linesFromEnd(output)) {
    if (line === "function" || line === "alias" || line === "builtin" || line === "keyword") {
      return { kind: line };
    }
    if (line === "file") return { kind: "file" };
  }
  return undefined;
}

function parseZshWhence(output: string): CommandClass | undefined {
  for (const line of linesFromEnd(output)) {
    const match = /:\s*(function|alias|command|builtin|hashed|reserved)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === "command" || match[1] === "hashed") return { kind: "file" };
    if (match[1] === "reserved") return { kind: "keyword" };
    return { kind: match[1] as LaunchCollisionKind };
  }
  return undefined;
}

function linesFromEnd(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
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
