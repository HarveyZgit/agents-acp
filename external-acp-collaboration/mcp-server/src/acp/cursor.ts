import {
  AcpProvider,
  addEnvironmentVariables,
  baseEnvironment,
  type PermissionDecision,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";
import { spawnSync } from "node:child_process";

const CANDIDATES = ["cursor", "cursor-agent", "agent"] as const;

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
  private tried = [...CANDIDATES];

  constructor(probe: CursorProbe = new ProcessCursorProbe()) {
    super();
    this.probe = probe;
  }

  get executable(): string {
    return this.resolve()?.executable ?? CANDIDATES[0];
  }

  discover() {
    const resolved = this.resolve();
    const tried = this.tried.join(", ");
    if (!resolved) {
      return {
        provider: this.name,
        available: false,
        executable: CANDIDATES[0],
        capabilities: this.capabilities,
        note: `No usable Cursor ACP executable found on PATH. Tried: ${tried}.`,
      };
    }
    return {
      provider: this.name,
      available: true,
      executable: resolved.executable,
      version: resolved.version,
      capabilities: this.capabilities,
      note: `Selected ACP launch: ${[resolved.executable, ...resolved.args].join(" ")}. Tried: ${tried}.`,
    };
  }

  command(options: StartOptions): string[] {
    if (options.model) {
      throw new Error("Model selection unavailable for this Cursor ACP version; the documented ACP entry point does not define a model launch or session parameter.");
    }
    const resolved = this.resolve();
    if (!resolved) throw new Error(`No usable Cursor ACP executable found on PATH. Tried: ${this.tried.join(", ")}.`);
    return [...resolved.args];
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

  permissionResponse(decision: PermissionDecision): Record<string, unknown> {
    return { outcome: { outcome: "selected", optionId: decision } };
  }

  private resolve(): ResolvedCursorLaunch | undefined {
    if (this.resolved) return this.resolved;
    const tried: string[] = [];
    for (const executable of CANDIDATES) {
      tried.push(executable);
      const version = this.probe.run(executable, ["--version"]);
      if (!succeeded(version)) continue;
      for (const prefix of acpPrefixes(executable)) {
        const help = this.probe.run(executable, [...prefix, "--help"]);
        if (succeeded(help) && /\bacp\b/i.test(`${help.stdout ?? ""}\n${help.stderr ?? ""}`)) {
          this.tried = tried;
          this.resolved = {
            executable,
            args: prefix,
            version: firstLine(version.stdout),
          };
          return this.resolved;
        }
      }
    }
    this.tried = tried;
    return undefined;
  }
}

function acpPrefixes(executable: string): string[][] {
  return executable === "cursor"
    ? [["acp"], ["agent", "acp"]]
    : [["acp"]];
}

function succeeded(result: CursorProbeResult): boolean {
  return result.error === undefined && result.status === 0;
}

function firstLine(value: string | undefined): string | undefined {
  const line = value?.split(/\r?\n/, 1)[0]?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return line || undefined;
}
