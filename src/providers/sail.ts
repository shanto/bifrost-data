/**
 * Sail: https://api.sailresearch.com/v1/models
 *
 * OpenAI-shaped listing with USD prices per million tokens, quoted per service
 * tier. Bifrost already ships `sail/*` entries sourced from Sail's docs, and it
 * names the tiers like this — so we match it exactly rather than inventing a
 * convention:
 *
 *   asap     → input_cost_per_token                (the plain field)
 *   balanced → input_cost_per_token_balanced
 *   flex     → input_cost_per_token_flex
 *
 * Nothing is divided by a guessed exchange rate here — these are already USD.
 * The listing carries no context length, so `max_input_tokens` is left to the
 * core definition the model extends.
 */

import { scaleRate } from "./common.ts";
import type { NormalizedModel, Provider } from "./types.ts";

export const SAIL_MODELS_URL = "https://api.sailresearch.com/v1/models";

interface SailPricingTier {
  input?: number;
  cached_input?: number;
  output?: number;
}

interface SailModel {
  id: string;
  owned_by?: string;
  created?: number;
  input_modalities?: string[];
  pricing_usd_per_million_tokens?: Record<string, SailPricingTier>;
}

/** Tier → cost-field suffix, matching the stock datasheet's `sail/*` entries. */
const TIERS: Record<string, string> = {
  asap: "",
  balanced: "_balanced",
  flex: "_flex",
};

const TOKENS_PER_MILLION = 1_000_000;

export function parseSail(payload: unknown): NormalizedModel[] {
  const list = (payload as { data?: SailModel[] } | null)?.data ?? [];
  if (!Array.isArray(list)) return [];

  return list.map((model) => {
    const costs: Record<string, number> = {};
    const tiers = Object.keys(model.pricing_usd_per_million_tokens ?? {});

    for (const [tier, suffix] of Object.entries(TIERS)) {
      const pricing = model.pricing_usd_per_million_tokens?.[tier];
      if (!pricing) continue;
      const input = scaleRate(pricing.input, TOKENS_PER_MILLION);
      const cached = scaleRate(pricing.cached_input, TOKENS_PER_MILLION);
      const output = scaleRate(pricing.output, TOKENS_PER_MILLION);
      if (input !== undefined) costs[`input_cost_per_token${suffix}`] = input;
      if (cached !== undefined) costs[`cache_read_input_token_cost${suffix}`] = cached;
      if (output !== undefined) costs[`output_cost_per_token${suffix}`] = output;
    }

    const modalities = model.input_modalities ?? ["text"];
    const specific: Record<string, unknown> = {};
    if (tiers.length > 1) specific.pricing_tiers = tiers;
    if (model.owned_by) specific.owned_by = model.owned_by;

    return {
      name: model.id,
      category: "text",
      mode: "chat",
      modalities,
      outputModalities: ["text"],
      costs,
      specific,
    };
  });
}

export function sailProvider(): Provider {
  return {
    id: "sail",
    sourceUrl: SAIL_MODELS_URL,
    // Authenticated listing: without SAIL_API_KEY the build skips it with a
    // warning rather than failing, so a fork still publishes the other sources.
    optional: true,
    urls: () => [SAIL_MODELS_URL],
    headers: (env): Record<string, string> => {
      // The listing is authenticated; without a key the API answers 401.
      const key = env("SAIL_API_KEY");
      const headers: Record<string, string> = {};
      if (key) headers.authorization = `Bearer ${key}`;
      return headers;
    },
    parse: (payload) => parseSail(payload),
  };
}
