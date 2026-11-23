/**
 * Every provider is reduced to this shape before any merging happens, so the
 * datasheet builder never learns a vendor's field names.
 */

/** A model as the provider publishes it, already in Bifrost vocabulary. */
export interface NormalizedModel {
  /** Provider-native model id, e.g. "openai/gpt-6.2-astra" or "deepseek-ai/DeepSeek-V4-Pro". */
  name: string;
  /** Provider-native aliases, used only to find the core (never emitted). */
  aliases?: string[];
  /** Provider-declared parent model id (community models, fine-tunes, …). */
  parent?: string;
  /** Provider category ("text", "image", …), mapped to a Bifrost mode. */
  category?: string;
  /** Explicit Bifrost mode when the provider states it directly. */
  mode?: string;
  endpoints?: string[];
  modalities?: string[];
  outputModalities?: string[];
  contextLength?: number;
  maxOutputTokens?: number;
  /** USD per unit, keyed by the Bifrost cost field it belongs in. */
  costs?: Record<string, number>;
  functionCalling?: boolean;
  reasoning?: boolean;
  webSearch?: boolean;
  /** Provider-only data for `provider_specific_entry`. */
  specific?: Record<string, unknown>;
}

export interface Provider {
  /** Datasheet key prefix: `<id>/<model name>`. */
  id: string;
  /** The canonical URL this provider's data comes from, emitted as `source`. */
  sourceUrl: string;
  /** What the cost fields mean, recorded in the overlay document. */
  units?: string;
  /** Needs credentials: skip with a warning instead of failing the whole build. */
  optional?: boolean;
  /** Endpoints to fetch on every build. */
  urls(): string[];
  /** Headers for those requests (auth lives here, never in the datasheet). */
  headers(env: (name: string) => string | undefined): Record<string, string>;
  /** Turn each raw payload into normalized models. */
  parse(payload: unknown): NormalizedModel[];
}
