import assert from "node:assert/strict";
import test from "node:test";
import {
  composeAntigravityLaunchId,
  composeCursorLaunchId,
  currentSessionModel,
  extractQualifiers,
  parseCatalogId,
  parseListModelsOutput,
  parseSessionModels,
  resolveModelSelection,
  storedModelParts,
} from "../src/models.ts";

const catalogText = `
Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
composer-2.5-high-fast - Composer 2.5 High Fast
gpt-5.4-high - GPT-5.4 High
gpt-5.4-high-fast - GPT-5.4 High Fast
claude-opus-4-8-thinking-high-fast - Opus 4.8 1M Thinking Fast
`;

test("parses cursor --list-models rows and strips effort/speed suffixes", () => {
  const models = parseListModelsOutput(`\u001b[32m${catalogText}\u001b[0m`);
  assert.equal(models.find((model) => model.id === "composer-2.5")?.base, "composer-2.5");
  assert.deepEqual(parseCatalogId("composer-2.5-high-fast", "Composer 2.5 High Fast"), {
    id: "composer-2.5-high-fast",
    label: "Composer 2.5 High Fast",
    base: "composer-2.5",
    effort: "high",
    speed: "fast",
  });
  assert.equal(parseCatalogId("gpt-5.4-high").speed, "standard");
  assert.equal(parseCatalogId("auto", "Auto (default)").base, "auto");
});

test("extracts Fast speed and High effort from a user keyword without treating them as the model", () => {
  assert.deepEqual(extractQualifiers("composer 2.5 fast high"), {
    query: "composer 2.5",
    effort: "high",
    speed: "fast",
  });
  assert.deepEqual(extractQualifiers("opus"), { query: "opus" });
});

test("resolves a keyword to a catalog base id and composes the Cursor launch id", () => {
  const catalog = parseListModelsOutput(catalogText);
  const resolved = resolveModelSelection(catalog, "composer 2.5", "high", "fast");
  assert.equal(resolved?.model, "composer-2.5");
  assert.equal(resolved?.effort, "high");
  assert.equal(resolved?.speed, "fast");
  assert.equal(resolved?.launchId, "composer-2.5-high-fast");
  assert.equal(resolved?.model.includes(" "), false);

  const combined = resolveModelSelection(catalog, "composer 2.5 high fast");
  assert.equal(combined?.model, "composer-2.5");
  assert.equal(combined?.effort, "high");
  assert.equal(combined?.speed, "fast");
  assert.equal(combined?.launchId, "composer-2.5-high-fast");

  const launchId = resolveModelSelection(catalog, "composer-2.5-high-fast");
  assert.equal(launchId?.model, "composer-2.5");
  assert.equal(launchId?.effort, "high");
  assert.equal(launchId?.speed, "fast");

  const opus = resolveModelSelection(catalog, "opus");
  assert.equal(opus?.model, "claude-opus-4-8-thinking");
  assert.equal(opus?.effort, undefined);
  assert.equal(opus?.speed, undefined);
  assert.equal(opus?.model.includes("opus"), true);
});

test("refuses to persist an unmatched, qualifier-only, or unresolved keyword", () => {
  const catalog = parseListModelsOutput(catalogText);
  assert.throws(() => resolveModelSelection(catalog, "not-a-real-model"), /No cursor catalog model matches/);
  assert.throws(() => resolveModelSelection(catalog, "high fast"), /only effort\/speed/);
  assert.throws(() => resolveModelSelection(catalog, "high"), /only effort\/speed/);
  assert.throws(() => resolveModelSelection(catalog, "fast"), /only effort\/speed/);
  assert.throws(() => resolveModelSelection(catalog, "--always-approve"), /CLI flag/);
  assert.throws(() => resolveModelSelection([], "composer 2.5"), /catalog is unavailable/);
  assert.throws(() => resolveModelSelection([], "composer-2.5"), /catalog is unavailable/);
  assert.throws(() => resolveModelSelection([], "opus"), /catalog is unavailable/);
});

test("composes Cursor launch ids from stored base + effort + speed", () => {
  const catalog = parseListModelsOutput(catalogText);
  assert.equal(composeCursorLaunchId("composer-2.5", "high", "fast", catalog), "composer-2.5-high-fast");
  assert.equal(composeCursorLaunchId("composer-2.5", undefined, "fast", catalog), "composer-2.5-fast");
  assert.equal(composeCursorLaunchId("composer-2.5", "high", "standard"), "composer-2.5-high");
  assert.equal(composeCursorLaunchId("composer-2.5-high-fast", "high", "fast"), "composer-2.5-high-fast");
  assert.equal(composeCursorLaunchId("composer-2.5-high-fast"), "composer-2.5-high-fast");
  const suffixOnly = parseListModelsOutput("composer-2.5-high-fast - Composer 2.5 High Fast\n");
  assert.equal(composeCursorLaunchId("composer-2.5", undefined, undefined, suffixOnly), "composer-2.5-high-fast");
});

test("composes Antigravity Gemini slugs from base + effort", () => {
  const catalog = parseListModelsOutput(`
gemini-3.8-flash-high - Gemini 3.8 Flash (High)
gemini-3.8-flash-medium - Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low - Gemini 3.8 Flash (Low)
gemini-pro-agent - Gemini 3.1 Pro (High)
`);
  assert.equal(composeAntigravityLaunchId("gemini-3.8-flash", "high", catalog), "gemini-3.8-flash-high");
  assert.equal(composeAntigravityLaunchId("gemini-3.8-flash-high", "high", catalog), "gemini-3.8-flash-high");
  const resolved = resolveModelSelection(catalog, "flash", "high", undefined, "antigravity");
  assert.equal(resolved?.model, "gemini-3.8-flash");
  assert.equal(resolved?.effort, "high");
  assert.equal(resolved?.launchId, "gemini-3.8-flash-high");
  assert.throws(() => resolveModelSelection([], "flash", "high", undefined, "antigravity"), /catalog is unavailable/);
});

test("parses Antigravity session/new model catalog", () => {
  const session = {
    models: {
      currentModelId: "gemini-3.7-flash-high",
      availableModels: [
        { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
        { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      ],
    },
  };
  const models = parseSessionModels(session);
  assert.equal(models[0]?.base, "gemini-3.8-flash");
  assert.equal(models[0]?.effort, "high");
  assert.equal(currentSessionModel(session), "gemini-3.7-flash-high");
});

test("storedModelParts strips launch suffixes and rejects raw keywords", () => {
  assert.deepEqual(storedModelParts("composer-2.5-high-fast"), {
    base: "composer-2.5",
    effort: "high",
    speed: "fast",
  });
  assert.deepEqual(storedModelParts("composer-2.5"), { base: "composer-2.5" });
  assert.deepEqual(storedModelParts(""), {});
  assert.throws(() => storedModelParts("composer 2.5 high fast"), /catalog id|raw keyword/);
});
