# Installing agents-acp 0.2.4-pre.1 into Codex

## Preconditions

- Node.js 22.6 or newer (`node --version`). The plugin runs dependency-free
  TypeScript with Node's `--experimental-strip-types`.
- Codex with the documented `codex plugin marketplace` commands.
- Optionally, an already installed and already authenticated Cursor CLI
  (`cursor-agent`) and/or Grok Build CLI (`grok`). Do not install or
  authenticate a provider just to use this plugin.

## 1. Configure the workspace boundary

Codex starts bundled MCP servers itself; it does **not** hand your shell
environment to them. Earlier versions of this document were wrong about that.
Configuration therefore lives in a file that the server reads directly:

Runtime files are **only** `~/.codex/agents-acp` (or `AGENTS_ACP_HOME` /
`AGENTS_ACP_CONFIG`). The plugin never creates a project-local `.agents-acp`
directory. After the plugin is enabled, initialize or change defaults with
the bundled skill — in Codex CLI / the IDE extension type `$config`
(or ask “初始化 agents-acp” / “把默认 agent 改成 grok”). That skill calls
`get_config` then `configure`. Prefer it over hand-editing.

Optional seed file if you want to set the workspace before the first chat:

```bash
mkdir -p ~/.codex/agents-acp
cat > ~/.codex/agents-acp/config.json <<'JSON'
{
  "workspace": "/absolute/path/to/project",
  "allowedSubtrees": [],
  "enablePermissionResponses": true,
  "allowUnsandboxedImplement": false,
  "maxRunMs": 7200000,
  "idleTimeoutMs": 900000,
  "envMode": "session",
  "defaultProvider": "cursor"
}
JSON
chmod 600 ~/.codex/agents-acp/config.json
```

Fields:

| Field | Meaning |
| --- | --- |
| `workspace` | Required before `start`. The only root in which providers may be started. |
| `defaultProvider` | `cursor` or `grok`. Set by `configure` or named in a user prompt. |
| `defaultModel` | Catalog model id resolved from a user keyword. Never store the raw keyword. |
| `defaultEffort` | Reasoning effort (`low` / `medium` / `high` / `xhigh` / `max`). High is `high`. |
| `defaultSpeed` | Cursor speed: `fast` or `standard`. Fast is `fast`. |
| `allowedSubtrees` | Extra launch directories, each inside `workspace`. |
| `enablePermissionResponses` | Enables `respond_permission` / `respond_question` / `respond_plan`. |
| `allowUnsandboxedImplement` | Required for `implement`; provider writes are not OS-sandboxed. |
| `maxRunMs` | Hard run budget (1 minute to 24 hours). |
| `idleTimeoutMs` | Aborts a silent provider; paused while a decision is pending. |
| `envMode` | `session` (auditable allowlist, default), `inherit`, or `minimal`. |
| `storePath` | Optional run-store location. Relative paths resolve under the central runtime dir, never the project. Example: `~/.codex/agents-acp/runs-<project>.json`. |
| `enableFake` | Registers the bundled fake ACP agent. Leave unset in production. |

The plugin's `.mcp.json` also declares `env_vars`, so Codex forwards these when
they exist in its own environment, and they override the config file:
`AGENTS_ACP_CONFIG`, `AGENTS_ACP_HOME`, `EXTERNAL_ACP_WORKSPACE`, `EXTERNAL_ACP_DEFAULT_PROVIDER`,
`EXTERNAL_ACP_DEFAULT_MODEL`, `EXTERNAL_ACP_DEFAULT_EFFORT`,
`EXTERNAL_ACP_DEFAULT_SPEED`, `EXTERNAL_ACP_ALLOWED_SUBTREES`,
`EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT`,
`EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES`, `EXTERNAL_ACP_MAX_RUN_MS`,
`EXTERNAL_ACP_IDLE_TIMEOUT_MS`, `EXTERNAL_ACP_STORE_PATH`,
`EXTERNAL_ACP_ENV_MODE`, `EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH`, and the
provider/session variables (`HOME`, `PATH`, `SHELL`, `SSH_AUTH_SOCK`,
`SECURITYSESSIONID`, `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`,
`AGENT_CLI_CREDENTIAL_STORE`, `XAI_API_KEY`, …).
Never put secret values in the plugin manifest; `env_vars` forwards names only.

## 2. Install the plugin

```bash
git clone https://github.com/HarveyZgit/agents-acp.git
cd agents-acp
codex plugin marketplace add "$PWD"
codex plugin marketplace list
```

The repository ships `.agents/plugins/marketplace.json`, whose `source.path`
points at `./external-acp-collaboration` (the plugin directory; the Codex-facing
identity is `agents-acp`).

Restart the Codex client, install and enable `agents-acp`, then enable its
bundled MCP server. Keep the response tools approval-prompted, for example:

```toml
[plugins."agents-acp".mcp_servers.agents-acp.tools.respond_permission]
approval_mode = "approve"
```

## 3. Smoke test

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

### Run-store resilience

The run store is a best-effort record, never a correctness dependency. A busy
lock is retried with backoff for roughly 300ms, a lock left by a dead writer or
one older than 30 seconds is reclaimed, and a corrupt file is moved aside. If
persistence still fails, live run state stays authoritative in memory and
`status` / `result` report `storeDegraded` instead of the server exiting.

Two Codex sessions sharing one `storePath` are safe but will contend. Set a
distinct `storePath` per project or profile if you run several at once.

`npm run smoke:main` starts a fresh MCP server plus the bundled fake ACP agent
and asserts the full flow: provider discovery, read-only mode negotiation,
streamed text, tool-call derived file changes, a pending permission with its
offered option IDs, rejection of an unoffered option, an approved response,
completion with `stopReason: "end_turn"`, resume through `session/load`,
cancellation, survival of a stale run-store lock, the blocked `implement` gate,
and termination of provider process groups when the transport closes. It
requires no Codex login and no Cursor/Grok binaries.

In Codex, then:

1. Invoke `$config` (or ask to initialize / change the default
   agent or model). The skill calls `get_config` with `suggestedWorkspace`
   set to the project root. If `needsSetup` is true, it asks the returned
   `setupQuestions` (or uses the agent/model already named) and calls
   `configure` with `userConfirmed: true`. This writes `~/.codex/agents-acp`,
   never a project-local `.agents-acp`.
2. `list_providers` — confirm `configLoaded` is true. Prefer the stored
   `defaultProvider`. Cursor notes that `start.model` is an optional CLI pin
   for a billing pool.
3. `start` with `mode: "review"` and a harmless prompt. After configure,
   `provider` and `model` may be omitted. `cwd` must be inside `workspace`.
   To override one run, pass `provider: "cursor"` and/or
   `model: "composer-2.5"`.
4. `status` while it runs, then `result` when it finishes.

If a permission appears, `status` lists its `requestId` and the provider's
offered `options`. Choose one yourself and call `respond_permission` with that
`optionId` and `userConfirmed: true`. Nothing is auto-approved.

### If Cursor reports an authentication problem

`cursor-agent` tokens live in the macOS keychain (or `~/.cursor/auth.json` when
`AGENT_CLI_CREDENTIAL_STORE=file`). `cli-config.json` only stores profile
metadata. Start Codex from the same user session where `cursor-agent status`
reports a login, and optionally forward `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`.
If a session still cannot be created, the failure text names the ACP stage, the
JSON-RPC code, the advertised auth methods, and a sanitized stderr tail. A
`-32602` from `authenticate(cursor_login)` is retried once against
`session/new` for older CLIs; if the retry is still `auth_required`, that code
means authenticate itself failed (no browser in the Codex child, unknown
method, or timeout), not that a login already exists. When
`cursor-agent status` already shows a login, the plugin never tells you to log
in again. A later `Failed to initialize session services` is reported as a
session-service error, not a missing login. A `terminal` auth method is never
sent to `authenticate`; the failure then explains that the ACP child could not
reuse the existing CLI session.

### If Grok reports Permission denied on session/new

Official Grok ACP is `grok agent stdio`, with `--no-auto-update` for scripts
and `--no-leader` so a Codex-spawned child does not need `~/.grok/leader.sock`.
The plugin also passes `--cwd` and authenticates with `_meta.headless: true`
when Grok requires `cached_token` or `xai.api_key`. Start Codex from the same
user login where interactive `grok` works, keep the workspace readable, and
keep `~/.grok` writable. A `Permission denied` at `session/new` is expanded to
name those workspace and session-file checks; it is not treated as a missing
login when a CLI session already exists. Never pass `--always-approve`.

## 4. Optional write mode

A provider process is not an OS sandbox: setting `cwd` does not stop a CLI from
using absolute paths. Write mode therefore has two gates and belongs in a
disposable workspace:

```json
{ "workspace": "/absolute/path/to/disposable", "allowUnsandboxedImplement": true }
```

Then call `start` with `mode: "implement"` and `allowImplement: true`. Write
runs are serialized per workspace.

## 5. Upgrading

A path-based marketplace has no in-place upgrade. Re-add it:

```bash
cd /path/to/agents-acp
git pull --ff-only origin main
codex plugin marketplace remove agents-acp
codex plugin marketplace add "$PWD"
```

Restart Codex, then confirm the reported plugin version is 0.2.4-pre.1.

## Archive

`dist/agents-acp-0.2.4-pre.1.zip` and `dist/agents-acp-0.2.4-pre.1.tar.gz` contain the
plugin directory. Extract one, then point a marketplace entry's `source.path`
at `./external-acp-collaboration` relative to that marketplace root.

Rebuild them from the repository root without installing dependencies:

```bash
rm -f dist/agents-acp-0.2.4-pre.1.tar.gz dist/agents-acp-0.2.4-pre.1.zip
tar -C . -czf dist/agents-acp-0.2.4-pre.1.tar.gz external-acp-collaboration
zip -qr dist/agents-acp-0.2.4-pre.1.zip external-acp-collaboration
sha256sum dist/agents-acp-0.2.4-pre.1.{tar.gz,zip}
```
