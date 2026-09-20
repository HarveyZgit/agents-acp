import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const serverRoot = new URL("..", import.meta.url);
const catalogFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor-catalog.json");

async function callMcp(env: NodeJS.ProcessEnv, calls: Array<{ id: number; name: string; args: Record<string, unknown> }>) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/index.ts"], {
    cwd: serverRoot,
    env: { PATH: process.env.PATH, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: string[] = [];
  const errors: string[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => output.push(...chunk.trim().split("\n").filter(Boolean)));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => errors.push(chunk));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
  for (const call of calls) {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: call.id,
      method: "tools/call",
      params: { name: call.name, arguments: call.args },
    })}\n`);
  }
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("close", () => resolve());
    child.on("error", reject);
  });
  const responses = output.map((line) => JSON.parse(line));
  return { responses, errors: errors.join("") };
}

function toolResult(responses: Array<{ id?: number; result?: { isError?: boolean; content?: Array<{ text: string }> } }>, id: number) {
  const response = responses.find((entry) => entry.id === id);
  assert.ok(response, `missing MCP response ${id}`);
  const text = response.result?.content?.[0]?.text ?? "";
  return {
    isError: response.result?.isError === true,
    body: text ? JSON.parse(text) : {},
  };
}

test("MCP configure resolves a keyword against a fixture catalog and never writes the raw text", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-ws-"));
  const { responses, errors } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_ENABLE_FAKE: "1",
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  }, [
    {
      id: 1,
      name: "configure",
      args: {
        workspace,
        defaultProvider: "cursor",
        defaultModel: "composer 2.5",
        defaultEffort: "high",
        defaultSpeed: "fast",
        userConfirmed: true,
      },
    },
    { id: 2, name: "get_config", args: { suggestedWorkspace: workspace } },
    {
      id: 3,
      name: "start",
      args: { provider: "fake", cwd: workspace, prompt: "task from stored defaults", mode: "review" },
    },
    {
      id: 4,
      name: "start",
      args: { cwd: workspace, prompt: "omit provider after configure", mode: "review" },
    },
  ]);
  const saved = toolResult(responses, 1);
  const snapshot = toolResult(responses, 2);
  const started = toolResult(responses, 3);
  const defaulted = toolResult(responses, 4);
  assert.equal(saved.isError, false, `${errors} ${JSON.stringify(saved.body)}`);
  assert.equal(saved.body.defaultModel, "composer-2.5");
  assert.equal(saved.body.resolved?.catalogId, "composer-2.5");
  assert.equal(saved.body.resolved?.query, "composer 2.5");
  assert.equal(saved.body.launchModel, "composer-2.5-high-fast");
  assert.equal(snapshot.body.defaultModel, "composer-2.5");
  assert.equal(snapshot.body.host, "codex");
  const written = JSON.parse(readFileSync(snapshot.body.configPath, "utf8"));
  assert.equal(written.defaultModel, "composer-2.5");
  assert.equal(JSON.stringify(written).includes("composer 2.5"), false);
  assert.equal(existsSync(join(workspace, ".agents-acp")), false);
  assert.equal(started.isError, false, started.body.error);
  assert.equal(/No default provider/i.test(defaulted.body.error ?? ""), false);
});

test("MCP configure rejects qualifier-only, unknown, and ambiguous keywords", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-rej-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-rejws-"));
  const { responses } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  }, [
    {
      id: 1,
      name: "configure",
      args: { workspace, defaultProvider: "cursor", defaultModel: "high fast", userConfirmed: true },
    },
    {
      id: 2,
      name: "configure",
      args: { workspace, defaultProvider: "cursor", defaultModel: "not-a-real-model", userConfirmed: true },
    },
    {
      id: 3,
      name: "configure",
      args: { workspace, defaultProvider: "cursor", defaultModel: "composer", userConfirmed: true },
    },
  ]);
  assert.equal(toolResult(responses, 1).isError, true);
  assert.match(toolResult(responses, 1).body.error, /only effort\/speed/);
  assert.match(toolResult(responses, 2).body.error, /No cursor catalog model matches/);
  assert.match(toolResult(responses, 3).body.error, /Ambiguous model keyword/);
  assert.equal(existsSync(join(home, ".codex", "agents-acp", "config.json")), false);
});

test("MCP configure clears model, effort, and speed together", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-clr-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-clrws-"));
  const { responses } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  }, [
    {
      id: 1,
      name: "configure",
      args: {
        workspace,
        defaultProvider: "cursor",
        defaultModel: "opus",
        defaultEffort: "high",
        defaultSpeed: "fast",
        userConfirmed: true,
      },
    },
    { id: 2, name: "configure", args: { defaultModel: "", userConfirmed: true } },
    { id: 3, name: "get_config", args: {} },
  ]);
  const first = toolResult(responses, 1);
  assert.equal(first.body.defaultModel, "claude-opus-4-8-thinking");
  assert.equal(first.body.defaultModel.includes(" "), false);
  const cleared = toolResult(responses, 3);
  assert.equal(cleared.body.defaultModel, undefined);
  assert.equal(cleared.body.defaultEffort, undefined);
  assert.equal(cleared.body.defaultSpeed, undefined);
  const written = JSON.parse(readFileSync(cleared.body.configPath, "utf8"));
  assert.equal("defaultModel" in written, false);
  assert.equal("defaultEffort" in written, false);
  assert.equal("defaultSpeed" in written, false);
});

test("MCP start resolves an explicit model keyword without login", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-start-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-startws-"));
  const { responses } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_WORKSPACE: workspace,
    EXTERNAL_ACP_DEFAULT_PROVIDER: "cursor",
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
    EXTERNAL_ACP_ENABLE_FAKE: "1",
  }, [
    {
      id: 1,
      name: "start",
      args: {
        provider: "cursor",
        cwd: workspace,
        prompt: "keyword launch",
        mode: "review",
        model: "composer 2.5",
        effort: "high",
        speed: "fast",
      },
    },
    {
      id: 2,
      name: "start",
      args: {
        provider: "fake",
        cwd: workspace,
        prompt: "after keyword resolve",
        mode: "review",
      },
    },
  ]);
  const cursorStart = toolResult(responses, 1);
  assert.equal(cursorStart.isError, true);
  assert.match(cursorStart.body.error, /cursor-agent ACP is unavailable|not found on PATH|unavailable on PATH/i);
  assert.equal(/catalog is unavailable|No cursor catalog model matches|raw keyword/i.test(cursorStart.body.error), false);
  const fakeStart = toolResult(responses, 2);
  assert.equal(fakeStart.isError, false, fakeStart.body.error);
});

test("MCP env launch id is stored as base + Fast/High, not doubled", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-envlaunch-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-envlaunchws-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({
    workspace,
    defaultProvider: "cursor",
    enableFake: true,
  }));
  const loaded = loadConfig({
    HOME: home,
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_DEFAULT_MODEL: "composer-2.5-high-fast",
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  });
  assert.equal(loaded.defaultModel, "composer-2.5");
  assert.equal(loaded.defaultEffort, "high");
  assert.equal(loaded.defaultSpeed, "fast");

  const { responses } = await callMcp({
    HOME: home,
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_DEFAULT_MODEL: "composer-2.5-high-fast",
    EXTERNAL_ACP_ENABLE_FAKE: "1",
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  }, [{ id: 1, name: "get_config", args: {} }]);
  const snapshot = toolResult(responses, 1);
  assert.equal(snapshot.body.defaultModel, "composer-2.5");
  assert.equal(snapshot.body.defaultEffort, "high");
  assert.equal(snapshot.body.defaultSpeed, "fast");
  assert.equal(snapshot.body.launchModel, "composer-2.5-high-fast");
  assert.equal(String(snapshot.body.launchModel).includes("high-fast-high-fast"), false);
});

test("MCP configure resolves an Antigravity keyword without login", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-agy-cfg-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-agy-cfgws-"));
  const { responses } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_ENABLE_FAKE: "1",
    EXTERNAL_ACP_CATALOG_FIXTURE: catalogFixture,
  }, [
    {
      id: 1,
      name: "configure",
      args: {
        workspace,
        defaultProvider: "agy",
        defaultModel: "flash high",
        userConfirmed: true,
      },
    },
    { id: 2, name: "get_config", args: {} },
    {
      id: 3,
      name: "start",
      args: {
        provider: "antigravity",
        cwd: workspace,
        prompt: "keyword launch",
        mode: "review",
        model: "flash",
        effort: "high",
      },
    },
  ]);
  const saved = toolResult(responses, 1);
  const snapshot = toolResult(responses, 2);
  const started = toolResult(responses, 3);
  assert.equal(saved.isError, false, JSON.stringify(saved.body));
  assert.equal(saved.body.defaultProvider, "antigravity");
  assert.equal(saved.body.defaultModel, "gemini-3.8-flash");
  assert.equal(saved.body.defaultEffort, "high");
  assert.equal(saved.body.launchModel, "gemini-3.8-flash-high");
  assert.equal(snapshot.body.defaultProvider, "antigravity");
  assert.equal(started.isError, true);
  assert.match(started.body.error, /AGY_ACP_BIN|never falls back to agy|unavailable/i);
  assert.equal(/catalog is unavailable|raw keyword/i.test(started.body.error), false);
});

test("MCP env default model cannot inject a raw keyword", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-env-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-envws-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ workspace, enableFake: true }));
  const loaded = loadConfig({
    HOME: home,
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_DEFAULT_MODEL: "composer 2.5 high fast",
  });
  assert.equal(loaded.defaultModel, undefined);

  const { responses } = await callMcp({
    HOME: home,
    AGENTS_ACP_CONFIG: configPath,
    EXTERNAL_ACP_DEFAULT_MODEL: "composer 2.5 high fast",
    EXTERNAL_ACP_ENABLE_FAKE: "1",
  }, [{ id: 1, name: "get_config", args: {} }]);
  const snapshot = toolResult(responses, 1);
  assert.equal(snapshot.body.defaultModel, undefined);
  assert.equal(String(snapshot.body.defaultModel ?? "").includes(" "), false);
});

test("MCP respond_permission rejects a string userConfirmed", async () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-cat-perm-"));
  const workspace = mkdtempSync(join(tmpdir(), "agents-acp-cat-permws-"));
  const { responses } = await callMcp({
    HOME: home,
    EXTERNAL_ACP_WORKSPACE: workspace,
    EXTERNAL_ACP_ENABLE_FAKE: "1",
    EXTERNAL_ACP_ENABLE_PERMISSION_RESPONSES: "1",
  }, [
    {
      id: 1,
      name: "respond_permission",
      args: { runId: "missing", requestId: "rpc-1", optionId: "allow-once", userConfirmed: "true" },
    },
  ]);
  assert.equal(toolResult(responses, 1).isError, true);
  assert.match(toolResult(responses, 1).body.error, /userConfirmed/);
});
