---
name: config
description: Configure agents-acp defaults (default Cursor/Grok/Antigravity agent, default model, Fast speed, High effort, workspace). Use when the user asks to set up, configure, initialize, or change the default ACP agent or model. Do not start an ACP run.
---

This is the configuration skill for the installed `agents-acp` plugin (Codex or Claude Code). Call the bundled MCP tools `get_config` and `configure`. Do not create or write `.agents-acp` in the project. Runtime files stay in the centralized `runtimeDir` from `get_config` (`~/.codex/agents-acp` on Codex, `~/.claude/agents-acp` on Claude Code, or `AGENTS_ACP_HOME`).

Do **not** call `start`, `resume`, or any respond tool. This skill only reads and persists defaults.

1. Call `get_config` with `suggestedWorkspace` set to the current project root.
2. Report the current `host`, `defaultProvider`, `defaultModel`, `defaultEffort`, `defaultSpeed`, `launchModel`, `workspace`, `configPath`, `needsSetup`, and the `catalogs` model lists.
3. Report **every** provider's confirmed `launch` (`argv`, `source`, `spawn: "direct"`, `wrapperDetection: "rc-scan"`): Cursor (`cursor-agent`), Grok (`grok`), and Antigravity (`agy_acp_server.par`). Also report `setupQuestions` id `confirmedLaunch`. The plugin spawns that official file with `shell:false`. Wrapper detection **reads** `~/.bashrc` / `~/.zshrc` as text and never sources them, so a network check inside a function body does not run. If `ignoredWrappers` lists a `cursor-agent` / `cursor` / `agent` / `grok` / `agy` / `antigravity` function, alias, or PATH file, tell the user it was detected and **will not be used**. Never invoke those wrapper names from the host shell to “help” setup. Pin official files with `CURSOR_AGENT_BIN` / `GROK_BIN` / `AGY_ACP_BIN` when a PATH script would otherwise win.
4. Collect the next defaults:
   - If this prompt already names an agent (`cursor` / `grok` / `antigravity`), a model keyword, Fast/standard speed, High/other effort, or workspace, use those values. Do not re-ask for a field the user already named.
   - Otherwise ask with the returned `setupQuestions`. When the user asked to **change** settings and `setupQuestions` is empty, ask agent, model, effort (High), speed (Fast), and workspace.
   - Never guess `defaultProvider`.
5. Resolve the model **from the matching agent's catalog** (`catalogs[].models`). Match the user's keyword against catalog `id` / `label` / `base`. Persist the catalog base id, not the raw keyword. If several bases match, ask the user to pick an id.
6. Persist Fast and High separately: `defaultSpeed: "fast"` and `defaultEffort: "high"`. Do not invent a combined string such as `composer-2.5 fast high`. Cursor launch ids are composed by the server (`composer-2.5-high-fast`). Grok uses `--model` plus `--effort`. Antigravity has no Fast dimension; High is a Gemini slug suffix (`gemini-3.8-flash-high`) set in-session. Never persist `agy` as the provider id — store `antigravity`.
7. Call `configure` with `userConfirmed: true` and only the fields they chose or named. Pass `defaultModel: ""` to clear model, effort, and speed.
8. Call `get_config` again. Confirm the stored `defaultModel` is a catalog id, `defaultEffort` / `defaultSpeed` match the request, and `writesProjectRuntimeDir` is false. Tell the user the stored defaults, `launchModel`, and the confirmed official spawn argv. Repeat that ignored wrappers were not followed.
9. Stop.
