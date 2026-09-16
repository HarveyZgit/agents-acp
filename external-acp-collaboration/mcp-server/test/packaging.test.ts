import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const pluginRoot = new URL("../../", import.meta.url).pathname;

test("plugin MCP config uses the camelCase key Codex loads, with cwd and env forwarding", () => {
  const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers, "Codex reads the camelCase `mcpServers` wrapper");
  assert.equal(mcp.mcp_servers, undefined, "the snake_case wrapper is the TOML spelling and is not loaded");

  const server = mcp.mcpServers["agents-acp"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["--experimental-strip-types", "./mcp-server/src/index.ts"]);
  // Relative args only resolve when cwd is pinned to the installed plugin root.
  assert.equal(server.cwd, ".");
  assert.ok(Number.isInteger(server.startup_timeout_sec));

  for (const name of [
    "AGENTS_ACP_CONFIG",
    "EXTERNAL_ACP_WORKSPACE",
    "EXTERNAL_ACP_ALLOWED_SUBTREES",
    "EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT",
    "EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES",
    "EXTERNAL_ACP_MAX_RUN_MS",
    "EXTERNAL_ACP_STORE_PATH",
    "EXTERNAL_ACP_ENV_MODE",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "XAI_API_KEY",
    "HOME",
    "PATH",
  ]) {
    assert.ok(server.env_vars.includes(name), `${name} must be forwarded through env_vars`);
  }
  assert.equal(server.env, undefined, "secrets must never be inlined in the plugin manifest");
});

test("plugin and MCP manifests agree on the agents-acp identity and version", () => {
  const plugin = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(pluginRoot, "mcp-server", "package.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
  const install = readFileSync(new URL("../../../INSTALL.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.equal(plugin.name, "agents-acp");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.ok(mcp.mcpServers["agents-acp"]);
  assert.equal(server.version, plugin.version);
  assert.match(install, new RegExp(`agents-acp-${plugin.version}\\.tar\\.gz`));
  assert.match(readme, new RegExp(plugin.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("configuration file is primary and forwarded environment variables override it", () => {
  const directory = mkdtempSync(join(tmpdir(), "agents-acp-config-"));
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify({
    workspace: "/from/file",
    allowedSubtrees: ["/from/file/packages"],
    allowUnsandboxedImplement: true,
    enablePermissionResponses: true,
    maxRunMs: 120_000,
    envMode: "minimal",
  }));

  const fromFile = loadConfig({ AGENTS_ACP_CONFIG: configPath });
  assert.equal(fromFile.workspace, "/from/file");
  assert.deepEqual(fromFile.allowedSubtrees, ["/from/file/packages"]);
  assert.equal(fromFile.allowUnsandboxedImplement, true);
  assert.equal(fromFile.enablePermissionResponses, true);
  assert.equal(fromFile.maxRunMs, 120_000);
  assert.equal(fromFile.envMode, "minimal");
  assert.equal(fromFile.configLoaded, true);

  const overridden = loadConfig({
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_WORKSPACE: "/from/env",
    EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT: "0",
    EXTERNAL_ACP_ENV_MODE: "inherit",
  });
  assert.equal(overridden.workspace, "/from/env");
  assert.equal(overridden.allowUnsandboxedImplement, false);
  assert.equal(overridden.envMode, "inherit");

  const missing = loadConfig({ AGENTS_ACP_CONFIG: join(directory, "absent.json") });
  assert.equal(missing.configLoaded, false);
  assert.equal(missing.workspace, undefined);
  assert.equal(missing.envMode, "session");
});
