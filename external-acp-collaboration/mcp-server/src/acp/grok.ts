import { spawnSync } from "node:child_process";
import {
  AcpProvider,
  providerEnvironment,
  safeModelId,
  type AuthMethod,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";
import { readAuthMethods } from "./cursor.ts";
import { parseListModelsOutput, type EffortLevel, type ModelCatalog } from "../models.ts";
import { collisionNamesFor, inspectLaunch, resolveOfficialCli, selectedLaunchNote, type CommandClassifier } from "./launch-inspect.ts";

const EXECUTABLE = "grok";
const GROK_ARGS = ["--no-auto-update", "--cwd", "<workspace>", "agent", "--no-leader", "stdio"];

export class GrokProvider extends AcpProvider {
  readonly name: ProviderName = "grok";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };
  private readonly classifier?: CommandClassifier;

  constructor(classifier?: CommandClassifier) {
    super();
    this.classifier = classifier;
  }

  get executable(): string {
    try {
      return resolveOfficialCli(EXECUTABLE, { envName: "GROK_BIN" })?.executable ?? EXECUTABLE;
    } catch {
      return EXECUTABLE;
    }
  }

  discover(): ProviderAvailability {
    const discovered = super.discover();
    const launch = inspectLaunch({
      executable: discovered.available ? discovered.executable : undefined,
      args: GROK_ARGS,
      source: discovered.available ? "path" : "missing",
      collisionNames: collisionNamesFor("grok"),
      classifier: this.classifier,
    });
    if (!discovered.available) {
      return {
        ...discovered,
        launch,
        note: discovered.note
          ?? "grok was not found as a filesystem executable. A grok shell function or alias is ignored.",
      };
    }
    return {
      ...discovered,
      launch,
      note: `${selectedLaunchNote(launch)} Model is optional; omit start.model to use the Grok CLI default. Effort is --effort, not a model-id suffix.`,
    };
  }

  command(options: StartOptions): string[] {
    const model = safeModelId(options.model, "Grok");
    const modelArgs = model ? ["--model", model] : [];
    const effortArgs = grokEffortArgs(options.effort);
    // Official ACP launch is `grok agent stdio`. `--no-auto-update` is the
    // documented scripting flag (global). `--no-leader` forces a local agent so
    // a Codex-spawned child does not need `~/.grok/leader.sock`. Never pass
    // `--always-approve`: each permission stays a user decision.
    return ["--no-auto-update", "--cwd", options.cwd, "agent", "--no-leader", ...modelArgs, ...effortArgs, "stdio"];
  }

  listModels(options?: Pick<StartOptions, "envMode" | "envPassthrough">): ModelCatalog {
    const result = spawnSync(this.executable, ["models"], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
      shell: false,
      env: this.environment({
        cwd: process.cwd(),
        prompt: "",
        mode: "review",
        envMode: options?.envMode ?? "session",
        envPassthrough: options?.envPassthrough,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) {
      return {
        provider: "grok",
        available: false,
        models: [],
        error: "grok models is unavailable. Start Codex from the same login where grok models works.",
      };
    }
    const models = parseListModelsOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return {
      provider: "grok",
      available: models.length > 0,
      models,
      error: models.length > 0 ? undefined : "grok listed no models for this account.",
    };
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    const methods = readAuthMethods(initialized);
    return methods.find((method) => method.methodId === "cached_token")
      // The CLI, not this plugin, reads a pre-existing environment credential.
      ?? methods.find((method) => method.methodId === "xai.api_key" && process.env.XAI_API_KEY !== undefined);
  }

  authenticateParams(method: AuthMethod): Record<string, unknown> {
    // Official x.ai ACP scripting example requires headless authenticate so
    // Grok does not try a TTY/GUI login from a Codex-spawned child.
    return { methodId: method.methodId, _meta: { headless: true } };
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  cliSessionKnownGood(_options?: Pick<StartOptions, "envMode" | "envPassthrough">): boolean {
    return process.env.XAI_API_KEY !== undefined;
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    return providerEnvironment(options, ["XAI_", "GROK_"], ["XAI_API_KEY", "GROK_CONFIG_DIR", "GROK_HOME"]);
  }
}

function grokEffortArgs(effort?: EffortLevel): string[] {
  return effort ? ["--effort", effort] : [];
}
