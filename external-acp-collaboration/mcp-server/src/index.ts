import readline from "node:readline";
import { loadConfig, persistConfig, type PluginConfig } from "./config.ts";
import {
  composeCursorLaunchId,
  resolveModelSelection,
  safeEffort,
  safeSpeed,
  type EffortLevel,
  type ModelCatalog,
  type SpeedLevel,
} from "./models.ts";
import { RunController } from "./run-controller.ts";
import { WorkspacePolicy } from "./policy.ts";
import { RunStore } from "./run-store.ts";
import { renderRunPanel } from "../../ui/run-panel/run-panel.ts";

const SERVER_VERSION = "0.2.4-pre.1";

let config = loadConfig();
const store = new RunStore(config.storePath);
let controller = createController(config, store);
let initialized = false;
let shuttingDown = false;

/**
 * Provider children run in their own detached process groups, so the server
 * must terminate them when Codex stops or closes the transport. A crash is
 * reported on stderr instead of silently killing an in-flight run.
 */
function shutdown(reason: string, exitCode?: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    controller.shutdown(reason);
  } catch (error) {
    report("shutdown failed", error);
  }
  if (exitCode !== undefined) process.exit(exitCode);
}

function report(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agents-acp: ${context}: ${message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500)}\n`);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => shutdown(`received ${signal}`, 0));
}
process.on("exit", () => shutdown("the MCP server exited"));
process.on("uncaughtException", (error) => {
  report("uncaught exception", error);
  shutdown("the MCP server hit an uncaught exception", 1);
});
process.on("unhandledRejection", (error) => report("unhandled rejection", error));

const tools = [
  tool("list_providers", "Discover locally installed ACP providers and their documented capabilities.", {
    type: "object",
    properties: {},
  }),
  tool("get_config", "Return centralized runtime paths, defaults, and setup questions. Does not write project-local files.", {
    type: "object",
    properties: {
      suggestedWorkspace: {
        type: "string",
        description: "Current project root to offer as the workspace default during setup.",
      },
    },
  }),
  tool("configure", "Persist default provider/model and workspace under the centralized runtime dir (~/.codex/agents-acp or ~/.claude/agents-acp). Call after the user answers setup questions or names defaults in a prompt. Never creates .agents-acp in a project.", {
    type: "object",
    required: ["userConfirmed"],
    properties: {
      workspace: { type: "string", description: "Absolute workspace root." },
      defaultProvider: { type: "string", enum: ["cursor", "grok"] },
      defaultModel: {
        type: "string",
        description: "User keyword or catalog id. Resolved against the agent model list; the raw keyword is never stored. Empty string clears model, effort, and speed.",
      },
      defaultEffort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description: "Reasoning effort (High). Persisted separately from the model id. Empty string clears.",
      },
      defaultSpeed: {
        type: "string",
        enum: ["fast", "standard"],
        description: "Speed (Fast). Persisted separately. Cursor encodes it in the launch model id.",
      },
      enablePermissionResponses: { type: "boolean" },
      userConfirmed: {
        type: "boolean",
        description: "Must be true after the user chose these defaults or named them in a prompt.",
      },
    },
  }),
  tool("start", "Start an ACP run. Provider/model may be omitted when configure stored defaults. Implement mode requires allowImplement: true and is serialized per workspace.", {
    type: "object",
    required: ["cwd", "prompt", "mode"],
    properties: {
      provider: { type: "string", enum: ["cursor", "grok", "fake"] },
      cwd: { type: "string" },
      prompt: { type: "string", description: "Sent only to the provider process and never persisted." },
      mode: { type: "string", enum: ["review", "plan", "implement"] },
      allowImplement: { type: "boolean" },
      model: {
        type: "string",
        description: "Optional catalog id or keyword. Omit to use the configured default, then the provider CLI default.",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh", "max"],
        description: "Optional effort override for this run.",
      },
      speed: {
        type: "string",
        enum: ["fast", "standard"],
        description: "Optional speed override for this run (Cursor Fast).",
      },
    },
  }),
  tool("status", "Return status, lifecycle stage, elapsed time, pending decisions with their offered option IDs, and recent events.", schema(["runId"])),
  tool("cancel", "Send the ACP cancel notification and stop the local provider process group.", schema(["runId"])),
  tool("resume", "Resume a saved ACP provider session in the same cwd.", {
    type: "object",
    required: ["followUp"],
    properties: {
      runId: { type: "string" },
      provider: { type: "string", enum: ["cursor", "grok", "fake"] },
      sessionId: { type: "string" },
      followUp: { type: "string", description: "Sent only to the provider process and never persisted." },
      allowImplement: { type: "boolean" },
    },
  }),
  tool("result", "Return final in-memory text, stop reason, changed-file summary, errors, and verification advice.", schema(["runId"])),
  tool("respond_permission", "Answer a pending ACP permission with one of the provider's offered optionIds. Keep this tool approval-prompted in Codex.", {
    type: "object",
    required: ["runId", "requestId", "optionId", "userConfirmed"],
    properties: {
      runId: { type: "string" },
      requestId: { type: "string" },
      optionId: { type: "string", description: "Must be one of the optionIds reported by status." },
      userConfirmed: { type: "boolean", description: "Must be true only after the human user selected the option." },
    },
  }),
  tool("respond_question", "Answer a pending Cursor multiple-choice question, or skip it.", {
    type: "object",
    required: ["runId", "requestId", "userConfirmed"],
    properties: {
      runId: { type: "string" },
      requestId: { type: "string" },
      answers: {
        type: "array",
        items: {
          type: "object",
          required: ["questionId", "selectedOptionIds"],
          properties: {
            questionId: { type: "string" },
            selectedOptionIds: { type: "array", items: { type: "string" } },
          },
        },
      },
      userConfirmed: { type: "boolean" },
    },
  }),
  tool("respond_plan", "Accept or reject a pending Cursor plan approval request.", {
    type: "object",
    required: ["runId", "requestId", "accept", "userConfirmed"],
    properties: {
      runId: { type: "string" },
      requestId: { type: "string" },
      accept: { type: "boolean" },
      reason: { type: "string" },
      userConfirmed: { type: "boolean" },
    },
  }),
];

const input = readline.createInterface({ input: process.stdin });
// When the client closes stdin the server has no further work; exit instead of
// lingering with live provider children.
input.on("close", () => shutdown("the Codex transport closed", 0));
input.on("line", async (line) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRequest(parsed)) {
    const id = objectId(parsed);
    if (id !== undefined) respondError(id, "Invalid JSON-RPC request.");
    return;
  }
  const request = parsed;
  try {
    const result = await dispatch(request.method as string, asObject(request.params ?? {}));
    if (request.id !== undefined) respond(request.id, result);
  } catch (error) {
    if (request.id !== undefined) {
      respondError(request.id, error instanceof Error ? error.message : "Unexpected server error");
    }
  }
});

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      initialized = true;
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: { listChanged: false } },
        serverInfo: { name: "agents-acp", version: SERVER_VERSION },
        instructions: "Call get_config first. If needsSetup, ask the user (or use defaults they already named) then call configure. Runtime files stay in the centralized runtimeDir from get_config (~/.codex/agents-acp or ~/.claude/agents-acp); never create a project-local .agents-acp directory. Runs are confined to the configured workspace. ACP permissions stay pending until a user-confirmed response tool call selects one of the provider's offered optionIds.",
      };
    case "ping":
      return {};
    default:
      if (!initialized) throw new Error("MCP initialize must complete before this method.");
  }
  switch (method) {
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(requiredString(params.name, "tool name", 100), asObject(params.arguments ?? {}));
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return {
        resourceTemplates: [{
          uriTemplate: "agents-acp://runs/{runId}",
          name: "agents-acp run panel",
          description: "Structured run state with an optional generic HTML rendering.",
          mimeType: "text/html",
        }],
      };
    case "resources/read": {
      const uri = requiredString(params.uri, "resource URI", 512, true);
      const match = /^agents-acp:\/\/runs\/([^/]+)$/.exec(uri);
      if (!match) throw new Error("Unknown resource URI.");
      return { contents: [{ uri, mimeType: "text/html", text: renderRunPanel(controller.status(match[1])) }] };
    }
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    let result: unknown;
    switch (name) {
      case "list_providers":
        onlyKeys(args, []);
        result = {
          providers: controller.listProviders(),
          ...publicConfig(config, controller.listModels()),
        };
        break;
      case "get_config":
        onlyKeys(args, ["suggestedWorkspace"]);
        result = configSnapshot(optionalString(args.suggestedWorkspace, "suggestedWorkspace", 4_096));
        break;
      case "configure":
        onlyKeys(args, ["workspace", "defaultProvider", "defaultModel", "defaultEffort", "defaultSpeed", "enablePermissionResponses", "userConfirmed"]);
        if (args.userConfirmed !== true) throw new Error("configure requires explicit userConfirmed: true after the user chose or named these defaults.");
        result = applyConfigure(args);
        break;
      case "start":
        onlyKeys(args, ["provider", "cwd", "prompt", "mode", "allowImplement", "model", "effort", "speed"]);
        requireWorkspaceConfiguration();
        result = controller.start({
          provider: resolveStartProvider(args.provider),
          cwd: requiredString(args.cwd, "cwd", 4_096, true),
          prompt: requiredString(args.prompt, "prompt", 65_536),
          mode: stringEnum(args.mode, ["review", "plan", "implement"]),
          allowImplement: args.allowImplement === true,
          ...resolveStartSelection(args.provider, args.model, args.effort, args.speed),
        });
        break;
      case "status":
        onlyKeys(args, ["runId"]);
        result = controller.status(requiredString(args.runId, "runId", 128));
        break;
      case "cancel":
        onlyKeys(args, ["runId"]);
        result = await controller.cancel(requiredString(args.runId, "runId", 128));
        break;
      case "resume":
        onlyKeys(args, ["runId", "provider", "sessionId", "followUp", "allowImplement"]);
        requireWorkspaceConfiguration();
        result = controller.resume({
          runId: optionalString(args.runId, "runId", 128),
          provider: args.provider === undefined ? undefined : stringEnum(args.provider, ["cursor", "grok", "fake"]),
          sessionId: optionalString(args.sessionId, "sessionId", 512),
          followUp: requiredString(args.followUp, "followUp", 65_536),
          allowImplement: args.allowImplement === true,
        });
        break;
      case "result":
        onlyKeys(args, ["runId"]);
        result = controller.result(requiredString(args.runId, "runId", 128));
        break;
      case "respond_permission":
        onlyKeys(args, ["runId", "requestId", "optionId", "userConfirmed"]);
        requirePermissionResponses(args.userConfirmed);
        result = controller.respondPermission(
          requiredString(args.runId, "runId", 128),
          requiredString(args.requestId, "requestId", 128),
          requiredString(args.optionId, "optionId", 128),
        );
        break;
      case "respond_question":
        onlyKeys(args, ["runId", "requestId", "answers", "userConfirmed"]);
        requirePermissionResponses(args.userConfirmed);
        result = controller.respondQuestion(
          requiredString(args.runId, "runId", 128),
          requiredString(args.requestId, "requestId", 128),
          readAnswers(args.answers),
        );
        break;
      case "respond_plan":
        onlyKeys(args, ["runId", "requestId", "accept", "reason", "userConfirmed"]);
        requirePermissionResponses(args.userConfirmed);
        if (typeof args.accept !== "boolean") throw new Error("Expected accept to be a boolean.");
        result = controller.respondPlan(
          requiredString(args.runId, "runId", 128),
          requiredString(args.requestId, "requestId", 128),
          args.accept,
          optionalString(args.reason, "reason", 512),
        );
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return success(result);
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }) }],
      isError: true,
    };
  }
}

function readAnswers(value: unknown): Array<{ questionId: string; selectedOptionIds: string[] }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected answers to be an array.");
  return value.map((entry) => {
    const answer = asObject(entry);
    const selected = answer.selectedOptionIds;
    if (!Array.isArray(selected) || selected.some((option) => typeof option !== "string")) {
      throw new Error("Expected selectedOptionIds to be an array of strings.");
    }
    return {
      questionId: requiredString(answer.questionId, "questionId", 128),
      selectedOptionIds: selected as string[],
    };
  });
}

function tool(name: string, description: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
  return { name, description, inputSchema };
}

function schema(required: string[]): Record<string, unknown> {
  return {
    type: "object",
    required,
    properties: Object.fromEntries(required.map((name) => [name, { type: "string" }])),
  };
}

function success(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

function respond(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maximumLength: number, forbidControl = false): string {
  if (typeof value !== "string" || !value || value.length > maximumLength || (forbidControl && /[\0-\x1f\x7f]/.test(value))) {
    throw new Error(`Expected ${name} to be a non-empty string no longer than ${maximumLength} characters.`);
  }
  return value;
}

function optionalString(value: unknown, name: string, maximumLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maximumLength);
}

function stringEnum<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Expected one of: ${values.join(", ")}`);
  return value as T;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`Unexpected tool argument: ${unexpected[0]}`);
}

function createController(next: PluginConfig, runStore: RunStore): RunController {
  return new RunController(
    runStore,
    createPolicy(next),
    {
      enableFake: next.enableFake,
      maxRunMs: next.maxRunMs,
      idleTimeoutMs: next.idleTimeoutMs,
      envMode: next.envMode,
      envPassthrough: next.cursorEnvPassthrough,
    },
  );
}

function createPolicy(next: PluginConfig): WorkspacePolicy {
  return new WorkspacePolicy(
    next.workspace ?? process.cwd(),
    next.workspace ? next.allowedSubtrees : [],
    next.allowUnsandboxedImplement,
  );
}

function publicConfig(next: PluginConfig, catalogs: ModelCatalog[] = []) {
  const catalog = catalogs.find((item) => item.provider === next.defaultProvider)?.models ?? [];
  return {
    runtimeDir: next.runtimeDir,
    configPath: next.configPath,
    configLoaded: next.configLoaded,
    workspace: next.workspace,
    defaultProvider: next.defaultProvider,
    defaultModel: next.defaultModel,
    defaultEffort: next.defaultEffort,
    defaultSpeed: next.defaultSpeed,
    launchModel: next.defaultProvider && next.defaultModel
      ? launchModelFor(next.defaultProvider, next.defaultModel, next.defaultEffort, next.defaultSpeed, catalog)
      : undefined,
    enablePermissionResponses: next.enablePermissionResponses,
    needsSetup: !next.workspace || !next.defaultProvider,
    writesProjectRuntimeDir: false,
    host: next.host,
  };
}

function configSnapshot(suggestedWorkspace?: string) {
  const providers = controller.listProviders().map((provider) => ({
    provider: provider.provider,
    available: provider.available,
    version: provider.version,
    note: provider.note,
  }));
  const catalogs = controller.listModels();
  const snapshot = publicConfig(config, catalogs);
  return {
    ...snapshot,
    providers,
    catalogs,
    setupQuestions: snapshot.needsSetup
      ? [
        {
          id: "defaultProvider",
          prompt: "Which ACP agent should be the default?",
          options: [
            { id: "cursor", label: "Cursor CLI (cursor-agent)" },
            { id: "grok", label: "Grok Build (grok)" },
          ],
        },
        ...modelSetupQuestions(catalogs.find((catalog) => catalog.provider === config.defaultProvider)),
        {
          id: "workspace",
          prompt: "Absolute workspace root the provider may run in.",
          suggested: suggestedWorkspace,
          optional: Boolean(config.workspace),
        },
      ]
      : modelSetupQuestions(catalogs.find((catalog) => catalog.provider === config.defaultProvider)),
  };
}

function applyConfigure(args: Record<string, unknown>) {
  const previousWorkspace = config.workspace;
  const provider = args.defaultProvider === undefined
    ? config.defaultProvider
    : stringEnum(args.defaultProvider, ["cursor", "grok"]);
  const resolved = resolveConfigureSelection(provider, args);
  const next = persistConfig({
    workspace: optionalString(args.workspace, "workspace", 4_096),
    defaultProvider: args.defaultProvider === undefined
      ? undefined
      : stringEnum(args.defaultProvider, ["cursor", "grok"]),
    defaultModel: resolved.model,
    defaultEffort: resolved.effort,
    defaultSpeed: resolved.speed,
    enablePermissionResponses: args.enablePermissionResponses === undefined
      ? undefined
      : args.enablePermissionResponses === true,
  });
  if (next.workspace !== previousWorkspace || next.allowUnsandboxedImplement !== config.allowUnsandboxedImplement) {
    controller.replacePolicy(createPolicy(next));
  }
  config = next;
  return {
    ...configSnapshot(),
    resolved,
  };
}

function resolveStartProvider(value: unknown): "cursor" | "grok" | "fake" {
  if (value !== undefined) {
    const provider = stringEnum(value, ["cursor", "grok", "fake"]);
    if (provider === "fake" && !config.enableFake) throw new Error("The fake provider is disabled.");
    return provider;
  }
  if (config.defaultProvider) return config.defaultProvider;
  throw new Error(`No default provider is configured. Ask the user, then call configure, or pass provider on start. Settings live in ${config.configPath}.`);
}

function resolveStartSelection(
  providerValue: unknown,
  modelValue: unknown,
  effortValue: unknown,
  speedValue: unknown,
): { model?: string; effort?: EffortLevel; speed?: SpeedLevel } {
  const provider = providerValue === undefined
    ? config.defaultProvider
    : stringEnum(providerValue, ["cursor", "grok", "fake"]);
  const useStored = provider === config.defaultProvider;
  const explicitModel = optionalString(modelValue, "model", 256);
  const effort = effortValue === undefined ? (useStored ? config.defaultEffort : undefined) : optionalEnum(safeEffort(effortValue));
  const speed = speedValue === undefined ? (useStored ? config.defaultSpeed : undefined) : optionalEnum(safeSpeed(speedValue));
  if (explicitModel !== undefined) {
    const catalog = provider === "cursor" || provider === "grok"
      ? controller.listModels(provider)[0]?.models ?? []
      : [];
    const resolved = resolveModelSelection(catalog, explicitModel, effort, speed, provider === "grok" ? "grok" : "cursor");
    return { model: resolved?.model, effort: resolved?.effort, speed: resolved?.speed };
  }
  if (!useStored) return { effort, speed };
  return { model: config.defaultModel, effort, speed };
}

function resolveConfigureSelection(provider: "cursor" | "grok" | undefined, args: Record<string, unknown>) {
  const clearingModel = args.defaultModel === "" || args.defaultModel === null;
  if (clearingModel) {
    return { model: null, effort: null, speed: null, launchId: undefined as string | undefined };
  }
  const query = args.defaultModel === undefined
    ? undefined
    : requiredString(args.defaultModel, "defaultModel", 256);
  const effort = args.defaultEffort === undefined ? undefined : safeEffort(args.defaultEffort);
  const speed = args.defaultSpeed === undefined ? undefined : safeSpeed(args.defaultSpeed);
  if (query === undefined && effort === undefined && speed === undefined) {
    return { model: undefined, effort: undefined, speed: undefined, launchId: undefined as string | undefined };
  }
  if (!provider) {
    throw new Error("Set defaultProvider before resolving a model keyword.");
  }
  const catalog = controller.listModels(provider)[0] ?? { provider, available: false, models: [] };
  const resolved = resolveModelSelection(
    catalog.models,
    query ?? config.defaultModel,
    effort === null ? undefined : effort ?? config.defaultEffort,
    speed === null ? undefined : speed ?? config.defaultSpeed,
    provider,
  );
  if (!resolved && query) {
    throw new Error(`Could not resolve model keyword against the ${provider} catalog.`);
  }
  return {
    model: query === undefined && !resolved ? undefined : resolved?.model ?? null,
    effort: effort === null ? null : resolved?.effort ?? effort,
    speed: speed === null ? null : resolved?.speed ?? speed,
    launchId: resolved?.launchId,
    query,
    catalogId: resolved?.model,
  };
}

function launchModelFor(
  provider: "cursor" | "grok",
  model: string,
  effort?: EffortLevel,
  speed?: SpeedLevel,
  catalog: ModelCatalog["models"] = [],
): string {
  return provider === "cursor" ? composeCursorLaunchId(model, effort, speed, catalog) : model;
}

function modelSetupQuestions(catalog?: ModelCatalog) {
  const options = (catalog?.models ?? [])
    .filter((model, index, all) => all.findIndex((entry) => entry.base === model.base) === index)
    .slice(0, 40)
    .map((model) => ({ id: model.base, label: `${model.label} (${model.base})` }));
  return [
    {
      id: "defaultModel",
      prompt: "Default model keyword or catalog id. The skill must resolve this against the agent model list and persist the catalog id, never the raw keyword.",
      optional: true,
      options,
    },
    {
      id: "defaultEffort",
      prompt: "Reasoning effort (High). Persist separately; do not bake it into a guessed model string.",
      optional: true,
      options: [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "xhigh" },
        { id: "max", label: "max" },
      ],
    },
    {
      id: "defaultSpeed",
      prompt: "Speed (Fast). Persist separately. Cursor composes this into the launch model id.",
      optional: true,
      options: [
        { id: "fast", label: "Fast" },
        { id: "standard", label: "standard" },
      ],
    },
  ];
}

function optionalEnum<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function requireWorkspaceConfiguration(): void {
  if (!config.workspace) {
    throw new Error(`No workspace is configured. Call get_config, then configure, or set "workspace" in ${config.configPath}.`);
  }
}

function requirePermissionResponses(userConfirmed: unknown): void {
  if (!config.enablePermissionResponses) {
    throw new Error(`Responses are disabled. Set "enablePermissionResponses": true in ${config.configPath} or forward EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES=1.`);
  }
  if (userConfirmed !== true) throw new Error("A response requires explicit userConfirmed: true.");
}

type JsonRpcRequest = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
};

function isRequest(value: unknown): value is JsonRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return request.jsonrpc === "2.0"
    && typeof request.method === "string"
    && (request.id === undefined || typeof request.id === "string" || typeof request.id === "number")
    && (request.params === undefined || (request.params !== null && typeof request.params === "object" && !Array.isArray(request.params)));
}

function objectId(value: unknown): number | string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}
