import { spawnSync } from "node:child_process";
import {
  AcpProvider,
  providerEnvironment,
  safeModelId,
  type AuthMethod,
  type ProviderCapabilities,
  type ProviderName,
  type StartOptions,
} from "./provider.ts";
import { composeCursorLaunchId, parseListModelsOutput, type ModelCatalog } from "../models.ts";
import { inspectLaunch, resolveOnPath, type CommandClassifier } from "./launch-inspect.ts";

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
  run(executable: string, args: string[], env?: NodeJS.ProcessEnv): CursorProbeResult;
}

const CURSOR_ENV_NAMES = [
  "CURSOR_API_KEY",
  "CURSOR_AUTH_TOKEN",
  "CURSOR_CONFIG_DIR",
  "AGENT_CLI_CREDENTIAL_STORE",
];

/** Same allowlist the ACP child receives, including keychain/session variables. */
export function cursorChildEnvironment(options: StartOptions): NodeJS.ProcessEnv {
  return providerEnvironment(options, ["CURSOR_"], CURSOR_ENV_NAMES);
}

function probeEnvironment(options?: Pick<StartOptions, "envMode" | "envPassthrough">): NodeJS.ProcessEnv {
  return cursorChildEnvironment({
    cwd: process.cwd(),
    prompt: "",
    mode: "review",
    envMode: options?.envMode ?? "session",
    envPassthrough: options?.envPassthrough,
  });
}

type ResolvedCursorLaunch = {
  executable: string;
  args: string[];
  version?: string;
};

const CURSOR_COLLISIONS = ["cursor", "agent"];

class ProcessCursorProbe implements CursorProbe {
  run(executable: string, args: string[], env: NodeJS.ProcessEnv = probeEnvironment()): CursorProbeResult {
    const result = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
      shell: false,
      env,
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
    supportsModelSelection: true,
    modelSelection: "startup",
    supportedModes: ["ask", "plan", "agent"],
  };
  private readonly probe: CursorProbe;
  private readonly classifier?: CommandClassifier;
  private resolved?: ResolvedCursorLaunch;

  constructor(probe: CursorProbe = new ProcessCursorProbe(), classifier?: CommandClassifier) {
    super();
    this.probe = probe;
    this.classifier = classifier;
  }

  get executable(): string {
    return this.resolved?.executable ?? EXECUTABLE;
  }

  discover() {
    const resolved = this.resolve();
    if (!resolved) {
      const launch = inspectLaunch({
        args: ["acp"],
        source: "missing",
        collisionNames: CURSOR_COLLISIONS,
        classifier: this.classifier,
      });
      return {
        provider: this.name,
        available: false,
        executable: EXECUTABLE,
        capabilities: this.capabilities,
        note: "cursor-agent was not found on PATH or does not support `cursor-agent acp`. This provider never falls back to `cursor` or `agent`.",
        launch,
      };
    }
    const launch = inspectLaunch({
      executable: resolved.executable,
      args: resolved.args,
      source: "path",
      collisionNames: CURSOR_COLLISIONS,
      classifier: this.classifier,
    });
    return {
      provider: this.name,
      available: true,
      executable: resolved.executable,
      version: resolved.version,
      capabilities: this.capabilities,
      note: `Selected ACP launch: ${launch.argv} (shell:false). Optional start.model is a catalog id; start.effort (high) and start.speed (fast) are persisted separately and composed into the launch id (for example composer-2.5-high-fast). User cursor/agent wrappers are not followed.`,
      launch,
    };
  }

  command(options: StartOptions): string[] {
    const resolved = this.resolve();
    if (!resolved) throw new Error("cursor-agent ACP is unavailable on PATH. This provider intentionally does not fall back to cursor or agent.");
    const model = safeModelId(options.model, "Cursor");
    const catalog = options.catalog ?? this.listModels(options).models;
    const launch = model
      ? composeCursorLaunchId(model, options.effort, options.speed, catalog)
      : undefined;
    // Official ACP docs omit a universal model field; the CLI still accepts
    // `cursor-agent --model <id> acp`. Effort/speed are encoded in that id.
    return launch ? ["--model", launch, ...resolved.args] : [...resolved.args];
  }

  listModels(options?: Pick<StartOptions, "envMode" | "envPassthrough">): ModelCatalog {
    const env = probeEnvironment(options);
    const listed = this.probe.run(EXECUTABLE, ["--list-models"], env);
    const fallback = succeeded(listed) ? listed : this.probe.run(EXECUTABLE, ["models"], env);
    if (!succeeded(fallback)) {
      return {
        provider: "cursor",
        available: false,
        models: [],
        error: "cursor-agent --list-models is unavailable. Start Codex from the same login where cursor-agent models works.",
      };
    }
    const models = parseListModelsOutput(`${fallback.stdout ?? ""}\n${fallback.stderr ?? ""}`);
    return {
      provider: "cursor",
      available: models.length > 0,
      models,
      error: models.length > 0 ? undefined : "cursor-agent listed no models for this account.",
    };
  }

  authenticationMethod(initialized: Record<string, unknown>): AuthMethod | undefined {
    return readAuthMethods(initialized).find((method) => method.methodId === "cursor_login")
      ?? readAuthMethods(initialized)[0];
  }

  prefersSessionBeforeAuthentication(): boolean {
    return true;
  }

  cliSessionKnownGood(options?: Pick<StartOptions, "envMode" | "envPassthrough">): boolean {
    const result = this.probe.run(EXECUTABLE, ["status"], probeEnvironment(options));
    if (!succeeded(result)) return false;
    const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (/not logged in|logged out|unauthenticated/i.test(text)) return false;
    return /logged in|authenticated/i.test(text) || result.status === 0;
  }

  protected environment(options: StartOptions): NodeJS.ProcessEnv {
    // Tokens live in the macOS keychain (or ~/.cursor/auth.json when
    // AGENT_CLI_CREDENTIAL_STORE=file). The child needs the same login-session
    // variables Codex itself was started with.
    return cursorChildEnvironment(options);
  }

  private resolve(): ResolvedCursorLaunch | undefined {
    if (this.resolved) return this.resolved;
    const version = this.probe.run(EXECUTABLE, ["--version"]);
    if (!succeeded(version)) return undefined;
    const args = ["acp"];
    const help = this.probe.run(EXECUTABLE, [...args, "--help"]);
    if (succeeded(help) && /\bacp\b/i.test(`${help.stdout ?? ""}\n${help.stderr ?? ""}`)) {
      this.resolved = {
        executable: resolveOnPath(EXECUTABLE) ?? EXECUTABLE,
        args,
        version: firstLine(version.stdout),
      };
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
