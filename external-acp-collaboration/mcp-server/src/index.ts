import path from "node:path";
import readline from "node:readline";
import { RunController } from "./run-controller.ts";
import { WorkspacePolicy } from "./policy.ts";
import { RunStore } from "./run-store.ts";
import { renderRunPanel } from "../../ui/run-panel/run-panel.ts";

const workspace = process.env.EXTERNAL_ACP_WORKSPACE ?? process.cwd();
const authorizedSubtrees = (process.env.EXTERNAL_ACP_ALLOWED_SUBTREES ?? "")
  .split(path.delimiter)
  .filter(Boolean);
const store = new RunStore(process.env.EXTERNAL_ACP_STORE_PATH);
const controller = new RunController(store, new WorkspacePolicy(workspace, authorizedSubtrees));

const tools = [
  tool("list_external_agent_providers", "Discover locally installed ACP providers and their documented capabilities.", { type: "object", properties: {} }),
  tool("start_external_agent", "Start an ACP run. Implement mode requires allowImplement: true and is serialized per workspace.", {
    type: "object",
    required: ["provider", "cwd", "prompt", "mode"],
    properties: {
      provider: { enum: ["cursor", "grok"] },
      cwd: { type: "string" },
      prompt: { type: "string", description: "Sent only to the provider process and never persisted." },
      mode: { enum: ["review", "plan", "implement"] },
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
  tool("respond_external_agent_request", "Explicitly answer a pending ACP permission or provider decision. This plugin never auto-approves requests.", {
    type: "object",
    required: ["runId", "requestId", "response"],
    properties: {
      runId: { type: "string" },
      requestId: { type: "string" },
      response: { type: "object", description: "Provider-specific ACP response selected by the user." },
    },
  }),
];

const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return;
  }
  if (!request.method) return;
  try {
    const result = await dispatch(request.method, request.params ?? {});
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
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: { listChanged: false } },
        serverInfo: { name: "external-acp-collaboration", version: "0.1.0" },
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call":
      return callTool(String(params.name ?? ""), asObject(params.arguments));
    case "resources/list":
      return {
        resources: [],
        resourceTemplates: [{
          uriTemplate: "external-acp://runs/{runId}",
          name: "External ACP run panel",
          description: "Structured run state with an optional generic HTML rendering.",
          mimeType: "text/html",
        }],
      };
    case "resources/read": {
      const uri = String(params.uri ?? "");
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
        result = controller.listProviders();
        break;
      case "start_external_agent":
        result = controller.start({
          provider: stringEnum(args.provider, ["cursor", "grok"]),
          cwd: requiredString(args.cwd),
          prompt: requiredString(args.prompt),
          mode: stringEnum(args.mode, ["review", "plan", "implement"]),
          allowImplement: args.allowImplement === true,
          model: optionalString(args.model),
        });
        break;
      case "get_external_agent_status":
        result = controller.status(requiredString(args.runId));
        break;
      case "cancel_external_agent":
        result = await controller.cancel(requiredString(args.runId));
        break;
      case "resume_external_agent":
        result = controller.resume({
          runId: optionalString(args.runId),
          provider: args.provider === undefined ? undefined : stringEnum(args.provider, ["cursor", "grok"]),
          sessionId: optionalString(args.sessionId),
          followUp: requiredString(args.followUp),
          allowImplement: args.allowImplement === true,
        });
        break;
      case "get_external_agent_result":
        result = controller.result(requiredString(args.runId));
        break;
      case "respond_external_agent_request":
        result = controller.respond(requiredString(args.runId), requiredString(args.requestId), asObject(args.response));
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

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a non-empty string.");
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
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
