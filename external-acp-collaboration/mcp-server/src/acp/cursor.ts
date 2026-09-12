import {
  AcpProvider,
  addEnvironmentVariables,
  baseEnvironment,
  type PermissionDecision,
  type AuthMethod,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";
import { spawnSync } from "node:child_process";

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
      timeout: 2_000,
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
    return this.resolve()?.executable ?? EXECUTABLE;
  }

  discover() {
    const resolved = this.resolve();
    if (!resolved) {
      return {
        provider: this.name,
        available: false,
        executable: EXECUTABLE,
        capabilities: this.capabilities,
        note: "cursor-agent was not found on PATH or does not support `cursor-agent acp`.",
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
    const methods = Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
    for (const method of methods) {
      if (!method || typeof method !== "object") continue;
      const descriptor = method as { id?: unknown; methodId?: unknown; type?: unknown };
      const methodId = typeof descriptor.methodId === "string"
        ? descriptor.methodId
        : typeof descriptor.id === "string" ? descriptor.id : undefined;
      if (methodId === "cursor_login") {
        return { methodId, type: typeof descriptor.type === "string" ? descriptor.type : undefined };
      }
    }
    return undefined;
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  allowsPreauthenticatedSessionFallback(): boolean {
    return true;
  }

  protected environment(): NodeJS.ProcessEnv {
    if (process.env.EXTERNAL_ACP_ENV_MODE !== "allowlist") {
      // Cursor login can be mediated by macOS Keychain and session-specific
      // variables. Preserve the launcher's environment by default, matching
      // the documented CLI examples, without ever logging its values.
      return { ...process.env };
    }
    return addEnvironmentVariables(baseEnvironment(), ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]);
  }

  permissionResponse(decision: PermissionDecision): Record<string, unknown> {
    return { outcome: { outcome: "selected", optionId: decision } };
  }

  private resolve(): ResolvedCursorLaunch | undefined {
    if (this.resolved) return this.resolved;
    const version = this.probe.run(EXECUTABLE, ["--version"]);
    if (!succeeded(version)) return undefined;
    const prefix = ["acp"];
    const help = this.probe.run(EXECUTABLE, [...prefix, "--help"]);
    if (succeeded(help) && /\bacp\b/i.test(`${help.stdout ?? ""}\n${help.stderr ?? ""}`)) {
      this.resolved = {
        executable: EXECUTABLE,
        args: prefix,
        version: firstLine(version.stdout),
      };
      return this.resolved;
    }
    return undefined;
  }
}

function succeeded(result: CursorProbeResult): boolean {
  return result.error === undefined && result.status === 0;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return line || undefined;
}
