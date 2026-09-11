# Linux Codex installation — external-acp-collaboration 0.1.1

## Preconditions

- Linux with Node.js 22.6 or newer (`node --version`). The plugin runs
  dependency-free TypeScript with Node's `--experimental-strip-types`.
- Codex with the documented `codex plugin marketplace` command available.
- Optionally, an already installed and already authenticated Cursor CLI
  (`agent`) and/or Grok Build CLI (`grok`). Do not install or authenticate a
  provider just to use this plugin.

## Install from this repository

The repository already contains the documented marketplace file
`.agents/plugins/marketplace.json`. Its source path is relative to the
repository root.

```bash
git clone https://github.com/HarveyZgit/agents-acp.git
cd agents-acp

# Choose the only workspace in which provider processes may be started.
export EXTERNAL_ACP_WORKSPACE="/absolute/path/to/project"

# Optional: restrict launches further to existing paths beneath that workspace.
export EXTERNAL_ACP_ALLOWED_SUBTREES="/absolute/path/to/project/packages"

# Register the repository as a local Codex marketplace, then verify it.
codex plugin marketplace add "$PWD"
codex plugin marketplace list
```

Start the Codex client from the same environment so the bundled MCP server
inherits `EXTERNAL_ACP_WORKSPACE`. In the Desktop app, install and enable
`external-acp-collaboration` from the added marketplace, then enable its
bundled MCP server. Restart the desktop app after changing plugin files.

The plugin fails closed: `start_external_agent` and
`resume_external_agent` return an error when `EXTERNAL_ACP_WORKSPACE` is not
present or does not name an existing directory. A Desktop launcher that does
not inherit shell variables needs an OS-level environment configuration; no
portable Codex Desktop setting for that is documented here.

## Smoke test

Run only read-only commands first:

```bash
node --version
agent --version
agent --help
grok --version
grok --help
grok agent --help

cd external-acp-collaboration/mcp-server
npm test
```

In Codex, enable the plugin and call:

1. `list_external_agent_providers`
2. `start_external_agent` with `mode: "review"` and a harmless read-only
   prompt, with `cwd` inside `EXTERNAL_ACP_WORKSPACE`
3. `get_external_agent_status` while it runs, then
   `get_external_agent_result` after completion

If a provider asks permission, the run remains pending. This is intentional:
there is no model-callable approval method. Use `cancel_external_agent` to
stop it. A human-approved permission flow requires a future documented Codex
plugin UI/callback API.

## Optional write-mode test

A provider process is not an operating-system sandbox: setting its `cwd`
does not stop a CLI from issuing an absolute-path command. For that reason,
write mode has two explicit gates and should only be used in a disposable
workspace:

```bash
export EXTERNAL_ACP_WORKSPACE="/absolute/path/to/disposable-project"
export EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT=1
```

Then use `start_external_agent` with `mode: "implement"` and
`allowImplement: true`. The plugin serializes this mode per configured
workspace but does not claim to provide OS-level filesystem isolation.

## Archive

`dist/external-acp-collaboration-0.1.1.zip` and
`dist/external-acp-collaboration-0.1.1.tar.gz` are portable copies of the
plugin folder. Extract either into a directory, then create a marketplace
entry whose `source.path` is `./external-acp-collaboration` relative to that
marketplace root.

Rebuild the archive from the repository root without installing dependencies:

```bash
rm -f dist/external-acp-collaboration-0.1.1.tar.gz
tar -C . -czf dist/external-acp-collaboration-0.1.1.tar.gz external-acp-collaboration
rm -f dist/external-acp-collaboration-0.1.1.zip
zip -qr dist/external-acp-collaboration-0.1.1.zip external-acp-collaboration
sha256sum dist/external-acp-collaboration-0.1.1.{tar.gz,zip}
```
