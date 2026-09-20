import { existsSync, statSync } from "node:fs";
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

/**
 * Official ACP server only. Never wrap the `agy` TUI and never fall back to
 * a community stdio shim.
 */
const OFFICIAL_NAMES = new Set(["agy_acp_server.par", "antigravity-acp"]);
const REJECTED_NAMES = new Set(["agy"]);

export type AntigravityResolve = {
  executable: string;
  args: string[];
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
      return { executable: explicit, args: officialArgs() };
    }

    const home = env.HOME?.trim() || homedir();
    const candidates = [
      path.join(home, ".local", "opt", "agy-acp", "current", "agy_acp_server.par"),
      path.join(home, ".local", "bin", "agy_acp_server.par"),
      ...pathEntries(env.PATH).flatMap((directory) => [
        path.join(directory, "agy_acp_server.par"),
        path.join(directory, "antigravity-acp"),
      ]),
    ];
    for (const candidate of candidates) {
      if (!isExecutableFile(candidate)) continue;
      rejectUnofficialName(path.basename(candidate), false);
      return { executable: candidate, args: officialArgs() };
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
  private resolved?: AntigravityResolve;
  private cachedModels: CatalogModel[] = [];

  constructor(locator: AntigravityLocator = new FilesystemAntigravityLocator()) {
    super();
    this.locator = locator;
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
      };
    }
    if (!resolved) {
      return {
        provider: this.name,
        available: false,
        executable: "agy_acp_server.par",
        capabilities: this.capabilities,
        note: "Official Antigravity ACP server was not found. Set AGY_ACP_BIN to agy_acp_server.par or install antigravity-acp. This provider never wraps the agy TUI.",
      };
    }
    const loggedIn = this.cliSessionKnownGood();
    return {
      provider: this.name,
      available: true,
      executable: resolved.executable,
      capabilities: this.capabilities,
      note: loggedIn
        ? `Selected ACP launch: ${[resolved.executable, ...resolved.args].join(" ")}. Model is session/set_config_option {configId:\"model\"}; effort is a Gemini slug suffix. Modes stay on default — never yolo or auto_edit.`
        : `Binary found at ${resolved.executable}, but no ~/.gemini/antigravity-acp/acp_token.json or GEMINI_API_KEY / GOOGLE_API_KEY is visible. Log in via the Antigravity IDE or Zed first; do not expect headless OAuth in this child.`,
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

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathEntries(value: string | undefined): string[] {
  return (value ?? "").split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

