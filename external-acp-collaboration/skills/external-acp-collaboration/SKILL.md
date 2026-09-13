---
name: agents-acp
description: Delegate a clearly scoped coding task to a locally installed Cursor CLI or Grok Build ACP agent.
---

Use this skill when the user explicitly asks for an independent external-agent pass, names Cursor CLI or Grok Build, or benefits from a second opinion. Do not present the run as a native Codex subagent.

1. Call `list_providers` and report unavailable local executables clearly. Cursor uses `cursor-agent acp` only; it never falls back to `cursor` or `agent`.
2. Use `review` or `plan` for read-only questions. These runs may be parallel. A run fails rather than silently using a write-capable default mode.
3. Use `implement` only when the user explicitly asks for changes, pass `allowImplement: true`, and only after the local operator enabled unsandboxed implementation. It is serialized per workspace.
4. Send a task prompt only through `start`; never put it into a shell command or persist it.
5. Poll `status`. It reports the lifecycle `stage`, a sanitized `error`, and each pending request with its `requestId`, `kind`, and the provider's offered `options`.
6. Never auto-approve. Ask the user which offered option to take, then call `respond_permission` with that exact `optionId` and `userConfirmed: true`. Use `respond_question` for a Cursor question and `respond_plan` for a Cursor plan approval. Keep these tools approval-prompted in Codex. If human confirmation is unavailable, leave the request pending or call `cancel`.
7. Use `cancel` only on request or when the user asks to stop work.
8. On completion, call `result`. Treat only `stopReason: "end_turn"` as success; report refusal or truncation as an incomplete run. Review changed files and run relevant project checks before recommending adoption.

If the provider exposes no documented ACP model selector, return the tool's model-selection error rather than embedding a model name in the prompt.

If a Cursor run fails during authenticate or session creation, do not tell the user to run `cursor-agent login` when they are already logged in. `-32602` from `authenticate(cursor_login)` means protocol authenticate is invalid or unnecessary; the plugin retries the session using the existing CLI session.
