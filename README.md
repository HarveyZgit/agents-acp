# agents-acp

`external-acp-collaboration` is a Codex Desktop plugin that delegates a scoped
task to a locally installed ACP-capable coding agent. The first adapters target
Grok Build (`grok agent stdio`) and Cursor CLI. Cursor discovery tries
`cursor`, then `cursor-agent`, then `agent`, selecting only a binary whose
version and ACP help probe succeed.

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
  `allowImplement: true` plus a local unsandboxed-write opt-in, and is
  serialized per configured workspace.
- `cwd` must be the configured active workspace or an explicitly authorized
  subtree. Real paths are checked, so symlinks cannot escape the workspace.
- Read-only and write modes fail closed unless the provider advertises and
  accepts the corresponding ACP session mode.
- ACP permissions are never approved automatically. The single-use response
  tool requires the caller to assert an explicit user decision and should
  remain approval-prompted in Codex; it is disabled unless
  `EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES=1` is configured.

Model selection is intentionally provider-specific. Grok Build's documented
ACP startup flag supports `--model`; Cursor's documented `agent acp` interface
does not document a model parameter, so the Cursor adapter rejects `model`
instead of adding it to task text.

## Linux Codex installation

Use the detailed, versioned commands in [INSTALL.md](INSTALL.md). In short,
clone this repository, configure the workspace boundary in the environment
that launches Codex, and add the repository as a documented local marketplace:

```bash
export EXTERNAL_ACP_WORKSPACE=/absolute/path/to/project
codex plugin marketplace add /absolute/path/to/agents-acp
```

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
cursor --version
cursor-agent --version
agent --version
grok --version
grok --help
grok agent --help
```

Not every Cursor executable needs to be present: the provider uses the priority
`cursor` → `cursor-agent` → `agent` and records its resolved ACP launch prefix
in `list_external_agent_providers`. For `cursor`, it probes `cursor acp` and
`cursor agent acp`; the selected form is reused for start and resume.

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
`review` or `plan` run, and verify status/result tools and the resource. If a
permission is requested, select `allow-once` or `reject-once` yourself and
call `respond_external_agent_permission` with `userConfirmed: true`. Test
`implement` only in a disposable workspace after the two explicit opt-ins
documented in `INSTALL.md`.

## Verification boundaries

The repository tests mock the ACP JSON-RPC lifecycle; they do not install
Grok Build or Cursor CLI, authenticate either provider, or exercise Codex
Desktop. Those integrations must be verified on the user's machine.

The bundled fake ACP provider is available only when
`EXTERNAL_ACP_ENABLE_FAKE=1` is set. It exists solely for the deterministic
main-flow smoke test; it is not enabled in normal installations.

The prior referenced scratch branch was not readable from this repository's
remote, so this implementation was created from the design and current public
provider/plugin documentation.
