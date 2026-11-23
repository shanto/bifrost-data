import { assertEquals } from "jsr:@std/assert@1";
import {
  _internal,
  baseOf,
  buildOverlay,
  type Datasheet,
  mergedDatasheet,
  type PollModel,
} from "../src/merge.ts";

const bifrost: Datasheet = {
  "openai/gpt-x": {
    provider: "openai",
    base_model: "gpt-x",
    mode: "chat",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 3e-6,
    max_input_tokens: 128000,
  },
  "azure/gpt-x": { provider: "azure", base_model: "gpt-x", mode: "chat" },
  "openrouter/openai/gpt-x": { provider: "openrouter", base_model: "gpt-x", mode: "chat" },
  "anthropic/claude-opus-4-5": {
    provider: "anthropic",
    base_model: "claude-opus-4-5",
    mode: "chat",
    max_input_tokens: 200000,
  },
};

const poll: PollModel[] = [
  {
    name: "openai/gpt-x",
    category: "text",
    title: "GPT X",
    context_length: 200000,
    max_completion_tokens: 8192,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_endpoints: ["/v1/chat/completions", "/v1/responses"],
    capabilities: ["tool_calling", "reasoning"],
    tools: true,
    reasoning: true,
    pricing: {
      currency: "pollen",
      promptTextTokens: "0.000002",
      completionTextTokens: "0.000006",
      promptCachedTokens: "0.0000002",
    },
  },
  {
    name: "black-forest/flux-x",
    category: "image",
    context_length: 4096,
    input_modalities: ["text"],
    output_modalities: ["image"],
    supported_endpoints: ["/v1/images/generations"],
    pricing: { currency: "pollen", completionImageTokens: "0.004" },
  },
  {
    name: "openai/whisper-x",
    category: "audio",
    input_modalities: ["audio"],
    output_modalities: ["text"],
    supported_endpoints: ["/v1/audio/transcriptions"],
    pricing: { currency: "pollen", promptAudioTokens: "0.000006" },
  },
  // Alias-only match against anthropic/claude-opus-4-5.
  {
    name: "anthropic/claude-opus-4.6",
    aliases: ["claude-opus-4.5"],
    category: "text",
    context_length: 1000000,
    pricing: { currency: "pollen", promptTextTokens: "0.000005" },
  },
];

const entryOf = (data: Datasheet, key: string) => {
  const found = data[key];
  if (!found) throw new Error(`missing: ${key}`);
  return found;
};

Deno.test("entries are keyed provider/author/model and are stock-shaped", () => {
  const { models } = buildOverlay(bifrost, poll);
  const e = entryOf(models, "pollinations/openai/gpt-x");

  assertEquals(e.provider, "pollinations");
  assertEquals(e.base_model, "gpt-x");
  assertEquals(e.mode, "chat");
  assertEquals(e.source, "https://gen.pollinations.ai/models");
  assertEquals(e.input_cost_per_token, 0.000002);
  assertEquals(e.output_cost_per_token, 0.000006);
  assertEquals(e.cache_read_input_token_cost, 0.0000002);
  assertEquals(e.max_input_tokens, 200000);
  assertEquals(e.max_output_tokens, 8192);
  assertEquals(e.max_tokens, 8192);
  assertEquals(e.supported_endpoints, ["/v1/chat/completions", "/v1/responses"]);
  assertEquals(e.supported_modalities, ["text", "image"]);
  assertEquals(e.supported_output_modalities, ["text"]);
  assertEquals(e.supports_function_calling, true);
  assertEquals(e.supports_reasoning, true);
  assertEquals(e.supports_vision, true);
  // No nested provenance key — only stock fields.
  assertEquals("pollinations" in e, false);
  assertEquals(e.provider_specific_entry?.title, "GPT X");
});

Deno.test("a pollinations entry extends the same base as openrouter's", () => {
  const merged = mergedDatasheet(bifrost, buildOverlay(bifrost, poll));
  const siblings = Object.keys(baseOf(merged, "pollinations/openai/gpt-x"));
  assertEquals(siblings.sort(), ["azure/gpt-x", "openai/gpt-x", "openrouter/openai/gpt-x"]);
  assertEquals(
    merged["openrouter/openai/gpt-x"].base_model,
    merged["pollinations/openai/gpt-x"].base_model,
  );
});

Deno.test("image models price per image token, not per image", () => {
  const { models } = buildOverlay(bifrost, poll);
  const e = entryOf(models, "pollinations/black-forest/flux-x");
  assertEquals(e.mode, "image_generation");
  assertEquals(e.output_cost_per_image, undefined);
  assertEquals(e.output_cost_per_image_token, 0.004);
  assertEquals(e.input_cost_per_token, undefined);
  assertEquals(e.provider_specific_entry?.pollen_pricing, undefined);
});

Deno.test("audio endpoints decide between speech and transcription", () => {
  const { models } = buildOverlay(bifrost, poll);
  const e = entryOf(models, "pollinations/openai/whisper-x");
  assertEquals(e.mode, "audio_transcription");
  assertEquals(e.input_cost_per_audio_token, 0.000006);
  assertEquals(e.supports_audio_input, true);
});

Deno.test("alias joins land on the core and are flagged", () => {
  const { models, stats } = buildOverlay(bifrost, poll);
  const e = entryOf(models, "pollinations/anthropic/claude-opus-4.6");
  assertEquals(e.base_model, "claude-opus-4-5");
  assertEquals(e.provider_specific_entry?.joined_by_alias, true);
  assertEquals(stats.joined_by.alias, 1);

  const strict = buildOverlay(bifrost, poll, { strict: true });
  assertEquals(
    entryOf(strict.models, "pollinations/anthropic/claude-opus-4.6").base_model,
    "claude-opus-4.6",
  );
  assertEquals(strict.stats.joined_by.alias, 0);
});

Deno.test("no prices mode drops every cost field", () => {
  const { models } = buildOverlay(bifrost, poll, { pollenPerUsd: 0 });
  const e = entryOf(models, "pollinations/openai/gpt-x");
  assertEquals(e.input_cost_per_token, undefined);
  assertEquals(e.output_cost_per_token, undefined);
  assertEquals(e.cache_read_input_token_cost, undefined);
  assertEquals(e.max_input_tokens, 200000);
});

Deno.test("a pollen rate other than 1:1 scales the cost fields", () => {
  const { models } = buildOverlay(bifrost, poll, { pollenPerUsd: 1000 });
  assertEquals(entryOf(models, "pollinations/openai/gpt-x").input_cost_per_token, 0.000002 / 1000);
});

Deno.test("merged datasheet keeps stock entries untouched", () => {
  const merged = mergedDatasheet(bifrost, buildOverlay(bifrost, poll));
  assertEquals(merged["openai/gpt-x"], bifrost["openai/gpt-x"]);
  assertEquals(Object.keys(merged).length, Object.keys(bifrost).length + 4);
});

Deno.test("stats account for matched and unmatched cores", () => {
  const { stats } = buildOverlay(bifrost, poll);
  assertEquals(stats.emitted, 4);
  assertEquals(stats.matched_cores, 2); // gpt-x, claude-opus-4-5 (alias)
  assertEquals(stats.unmatched_cores, 2); // flux-x, whisper-x
  assertEquals(stats.with_prices, 4); // every fixture carries a cost field
  assertEquals(_internal.modeFor({ name: "a/b", category: "video" }), "video_generation");
});
