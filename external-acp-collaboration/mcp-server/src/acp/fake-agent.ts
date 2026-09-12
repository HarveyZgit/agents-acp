import readline from "node:readline";

/**
 * Deterministic ACP agent used by the local smoke test. It follows the
 * documented ACP shapes (SessionModeState, permission options, stop reasons,
 * tool_call diffs) so the smoke flow cannot pass against a wrong client.
 */
let nextSession = 1;
let nextPermission = 900;
let pendingPromptId: number | string | undefined;
let pendingPermissionId: number | string | undefined;
let authenticated = process.env.FAKE_ACP_REQUIRE_AUTH !== "1";
let currentModeId = "agent";

const AVAILABLE_MODES = [
  { id: "ask", name: "Ask" },
  { id: "plan", name: "Plan" },
  { id: "agent", name: "Agent" },
];

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
    handleMethod(message);
    return;
  }
  if (message.id === pendingPermissionId && pendingPermissionId !== undefined) {
    const outcome = (message.result as { outcome?: { outcome?: string } } | undefined)?.outcome?.outcome;
    pendingPermissionId = undefined;
    if (outcome === "cancelled") {
      finishPrompt("cancelled");
      return;
    }
    notify("session/update", {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Fake ACP permission response received.\n" },
    });
    finishPrompt("end_turn");
  }
});

function handleMethod(message: Record<string, unknown>): void {
  const id = message.id as number | string | undefined;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        authMethods: authenticated ? [] : [{ methodId: "fake_local", type: "agent" }],
      });
      return;
    case "authenticate":
      authenticated = true;
      respond(id, {});
      return;
    case "session/new":
      if (!authenticated) {
        respondError(id, -32000, "auth_required");
        return;
      }
      currentModeId = "agent";
      respond(id, session(`fake-session-${nextSession++}`));
      return;
    case "session/load": {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : `fake-session-${nextSession++}`;
      currentModeId = "agent";
      // ACP permits a null/empty result for session/load.
      respondRaw(id, null);
      notify("session/update", { sessionUpdate: "current_mode_update", currentModeId });
      lastLoadedSession = sessionId;
      return;
    }
    case "session/set_mode":
      currentModeId = typeof params.modeId === "string" ? params.modeId : currentModeId;
      respond(id, {});
      return;
    case "session/prompt":
      pendingPromptId = id;
      notify("session/update", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Fake ACP run started.\n" },
      });
      notify("session/update", {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Write fake output",
        kind: "edit",
        status: "completed",
        locations: [{ path: "fake-output.txt" }],
        content: [{ type: "diff", path: "fake-output.txt", oldText: "old", newText: "new" }],
      });
      pendingPermissionId = nextPermission++;
      request(pendingPermissionId, "session/request_permission", {
        sessionId: "fake-session",
        toolCall: { toolCallId: "tool-1", title: "Apply fake change" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      });
      return;
    case "session/cancel":
      // ACP cancel is a notification; the prompt resolves with "cancelled".
      pendingPermissionId = undefined;
      finishPrompt("cancelled");
      return;
    default:
      if (id !== undefined) respondError(id, -32601, "Unknown fake ACP method");
  }
}

let lastLoadedSession: string | undefined;

function session(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    modes: { currentModeId, availableModes: AVAILABLE_MODES },
  };
}

function finishPrompt(stopReason: string): void {
  if (pendingPromptId === undefined) return;
  const id = pendingPromptId;
  pendingPromptId = undefined;
  respond(id, { stopReason });
}

function notify(method: string, params: Record<string, unknown>): void {
  write({ jsonrpc: "2.0", method, params: method === "session/update" ? { sessionId: lastLoadedSession ?? "fake-session", update: params } : params });
}

function request(id: number | string, method: string, params: Record<string, unknown>): void {
  write({ jsonrpc: "2.0", id, method, params });
}

function respond(id: number | string | undefined, result: Record<string, unknown>): void {
  if (id !== undefined) write({ jsonrpc: "2.0", id, result });
}

function respondRaw(id: number | string | undefined, result: unknown): void {
  if (id !== undefined) write({ jsonrpc: "2.0", id, result });
}

function respondError(id: number | string | undefined, code: number, message: string): void {
  if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code, message } });
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
