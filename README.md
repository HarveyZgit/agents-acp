# agents-acp

Current packaged version: **0.2.4-pre.1**.

`agents-acp` is a Codex plugin that delegates a scoped task to a locally
installed ACP-capable coding agent. The adapters target Grok Build
(`grok --no-auto-update --cwd <workspace> agent --no-leader stdio`) and
Cursor CLI (`cursor-agent acp`).

Cursor uses only the official `cursor-agent` binary. It never invokes `cursor`
(the desktop launcher on many machines) and never invokes a bare `agent`,
whose name collides with other vendors' CLIs and is blocked on some machines.

## Architecture

The plugin exposes the `agents-acp` local stdio MCP server to Codex. That
server starts a provider using argument arrays (never a shell command), speaks
newline-delimited JSON-RPC ACP over stdio, and normalizes provider output into
`started`, `text`, `activity`, `permission`, `file_change`, `error`, and
`completed` events.

`external-acp-collaboration/mcp-server/src/acp/provider.ts` owns shared ACP
transport and lifecycle behavior. `cursor.ts` and `grok.ts` contain only
provider-specific executable, authentication, model, and launch details.

The persistent local store contains run IDs, session IDs, safe status metadata,
and changed-file summaries. It never writes task prompts, credentials, or
streamed text to disk; streamed text stays in memory while the server runs.

### Tools

| Tool | Purpose |
| --- | --- |
| `list_providers` | Discovered providers, resolved ACP command, centralized config path, and defaults |
| `get_config` | Runtime dir, defaults, `needsSetup`, and setup questions. Never writes a project-local `.agents-acp` |
| `configure` | Persist default provider/model and workspace under `~/.codex/agents-acp` after the user answers or names them |
| `start` | Start a `review`, `plan`, or `implement` run. `provider`/`model` may be omitted after configure |
| `status` | Lifecycle stage, sanitized error, events, pending requests and their offered option IDs |
| `result` | Final text, `stopReason`, changed files, verification advice |
| `cancel` | ACP cancel notification plus process-group termination |
| `resume` | Resume a stored provider session via `session/load` |
| `respond_permission` | Answer a pending permission with one offered `optionId` |
| `respond_question` | Answer or skip a Cursor multiple-choice question |
| `respond_plan` | Accept or reject a Cursor plan approval |

The plugin also ships two Codex skills (invoke with `$` in Codex CLI / the
IDE extension, or `@` in ChatGPT):

| Skill | Purpose |
| --- | --- |
| `$config` | First-time init or later change of default agent / model / workspace |
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
  `configOptions` of `category: "mode"`. `review` requires `ask` or `plan`,
  `plan` requires `plan` or `ask`, and `implement` requires `agent`. If no
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

After `configure`, `start` may omit `provider` and `model` and uses the stored
defaults. Pass either field only to override that run. Cursor accepts optional
startup `--model` (`cursor-agent --model <id> acp`) so a billing pool can be
pinned after a usage cap (for example `composer-2.5`). Model values are
validated as a single argv element and never concatenated into a prompt.

## Installation

Follow [INSTALL.md](INSTALL.md) for the exact commands. Codex launches bundled
MCP servers itself and does not pass along your shell environment, so
configuration comes from a config file first:

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

Or skip the seed file: after install, invoke the plugin skill
`$config` (or ask Codex to initialize / change the default agent
or model). That skill calls `get_config` then `configure` and writes
`~/.codex/agents-acp`. The plugin never creates `.agents-acp` in a project.

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

cd external-acp-collaboration/mcp-server
npm test
npm run smoke:main
```

`npm run smoke:main` exercises the full MCP flow against a bundled fake ACP
agent that speaks documented ACP shapes. It needs no Codex login and no Cursor
or Grok binaries.

## Verification boundaries

The tests and smoke run against mocks and the bundled fake agent. They do not
install Grok Build or Cursor CLI, authenticate either provider, or exercise
Codex itself. Real provider and real Codex verification remain the user's
local step.

The bundled fake provider is registered only when it is explicitly enabled in
config or environment; it is not available in a normal installation.
