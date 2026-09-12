import {
  AcpProvider,
  addEnvironmentVariables,
  baseEnvironment,
  type ProviderCapabilities,
  type AuthMethod,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";

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
    const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    const ids = new Set(methods.flatMap((method) => (
      typeof method === "object" && method !== null && typeof (method as { id?: unknown }).id === "string"
        ? [(method as { id: string }).id]
        : []
    )));
    if (ids.has("cached_token")) return { methodId: "cached_token" };
    // The CLI, not this plugin, reads a pre-existing environment credential.
    if (ids.has("xai.api_key") && process.env.XAI_API_KEY) return { methodId: "xai.api_key" };
    return undefined;
  }

  protected environment(): NodeJS.ProcessEnv {
    return addEnvironmentVariables(baseEnvironment(), ["XAI_API_KEY"]);
  }
}
