/**
 * Pollinations: https://gen.pollinations.ai/models
 *
 * Prices arrive in pollen units; pollen is treated as USD 1:1 unless a rate is
 * supplied. Rates map onto the Bifrost field with the same meaning, and anything
 * without an equivalent stays raw under `provider_specific_entry.pollen_pricing`.
 */

import { modeFromCategory, scaleRate } from "./common.ts";
import type { NormalizedModel, Provider } from "./types.ts";

export const POLLINATIONS_MODELS_URL = "https://gen.pollinations.ai/models";
export const POLLINATIONS_IMAGE_MODELS_URL = "https://gen.pollinations.ai/image/models";

interface PollModel {
  name: string;
  aliases?: string[];
  category?: string;
  base_model?: string;
  title?: string;
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
}

/** Pollen rate → Bifrost cost field. Same meaning, same units. */
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

const MAPPED_RATES = new Set([...COST_FIELDS.map(([pollenKey]) => pollenKey), "currency"]);

export function parsePollinations(payload: unknown, pollenPerUsd = 1): NormalizedModel[] {
  const list = Array.isArray(payload) ? (payload as PollModel[]) : [];
  const divisor = pollenPerUsd > 0 ? pollenPerUsd : 0;

  return list.map((model) => {
    const pricing = model.pricing ?? {};
    const costs: Record<string, number> = {};
    if (divisor > 0) {
      for (const [pollenKey, field] of COST_FIELDS) {
        const value = scaleRate(pricing[pollenKey], divisor);
        if (value !== undefined) costs[field] = value;
      }
    }

    const capabilities = model.capabilities ?? [];
    const inputs = model.input_modalities ?? [];
    const outputs = model.output_modalities ?? [];

    const specific: Record<string, unknown> = {};
    if (model.title) specific.title = model.title;
    if (model.community) specific.community = true;
    if (model.paid_only) specific.paid_only = true;
    if (typeof model.per_user_rpm === "number") specific.per_user_rpm = model.per_user_rpm;
    const rawPricing = Object.fromEntries(
      Object.entries(pricing).filter(([key]) => !MAPPED_RATES.has(key) || key === "currency"),
    );
    if (Object.keys(rawPricing).length > 1) specific.pollen_pricing = rawPricing;
    if (model.pricing_variants?.length) specific.pricing_variants = model.pricing_variants;

    const normalized: NormalizedModel = {
      name: model.name,
      aliases: model.aliases,
      parent: model.base_model,
      category: model.category,
      mode: modeFromCategory(model.category, model.supported_endpoints),
      endpoints: model.supported_endpoints,
      modalities: inputs,
      outputModalities: outputs,
      contextLength: model.context_length,
      maxOutputTokens: model.max_completion_tokens,
      costs,
      functionCalling: model.tools === true || capabilities.includes("tool_calling"),
      reasoning: model.reasoning === true || capabilities.includes("reasoning"),
      webSearch: capabilities.includes("web_search"),
      specific,
    };
    return normalized;
  });
}

export function pollinationsProvider(opts: { pollenPerUsd?: number; key?: string } = {}): Provider {
  const perUsd = opts.pollenPerUsd ?? 1;
  return {
    id: "pollinations",
    sourceUrl: POLLINATIONS_MODELS_URL,
    units: perUsd === 1
      ? "pollen treated as USD (1:1)"
      : perUsd > 0
      ? `pollen / ${perUsd} per USD`
      : "cost fields disabled",
    urls: () => [POLLINATIONS_MODELS_URL, POLLINATIONS_IMAGE_MODELS_URL],
    headers: () => ({}),
    parse: (payload) => parsePollinations(payload, perUsd),
  };
}
