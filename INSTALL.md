# Installing agents-acp 0.2.0 into Codex

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
| `storePath` | Optional run-store location. |
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

`npm run smoke:main` starts a fresh MCP server plus the bundled fake ACP agent
and asserts the full flow: provider discovery, read-only mode negotiation,
streamed text, tool-call derived file changes, a pending permission with its
offered option IDs, rejection of an unoffered option, an approved response,
completion with `stopReason: "end_turn"`, resume through `session/load`,
cancellation, and the blocked `implement` gate. It requires no Codex login and
no Cursor/Grok binaries.

In Codex, then call:

1. `list_providers` — confirm `cursor-agent acp` resolved and `configLoaded` is true.
2. `start` with `mode: "review"` and a harmless prompt, with `cwd` inside `workspace`.
3. `status` while it runs, then `result` when it finishes.

If a permission appears, `status` lists its `requestId` and the provider's
offered `options`. Choose one yourself and call `respond_permission` with that
`optionId` and `userConfirmed: true`. Nothing is auto-approved.

### If Cursor reports an authentication problem

`cursor-agent` login state lives in its CLI config and the OS keychain. Start
Codex from the same user session where `cursor-agent status` reports a login.
If a session still cannot be created, the failure text names the ACP stage, the
JSON-RPC code, the advertised auth methods, and a sanitized stderr tail. When
only a `terminal` auth method is advertised, run `cursor-agent login` in a
terminal; ACP forbids sending terminal methods to `authenticate`.

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

Restart Codex, then confirm the reported plugin version is 0.2.0.

## Archive

`dist/agents-acp-0.2.0.zip` and `dist/agents-acp-0.2.0.tar.gz` contain the
plugin directory. Extract one, then point a marketplace entry's `source.path`
at `./external-acp-collaboration` relative to that marketplace root.

Rebuild them from the repository root without installing dependencies:

```bash
rm -f dist/agents-acp-0.2.0.tar.gz dist/agents-acp-0.2.0.zip
tar -C . -czf dist/agents-acp-0.2.0.tar.gz external-acp-collaboration
zip -qr dist/agents-acp-0.2.0.zip external-acp-collaboration
sha256sum dist/agents-acp-0.2.0.{tar.gz,zip}
```
