import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AntigravityProvider, antigravityChildEnvironment } from "../src/acp/antigravity.ts";
import { persistConfig } from "../src/config.ts";

function fakeBinary(home: string, name = "agy_acp_server.par"): string {
  const directory = join(home, ".local", "bin");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, name);
  writeFileSync(path, "#!/bin/sh\n");
  return path;
}

test("Antigravity resolves the official binary and never wraps agy", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-agy-home-"));
  const previousHome = process.env.HOME;
  const previousPath = process.env.PATH;
  const previousBin = process.env.AGY_ACP_BIN;
  try {
    delete process.env.AGY_ACP_BIN;
    process.env.HOME = home;
    process.env.PATH = join(home, ".local", "bin");
    const missing = new AntigravityProvider();
    assert.equal(missing.discover().available, false);
    assert.match(missing.discover().note ?? "", /never wraps the agy TUI/);
    assert.throws(() => missing.command({ cwd: home, prompt: "t", mode: "review" }), /never falls back to agy/);

    const binary = fakeBinary(home);
    const found = new AntigravityProvider();
    assert.equal(found.discover().available, false);
    assert.equal(found.discover().executable, binary);
    assert.match(found.discover().note ?? "", /Log in via the Antigravity IDE/);
    mkdirSync(join(home, ".gemini", "antigravity-acp"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-acp", "acp_token.json"), "{\"token\":1}");
    const loggedIn = new AntigravityProvider();
    assert.equal(loggedIn.discover().available, true);
    assert.equal(loggedIn.discover().executable, binary);
    assert.deepEqual(found.command({ cwd: home, prompt: "t", mode: "review" }), ["--uid="]);
    assert.equal(found.command({ cwd: home, prompt: "t", mode: "review", model: "gemini-3.8-flash" }).includes("--model"), false);

    writeFileSync(join(home, "agy"), "#!/bin/sh\n");
    process.env.AGY_ACP_BIN = join(home, "agy");
    const refused = new AntigravityProvider();
    assert.equal(refused.discover().available, false);
    assert.match(refused.discover().note ?? "", /agy TUI|Refusing to launch "agy"/);
    assert.throws(() => refused.command({ cwd: home, prompt: "t", mode: "review" }), /agy TUI|Refusing to launch "agy"|never falls back to agy/);
  } finally {
    process.env.HOME = previousHome;
    process.env.PATH = previousPath;
    if (previousBin === undefined) delete process.env.AGY_ACP_BIN;
    else process.env.AGY_ACP_BIN = previousBin;
  }
});

test("Antigravity treats a token file or API key as a known-good session", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-agy-token-"));
  const previousHome = process.env.HOME;
  const previousKey = process.env.GEMINI_API_KEY;
  try {
    process.env.HOME = home;
    delete process.env.GEMINI_API_KEY;
    const provider = new AntigravityProvider({ resolve: () => ({ executable: "/opt/agy_acp_server.par", args: ["--uid="] }) });
    assert.equal(provider.cliSessionKnownGood(), false);
    mkdirSync(join(home, ".gemini", "antigravity-acp"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-acp", "acp_token.json"), "{\"token\":1}");
    assert.equal(provider.cliSessionKnownGood(), true);
    delete process.env.HOME;
    process.env.GEMINI_API_KEY = "test-key";
    assert.equal(new AntigravityProvider({ resolve: () => ({ executable: "/opt/agy_acp_server.par", args: ["--uid="] }) }).cliSessionKnownGood(), true);
  } finally {
    process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test("Antigravity never advertises oauth-personal for the host child", () => {
  const provider = new AntigravityProvider({ resolve: () => ({ executable: "/opt/agy_acp_server.par", args: ["--uid="] }) });
  const previous = process.env.GEMINI_API_KEY;
  try {
    delete process.env.GEMINI_API_KEY;
    assert.equal(provider.authenticationMethod({
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    }), undefined);
    process.env.GEMINI_API_KEY = "k";
    assert.deepEqual(provider.authenticationMethod({
      authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
    }), { methodId: "gemini-api-key", type: undefined });
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("Antigravity maps every task mode to default and prefixes plan/review prompts", () => {
  const provider = new AntigravityProvider({ resolve: () => ({ executable: "/opt/agy_acp_server.par", args: ["--uid="] }) });
  assert.deepEqual(provider.acceptableSessionModes("review"), ["default"]);
  assert.deepEqual(provider.acceptableSessionModes("plan"), ["default"]);
  assert.deepEqual(provider.acceptableSessionModes("implement"), ["default"]);
  assert.match(provider.decoratePrompt("plan", "ship it"), /Create a plan only/);
  assert.match(provider.decoratePrompt("review", "look"), /read-only review/);
  assert.equal(provider.decoratePrompt("implement", "ship it"), "ship it");
});

test("Antigravity child environment forwards Gemini/Google names and not unrelated secrets", () => {
  const previous = process.env.UNRELATED_SECRET;
  const previousGemini = process.env.GEMINI_API_KEY;
  try {
    process.env.UNRELATED_SECRET = "nope";
    process.env.GEMINI_API_KEY = "gemini-test";
    const env = antigravityChildEnvironment({ cwd: "/tmp", prompt: "", mode: "review", envMode: "session" });
    assert.equal(env.GEMINI_API_KEY, "gemini-test");
    assert.equal(env.UNRELATED_SECRET, undefined);
  } finally {
    if (previous === undefined) delete process.env.UNRELATED_SECRET;
    else process.env.UNRELATED_SECRET = previous;
    if (previousGemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousGemini;
  }
});

test("configure stores agy as antigravity", () => {
  const home = mkdtempSync(join(tmpdir(), "agents-acp-agy-cfg-"));
  const saved = persistConfig({ defaultProvider: "agy" }, { HOME: home });
  assert.equal(saved.defaultProvider, "antigravity");
});
