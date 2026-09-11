import { fileURLToPath } from "node:url";
import {
  AcpProvider,
  type PermissionDecision,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";

/**
 * A deterministic ACP fixture for smoke tests. It is never registered unless
 * EXTERNAL_ACP_ENABLE_FAKE=1 is supplied to the MCP server process.
 */
export class FakeProvider extends AcpProvider {
  readonly name: ProviderName = "fake";
  readonly executable = process.execPath;
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: false,
    modelSelection: "none",
    supportedModes: ["ask", "plan", "agent"],
  };

  command(options: StartOptions): string[] {
    if (options.model) throw new Error("Model selection is unavailable for the bundled fake ACP provider.");
    return ["--experimental-strip-types", fileURLToPath(new URL("./fake-agent.ts", import.meta.url))];
  }

  discover(): ProviderAvailability {
    return {
      provider: "fake",
      available: true,
      executable: process.execPath,
      version: "bundled-test-fixture",
      capabilities: this.capabilities,
      note: "Enabled only for deterministic local smoke testing.",
    };
  }

  authenticationMethod(initialized: Record<string, unknown>): string | undefined {
    const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    return methods.some((method) => (
      typeof method === "object" && method !== null && (method as { id?: string }).id === "fake_local"
    )) ? "fake_local" : undefined;
  }

  permissionResponse(decision: PermissionDecision): Record<string, unknown> {
    return { outcome: { outcome: "selected", optionId: decision } };
  }
}
