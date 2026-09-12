import { spawnSync } from "node:child_process";
import {
  AcpProvider,
  baseEnvironment,
  providerEnvironment,
  type AuthMethod,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";

/**
 * Only the official `cursor-agent` binary is used. `cursor` is the desktop
 * launcher on many machines, and a bare `agent` name collides with other
 * vendors' CLIs (including Grok tooling), so neither is an acceptable
 * fallback for an ACP session.
 */
const EXECUTABLE = "cursor-agent";

export type CursorProbeResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: unknown;
};

export interface CursorProbe {
  run(executable: string, args: string[]): CursorProbeResult;
}

type ResolvedCursorLaunch = {
  executable: string;
  args: string[];
  version?: string;
};

class ProcessCursorProbe implements CursorProbe {
  run(executable: string, args: string[]): CursorProbeResult {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: false,
      env: baseEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : undefined,
      stderr: typeof result.stderr === "string" ? result.stderr : undefined,
      error: result.error,
    };
  }
}

export class CursorProvider extends AcpProvider {
  readonly name: ProviderName = "cursor";
  readonly capabilities: ProviderCapabilities = {
    supportsModelSelection: false,
    modelSelection: "none",
    supportedModes: ["ask", "plan", "agent"],
  };
  private readonly probe: CursorProbe;
  private resolved?: ResolvedCursorLaunch;

  constructor(probe: CursorProbe = new ProcessCursorProbe()) {
    super();
    this.probe = probe;
  }

  get executable(): string {
    return EXECUTABLE;
  }

  discover() {
    const resolved = this.resolve();
    if (!resolved) {
      return {
        provider: this.name,
        available: false,
        executable: EXECUTABLE,
        capabilities: this.capabilities,
        note: "cursor-agent was not found on PATH or does not support `cursor-agent acp`. This provider never falls back to `cursor` or `agent`.",
      };
    }
    return {
      provider: this.name,
      available: true,
      executable: resolved.executable,
      version: resolved.version,
      capabilities: this.capabilities,
      note: `Selected ACP launch: ${[resolved.executable, ...resolved.args].join(" ")}.`,
    };
  }

  command(options: StartOptions): string[] {
    if (options.model) {
      throw new Error("Model selection unavailable for this Cursor ACP version; the documented ACP entry point does not define a model launch or session parameter.");
    }
    const resolved = this.resolve();
    if (!resolved) throw new Error("cursor-agent ACP is unavailable on PATH. This provider intentionally does not fall back to cursor or agent.");
    return [...resolved.args];
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    return readAuthMethods(initialized).find((method) => method.methodId === "cursor_login")
      ?? readAuthMethods(initialized)[0];
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    // Cursor login state lives in the user's CLI config and OS keychain, so the
    // child needs the session context Codex itself was started with.
    return providerEnvironment(options, ["CURSOR_"], ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_CONFIG_DIR"]);
  }

  private resolve(): ResolvedCursorLaunch | undefined {
    if (this.resolved) return this.resolved;
    const version = this.probe.run(EXECUTABLE, ["--version"]);
    if (!succeeded(version)) return undefined;
    const args = ["acp"];
    const help = this.probe.run(EXECUTABLE, [...args, "--help"]);
    if (succeeded(help) && /\bacp\b/i.test(`${help.stdout ?? ""}\n${help.stderr ?? ""}`)) {
      this.resolved = { executable: EXECUTABLE, args, version: firstLine(version.stdout) };
      return this.resolved;
    }
    return undefined;
  }
}

/** ACP descriptors use `methodId`; older agents emitted `id`. */
export function readAuthMethods(initialized: Record<string, unknown>): AuthMethod[] {
  const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  return methods.flatMap((method) => {
    if (!method || typeof method !== "object") return [];
    const descriptor = method as { id?: unknown; methodId?: unknown; type?: unknown };
    const methodId = typeof descriptor.methodId === "string"
      ? descriptor.methodId
      : typeof descriptor.id === "string" ? descriptor.id : undefined;
    if (!methodId) return [];
    return [{ methodId, type: typeof descriptor.type === "string" ? descriptor.type : undefined }];
  });
}

function succeeded(result: CursorProbeResult): boolean {
  return result.error === undefined && result.status === 0;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return line || undefined;
}
