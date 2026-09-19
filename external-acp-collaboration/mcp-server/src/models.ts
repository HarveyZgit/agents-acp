import { readFileSync } from "node:fs";
import path from "node:path";

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type SpeedLevel = "fast" | "standard";
export type CatalogProvider = "cursor" | "grok";

export type CatalogModel = {
  id: string;
  label: string;
  base: string;
  effort?: EffortLevel;
  speed: SpeedLevel;
};

export type ModelCatalog = {
  provider: CatalogProvider;
  available: boolean;
  models: CatalogModel[];
  error?: string;
};

export type ModelSelection = {
  model: string;
  effort?: EffortLevel;
  speed?: SpeedLevel;
  launchId: string;
};

const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_ALIASES: Record<string, EffortLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "x-high": "xhigh",
  extra: "xhigh",
  "extra-high": "xhigh",
  max: "max",
};
const EFFORT_SUFFIXES = ["extra-high", "xhigh", "high", "medium", "low", "max"] as const;
const QUALIFIER_TOKENS = new Set([
  "fast", "standard", "normal", "default",
  "effort", "speed",
  ...Object.keys(EFFORT_ALIASES),
]);

export function parseListModelsOutput(text: string): CatalogModel[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(available models|tip:|use --model)/i.test(line)) continue;
    const dashed = /^([A-Za-z0-9._:/\-]+)\s+-\s+(.+)$/.exec(line);
    const bare = !dashed && /^([A-Za-z0-9._:/\-]{2,128})$/.test(line) ? line : undefined;
    const id = dashed?.[1] ?? bare;
    if (!id || id.startsWith("-") || seen.has(id)) continue;
    seen.add(id);
    models.push(parseCatalogId(id, dashed?.[2]?.trim() || id));
  }
  return models;
}

export function parseCatalogId(id: string, label = id): CatalogModel {
  let rest = id;
  let speed: SpeedLevel = "standard";
  if (rest.endsWith("-fast")) {
    speed = "fast";
    rest = rest.slice(0, -5);
  }
  let effort: EffortLevel | undefined;
  for (const suffix of EFFORT_SUFFIXES) {
    if (rest === suffix || !rest.endsWith(`-${suffix}`)) continue;
    effort = EFFORT_ALIASES[suffix];
    rest = rest.slice(0, -(suffix.length + 1));
    break;
  }
  return { id, label, base: rest || id, effort, speed };
}

export function extractQualifiers(value: string): {
  query: string;
  effort?: EffortLevel;
  speed?: SpeedLevel;
} {
  const tokens = tokenize(value);
  let effort: EffortLevel | undefined;
  let speed: SpeedLevel | undefined;
  const kept: string[] = [];
  for (const token of tokens) {
    if (token === "fast") {
      speed = "fast";
      continue;
    }
    if (token === "standard" || token === "normal") {
      speed = "standard";
      continue;
    }
    const mapped = EFFORT_ALIASES[token];
    if (mapped && token !== "extra") {
      effort = mapped;
      continue;
    }
    if (token === "effort" || token === "speed" || token === "default") continue;
    kept.push(token);
  }
  const result: { query: string; effort?: EffortLevel; speed?: SpeedLevel } = {
    query: kept.join(" "),
  };
  if (effort) result.effort = effort;
  if (speed) result.speed = speed;
  return result;
}

export function safeEffort(value: unknown): EffortLevel | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("defaultEffort must be a string.");
  const effort = EFFORT_ALIASES[value.trim().toLowerCase()];
  if (!effort) throw new Error(`defaultEffort must be one of: ${EFFORTS.join(", ")}.`);
  return effort;
}

export function safeSpeed(value: unknown): SpeedLevel | undefined | null {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("defaultSpeed must be a string.");
  const speed = value.trim().toLowerCase();
  if (speed === "fast" || speed === "standard") return speed;
  throw new Error('defaultSpeed must be "fast" or "standard".');
}

export function resolveModelSelection(
  catalog: CatalogModel[],
  query: string | undefined,
  effort?: EffortLevel,
  speed?: SpeedLevel,
  provider: CatalogProvider = "cursor",
): ModelSelection | undefined {
  const raw = query?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("-")) {
    throw new Error(`${provider} model must be a documented model identifier and cannot be interpreted as a CLI flag.`);
  }
  const extracted = extractQualifiers(raw);
  const resolvedEffort = effort ?? extracted.effort;
  const resolvedSpeed = speed ?? extracted.speed;
  const needle = extracted.query;
  if (!needle) {
    throw new Error("Model keyword is only effort/speed. Name a model from the agent catalog, or keep the stored model and pass defaultEffort / defaultSpeed.");
  }
  if (looksLikeModelId(raw)) {
    const parsed = parseCatalogId(raw);
    const hit = catalog.find((model) => model.id === raw || model.base === raw);
    if (hit) {
      return {
        model: hit.base,
        effort: resolvedEffort ?? parsed.effort,
        speed: resolvedSpeed ?? parsed.speed,
        launchId: provider === "cursor"
          ? composeCursorLaunchId(hit.base, resolvedEffort ?? parsed.effort, resolvedSpeed ?? parsed.speed, catalog)
          : hit.base,
      };
    }
  }

  if (catalog.length === 0) {
    throw new Error(`Cannot resolve model keyword "${needle}" because the ${provider} model catalog is unavailable. Ask the user to pick after the CLI can list models.`);
  }

  const matches = rankCatalog(catalog, needle);
  if (matches.length === 0) {
    throw new Error(`No ${provider} catalog model matches "${needle}". Use an id or label from the listed models.`);
  }
  const preferred = pickPreferred(matches, resolvedEffort, resolvedSpeed) ?? matches[0];
  const ambiguous = matches.filter((model) => model.base === preferred.base || scoreMatch(model, needle) === scoreMatch(preferred, needle));
  const distinctBases = new Set(ambiguous.map((model) => model.base));
  if (distinctBases.size > 1 && !matches.some((model) => model.id === needle || model.base === needle)) {
    const options = [...distinctBases].slice(0, 8).join(", ");
    throw new Error(`Ambiguous model keyword "${needle}". Matches: ${options}. Ask the user to pick a catalog id.`);
  }
  return {
    model: preferred.base,
    effort: resolvedEffort,
    speed: resolvedSpeed,
    launchId: provider === "cursor"
      ? composeCursorLaunchId(preferred.base, resolvedEffort, resolvedSpeed, catalog)
      : preferred.base,
  };
}

export function composeCursorLaunchId(
  base: string,
  effort?: EffortLevel,
  speed?: SpeedLevel,
  catalog: CatalogModel[] = [],
): string {
  const ids = candidateCursorIds(base, effort, speed);
  if (catalog.length > 0) {
    const available = new Set(catalog.map((model) => model.id));
    const hit = ids.find((id) => available.has(id));
    if (hit) return hit;
    const sameBase = catalog.filter((model) => model.base === base);
    const byParams = sameBase.find((model) => (
      (effort === undefined || model.effort === effort)
      && (speed === undefined || model.speed === speed)
    ));
    if (byParams) return byParams.id;
    if (sameBase[0]) return sameBase[0].id;
  }
  return ids[0] ?? base;
}

export function looksLikeModelId(value: string): boolean {
  const model = value.trim();
  return Boolean(model) && !model.startsWith("-") && !/\s/.test(model) && /^[A-Za-z0-9._:/\-]{1,128}$/.test(model);
}

function candidateCursorIds(base: string, effort?: EffortLevel, speed?: SpeedLevel): string[] {
  const ids: string[] = [];
  if (effort && speed === "fast") ids.push(`${base}-${effort}-fast`);
  if (effort && speed !== "fast") ids.push(`${base}-${effort}`);
  if (speed === "fast") ids.push(`${base}-fast`);
  if (effort) ids.push(`${base}-${effort}`);
  ids.push(base);
  return [...new Set(ids)];
}

function rankCatalog(catalog: CatalogModel[], query: string): CatalogModel[] {
  return catalog
    .map((model) => ({ model, score: scoreMatch(model, query) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.model.id.localeCompare(right.model.id))
    .map((entry) => entry.model);
}

function pickPreferred(matches: CatalogModel[], effort?: EffortLevel, speed?: SpeedLevel): CatalogModel | undefined {
  const exact = matches.find((model) => (
    (effort === undefined || model.effort === effort)
    && (speed === undefined || model.speed === speed)
  ));
  return exact ?? matches.find((model) => effort === undefined || model.effort === effort)
    ?? matches.find((model) => speed === undefined || model.speed === speed);
}

function scoreMatch(model: CatalogModel, query: string): number {
  const needle = normalize(query);
  const id = normalize(model.id);
  const base = normalize(model.base);
  const label = normalize(model.label);
  if (!needle) return 0;
  if (id === needle || model.id === query.trim()) return 100;
  if (base === needle) return 90;
  if (label === needle) return 85;
  const tokens = needle.split(" ").filter((token) => !QUALIFIER_TOKENS.has(token));
  if (tokens.length === 0) return 0;
  if (tokens.every((token) => id.includes(token))) return 70 + tokens.length;
  if (tokens.every((token) => base.includes(token))) return 60 + tokens.length;
  if (tokens.every((token) => label.includes(token))) return 50 + tokens.length;
  return 0;
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * Test/dev overlay so MCP flows can resolve keywords without cursor-agent
 * or grok login. EXTERNAL_ACP_CATALOG_FIXTURE is an absolute JSON path:
 * { "cursor": [{ "id": "composer-2.5", "label": "Composer 2.5" }] }
 */
export function overlayCatalogFixture(
  catalogs: ModelCatalog[],
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalog[] {
  const fixturePath = env.EXTERNAL_ACP_CATALOG_FIXTURE?.trim();
  if (!fixturePath) return catalogs;
  const resolved = path.resolve(fixturePath);
  if (!path.isAbsolute(fixturePath) || fixturePath.includes("\0")) {
    throw new Error("EXTERNAL_ACP_CATALOG_FIXTURE must be an absolute filesystem path.");
  }
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  return catalogs.map((catalog) => {
    const rows = parsed[catalog.provider];
    if (!Array.isArray(rows)) return catalog;
    const models = rows.flatMap((row) => {
      if (!row || typeof row !== "object") return [];
      const entry = row as { id?: unknown; label?: unknown };
      if (typeof entry.id !== "string" || !looksLikeModelId(entry.id)) return [];
      return [parseCatalogId(entry.id, typeof entry.label === "string" ? entry.label : entry.id)];
    });
    return {
      ...catalog,
      available: models.length > 0,
      models,
      error: models.length > 0 ? undefined : catalog.error,
    };
  });
}
