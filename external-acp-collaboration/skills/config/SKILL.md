---
name: config
description: Configure agents-acp defaults (default Cursor/Grok agent, default model, workspace). Use when the user asks to set up, configure, initialize, or change the default ACP agent or model. Do not start an ACP run.
---

This is the configuration skill for the installed `agents-acp` Codex plugin. Call the bundled MCP tools `get_config` and `configure`. Do not create or write `.agents-acp` in the project. Runtime files stay in `~/.codex/agents-acp`.

Do **not** call `start`, `resume`, or any respond tool. This skill only reads and persists defaults.

1. Call `get_config` with `suggestedWorkspace` set to the current project root.
2. Report the current `defaultProvider`, `defaultModel`, `workspace`, `configPath`, `needsSetup`, and which providers `list_providers` (or the snapshot `providers` list) marks available.
3. Collect the next defaults:
   - If this prompt already names an agent (`cursor` / `grok`), optional model, or workspace, use those values. Do not re-ask for a field the user already named.
   - Otherwise ask with the returned `setupQuestions`. When the user asked to **change** settings and `setupQuestions` is empty, ask the same three questions: default agent (`cursor` or `grok`), optional default model (empty clears the pin), and workspace (offer `suggestedWorkspace`).
   - Never guess `defaultProvider`.
4. Call `configure` with `userConfirmed: true` and only the fields they chose or named. Pass `defaultModel: ""` to clear a stored model pin.
5. Call `get_config` again. Confirm `needsSetup` is false when both workspace and default provider are set, and that `writesProjectRuntimeDir` is false. Tell the user the stored defaults and that later `$dispatch` runs can omit `provider` / `model`.
6. Stop.
