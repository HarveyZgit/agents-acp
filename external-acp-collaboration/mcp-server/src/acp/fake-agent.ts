import readline from "node:readline";

let nextSession = 1;
let nextPermission = 900;
let pendingPromptId: number | string | undefined;
let pendingPermissionId: number | string | undefined;

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  if (typeof message.method === "string") {
    handleRequest(message);
  } else if (message.id === pendingPermissionId) {
    notify("session/update", {
      update: { sessionUpdate: "agent_message_chunk", content: { text: "Fake ACP permission response received.\n" } },
    });
    respond(pendingPromptId, { stopReason: "end_turn" });
    pendingPromptId = undefined;
    pendingPermissionId = undefined;
  }
});

function handleRequest(message: Record<string, unknown>): void {
  const id = message.id as number | string | undefined;
  switch (message.method) {
    case "initialize":
      respond(id, { authMethods: [{ id: "fake_local" }] });
      return;
    case "authenticate":
    case "session/set_config_option":
      respond(id, {});
      return;
    case "session/new":
      respond(id, session(`fake-session-${nextSession++}`));
      return;
    case "session/load": {
      const sessionId = (message.params as { sessionId?: unknown } | undefined)?.sessionId;
      respond(id, session(typeof sessionId === "string" ? sessionId : `fake-session-${nextSession++}`));
      return;
    }
    case "session/prompt":
      pendingPromptId = id;
      notify("session/update", {
        update: { sessionUpdate: "agent_message_chunk", content: { text: "Fake ACP run started.\n" } },
      });
      notify("session/update", { update: { sessionUpdate: "tool_call" } });
      notify("session/update", { update: { sessionUpdate: "file_change", path: "fake-output.txt" } });
      pendingPermissionId = nextPermission++;
      notifyRequest(pendingPermissionId, "session/request_permission", { title: "Fake permission request" });
      return;
    case "session/cancel":
      respond(id, {});
      return;
    default:
      respondError(id, -32601, "Unknown fake ACP method");
  }
}

function session(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    configOptions: [{
      id: "mode",
      category: "mode",
      options: [{ value: "ask" }, { value: "plan" }, { value: "agent" }],
    }],
  };
}

function notify(method: string, params: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function notifyRequest(id: number | string, method: string, params: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

function respond(id: number | string | undefined, result: Record<string, unknown>): void {
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id: number | string | undefined, code: number, message: string): void {
  if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
