import {
  AcpProvider,
  addEnvironmentVariables,
  baseEnvironment,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";

export class CursorProvider extends AcpProvider {
  readonly name: ProviderName = "cursor";
  readonly executable = "agent";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: false,
    modelSelection: "none",
    supportedModes: ["ask", "plan", "agent"],
  };

  command(options: StartOptions): string[] {
    if (options.model) {
      throw new Error("Model selection unavailable for this Cursor ACP version; the documented ACP entry point does not define a model launch or session parameter.");
    }
    return ["acp"];
  }

  authenticationMethod(initialized: Record<string, unknown>): string | undefined {
    const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    return methods.some((method) => (
      typeof method === "object" && method !== null && (method as { id?: string }).id === "cursor_login"
    )) ? "cursor_login" : undefined;
  }

  protected environment(): NodeJS.ProcessEnv {
    return addEnvironmentVariables(baseEnvironment(), ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]);
  }
}
