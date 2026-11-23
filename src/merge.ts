/**
 * Pollinations model data, emitted as stock Bifrost datasheet entries.
 *
 * Shape rule — the output is the Bifrost datasheet format, nothing else. An
 * entry is keyed `<provider>/<author>/<model>` and carries `provider`,
 * `base_model`, `mode`, costs, limits and capability flags exactly like the
 * `openrouter/...` entries in the stock datasheet:
 *
 *   "openrouter/openai/gpt-6.2-astra"   extends  "openai/gpt-6.2-astra"
 *   "pollinations/openai/gpt-6.2-astra" extends  "openai/gpt-6.2-astra"   ← ours
 *
 * No per-model wrapper document, no nested provenance block. Anything
 * Pollinations publishes that Bifrost has no field for goes into
 * `provider_specific_entry`, which is the stock place for provider-only data.
 */

export interface BifrostEntry {
  provider?: string;
  base_model?: string;
  mode?: string;
  source?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  input_cost_per_audio_token?: number;
  output_cost_per_audio_token?: number;
  input_cost_per_image_token?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  supported_endpoints?: string[];
  supported_modalities?: string[];
  supported_output_modalities?: string[];
  supports_function_calling?: boolean;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_web_search?: boolean;
  provider_specific_entry?: Record<string, unknown>;
  [field: string]: unknown;
}

export type Datasheet = Record<string, BifrostEntry>;

export interface PollModel {
  name: string;
  aliases?: string[];
  category?: string;
  publisher?: string;
  base_model?: string;
  title?: string;
  description?: string;
  community?: boolean;
  paid_only?: boolean;
  context_length?: number;
  max_completion_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
  capabilities?: string[];
  tools?: boolean;
  reasoning?: boolean;
  per_user_rpm?: number;
  pricing?: Record<string, string>;
  pricing_variants?: unknown[];
  [field: string]: unknown;
}

export const PROVIDER = "pollinations";
export const SOURCE = "https://gen.pollinations.ai/models";

export interface MergeStats {
  pollinations_entries: number;
  emitted: number;
  matched_cores: number;
  unmatched_cores: number;
  with_prices: number;
  by_category: Record<string, number>;
  joined_by: { name: number; basename: number; alias: number };
}

export interface MergeOptions {
  /** Pollen units per 1 USD. Default 1 — pollen treated as USD. 0 disables cost fields. */
  pollenPerUsd?: number;
  /** Only join on model names; ignore aliases (aliases are upstream's claim, not ours). */
  strict?: boolean;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const basename = (n: string): string => n.split("/").pop() ?? n;

export interface CoreIndex {
  /** Bare model name (as it appears in `base_model`) → a stock entry using it. */
  bare: Map<string, BifrostEntry>;
  /** Normalised core name → the core names that normalise to it. */
  tokens: Map<string, string[]>;
  /** Core names exactly as they appear in the datasheet. */
  names: Set<string>;
}

export function indexCores(bifrost: Datasheet): CoreIndex {
  const bare = new Map<string, BifrostEntry>();
  const tokens = new Map<string, string[]>();
  const names = new Set<string>();
  for (const entry of Object.values(bifrost)) {
    const core = entry.base_model;
    if (!core) continue;
    names.add(core);
    if (!bare.has(core)) bare.set(core, entry);
    const key = norm(core);
    const list = tokens.get(key);
    if (!list) tokens.set(key, [core]);
    else if (!list.includes(core)) list.push(core);
  }
  return { bare, tokens, names };
}

/**
 * The core a Pollinations model extends: exact core name, then the bare model
 * name, then its own `base_model`, then a normalised alias — and an alias only
 * counts when exactly one core matches, so "claude" can never retarget every
 * Claude variant.
 */
export function coreFor(
  model: PollModel,
  cores: CoreIndex,
  opts: { strict?: boolean } = {},
): { core: string; via: "name" | "basename" | "alias" | null } {
  const own = basename(model.name);
  const parent = model.base_model ? basename(model.base_model) : "";

  if (cores.names.has(model.name)) return { core: model.name, via: "name" };
  if (cores.names.has(own)) return { core: own, via: "basename" };
  if (model.base_model && cores.names.has(model.base_model)) {
    return { core: model.base_model, via: "name" };
  }
  if (parent && cores.names.has(parent)) return { core: parent, via: "basename" };

  if (opts.strict) return { core: own, via: null };

  // Upstream's own aliases are the only sanctioned way to cross a naming
  // difference (4.6's alias list claims 4.5), so they are candidates too.
  const candidates = [own, parent, ...(model.aliases ?? [])];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const matches = cores.tokens.get(norm(candidate)) ?? [];
    if (matches.length === 1) return { core: matches[0], via: "alias" };
  }
  return { core: own, via: null };
}

/** Pollen rate → USD per unit (1:1 by default), or undefined when costs are off. */
function usd(pollen: string | undefined, perUsd: number): number | undefined {
  if (perUsd <= 0) return undefined;
  const value = Number(pollen);
  return Number.isFinite(value) && value > 0 ? value / perUsd : undefined;
}

const MODES: Record<string, string> = {
  text: "chat",
  image: "image_generation",
  video: "video_generation",
  embedding: "embedding",
  realtime: "realtime",
  decision: "decisions",
  "3d": "3d",
};

function modeFor(model: PollModel): string | undefined {
  if (model.category === "audio") {
    return (model.supported_endpoints ?? []).includes("/v1/audio/transcriptions")
      ? "audio_transcription"
      : "audio_speech";
  }
  return model.category ? MODES[model.category] : undefined;
}

/** Pollen rates that carry the same meaning as the Bifrost cost field. */
const COST_FIELDS: [string, string][] = [
  ["promptTextTokens", "input_cost_per_token"],
  ["completionTextTokens", "output_cost_per_token"],
  ["promptCachedTokens", "cache_read_input_token_cost"],
  ["promptCacheWriteTokens", "cache_creation_input_token_cost"],
  ["promptAudioTokens", "input_cost_per_audio_token"],
  ["completionAudioTokens", "output_cost_per_audio_token"],
  ["promptAudioSeconds", "input_cost_per_audio_per_second"],
  ["promptImageTokens", "input_cost_per_image_token"],
  ["completionImageTokens", "output_cost_per_image_token"],
  ["promptVideoTokens", "input_cost_per_video_token"],
  ["completionVideoTokens", "output_cost_per_video_token"],
  ["promptVideoSeconds", "input_cost_per_video_per_second"],
  ["completionVideoSeconds", "output_cost_per_video_per_second"],
  ["completionReasoningTokens", "output_cost_per_reasoning_token"],
];

/** Rates with no Bifrost equivalent stay raw in `provider_specific_entry`. */
const MAPPED_RATES = new Set(COST_FIELDS.map(([pollenKey]) => pollenKey).concat("currency"));

export function buildEntry(
  model: PollModel,
  core: string,
  via: "name" | "basename" | "alias" | null,
  opts: MergeOptions = {},
): BifrostEntry {
  const perUsd = opts.pollenPerUsd ?? 1;
  const pricing = model.pricing ?? {};

  const entry: BifrostEntry = {
    provider: PROVIDER,
    base_model: core,
    source: SOURCE,
  };
  const mode = modeFor(model);
  if (mode) entry.mode = mode;

  for (const [pollenKey, field] of COST_FIELDS) {
    const value = usd(pricing[pollenKey], perUsd);
    if (value !== undefined) entry[field] = value;
  }

  if (typeof model.context_length === "number") entry.max_input_tokens = model.context_length;
  if (typeof model.max_completion_tokens === "number") {
    entry.max_output_tokens = model.max_completion_tokens;
    entry.max_tokens = model.max_completion_tokens;
  }

  if (model.supported_endpoints?.length) entry.supported_endpoints = model.supported_endpoints;
  if (model.input_modalities?.length) entry.supported_modalities = model.input_modalities;
  if (model.output_modalities?.length) entry.supported_output_modalities = model.output_modalities;

  const capabilities = model.capabilities ?? [];
  if (model.tools === true || capabilities.includes("tool_calling")) {
    entry.supports_function_calling = true;
  }
  if (model.reasoning === true || capabilities.includes("reasoning")) {
    entry.supports_reasoning = true;
  }
  if (capabilities.includes("web_search")) entry.supports_web_search = true;

  const inputs = model.input_modalities ?? [];
  const outputs = model.output_modalities ?? [];
  if (inputs.includes("image")) entry.supports_vision = true;
  if (inputs.includes("audio")) entry.supports_audio_input = true;
  if (outputs.includes("audio")) entry.supports_audio_output = true;

  const specific: Record<string, unknown> = {};
  if (model.title) specific.title = model.title;
  if (model.community) specific.community = true;
  if (model.paid_only) specific.paid_only = true;
  if (via === "alias") specific.joined_by_alias = true;
  if (typeof model.per_user_rpm === "number") specific.per_user_rpm = model.per_user_rpm;

  const rawPricing = Object.fromEntries(
    Object.entries(pricing).filter(([key]) => !MAPPED_RATES.has(key) || key === "currency"),
  );
  if (Object.keys(rawPricing).length > 1) specific.pollen_pricing = rawPricing;
  if (model.pricing_variants?.length) specific.pricing_variants = model.pricing_variants;
  if (Object.keys(specific).length) entry.provider_specific_entry = specific;

  return entry;
}

export interface OverlayDoc {
  schema: "bifrost-data/pollinations@1";
  generated_at: string;
  provider: typeof PROVIDER;
  source: string;
  units: string;
  sources?: { url: string; status: number; bytes: number; entries: number; ms: number }[];
  stats: MergeStats;
  models: Datasheet;
}

/** The additive layer: only `pollinations/...` keys, in stock entry shape. */
export function buildOverlay(
  bifrost: Datasheet,
  poll: PollModel[],
  opts: MergeOptions = {},
): OverlayDoc {
  const cores = indexCores(bifrost);
  const models: Datasheet = {};
  const stats: MergeStats = {
    pollinations_entries: poll.length,
    emitted: 0,
    matched_cores: 0,
    unmatched_cores: 0,
    with_prices: 0,
    by_category: {},
    joined_by: { name: 0, basename: 0, alias: 0 },
  };

  for (const model of poll) {
    const key = `${PROVIDER}/${model.name}`;
    if (models[key]) continue;

    const { core, via } = coreFor(model, cores, opts);
    const entry = buildEntry(model, core, via, opts);
    models[key] = entry;

    stats.emitted++;
    if (cores.bare.has(core)) stats.matched_cores++;
    else stats.unmatched_cores++;
    if (via) stats.joined_by[via]++;
    if (Object.keys(entry).some((field) => field.includes("_cost_"))) stats.with_prices++;
    const category = model.category ?? "unknown";
    stats.by_category[category] = (stats.by_category[category] ?? 0) + 1;
  }

  const perUsd = opts.pollenPerUsd ?? 1;
  return {
    schema: "bifrost-data/pollinations@1",
    generated_at: new Date().toISOString(),
    provider: PROVIDER,
    source: SOURCE,
    units: perUsd === 1
      ? "pollen treated as USD (1:1)"
      : perUsd > 0
      ? `pollen / ${perUsd} per USD`
      : "cost fields disabled",
    stats,
    models,
  };
}

/** Stock datasheet + the overlay entries. Drop-in for getbifrost.ai/datasheet. */
export function mergedDatasheet(bifrost: Datasheet, overlay: OverlayDoc): Datasheet {
  return { ...bifrost, ...overlay.models };
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

export const _internal = { norm, basename, usd, modeFor };
