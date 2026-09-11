# Task: Build a generic ACP-provider plugin for Codex

You are a cloud coding agent. Implement source code only; you do not have access to the user's local machine, local CLI installations, login state, or Codex Desktop UI. Do not claim that you tested those local integrations.

## Product goal

Build an installable Codex Desktop plugin named `external-acp-collaboration`. It lets Codex delegate tasks to any locally installed **ACP-capable coding agent**, with initial adapters for:

- Grok Build CLI
- Cursor CLI

The user-facing goal is a visible, expandable run panel inside Codex app: status, elapsed time, progress/text, tool activity, permission requests, changed-file summary, errors, cancellation, resume, and final result. It is not intended to impersonate Codex's native subagent card.

## Inputs available in this repository

Read the repository's design documents first. The current reference documents are expected under `outputs/` and describe the ACP-first design. If paths differ, search the workspace for `external-acp` and `ACP` before proceeding.

The design is normative except where current official Codex, MCP, ACP, Cursor, or Grok documentation differs. In a conflict, use the smallest documented compatible approach and record the difference in the final report.

## Environment boundary

Your cloud environment may not contain Grok Build, Cursor CLI, credentials, or the actual Codex plugin runtime. Therefore:

- Do not install either provider or authenticate to it.
- Do not run a real external-agent task.
- Implement provider discovery and ACP process launching as runtime code, but test them only with mocks/fakes.
- Add a local verification guide for the eventual user, including harmless read-only checks (`--version`, `--help`, documented status commands).

## Required implementation

Create a self-contained plugin directory at the repository root named `external-acp-collaboration/` (or use the project convention if one exists).

Implement:

1. A Codex plugin manifest and a reusable Skill that tells Codex when and how to use external ACP agents.
2. A local MCP server with these tools:
   - `list_external_agent_providers`
   - `start_external_agent`
   - `get_external_agent_status`
   - `cancel_external_agent`
   - `resume_external_agent`
   - `get_external_agent_result`
3. A provider interface. It must separate shared ACP lifecycle code from provider-specific command, authentication, model-selection, and extension-event handling.
4. Initial adapters for Grok Build and Cursor, implemented against their documented stdio ACP entry points. Keep process invocation argument-array based; never concatenate prompts into shell commands.
5. A provider-neutral run event model: `started`, `text`, `activity`, `permission`, `file_change`, `error`, and `completed`.
6. A persistent but minimal local run/session store. It must contain no credentials or prompt secrets.
7. A policy module: cwd limited to the active workspace or explicitly authorized subtree; `review`/`plan` read-only and parallelizable; `implement` only when caller explicitly opts in and serialized per workspace; no auto-approval of ACP permissions.
8. An optional custom plugin UI / resource that renders a run panel, **only when the available official Codex plugin SDK/runtime documents a supported mechanism**. If unavailable in this cloud environment, implement structured tool results and a UI adapter boundary, then document the exact local runtime capability still needed.

## Model selection requirement

ACP itself is the session/streaming protocol; do not assume it defines one universal `model` field. Treat model selection as provider-specific capability.

Expose an optional `model` request field and provider capability metadata, such as:

```ts
type ProviderCapabilities = {
  supportsModelSelection: boolean;
  modelSelection: "startup" | "session" | "config" | "none";
  supportedModes: Array<"ask" | "plan" | "agent">;
};
```

Only pass a model to a provider when its documented ACP launch/session/configuration path supports it. Otherwise return a clear “model selection unavailable for this provider/version” result. Do not fake this feature through prompt text.

## Validation

- Add focused unit tests for policy enforcement, run store, event normalization, and mocked ACP JSON-RPC flows.
- Build/lint/test only with dependencies already available. If a package install is required, stop and report the exact command rather than installing it.
- Inspect the final diff. Report files created, checks run, mocked vs real verification, and the user's local install/test steps.

## Do not do

- Do not install/update tools or dependencies without explicit user approval.
- Do not store/prompt/log API keys or tokens.
- Do not start full-screen TUIs, invent unsupported Codex UI metadata, create an unrelated daemon, or make an agent appear as a native Codex subagent.
- Do not commit, publish, or modify global settings.

## Done criteria

The repository contains a generic multi-provider ACP plugin with Grok Build and Cursor adapters, mocks/tests for the protocol core, and a clear local verification guide. Any inability to render the Codex UI or run a real provider in the cloud environment is explicitly documented rather than guessed.
