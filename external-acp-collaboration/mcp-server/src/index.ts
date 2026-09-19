import readline from "node:readline";
import { loadConfig, persistConfig, type PluginConfig } from "./config.ts";
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
  tool("configure", "Persist default provider/model and workspace under ~/.codex/agents-acp. Call after the user answers setup questions or names defaults in a prompt. Never creates .agents-acp in a project.", {
    type: "object",
    required: ["userConfirmed"],
    properties: {
      workspace: { type: "string", description: "Absolute workspace root." },
      defaultProvider: { type: "string", enum: ["cursor", "grok"] },
      defaultModel: {
        type: "string",
        description: "Optional CLI model pin. Empty string clears the stored default.",
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
        description: "Optional. Omit to use the configured default, then the provider CLI default.",
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
        instructions: "Call get_config first. If needsSetup, ask the user (or use defaults they already named) then call configure. Runtime files stay in ~/.codex/agents-acp; never create a project-local .agents-acp directory. Runs are confined to the configured workspace. ACP permissions stay pending until an approval-prompted, user-confirmed response tool call selects one of the provider's offered optionIds.",
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
          ...publicConfig(config),
        };
        break;
      case "get_config":
        onlyKeys(args, ["suggestedWorkspace"]);
        result = configSnapshot(optionalString(args.suggestedWorkspace, "suggestedWorkspace", 4_096));
        break;
      case "configure":
        onlyKeys(args, ["workspace", "defaultProvider", "defaultModel", "enablePermissionResponses", "userConfirmed"]);
        if (args.userConfirmed !== true) throw new Error("configure requires explicit userConfirmed: true after the user chose or named these defaults.");
        result = applyConfigure(args);
        break;
      case "start":
        onlyKeys(args, ["provider", "cwd", "prompt", "mode", "allowImplement", "model"]);
        requireWorkspaceConfiguration();
        result = controller.start({
          provider: resolveStartProvider(args.provider),
          cwd: requiredString(args.cwd, "cwd", 4_096, true),
          prompt: requiredString(args.prompt, "prompt", 65_536),
          mode: stringEnum(args.mode, ["review", "plan", "implement"]),
          allowImplement: args.allowImplement === true,
          model: resolveStartModel(args.provider, args.model),
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

function publicConfig(next: PluginConfig) {
  return {
    runtimeDir: next.runtimeDir,
    configPath: next.configPath,
    configLoaded: next.configLoaded,
    workspace: next.workspace,
    defaultProvider: next.defaultProvider,
    defaultModel: next.defaultModel,
    enablePermissionResponses: next.enablePermissionResponses,
    needsSetup: !next.workspace || !next.defaultProvider,
    writesProjectRuntimeDir: false,
  };
}

function configSnapshot(suggestedWorkspace?: string) {
  const providers = controller.listProviders().map((provider) => ({
    provider: provider.provider,
    available: provider.available,
    version: provider.version,
    note: provider.note,
  }));
  const snapshot = publicConfig(config);
  return {
    ...snapshot,
    providers,
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
        {
          id: "defaultModel",
          prompt: "Optional default model. Leave unset to use the CLI default / selectedModel.",
          optional: true,
        },
        {
          id: "workspace",
          prompt: "Absolute workspace root the provider may run in.",
          suggested: suggestedWorkspace,
          optional: Boolean(config.workspace),
        },
      ]
      : [],
  };
}

function applyConfigure(args: Record<string, unknown>) {
  const previousWorkspace = config.workspace;
  const next = persistConfig({
    workspace: optionalString(args.workspace, "workspace", 4_096),
    defaultProvider: args.defaultProvider === undefined
      ? undefined
      : stringEnum(args.defaultProvider, ["cursor", "grok"]),
    defaultModel: args.defaultModel === undefined
      ? undefined
      : args.defaultModel === "" || args.defaultModel === null
        ? null
        : requiredString(args.defaultModel, "defaultModel", 256),
    enablePermissionResponses: args.enablePermissionResponses === undefined
      ? undefined
      : args.enablePermissionResponses === true,
  });
  if (next.workspace !== previousWorkspace || next.allowUnsandboxedImplement !== config.allowUnsandboxedImplement) {
    controller.replacePolicy(createPolicy(next));
  }
  config = next;
  return configSnapshot();
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

function resolveStartModel(providerValue: unknown, modelValue: unknown): string | undefined {
  const explicit = optionalString(modelValue, "model", 256);
  if (explicit !== undefined) return explicit;
  const provider = providerValue === undefined
    ? config.defaultProvider
    : stringEnum(providerValue, ["cursor", "grok", "fake"]);
  return provider === config.defaultProvider ? config.defaultModel : undefined;
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
