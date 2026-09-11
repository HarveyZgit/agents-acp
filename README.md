# agents-acp

`external-acp-collaboration` is a Codex Desktop plugin that delegates a scoped
task to a locally installed ACP-capable coding agent. The first adapters target
Grok Build (`grok agent stdio`) and Cursor CLI (`agent acp`).

## Architecture

The plugin exposes a local stdio MCP server to Codex. That server starts a
provider using argument arrays (never a shell command), speaks newline-delimited
JSON-RPC ACP over stdio, and normalizes provider output into `started`, `text`,
`activity`, `permission`, `file_change`, `error`, and `completed` events.

`external-acp-collaboration/mcp-server/src/acp/provider.ts` owns shared ACP
transport and lifecycle behavior. `cursor.ts` and `grok.ts` contain only
provider-specific executable, authentication, model, and launch details.

The persistent local store contains run IDs, session IDs, safe status metadata,
and changed-file summaries. It intentionally never writes task prompts,
credentials, or streamed text to disk; streamed text remains in memory while
the MCP server is running.

Policy is enforced before launch:

- `review` and `plan` are read-only scheduling modes and can run in parallel.
- `implement` maps to the provider's `agent` mode, requires
  `allowImplement: true`, and is serialized per configured workspace.
- `cwd` must be the configured active workspace or an explicitly authorized
  subtree.
- ACP permissions are never approved automatically. The caller must answer
  through `respond_external_agent_request`.

Model selection is intentionally provider-specific. Grok Build's documented
ACP startup flag supports `--model`; Cursor's documented `agent acp` interface
does not document a model parameter, so the Cursor adapter rejects `model`
instead of adding it to task text.

## Local installation in Codex Desktop

1. Clone this repository locally. It includes the required repo marketplace at
   `.agents/plugins/marketplace.json`, whose `./external-acp-collaboration`
   source path resolves from the repository root.
2. Add that repository as a local marketplace:

   ```bash
   codex plugin marketplace add /absolute/path/to/agents-acp
   ```

   Alternatively, copy the same marketplace JSON to a personal marketplace and
   retain a `./` plugin path within that marketplace root.
3. Restart the desktop app, install the plugin from that marketplace, then
   enable its bundled MCP server. The plugin requires Node.js 22.6+ because it
   runs its dependency-free TypeScript with Node's
   `--experimental-strip-types` flag.
4. Configure the intended active project before enabling the MCP server:

   ```text
   EXTERNAL_ACP_WORKSPACE=/absolute/path/to/project
   EXTERNAL_ACP_ALLOWED_SUBTREES=/absolute/path/to/project/packages
   ```

   `EXTERNAL_ACP_ALLOWED_SUBTREES` uses the operating system path separator.
   Do not put secrets in this configuration.

The `.mcp.json` file follows the current documented Codex bundled-MCP
`mcp_servers` shape. It exposes structured tool responses and an
`external-acp://runs/{runId}` HTML resource. It does not declare a Codex custom
app panel: the current documented manifest only supports `.app.json` for a
registered MCP server mapping, not a generic embedded plugin UI. Wiring
`ui/run-panel/run-panel.ts` into a native expandable desktop panel therefore
requires a future documented Codex plugin UI/runtime surface.

## Local verification checklist

Do these read-only checks on the target machine; do not install, authenticate,
or start a provider task solely for verification:

```bash
node --version
agent --version
agent --help
grok --version
grok --help
grok agent --help
```

Confirm existing provider authentication using each provider's documented local
status/login help without exposing tokens. Cursor ACP uses the advertised
`cursor_login` method; Grok ACP uses an existing cached login token or a
pre-existing `XAI_API_KEY` environment credential. This plugin does not ask
for, save, or log either credential.

Then run the dependency-free mocked tests:

```bash
cd external-acp-collaboration/mcp-server
npm test
```

Finally, in Codex, call `list_external_agent_providers`, start a harmless
`review` or `plan` run, verify status/result tools and the resource, explicitly
reject one permission request if offered, and only then test an opted-in
`implement` run in a disposable workspace.

## Verification boundaries

The repository tests mock the ACP JSON-RPC lifecycle; they do not install
Grok Build or Cursor CLI, authenticate either provider, or exercise Codex
Desktop. Those integrations must be verified on the user's machine.

The prior referenced scratch branch was not readable from this repository's
remote, so this implementation was created from the design and current public
provider/plugin documentation.
