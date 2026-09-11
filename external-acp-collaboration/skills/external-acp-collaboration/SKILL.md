---
name: external-acp-collaboration
description: Delegate a clearly scoped coding task to a locally installed Cursor CLI or Grok Build ACP agent.
---

Use this skill when the user explicitly asks for an independent external-agent pass, names Cursor CLI or Grok Build, or benefits from a second opinion. Do not present the run as a native Codex subagent.

1. Call `list_external_agent_providers` and report unavailable local executables clearly.
2. Use `review` or `plan` for read-only questions. These runs may be parallel.
3. Use `implement` only when the user explicitly asks for changes, pass `allowImplement: true`, and only after the local operator enabled unsandboxed implementation. It is serialized per workspace.
4. Send a task prompt only through `start_external_agent`; never put it into a shell command or persist it.
5. Poll `get_external_agent_status` and surface pending requests. Never auto-approve an ACP permission. Standard MCP tool calls cannot prove a human approved it, so leave it pending or use `cancel_external_agent`.
6. Use `cancel_external_agent` only on request or when the user asks to stop work.
7. On completion, call `get_external_agent_result`, review changed files, and run relevant project checks before recommending adoption.

If the provider exposes no documented ACP model selector, return the tool's model-selection error rather than embedding a model name in the prompt.
