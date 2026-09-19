import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectHost, isProjectLocalRuntimeDir, loadConfig, persistConfig } from "../src/config.ts";

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
    "AGENTS_ACP_HOME",
    "EXTERNAL_ACP_WORKSPACE",
    "EXTERNAL_ACP_DEFAULT_PROVIDER",
    "EXTERNAL_ACP_DEFAULT_MODEL",
    "EXTERNAL_ACP_DEFAULT_EFFORT",
    "EXTERNAL_ACP_DEFAULT_SPEED",
    "EXTERNAL_ACP_ALLOWED_SUBTREES",
    "EXTERNAL_ACP_ALLOW_UNSANDBOXED_IMPLEMENT",
    "EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES",
    "EXTERNAL_ACP_MAX_RUN_MS",
    "EXTERNAL_ACP_STORE_PATH",
    "EXTERNAL_ACP_ENV_MODE",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "AGENT_CLI_CREDENTIAL_STORE",
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

test("plugin ships invocable $config and $dispatch skills", () => {
  const plugin = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.skills, "./skills/");
  const skillsRoot = join(pluginRoot, "skills");
  const skillFiles = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsRoot, entry.name, "SKILL.md"));
  const bodies = skillFiles.map((file) => readFileSync(file, "utf8"));
  const names = bodies.flatMap((body) => {
    const match = /^name:\s*(\S+)/m.exec(body);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(new Set(names), new Set(["config", "dispatch"]));

  const setup = bodies.find((body) => /^name:\s*config$/m.test(body)) ?? "";
  assert.match(setup, /get_config/);
  assert.match(setup, /configure/);
  assert.match(setup, /userConfirmed/);
  assert.match(setup, /catalog/);
  assert.match(setup, /defaultEffort|defaultSpeed|Fast|High/);
  assert.match(setup, /Do not start an ACP run|do not call `start`/i);

  const dispatch = bodies.find((body) => /^name:\s*dispatch$/m.test(body)) ?? "";
  assert.match(dispatch, /config skill|`config`|\$config/);
  assert.match(dispatch, /start/);
  assert.match(dispatch, /Claude Code|native Codex or Claude/);

  const install = readFileSync(new URL("../../../INSTALL.md", import.meta.url), "utf8");
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  assert.match(install, /\$config|\/plugin/);
  assert.match(install, /Claude Code/);
  assert.match(readme, /\$config/);
  assert.match(readme, /\$dispatch/);
  assert.match(readme, /Claude Code/);
});

test("plugin ships a Claude Code manifest that launches via CLAUDE_PLUGIN_ROOT", () => {
  const claude = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  const codex = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.claude.json"), "utf8"));
  const marketplace = JSON.parse(readFileSync(new URL("../../../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(claude.name, "agents-acp");
  assert.equal(claude.version, codex.version);
  assert.equal(claude.skills, "./skills/");
  assert.equal(claude.mcpServers, "./.mcp.claude.json");
  const server = mcp.mcpServers["agents-acp"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, [
    "--experimental-strip-types",
    "${CLAUDE_PLUGIN_ROOT}/mcp-server/src/index.ts",
  ]);
  assert.equal(server.env, undefined);
  assert.equal(marketplace.name, "agents-acp");
  assert.equal(marketplace.plugins[0].source, "./external-acp-collaboration");
  assert.equal(marketplace.plugins[0].strict, true);
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
  assert.equal(missing.storePath, join(directory, "runs.json"));
  assert.equal(fromFile.defaultProvider, undefined);
});

test("runtime files stay under the central dir and ignore project-local .agents-acp", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-home-"));
  const project = mkdtempSync(join(tmpdir(), "agents-acp-project-"));
  const localRuntime = join(project, ".agents-acp");
  mkdirSync(localRuntime, { recursive: true });
  writeFileSync(join(localRuntime, "config.json"), JSON.stringify({ workspace: "/should-not-load" }));

  assert.equal(isProjectLocalRuntimeDir(localRuntime), true);

  const fromPluginData = loadConfig({
    HOME: home,
    PLUGIN_DATA: localRuntime,
    CLAUDE_PLUGIN_DATA: localRuntime,
  });
  assert.equal(detectHost({ CLAUDE_PLUGIN_DATA: localRuntime }), "claude");
  assert.equal(fromPluginData.host, "claude");
  assert.equal(fromPluginData.configPath, join(home, ".claude", "agents-acp", "config.json"));
  assert.equal(fromPluginData.runtimeDir, join(home, ".claude", "agents-acp"));
  assert.equal(fromPluginData.workspace, undefined);
  assert.equal(fromPluginData.storePath, join(home, ".claude", "agents-acp", "runs.json"));

  const fromCodex = loadConfig({ HOME: home });
  assert.equal(fromCodex.host, "codex");
  assert.equal(fromCodex.configPath, join(home, ".codex", "agents-acp", "config.json"));

  const fromClaudeRoot = loadConfig({
    HOME: home,
    CLAUDE_PLUGIN_ROOT: join(home, "plugin-cache", "agents-acp"),
  });
  assert.equal(fromClaudeRoot.host, "claude");
  assert.equal(fromClaudeRoot.runtimeDir, join(home, ".claude", "agents-acp"));

  const relocated = loadConfig({
    HOME: home,
    AGENTS_ACP_HOME: localRuntime,
    AGENTS_ACP_CONFIG: join(localRuntime, "config.json"),
  });
  assert.equal(relocated.configPath, join(home, ".codex", "agents-acp", "config.json"));
  assert.equal(existsSync(join(project, ".agents-acp", "runs.json")), false);
});

test("configure persists defaults centrally and never writes the project", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cfghome-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cfgws-"));
  const env = { HOME: home };
  const saved = persistConfig({
    workspace,
    defaultProvider: "cursor",
    defaultModel: "composer-2.5",
    defaultEffort: "high",
    defaultSpeed: "fast",
    enablePermissionResponses: true,
  }, env);
  assert.equal(saved.workspace, workspace);
  assert.equal(saved.defaultProvider, "cursor");
  assert.equal(saved.defaultModel, "composer-2.5");
  assert.equal(saved.defaultEffort, "high");
  assert.equal(saved.defaultSpeed, "fast");
  assert.equal(saved.configPath, join(home, ".codex", "agents-acp", "config.json"));
  const written = JSON.parse(readFileSync(saved.configPath, "utf8"));
  assert.equal(written.defaultProvider, "cursor");
  assert.equal(written.defaultModel, "composer-2.5");
  assert.equal(written.defaultEffort, "high");
  assert.equal(written.defaultSpeed, "fast");
  assert.equal(existsSync(join(workspace, ".agents-acp")), false);

  const cleared = persistConfig({ defaultModel: "" }, env);
  assert.equal(cleared.defaultModel, undefined);
  assert.equal(cleared.defaultEffort, undefined);
  assert.equal(cleared.defaultSpeed, undefined);
  const clearedFile = JSON.parse(readFileSync(saved.configPath, "utf8"));
  assert.equal("defaultModel" in clearedFile, false);
  assert.equal("defaultEffort" in clearedFile, false);
  assert.equal("defaultSpeed" in clearedFile, false);
  assert.throws(
    () => persistConfig({ defaultModel: "composer 2.5 high fast" }, env),
    /catalog id|raw keyword/,
  );

  const projectRuntime = join(workspace, ".agents-acp");
  const relocated = persistConfig({
    defaultProvider: "grok",
  }, { HOME: home, AGENTS_ACP_HOME: projectRuntime });
  assert.equal(relocated.configPath, join(home, ".codex", "agents-acp", "config.json"));
  assert.equal(relocated.defaultProvider, "grok");
  assert.equal(existsSync(projectRuntime), false);
});
