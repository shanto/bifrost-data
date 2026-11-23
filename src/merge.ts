/**
 * Provider-agnostic merge: turn normalized provider models into stock Bifrost
 * datasheet entries.
 *
 * Shape rule — the output is the Bifrost datasheet format, nothing else. An
 * entry is keyed `<provider>/<author>/<model>` and carries `provider`,
 * `base_model`, `mode`, costs, limits and capability flags exactly like the
 * `openrouter/...` entries in the stock datasheet:
 *
 *   "openrouter/openai/gpt-6.2-astra"     extends  "openai/gpt-6.2-astra"
 *   "pollinations/openai/gpt-6.2-astra"   extends  "openai/gpt-6.2-astra"
 *   "sail/deepseek-ai/DeepSeek-V4-Pro"    extends  "DeepSeek-V4-Pro"
 *
 * No vendor-specific knowledge lives here — that belongs to the provider
 * adapter in src/providers/.
 */

import type { NormalizedModel, Provider } from "./providers/types.ts";

export interface BifrostEntry {
  provider?: string;
  base_model?: string;
  mode?: string;
  source?: string;
  [field: string]: unknown;
}

export type Datasheet = Record<string, BifrostEntry>;

export interface CoreIndex {
  /** Bare model name (as it appears in `base_model`) → a stock entry using it. */
  bare: Map<string, BifrostEntry>;
  /** Normalised core name → the core names that normalise to it. */
  tokens: Map<string, string[]>;
  /** Core names exactly as they appear in the datasheet. */
  names: Set<string>;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
export const basename = (n: string): string => n.split("/").pop() ?? n;

/** Structural equality, good enough for the JSON scalars and arrays we emit. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    if (ak.length !== Object.keys(bo).length) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

export function indexCores(bifrost: Datasheet): CoreIndex {
  const bare = new Map<string, BifrostEntry>();
  const tokens = new Map<string, string[]>();
  const names = new Set<string>();
  for (const entry of Object.values(bifrost)) {
    const core = entry.base_model;
    if (typeof core !== "string" || !core) continue;
    names.add(core);
    if (!bare.has(core)) bare.set(core, entry);
    const key = norm(core);
    const list = tokens.get(key);
    if (!list) tokens.set(key, [core]);
    else if (!list.includes(core)) list.push(core);
  }
  return { bare, tokens, names };
}

export type JoinVia = "stock" | "name" | "basename" | "alias";

/**
 * The core a provider model extends: exact core name, then the bare model name,
 * then the provider's own declared parent, then a normalised alias — and an
 * alias only counts when exactly one core matches, so "claude" can never
 * retarget every Claude variant.
 */
export function coreFor(
  model: NormalizedModel,
  cores: CoreIndex,
  opts: { strict?: boolean } = {},
): { core: string; via: JoinVia | null } {
  const own = basename(model.name);
  const parent = model.parent ? basename(model.parent) : "";

  if (cores.names.has(model.name)) return { core: model.name, via: "name" };
  if (cores.names.has(own)) return { core: own, via: "basename" };
  if (model.parent && cores.names.has(model.parent)) {
    return { core: model.parent, via: "name" };
  }
  if (parent && cores.names.has(parent)) return { core: parent, via: "basename" };

  if (opts.strict) return { core: own, via: null };

  // A provider's own aliases are the only sanctioned way to cross a naming
  // difference (4.6's alias list claims 4.5), so they are candidates too.
  for (const candidate of [own, parent, ...(model.aliases ?? [])]) {
    if (!candidate) continue;
    const matches = cores.tokens.get(norm(candidate)) ?? [];
    if (matches.length === 1) return { core: matches[0], via: "alias" };
  }
  return { core: own, via: null };
}

export interface BuildOptions {
  /** Only join on model names; ignore aliases. */
  strict?: boolean;
}

export interface MergeStats {
  models: number;
  emitted: number;
  matched_cores: number;
  unmatched_cores: number;
  with_prices: number;
  /** Provider entries Bifrost already publishes and we now extend in place. */
  extends_stock: number;
  /** Extends_stock entries where nothing differed, so nothing was written. */
  unchanged: number;
  by_mode: Record<string, number>;
  joined_by: { stock: number; name: number; basename: number; alias: number };
}

export interface OverlayDoc {
  schema: string;
  generated_at: string;
  provider: string;
  source: string;
  units?: string;
  note?: string;
  sources?: { url: string; status: number; bytes: number; entries: number; ms: number }[];
  stats: MergeStats;
  models: Datasheet;
}

export function buildEntry(
  model: NormalizedModel,
  core: string,
  via: JoinVia | null,
  provider: Provider,
  stock?: BifrostEntry,
): BifrostEntry {
  // Extending an entry Bifrost already publishes for this same provider: keep
  // everything it says (limits, capability flags, its own base_model) and let
  // the provider override only prices and sizes — the diff stays a diff.
  if (stock) {
    const next: BifrostEntry = { ...stock, provider: provider.id };
    for (const [field, value] of Object.entries(model.costs ?? {})) next[field] = value;
    if (typeof model.contextLength === "number") next.max_input_tokens = model.contextLength;
    if (typeof model.maxOutputTokens === "number") {
      next.max_output_tokens = model.maxOutputTokens;
      next.max_tokens = model.maxOutputTokens;
    }
    if (!next.mode && model.mode) next.mode = model.mode;

    const changed: BifrostEntry = { provider: provider.id, base_model: next.base_model ?? core };
    for (const [field, value] of Object.entries(next)) {
      if (field === "provider" || field === "base_model") continue;
      if (!deepEqual(stock[field], value)) changed[field] = value;
    }
    return changed;
  }

  const entry: BifrostEntry = {
    provider: provider.id,
    base_model: core,
    source: provider.sourceUrl,
  };
  if (model.mode) entry.mode = model.mode;

  for (const [field, value] of Object.entries(model.costs ?? {})) entry[field] = value;

  if (typeof model.contextLength === "number") entry.max_input_tokens = model.contextLength;
  if (typeof model.maxOutputTokens === "number") {
    entry.max_output_tokens = model.maxOutputTokens;
    entry.max_tokens = model.maxOutputTokens;
  }

  if (model.endpoints?.length) entry.supported_endpoints = model.endpoints;
  if (model.modalities?.length) entry.supported_modalities = model.modalities;
  if (model.outputModalities?.length) entry.supported_output_modalities = model.outputModalities;

  if (model.functionCalling) entry.supports_function_calling = true;
  if (model.reasoning) entry.supports_reasoning = true;
  if (model.webSearch) entry.supports_web_search = true;
  if (model.modalities?.includes("image")) entry.supports_vision = true;
  if (model.modalities?.includes("audio")) entry.supports_audio_input = true;
  if (model.outputModalities?.includes("audio")) entry.supports_audio_output = true;

  const specific: Record<string, unknown> = { ...(model.specific ?? {}) };
  if (via === "alias") specific.joined_by_alias = true;
  if (Object.keys(specific).length) entry.provider_specific_entry = specific;

  return entry;
}

/** The additive layer for one provider: only `<provider>/...` keys, stock entry shape. */
export function buildOverlay(
  bifrost: Datasheet,
  provider: Provider,
  models: NormalizedModel[],
  opts: BuildOptions = {},
): OverlayDoc {
  const cores = indexCores(bifrost);
  const entries: Datasheet = {};
  const stats: MergeStats = {
    models: models.length,
    emitted: 0,
    matched_cores: 0,
    unmatched_cores: 0,
    with_prices: 0,
    extends_stock: 0,
    unchanged: 0,
    by_mode: {},
    joined_by: { stock: 0, name: 0, basename: 0, alias: 0 },
  };

  for (const model of models) {
    const key = `${provider.id}/${model.name}`;
    if (entries[key]) continue;

    // Bifrost may already publish this exact provider/model key. Then the stock
    // entry is the authority on everything but prices and sizes: no second
    // guess at base_model, no dropped capability flags.
    const stock = bifrost[key];
    const resolved = stock?.base_model
      ? { core: String(stock.base_model), via: "stock" as JoinVia }
      : coreFor(model, cores, opts);
    const { core, via } = resolved;
    const entry = buildEntry(model, core, via, provider, stock);
    if (stock) stats.extends_stock++;
    if (cores.bare.has(core)) stats.matched_cores++;
    else stats.unmatched_cores++;
    if (via) stats.joined_by[via]++;
    const mode = model.mode ?? "unknown";
    stats.by_mode[mode] = (stats.by_mode[mode] ?? 0) + 1;
    if (Object.keys(entry).some((field) => field.includes("_cost_"))) stats.with_prices++;

    // An entry that only restates identity adds nothing: the stock record is
    // already in the merged sheet.
    const diffFields = Object.keys(entry).filter((f) => f !== "provider" && f !== "base_model");
    if (stock && diffFields.length === 0) {
      stats.unchanged++;
      continue;
    }
    entries[key] = entry;
    stats.emitted++;
  }

  return {
    schema: `bifrost-data/${provider.id}@1`,
    generated_at: new Date().toISOString(),
    provider: provider.id,
    source: provider.sourceUrl,
    ...(stats.unchanged > 0
      ? {
        note: `${stats.unchanged} ${provider.id} model(s) already match the stock datasheet ` +
          `exactly and are not repeated here — read them from the datasheet itself.`,
      }
      : {}),
    stats,
    models: entries,
  };
}

/** Stock datasheet + every overlay. Drop-in for getbifrost.ai/datasheet. */
export function mergedDatasheet(bifrost: Datasheet, overlays: OverlayDoc[]): Datasheet {
  const merged: Datasheet = { ...bifrost };
  for (const overlay of overlays) {
    for (const [key, entry] of Object.entries(overlay.models)) {
      // Overlay entries for an existing key are a diff — apply them on top.
      merged[key] = merged[key] ? { ...merged[key], ...entry } : entry;
    }
  }
  return merged;
}

/** Entries a given key inherits from, by shared base_model. */
export function baseOf(datasheet: Datasheet, key: string): Datasheet {
  const entry = datasheet[key];
  if (!entry?.base_model) return {};
  const out: Datasheet = {};
  for (const [k, v] of Object.entries(datasheet)) {
    if (k !== key && v.base_model === entry.base_model) out[k] = v;
  }
  return out;
}

/** Every top-level field the stock datasheet already uses — the alignment guard. */
export function stockFields(datasheet: Datasheet): Set<string> {
  const fields = new Set<string>();
  for (const entry of Object.values(datasheet)) {
    for (const field of Object.keys(entry)) fields.add(field);
  }
  return fields;
}
