import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  AcpProvider,
  providerEnvironment,
  type AuthMethod,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
  type TaskMode,
} from "./provider.ts";
import { readAuthMethods } from "./cursor.ts";
import { parseSessionModels, type CatalogModel, type ModelCatalog } from "../models.ts";
import {
  collisionNamesFor,
  inspectLaunch,
  isExecutableFile,
  pathEntries,
  selectedLaunchNote,
  type CommandClassifier,
  type LaunchInspection,
  type LaunchSource,
} from "./launch-inspect.ts";

/**
 * Official ACP server only. Never wrap the `agy` TUI and never fall back to
 * a community stdio shim.
 */
const OFFICIAL_NAMES = new Set(["agy_acp_server.par", "antigravity-acp"]);
const REJECTED_NAMES = new Set(["agy"]);

export type AntigravityResolve = {
  executable: string;
  args: string[];
  source?: LaunchSource;
};

export interface AntigravityLocator {
  resolve(env?: NodeJS.ProcessEnv): AntigravityResolve | undefined;
}

const ENV_NAMES = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AGY_ACP_BIN",
];

export function antigravityChildEnvironment(options: StartOptions): NodeJS.ProcessEnv {
  return providerEnvironment(options, ["GEMINI_", "GOOGLE_"], ENV_NAMES);
}

class FilesystemAntigravityLocator implements AntigravityLocator {
  resolve(env: NodeJS.ProcessEnv = process.env): AntigravityResolve | undefined {
    const explicit = env.AGY_ACP_BIN?.trim();
    if (explicit) {
      if (!path.isAbsolute(explicit) || explicit.includes("\0")) {
        throw new Error("AGY_ACP_BIN must be an absolute filesystem path to the official Antigravity ACP server.");
      }
      rejectUnofficialName(path.basename(explicit), true);
      if (!isExecutableFile(explicit)) return undefined;
      return { executable: explicit, args: officialArgs(), source: "env" };
    }

    const home = env.HOME?.trim() || homedir();
    const managed = path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par");
    const candidates: Array<{ file: string; source: LaunchSource }> = [
      { file: managed, source: "managed" },
      { file: path.join(home, ".local", "bin", "agy_acp_server.par"), source: "path" },
      ...pathEntries(env.PATH).flatMap((directory) => [
        { file: path.join(directory, "agy_acp_server.par"), source: "path" as const },
        { file: path.join(directory, "antigravity-acp"), source: "path" as const },
      ]),
    ];
    for (const candidate of candidates) {
      if (!isExecutableFile(candidate.file)) continue;
      rejectUnofficialName(path.basename(candidate.file), false);
      return { executable: candidate.file, args: officialArgs(), source: candidate.source };
    }
    return undefined;
  }
}

export class AntigravityProvider extends AcpProvider {
  readonly name: ProviderName = "antigravity";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "session",
    supportedModes: ["ask", "plan", "agent"],
  };
  private readonly locator: AntigravityLocator;
  private readonly classifier?: CommandClassifier;
  private resolved?: AntigravityResolve;
  private cachedModels: CatalogModel[] = [];

  constructor(locator?: AntigravityLocator, classifier?: CommandClassifier) {
    super();
    this.locator = locator ?? new FilesystemAntigravityLocator();
    this.classifier = classifier;
  }

  get executable(): string {
    return this.resolve()?.executable ?? "agy_acp_server.par";
  }

  discover(): ProviderAvailability {
    let resolved: AntigravityResolve | undefined;
    try {
      resolved = this.resolve();
    } catch (error) {
      return {
        provider: this.name,
        available: false,
        executable: "agy_acp_server.par",
        capabilities: this.capabilities,
        note: error instanceof Error ? error.message : "Antigravity ACP is unavailable.",
        launch: this.inspect(undefined),
      };
    }
    if (!resolved) {
      const launch = this.inspect(undefined);
      return {
        provider: this.name,
        available: false,
        executable: "agy_acp_server.par",
        capabilities: this.capabilities,
        note: "Official Antigravity ACP server was not found. Set AGY_ACP_BIN to agy_acp_server.par or install antigravity-acp. This provider never wraps the agy TUI.",
        launch,
      };
    }
    const loggedIn = this.cliSessionKnownGood();
    const launch = this.inspect(resolved);
    return {
      provider: this.name,
      available: loggedIn,
      executable: resolved.executable,
      capabilities: this.capabilities,
      note: loggedIn
        ? `${selectedLaunchNote(launch)} Model is session/set_config_option {configId:\"model\"}; effort is a Gemini slug suffix. Modes stay on default — never yolo or auto_edit.`
        : `Binary found at ${resolved.executable}, but no ~/.gemini/antigravity-acp/acp_token.json or GEMINI_API_KEY / GOOGLE_API_KEY is visible. Log in via the Antigravity IDE or Zed first; do not expect headless OAuth in this child.`,
      launch,
    };
  }

  command(_options: StartOptions): string[] {
    const resolved = this.resolve();
    if (!resolved) {
      throw new Error("Antigravity ACP is unavailable. Set AGY_ACP_BIN to the official agy_acp_server.par. This provider never falls back to agy.");
    }
    return [...resolved.args];
  }

  listModels(): ModelCatalog {
    if (this.cachedModels.length > 0) {
      return { provider: "antigravity", available: true, models: this.cachedModels };
    }
    return {
      provider: "antigravity",
      available: false,
      models: [],
      error: "Antigravity lists models on session/new, not a CLI flag. Use a catalog fixture, or configure after the first authenticated run.",
    };
  }

  ingestSession(session: Record<string, unknown>): void {
    const models = parseSessionModels(session);
    if (models.length > 0) this.cachedModels = models;
  }

  acceptableSessionModes(_mode: TaskMode): string[] {
    return ["default"];
  }

  decoratePrompt(mode: TaskMode, prompt: string): string {
    if (mode === "plan") return `Create a plan only. Do not edit or write files.\n\n${prompt}`;
    if (mode === "review") return `Answer in a read-only review. Do not edit or write files.\n\n${prompt}`;
    return prompt;
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    const methods = readAuthMethods(initialized);
    if (process.env.GEMINI_API_KEY) {
      const key = methods.find((method) => method.methodId === "gemini-api-key");
      if (key) return key;
    }
    if (process.env.GOOGLE_API_KEY || process.env.GOOGLE_CLOUD_PROJECT) {
      const platform = methods.find((method) => method.methodId === "agent-platform");
      if (platform) return platform;
    }
    // Headless OAuth does not print a URL. Never send oauth-* from this child.
    return undefined;
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  cliSessionKnownGood(_options?: Pick<StartOptions, "envMode" | "envPassthrough">): boolean {
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
    const home = process.env.HOME?.trim() || homedir();
    const token = path.join(home, ".gemini", "antigravity-acp", "acp_token.json");
    try {
      return statSync(token).isFile() && statSync(token).size > 0;
    } catch {
      return false;
    }
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    return antigravityChildEnvironment(options);
  }

  private resolve(): AntigravityResolve | undefined {
    if (this.resolved) return this.resolved;
    this.resolved = this.locator.resolve();
    return this.resolved;
  }

  private inspect(resolved: AntigravityResolve | undefined): LaunchInspection {
    return inspectLaunch({
      executable: resolved?.executable,
      args: resolved?.args ?? officialArgs(),
      source: resolved?.source ?? (resolved ? "path" : "missing"),
      collisionNames: collisionNamesFor("antigravity"),
      classifier: this.classifier,
    });
  }
}

function officialArgs(): string[] {
  return ["--uid="];
}

function rejectUnofficialName(name: string, explicitBin: boolean): void {
  if (REJECTED_NAMES.has(name)) {
    throw new Error('Refusing to launch "agy". Only the official Antigravity ACP server (agy_acp_server.par / antigravity-acp) is supported. Never wrap the agy TUI.');
  }
  if (explicitBin) return;
  if (!OFFICIAL_NAMES.has(name) && !name.startsWith("agy_acp_server")) {
    throw new Error(`Refusing to launch "${name}". Only the official Antigravity ACP server (agy_acp_server.par / antigravity-acp) is supported.`);
  }
}


