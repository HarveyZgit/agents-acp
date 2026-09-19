---
name: dispatch
description: Dispatch a scoped coding task to a locally installed Cursor CLI or Grok Build ACP agent. If the user only wants to initialize or change the default agent/model, use the $config skill instead of starting a run.
---

Use this skill when the user explicitly asks to dispatch, delegate, or send a task to an independent external agent, names Cursor CLI or Grok Build, or benefits from a second opinion. Do not present the run as a native Codex subagent.

If this turn is only setup or a settings change (initialize, configure, change default agent/model), follow `$config` and stop after `configure`. Do not call `start`.

Runtime files stay in `~/.codex/agents-acp`. Never create or write `.agents-acp` in the project.

1. Call `get_config` with `suggestedWorkspace` set to the current project root.
2. If `needsSetup` is true, do **not** guess a provider. Ask the user with the returned `setupQuestions`, or apply values they already named in the prompt (`cursor` / `grok`, optional model). Then call `configure` with `userConfirmed: true`.
3. If the user later says to change the default agent or model, follow `$config` (ask or use the named values, then `configure`).
4. Call `list_providers` and report unavailable local executables clearly. Prefer the stored `defaultProvider` / `defaultModel`. A start may omit `provider` and `model` after configure. Pass `provider` or `model` only to override for that run.

Cursor uses `cursor-agent acp` only; it never falls back to `cursor` or `agent`. Official ACP has no universal model field; the CLI still accepts `cursor-agent --model <id> acp`.

5. Use `review` or `plan` for read-only questions. These runs may be parallel. A run fails rather than silently using a write-capable default mode.
6. Use `implement` only when the user explicitly asks for changes, pass `allowImplement: true`, and only after the local operator enabled unsandboxed implementation. It is serialized per workspace.
7. Send a task prompt only through `start`; never put it into a shell command or persist it.
8. Poll `status`. It reports the lifecycle `stage`, a sanitized `error`, and each pending request with its `requestId`, `kind`, and the provider's offered `options`.
9. Never auto-approve. Ask the user which offered option to take, then call `respond_permission` with that exact `optionId` and `userConfirmed: true`. Use `respond_question` for a Cursor question and `respond_plan` for a Cursor plan approval. Keep these tools approval-prompted in Codex. If human confirmation is unavailable, leave the request pending or call `cancel`.
10. Use `cancel` only on request or when the user asks to stop work.
11. On completion, call `result`. Treat only `stopReason: "end_turn"` as success; report refusal or truncation as an incomplete run. Review changed files and run relevant project checks before recommending adoption.

If a Cursor run fails during authenticate or session creation, do not tell the user to run `cursor-agent login` when `cursor-agent status` already shows a login. `-32602` from `authenticate(cursor_login)` is retried once against `session/new`; if that retry is still `auth_required`, report a failed authenticate (no browser in the Codex child, unknown method, or timeout), not a missing login. A later `Failed to initialize session services` is a session-service error, not a login problem.

If a Grok run fails at `session/new` with Permission denied, report the workspace and `~/.grok` access guidance from `status.error`. Do not invent a login step when the user already uses `grok` interactively.
