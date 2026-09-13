# Installing agents-acp 0.2.3 into Codex

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
  "envMode": "session"
}
JSON
chmod 600 ~/.codex/agents-acp/config.json
```

Fields:

| Field | Meaning |
| --- | --- |
| `workspace` | Required. The only root in which providers may be started. |
| `allowedSubtrees` | Extra launch directories, each inside `workspace`. |
| `enablePermissionResponses` | Enables `respond_permission` / `respond_question` / `respond_plan`. |
| `allowUnsandboxedImplement` | Required for `implement`; provider writes are not OS-sandboxed. |
| `maxRunMs` | Hard run budget (1 minute to 24 hours). |
| `idleTimeoutMs` | Aborts a silent provider; paused while a decision is pending. |
| `envMode` | `session` (auditable allowlist, default), `inherit`, or `minimal`. |
| `storePath` | Optional run-store location. Give each Codex profile/session its own path to avoid machine-wide lock contention, for example `~/.codex/agents-acp/runs-<project>.json`. |
| `enableFake` | Registers the bundled fake ACP agent. Leave unset in production. |

The plugin's `.mcp.json` also declares `env_vars`, so Codex forwards these when
they exist in its own environment, and they override the config file:
`AGENTS_ACP_CONFIG`, `EXTERNAL_ACP_WORKSPACE`, `EXTERNAL_ACP_ALLOWED_SUBTREES`,
`EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT`,
`EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES`, `EXTERNAL_ACP_MAX_RUN_MS`,
`EXTERNAL_ACP_IDLE_TIMEOUT_MS`, `EXTERNAL_ACP_STORE_PATH`,
`EXTERNAL_ACP_ENV_MODE`, `EXTERNAL_ACP_CURSOR_ENV_PASSTHROUGH`, and the
provider/session variables (`HOME`, `PATH`, `SHELL`, `SSH_AUTH_SOCK`,
`SECURITYSESSIONID`, `CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `XAI_API_KEY`, …).
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

In Codex, then call:

1. `list_providers` — confirm `configLoaded` is true. Prefer Grok when it is
   available. Cursor notes that `start.model` is an optional CLI pin for a
   billing pool.
2. `start` with `provider: "grok"`, `mode: "review"`, and a harmless prompt.
   Omit `model` unless you need a specific Grok model. `cwd` must be inside
   `workspace`. For Cursor quota pinning, pass `provider: "cursor"` and
   `model: "composer-2.5"` (or omit `model` to use the CLI `selectedModel`).
3. `status` while it runs, then `result` when it finishes.

If a permission appears, `status` lists its `requestId` and the provider's
offered `options`. Choose one yourself and call `respond_permission` with that
`optionId` and `userConfirmed: true`. Nothing is auto-approved.

### If Cursor reports an authentication problem

`cursor-agent` login state lives in its CLI config and the OS keychain. Start
Codex from the same user session where `cursor-agent status` reports a login.
If a session still cannot be created, the failure text names the ACP stage, the
JSON-RPC code, the advertised auth methods, and a sanitized stderr tail. A
`-32602` from `authenticate(cursor_login)` is treated as "protocol authenticate
is invalid or unnecessary" and the plugin retries the session without
authenticate. When `cursor-agent status` already shows a login, the plugin
never tells you to log in again. A `terminal` auth method is never sent to
`authenticate`; the failure then explains that the ACP child could not reuse
the existing CLI session.

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

Restart Codex, then confirm the reported plugin version is 0.2.3.

## Archive

`dist/agents-acp-0.2.3.zip` and `dist/agents-acp-0.2.3.tar.gz` contain the
plugin directory. Extract one, then point a marketplace entry's `source.path`
at `./external-acp-collaboration` relative to that marketplace root.

Rebuild them from the repository root without installing dependencies:

```bash
rm -f dist/agents-acp-0.2.3.tar.gz dist/agents-acp-0.2.3.zip
tar -C . -czf dist/agents-acp-0.2.3.tar.gz external-acp-collaboration
zip -qr dist/agents-acp-0.2.3.zip external-acp-collaboration
sha256sum dist/agents-acp-0.2.3.{tar.gz,zip}
```
