import path from "node:path";
import readline from "node:readline";
import { RunController } from "./run-controller.ts";
import { WorkspacePolicy } from "./policy.ts";
import { RunStore } from "./run-store.ts";
import { renderRunPanel } from "../../ui/run-panel/run-panel.ts";

const workspace = process.env.EXTERNAL_ACP_WORKSPACE;
const authorizedSubtrees = (workspace ? (process.env.EXTERNAL_ACP_ALLOWED_SUBTREES ?? "") : "")
  .split(path.delimiter)
  .filter(Boolean);
const store = new RunStore(process.env.EXTERNAL_ACP_STORE_PATH);
const configurationError = workspace
  ? undefined
  : "EXTERNAL_ACP_WORKSPACE must be set to an existing absolute workspace path before starting or resuming a run.";
const controller = new RunController(
  store,
  new WorkspacePolicy(workspace ?? process.cwd(), authorizedSubtrees, process.env.EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT === "1"),
  undefined,
  process.env.EXTERNAL_ACP_ENABLE_FAKE === "1",
  positiveIntegerEnvironment("EXTERNAL_ACP_MAX_RUN_MS", 7_200_000, 60_000, 86_400_000),
);
let initialized = false;
const permissionResponsesEnabled = process.env.EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES === "1";

const tools = [
  tool("list_external_agent_providers", "Discover locally installed ACP providers and their documented capabilities.", { type: "object", properties: {} }),
  tool("start_external_agent", "Start an ACP run. Implement mode requires allowImplement: true and is serialized per workspace.", {
    type: "object",
    required: ["provider", "cwd", "prompt", "mode"],
    properties: {
      provider: { type: "string", enum: ["cursor", "grok", "fake"] },
      cwd: { type: "string" },
      prompt: { type: "string", description: "Sent only to the provider process and never persisted." },
      mode: { type: "string", enum: ["review", "plan", "implement"] },
      allowImplement: { type: "boolean" },
      model: { type: "string" },
    },
  }),
  tool("get_external_agent_status", "Return status, elapsed time, pending user decisions, and recent in-memory events.", schema(["runId"])),
  tool("cancel_external_agent", "Request ACP cancellation and terminate the local provider process.", schema(["runId"])),
  tool("resume_external_agent", "Resume a saved ACP provider session in the same cwd.", {
    type: "object",
    required: ["followUp"],
    properties: {
      runId: { type: "string" },
      provider: { enum: ["cursor", "grok"] },
      sessionId: { type: "string" },
      followUp: { type: "string", description: "Sent only to the provider process and never persisted." },
      allowImplement: { type: "boolean" },
    },
  }),
  tool("get_external_agent_result", "Return final in-memory text, changed-file summary, errors, and verification advice.", schema(["runId"])),
  tool("respond_external_agent_permission", "Submit a user-confirmed, single-use response to a pending ACP permission. Keep this tool approval-prompted in Codex.", {
    type: "object",
    required: ["runId", "requestId", "decision", "userConfirmed"],
    properties: {
      runId: { type: "string" },
      requestId: { type: "string" },
      decision: { type: "string", enum: ["allow-once", "reject-once"] },
      userConfirmed: { type: "boolean", description: "Must be true only after the human user selected the decision." },
    },
  }),
];

const input = readline.createInterface({ input: process.stdin });
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
  if (!request.method) return;
  try {
    const result = await dispatch(request.method, asObject(request.params ?? {}));
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
        serverInfo: { name: "external-acp-collaboration", version: "0.1.8" },
        instructions: "Never start or resume a run until EXTERNAL_ACP_WORKSPACE is configured. ACP permissions remain pending until an approval-prompted, user-confirmed response tool call.",
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
          uriTemplate: "external-acp://runs/{runId}",
          name: "External ACP run panel",
          description: "Structured run state with an optional generic HTML rendering.",
          mimeType: "text/html",
        }],
      };
    case "resources/read": {
      const uri = requiredString(params.uri, "resource URI", 512, true);
      const match = /^external-acp:\/\/runs\/([^/]+)$/.exec(uri);
      if (!match) throw new Error("Unknown resource URI.");
      const run = controller.status(match[1]);
      return { contents: [{ uri, mimeType: "text/html", text: renderRunPanel(run) }] };
    }
    default:
      throw new Error(`Unsupported MCP method: ${method}`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    let result: unknown;
    switch (name) {
      case "list_external_agent_providers":
        onlyKeys(args, []);
        result = controller.listProviders();
        break;
      case "start_external_agent":
        onlyKeys(args, ["provider", "cwd", "prompt", "mode", "allowImplement", "model"]);
        requireWorkspaceConfiguration();
        result = controller.start({
          provider: stringEnum(args.provider, ["cursor", "grok", "fake"]),
          cwd: requiredString(args.cwd, "cwd", 4_096, true),
          prompt: requiredString(args.prompt, "prompt", 65_536),
          mode: stringEnum(args.mode, ["review", "plan", "implement"]),
          allowImplement: args.allowImplement === true,
          model: optionalString(args.model, "model", 256),
        });
        break;
      case "get_external_agent_status":
        onlyKeys(args, ["runId"]);
        result = controller.status(requiredString(args.runId, "runId", 128));
        break;
      case "cancel_external_agent":
        onlyKeys(args, ["runId"]);
        result = await controller.cancel(requiredString(args.runId, "runId", 128));
        break;
      case "resume_external_agent":
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
      case "get_external_agent_result":
        onlyKeys(args, ["runId"]);
        result = controller.result(requiredString(args.runId, "runId", 128));
        break;
      case "respond_external_agent_permission":
        onlyKeys(args, ["runId", "requestId", "decision", "userConfirmed"]);
        if (!permissionResponsesEnabled) {
          throw new Error("Permission responses are disabled until EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES=1 is explicitly configured.");
        }
        if (args.userConfirmed !== true) throw new Error("A permission response requires explicit userConfirmed: true.");
        result = controller.respondPermission(
          requiredString(args.runId, "runId", 128),
          requiredString(args.requestId, "requestId", 128),
          stringEnum(args.decision, ["allow-once", "reject-once"]),
        );
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return success(result);
  } catch (error) {
    return { content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }) }], isError: true };
  }
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

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`Unexpected tool argument: ${unexpected[0]}`);
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

function requireWorkspaceConfiguration(): void {
  if (configurationError) throw new Error(configurationError);
}

function positiveIntegerEnvironment(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function stringEnum<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Expected one of: ${values.join(", ")}`);
  return value as T;
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
