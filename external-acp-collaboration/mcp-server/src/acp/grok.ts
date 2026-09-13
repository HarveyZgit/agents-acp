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

export class GrokProvider extends AcpProvider {
  readonly name: ProviderName = "grok";
  readonly executable = "grok";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };

  discover(): ProviderAvailability {
    const discovered = super.discover();
    if (!discovered.available) return discovered;
    return {
      ...discovered,
      note: "Model is optional; omit start.model to use the Grok CLI default.",
    };
  }

  command(options: StartOptions): string[] {
    const model = safeModelId(options.model, "Grok");
    const modelArgs = model ? ["--model", model] : [];
    // Official ACP launch is `grok agent stdio`. `--no-auto-update` is the
    // documented scripting flag (global). `--no-leader` forces a local agent so
    // a Codex-spawned child does not need `~/.grok/leader.sock`. Never pass
    // `--always-approve`: each permission stays a user decision.
    return ["--no-auto-update", "--cwd", options.cwd, "agent", "--no-leader", ...modelArgs, "stdio"];
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

  cliSessionKnownGood(): boolean {
    return process.env.XAI_API_KEY !== undefined;
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    return providerEnvironment(options, ["XAI_", "GROK_"], ["XAI_API_KEY", "GROK_CONFIG_DIR", "GROK_HOME"]);
  }
}
