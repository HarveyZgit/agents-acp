# Antigravity as an agents-acp executor

Status: research only. No adapter is shipped in this change.
Question: can `agents-acp` add Google Antigravity next to Cursor CLI and Grok Build?

**Verdict: yes**, using Google's official ACP server. Do not wrap the `agy` TUI and do not ship a community stdio shim.

## What “Antigravity” is

Three different artifacts share the name:

| Artifact | Role | Use as our executor? |
| --- | --- | --- |
| Antigravity IDE | Desktop product | No. Host, not a child process. |
| `agy` CLI | First-party terminal agent | No. Not a documented ACP stdio server. Community bridges that scrape it risk ToS (Zed #57221). |
| `antigravity-acp` / `agy_acp_server.par` | Official ACP registry agent (Google LLC) | **Yes.** This is the sanctioned client channel (Zed, AgentRQ, Pi). |

Registry id: `antigravity-acp`. Linux launch: `./agy_acp_server.par` with registry args `["--uid="]`. Flags are only `--debug` / `--notices`. There is **no** `--model`, `--effort`, or `--cwd` flag; cwd and model move through ACP.

Published builds (registry 1.1.1 / server build `agy_acp_server_20260818_01_RC01`): darwin-aarch64, linux-x86_64, linux-aarch64, windows-x86_64, windows-aarch64. **Intel macOS has no official artifact.** The binary is ~1.5 GB plus a `localharness_external` sibling. Cold start is several seconds on Linux and has been reported at 15–25 s on Windows (PyInstaller onefile).

Resolution order other hosts use: `AGY_ACP_BIN`, a managed `~/.local/opt/agy-acp/current/` install, `~/.local/bin/agy_acp_server.par`, then `PATH`. A global `agy` is not required.

## Protocol fit against our `AcpProvider`

Our server already speaks newline-delimited ACP JSON-RPC, session-first auth, `session/request_permission`, and process-group teardown. Antigravity speaks the same v1 surface. The gaps are launch and session config, not a second protocol.

Verified live (2026-09-03, linux-x86_64 RC01) by independent ACP clients:

| Step | Antigravity | Our Cursor / Grok adapters today |
| --- | --- | --- |
| Transport | NDJSON JSON-RPC on stdio | Same |
| `initialize` | protocolVersion 1, `authMethods[].id` | We already accept `methodId` or `id` |
| `authenticate` | `{ methodId }` | Same. Headless Google OAuth does **not** print the URL; prefer a pre-existing login |
| `session/new` | `{ cwd, mcpServers: [] }` | Same. We already send `mcpServers: []` |
| Model | **Not** a startup argv. Catalog + current model arrive on `session/new`. Change with `session/set_config_option` `{ configId: "model", value }` | Cursor/Grok pass `--model` in `command()` |
| Effort | Baked into the model slug (`gemini-3.8-flash-high`) | Cursor: launch-id suffix. Grok: `--effort` |
| Modes | `default` / `auto_edit` / `yolo` (permission policy, not ask/plan/agent) | We negotiate `ask` / `plan` / `agent` |
| `session/load` | Works (`loadSession: true`) | We already resume |
| `session/cancel` | **-32601 Method not found** on RC01 | We notify cancel then kill the process group — keep the kill path |
| Permissions | `session/request_permission` with once-only option ids | Already relayed |
| Plan | Available-command `plan`, not a session mode | Map `mode: "plan"` to a prompt instruction or `/plan`; do not invent a mode id |

Auth methods: `oauth-personal`, `oauth-business`, `gemini-api-key` (`GEMINI_API_KEY`), `agent-platform` (ADC / `GOOGLE_API_KEY`). Persistent login lives under `~/.gemini/antigravity-acp/` (`settings.json`, `acp_token.json`). `settings.json` is read at **process start**. Unauthenticated `session/new` returns `-32000` with that recipe — the same code we already treat as `auth_required`.

Do not call `authenticate(oauth-personal)` from a Codex/Claude-spawned child expecting a browser. Prefer: operator already logged in via IDE/Zed/`settings.json`, then session-first. `cliSessionKnownGood` can check `acp_token.json` or `GEMINI_API_KEY` the way Cursor checks `cursor-agent status`.

## Mapping to our tools

`defaultProvider: "antigravity"` (or `"agy"` — prefer the registry name).

`configure` / `start` model keywords resolve against the catalog from the last `session/new` (or a cached copy). Example: user says `flash high` → persist base `gemini-3.8-flash` + `defaultEffort: "high"` → launch value `gemini-3.8-flash-high`. That matches the Fast/High split we already have, except Antigravity has no separate speed dimension.

Task modes:

| Our `start.mode` | Antigravity session mode | Notes |
| --- | --- | --- |
| `review` | `default` | Fail closed if we cannot keep permission prompts. Never `yolo`. |
| `plan` | `default` + plan instruction / available command | No `plan` mode id. |
| `implement` | `default` | Still requires `allowImplement`. `auto_edit` / `yolo` would auto-approve writes; that violates our respond-tool gate. |

`listModels` cannot be a 5 s `--version` / `--list-models` spawn. Discover should look for the binary (`AGY_ACP_BIN` / `agy_acp_server.par` / `antigravity-acp`) and treat “present + token or API key” as available. Catalog: cache from `session/new`, or omit options until the first run. Raising the discover timeout to cover a 1.5 GB cold start is required if we probe by actually starting the server.

Environment allowlist additions: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `AGY_ACP_BIN`, and `GEMINI_` / `GOOGLE_` prefixes. Home + XDG already cover `~/.gemini`.

## What would have to change in this repo

1. `ProviderName` and `configure` enum gain `antigravity`.
2. New `acp/antigravity.ts`: resolve the official binary, `command()` is argv-only (no model flags), session env as above.
3. `RunController` after `session/new`: if the provider selects models in-session, call `session/set_config_option` for model (and keep mode at `default`). Cursor/Grok stay startup-flag.
4. `parseCatalogId` / `resolveModelSelection` accept Gemini slugs with `high|medium|low` effort suffixes (already close to Cursor suffix parsing; add `medium`).
5. Discover timeout and “available” heuristic; do not require `agy` on PATH.
6. Skills / `get_config` questions list three agents. Docs: install from the ACP registry or `AGY_ACP_BIN`, login once outside the host.

Out of scope for a first adapter: `yolo`, downloading the 1.5 GB registry blob ourselves, Intel macOS, wrapping `agy`.

## Risks

- **Cancel is process kill only** until Google implements `session/cancel`.
- **Headless OAuth is unusable** in a plugin child (no URL on stdio).
- **Cold start + size** will look like “hung” if we keep a 5 s probe.
- **Registry checksums** are missing on some indexes; we should not fetch unverified blobs. Operator installs the binary.
- **Mode vocabulary mismatch**: treating `yolo` as implement would silently skip our permission tools.

## Sources

- ACP Registry agent `antigravity-acp`; Zed listing (launch `./agy_acp_server.par`).
- Live RC01 capture: [ACP protocol reference](https://cdn.jsdelivr.net/npm/@estebanforge/pi-antigravity-bridge@1.4.7/docs/ACP-PROTOCOL-REFERENCE.md) (2026-09-03).
- [ACP adoption notes](https://cdn.jsdelivr.net/npm/@estebanforge/pi-antigravity-bridge@1.6.0/docs/ACP-ADOPTION-PLAN.md) (binary, auth, `configId`).
- AgentRQ Antigravity setup (registry install, model slugs, login-first).
- Google AI Developers Forum thread on `agy_acp_server` Windows cold start (ACP 1.1.1 vs `agy` 1.2.5).
- Community `sysCat64/agy-acp` (CLI scrape — reject for this plugin).
