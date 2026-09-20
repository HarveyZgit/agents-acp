# agents-acp

Current packaged version: **0.2.4-pre.1**.

`agents-acp` is a Codex and Claude Code plugin that delegates a scoped task
to a locally installed ACP-capable coding agent. The adapters target Grok
Build (`grok --no-auto-update --cwd <workspace> agent --no-leader stdio`),
Cursor CLI (`cursor-agent acp`), and Antigravity
(`agy_acp_server.par --uid=`).

Cursor uses only the official `cursor-agent` binary. It never invokes `cursor`
(the desktop launcher on many machines) and never invokes a bare `agent`,
whose name collides with other vendors' CLIs and is blocked on some machines.

## Architecture

The plugin exposes the `agents-acp` local stdio MCP server to Codex or
Claude Code. That
server starts a provider using argument arrays (never a shell command), speaks
newline-delimited JSON-RPC ACP over stdio, and normalizes provider output into
`started`, `text`, `activity`, `permission`, `file_change`, `error`, and
`completed` events.

`external-acp-collaboration/mcp-server/src/acp/provider.ts` owns shared ACP
transport and lifecycle behavior. `cursor.ts`, `grok.ts`, and
`antigravity.ts` contain only provider-specific executable, authentication,
model, and launch details. Antigravity never wraps the `agy` TUI.
`$config` inspects every CLI agent (`cursor-agent`, `grok`,
`agy_acp_server.par`) and reports the exact spawn argv (`shell:false`).
User-modified commands — a `cursor-agent`, `grok`, or `agy` shell function
that checks the network first — are detected as `ignoredWrappers` and are
not followed.

The persistent local store contains run IDs, session IDs, safe status metadata,
and changed-file summaries. It never writes task prompts, credentials, or
streamed text to disk; streamed text stays in memory while the server runs.

### Tools

| Tool | Purpose |
| --- | --- |
| `list_providers` | Discovered providers, resolved ACP command, centralized config path, and defaults |
| `get_config` | Runtime dir, defaults, catalogs, `needsSetup`, setup questions, and confirmed official spawn argv. Reports user wrappers that will not be followed. Never writes a project-local `.agents-acp` |
| `configure` | Persist default provider, catalog model id, effort (High), speed (Fast), and workspace. Resolves keywords against the agent model list |
| `start` | Start a `review`, `plan`, or `implement` run. `provider`/`model`/`effort`/`speed` may be omitted after configure |
| `status` | Lifecycle stage, sanitized error, events, pending requests and their offered option IDs |
| `result` | Final text, `stopReason`, changed files, verification advice |
| `cancel` | ACP cancel notification plus process-group termination |
| `resume` | Resume a stored provider session via `session/load` |
| `respond_permission` | Answer a pending permission with one offered `optionId` |
| `respond_question` | Answer or skip a Cursor multiple-choice question |
| `respond_plan` | Accept or reject a Cursor plan approval |

The plugin also ships two skills. In Codex CLI / the IDE extension invoke
them with `$config` / `$dispatch` (or `@` in ChatGPT). In Claude Code they
are `/agents-acp:config` and `/agents-acp:dispatch`.

| Skill | Purpose |
| --- | --- |
| `$config` | First-time init or later change of default agent / model / High effort / Fast speed |
| `$dispatch` | Dispatch a scoped ACP run. Calls `$config` first when `needsSetup` |

### Protocol behavior

- Authentication follows ACP: after `initialize`, `session/new` is attempted
  first for pre-authenticated CLIs. Only an `auth_required` (`-32000`) response
  triggers `authenticate`, and only with an advertised non-terminal method.
  Auth descriptors are read from either `methodId` or `id`. A terminal-only
  method is never sent to `authenticate`. If `authenticate(cursor_login)`
  returns `-32602` (Invalid params), the plugin retries `session/new` once in
  case an older CLI already had a usable session. If that retry still reports
  `auth_required`, the `-32602` is treated as a failed authenticate (unknown
  method, no browser, or login timeout) — not as proof that login already
  exists. The same one-shot retry applies when a provider authenticates first.
  Grok authenticate includes `_meta.headless: true` as in the official x.ai
  ACP scripting example. When `cursor-agent status` is already good, failures
  never tell the operator to log in again. A later `session/new` failure such
  as `Failed to initialize session services` is reported as that service
  error, not as a missing login. A bare `Permission denied` from
  `session/new` is expanded to name workspace and provider-session file access.
- Modes are read from the ACP `SessionModeState` object
  (`modes.availableModes` / `modes.currentModeId`), with a fallback to
  `configOptions` of `category: "mode"`.   `review` requires `ask` or `plan`,
  `plan` requires `plan` or `ask`, and `implement` requires `agent`. Antigravity
  is different: its modes are permission policy (`default` / `auto_edit` /
  `yolo`). Every agents-acp task stays on `default`. Never `yolo`. If no
  acceptable mode can be confirmed, the run **fails closed** rather than
  running a read-only request in a write-capable default mode.
- `session/prompt` has no fixed request timeout. A prompt turn is bounded by
  the overall run budget and an idle watchdog that resets on provider output
  and pauses while a user decision is pending. Short timeouts remain on
  `initialize`, `authenticate`, `session/new`, mode selection, and cancel.
- Permission requests relay the provider's offered `PermissionOption` IDs; the
  caller must choose one of them. Cancelling answers pending requests with
  `{ outcome: { outcome: "cancelled" } }`.
- `session/cancel` is sent as a notification, per ACP, then the provider's
  process group is terminated.
- Changed files come from `tool_call` diff content, plus `locations` only for
  writing tool kinds (`edit`, `delete`, `move`). A change announced outside the
  workspace is never silently dropped: it is flagged, surfaced on the run, and
  prevents the turn from being reported as a clean success.
- After a mode is confirmed, a `current_mode_update` (or mode config-option
  update) that leaves the acceptable set aborts a `review`/`plan` run instead of
  letting it continue with write access.
- `initialize` responses are checked for a supported ACP protocol version.
- Pending requests carry their real content: the tool-call title, kind, and
  locations for permissions; the questions and option IDs for a Cursor
  question; the plan name, overview, and steps for a plan approval.
- Only `stopReason: "end_turn"` is success. `refusal`, `max_tokens`, and
  `max_turn_requests` are reported as failures with the reason retained.
- Provider children are terminated on cancel, on transport close, and on
  SIGINT/SIGTERM/SIGHUP, with a kill escalation so nothing is orphaned.

### Safety

- `cwd` must be the configured workspace or an explicitly authorized subtree.
  Real paths are resolved, so symlinks cannot escape the workspace.
- `review` and `plan` are read-only and may run in parallel; `implement`
  requires `allowImplement: true` plus a local unsandboxed-write opt-in and is
  serialized per workspace.
- Responses are disabled unless the operator enables them, and every response
  tool requires `userConfirmed: true`. Keep them approval-prompted in Codex.
- Provider children receive an auditable environment allowlist (base session
  variables, macOS/login session variables, proxy and TLS settings, plus
  `CURSOR_*` / `XAI_*` / `GROK_*`). `envMode: "inherit"` is an explicit escape
  hatch and `"minimal"` is the strictest option. Values are never logged.
- Failures expose a bounded, sanitized diagnostic with the ACP stage, JSON-RPC
  or process code, advertised auth-method IDs/types, and a stderr tail. Prompt
  text, credential-shaped values, and paths outside the workspace are redacted.
  Redaction covers `Authorization` (including Basic), cookies, JSON credential
  fields such as `access_token`, JWTs, prefixed keys such as `sk-`, and a
  final high-entropy sweep. Anything written to the run store is redacted again
  independently of the caller.
- The run store is best-effort. Lock contention backs off and then degrades,
  stale and corrupt state is reclaimed, and a persistence failure marks the run
  `storeDegraded` rather than taking down the MCP server.

After `configure`, `start` may omit `provider`, `model`, `effort`, and `speed`
and uses the stored defaults. Pass those fields only to override that run.
`$config` resolves a user keyword against `cursor-agent --list-models`,
`grok models`, or the Antigravity session catalog (or
`EXTERNAL_ACP_CATALOG_FIXTURE`) and stores the catalog id, never the raw
text. Fast is `defaultSpeed` and High is `defaultEffort`. Cursor composes
them into the launch id (`composer-2.5-high-fast`); Grok passes `--model`
plus `--effort`; Antigravity sets `session/set_config_option` to a Gemini
slug such as `gemini-3.8-flash-high`. Model values are a single argv
element (Cursor/Grok) or an in-session config value (Antigravity) and
never concatenated into a prompt.

## Installation

Follow [INSTALL.md](INSTALL.md) for the exact commands. Codex launches bundled
MCP servers itself and does not pass along your shell environment, so
configuration comes from a config file first. Claude Code inherits the login
environment and still reads the same file shape from `~/.claude/agents-acp`
(or a shared `AGENTS_ACP_HOME`).

```bash
mkdir -p ~/.codex/agents-acp
cat > ~/.codex/agents-acp/config.json <<'JSON'
{
  "workspace": "/absolute/path/to/project",
  "enablePermissionResponses": true,
  "defaultProvider": "cursor"
}
JSON
codex plugin marketplace add /absolute/path/to/agents-acp
```

Claude Code:

```bash
claude plugin marketplace add /absolute/path/to/agents-acp
claude plugin install agents-acp@agents-acp
```

Or skip the seed file: after install, invoke the plugin skill
`$config` / `/agents-acp:config` (or ask the host to initialize / change
the default agent or model). That skill calls `get_config` then `configure`
and writes the host runtime dir. The plugin never creates `.agents-acp` in
a project.

A later `$dispatch` run uses those stored defaults. `$config`
again changes the default agent or model without starting a run.

Any `EXTERNAL_ACP_*` variable listed in the plugin's `.mcp.json` `env_vars`
overrides the corresponding config file value when Codex forwards it.

The plugin exposes structured tool results and an `agents-acp://runs/{runId}`
HTML resource. It declares no Codex custom app panel: the documented manifest
supports `.app.json` only for a registered MCP server mapping, not a generic
embedded plugin UI, so `ui/run-panel/run-panel.ts` still needs a future
documented Codex plugin UI surface.

## Local verification

```bash
node --version
cursor-agent --version
cursor-agent acp --help
cursor-agent status
grok --version
grok agent --help
# optional: official Antigravity ACP server, never the agy TUI
ls "${AGY_ACP_BIN:-$HOME/.local/bin/agy_acp_server.par}"

cd external-acp-collaboration/mcp-server
npm test
npm run smoke:main
```

`npm run smoke:main` exercises the full MCP flow against a bundled fake ACP
agent that speaks documented ACP shapes. It needs no Codex login and no Cursor,
Grok, or Antigravity binaries.

## Verification boundaries

The tests and smoke run against mocks and the bundled fake agent. They do not
install Grok Build or Cursor CLI, authenticate either provider, or exercise
Codex or Claude Code themselves. Real provider and real host verification
remain the user's local step.

The bundled fake provider is registered only when it is explicitly enabled in
config or environment; it is not available in a normal installation.
