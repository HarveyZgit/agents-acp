import {
  AcpProvider,
  providerEnvironment,
  type AuthMethod,
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

  command(options: StartOptions): string[] {
    if (options.model && (!/^[A-Za-z0-9._:/-]{1,128}$/.test(options.model) || options.model.startsWith("-"))) {
      throw new Error("Grok model must be a documented model identifier and cannot be interpreted as a CLI flag.");
    }
    const modelArgs = options.model ? ["--model", options.model] : [];
    // --no-auto-update is documented for ACP scripting. Deliberately omit
    // --always-approve: each permission must remain a user decision.
    return ["--no-auto-update", "agent", ...modelArgs, "stdio"];
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    const methods = readAuthMethods(initialized);
    return methods.find((method) => method.methodId === "cached_token")
      // The CLI, not this plugin, reads a pre-existing environment credential.
      ?? methods.find((method) => method.methodId === "xai.api_key" && process.env.XAI_API_KEY !== undefined);
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    return providerEnvironment(options, ["XAI_", "GROK_"], ["XAI_API_KEY", "GROK_CONFIG_DIR"]);
  }
}
