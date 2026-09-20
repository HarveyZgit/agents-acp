import { fileURLToPath } from "node:url";
import {
  AcpProvider,
  baseEnvironment,
  type AuthMethod,
  type ProviderAvailability,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";
import { readAuthMethods } from "./cursor.ts";
import { inspectLaunch } from "./launch-inspect.ts";

/**
 * A deterministic ACP fixture for smoke tests. It is never registered unless
 * the fake provider is explicitly enabled for the MCP server process.
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
    const args = this.command({ cwd: process.cwd(), prompt: "", mode: "review" });
    return {
      provider: "fake",
      available: true,
      executable: process.execPath,
      version: "bundled-test-fixture",
      capabilities: this.capabilities,
      note: "Enabled only for deterministic local smoke testing.",
      launch: inspectLaunch({
        executable: process.execPath,
        args,
        source: "path",
        collisionNames: [],
      }),
    };
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    return readAuthMethods(initialized).find((method) => method.methodId === "fake_local");
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  protected environment(): NodeJS.ProcessEnv {
    return { ...baseEnvironment(), FAKE_ACP_REQUIRE_AUTH: process.env.FAKE_ACP_REQUIRE_AUTH ?? "" };
  }
}
