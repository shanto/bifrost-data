import { assertEquals } from "jsr:@std/assert@1";
import { baseOf, buildOverlay, type Datasheet, mergedDatasheet, stockFields } from "../src/merge.ts";
import type { NormalizedModel, Provider } from "../src/providers/types.ts";
import { parseSail, sailProvider } from "../src/providers/sail.ts";
import { parsePollinations, pollinationsProvider } from "../src/providers/pollinations.ts";

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
  "deepseek-ai/DeepSeek-V4-Pro": {
    provider: "deepseek",
    base_model: "DeepSeek-V4-Pro",
    mode: "chat",
    max_input_tokens: 128000,
  },
};

const fakeProvider: Provider = {
  id: "test",
  sourceUrl: "https://example.test/models",
  urls: () => ["https://example.test/models"],
  headers: () => ({}),
  parse: () => [],
};

const model = (over: Partial<NormalizedModel>): NormalizedModel => ({
  name: "openai/gpt-x",
  mode: "chat",
  ...over,
});

const entryOf = (data: Datasheet, key: string) => {
  const found = data[key];
  if (!found) throw new Error(`missing: ${key}`);
  return found;
};

const specificOf = (entry: Record<string, unknown>) =>
  (entry.provider_specific_entry ?? {}) as Record<string, unknown>;

// ---------------------------------------------------------------- core merge

Deno.test("entries are keyed provider/author/model and are stock-shaped", () => {
  const { models } = buildOverlay(bifrost, fakeProvider, [
    model({
      costs: { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
      contextLength: 200000,
      maxOutputTokens: 8192,
      endpoints: ["/v1/chat/completions"],
      modalities: ["text", "image"],
      outputModalities: ["text"],
      functionCalling: true,
      reasoning: true,
      specific: { title: "GPT X" },
    }),
  ]);

  const e = entryOf(models, "test/openai/gpt-x");
  assertEquals(e.provider, "test");
  assertEquals(e.base_model, "gpt-x");
  assertEquals(e.mode, "chat");
  assertEquals(e.source, "https://example.test/models");
  assertEquals(e.input_cost_per_token, 2e-6);
  assertEquals(e.max_input_tokens, 200000);
  assertEquals(e.max_output_tokens, 8192);
  assertEquals(e.max_tokens, 8192);
  assertEquals(e.supported_modalities, ["text", "image"]);
  assertEquals(e.supports_function_calling, true);
  assertEquals(e.supports_vision, true);
  assertEquals(specificOf(e).title, "GPT X");
  // No nested provenance key — only stock fields.
  assertEquals("test" in e, false);
});

Deno.test("a provider entry extends the same base as openrouter's", () => {
  const merged = mergedDatasheet(bifrost, [buildOverlay(bifrost, fakeProvider, [model({})])]);
  assertEquals(Object.keys(baseOf(merged, "test/openai/gpt-x")).sort(), [
    "azure/gpt-x",
    "openai/gpt-x",
    "openrouter/openai/gpt-x",
  ]);
});

Deno.test("alias joins land on the core and are flagged; strict refuses them", () => {
  const aliased = model({ name: "anthropic/claude-opus-4.6", aliases: ["claude-opus-4.5"] });
  const lenient = buildOverlay(bifrost, fakeProvider, [aliased]);
  const entry = entryOf(lenient.models, "test/anthropic/claude-opus-4.6");
  assertEquals(entry.base_model, "claude-opus-4-5");
  assertEquals(specificOf(entry).joined_by_alias, true);
  assertEquals(lenient.stats.joined_by.alias, 1);

  const strict = buildOverlay(bifrost, fakeProvider, [aliased], { strict: true });
  assertEquals(entryOf(strict.models, "test/anthropic/claude-opus-4.6").base_model, "claude-opus-4.6");
  assertEquals(strict.stats.joined_by.alias, 0);
});

Deno.test("a provider-declared parent is honoured", () => {
  const { models } = buildOverlay(bifrost, fakeProvider, [
    model({ name: "community/some-finetune", parent: "openai/gpt-x" }),
  ]);
  assertEquals(entryOf(models, "test/community/some-finetune").base_model, "gpt-x");
});

Deno.test("merged datasheet keeps stock entries untouched", () => {
  const merged = mergedDatasheet(bifrost, [buildOverlay(bifrost, fakeProvider, [model({})])]);
  assertEquals(merged["openai/gpt-x"], bifrost["openai/gpt-x"]);
  assertEquals(Object.keys(merged).length, Object.keys(bifrost).length + 1);
});

Deno.test("stats count matched, unmatched and priced entries", () => {
  const { stats } = buildOverlay(bifrost, fakeProvider, [
    model({}),
    model({ name: "acme/unknown-model" }),
    model({ name: "acme/priced", costs: { input_cost_per_token: 1e-6 } }),
  ]);
  assertEquals(stats.models, 3);
  assertEquals(stats.matched_cores, 1);
  assertEquals(stats.unmatched_cores, 2);
  assertEquals(stats.with_prices, 1);
  assertEquals(stats.by_mode, { chat: 3 });
});

Deno.test("stockFields is the alignment vocabulary", () => {
  const fields = stockFields(bifrost);
  for (const field of ["provider", "base_model", "mode", "input_cost_per_token"]) {
    assertEquals(fields.has(field), true);
  }
  assertEquals(fields.has("pollinations"), false);
});

// ------------------------------------------------------------------ providers

Deno.test("pollinations maps pollen rates onto Bifrost cost fields at 1:1", () => {
  const [m] = parsePollinations([{
    name: "openai/gpt-x",
    category: "text",
    context_length: 400000,
    max_completion_tokens: 8192,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    supported_endpoints: ["/v1/chat/completions"],
    capabilities: ["tool_calling", "reasoning"],
    pricing: {
      currency: "pollen",
      promptTextTokens: "0.00000015",
      completionTextTokens: "0.0000009375",
      promptCachedTokens: "0.000000015",
      completionImageTokens: "0.004",
    },
    title: "GPT X",
  }]);

  assertEquals(m.name, "openai/gpt-x");
  assertEquals(m.mode, "chat");
  assertEquals(m.costs?.input_cost_per_token, 0.00000015);
  assertEquals(m.costs?.output_cost_per_token, 0.0000009375);
  assertEquals(m.costs?.cache_read_input_token_cost, 0.000000015);
  assertEquals(m.costs?.output_cost_per_image_token, 0.004);
  assertEquals(m.contextLength, 400000);
  assertEquals(m.functionCalling, true);
  assertEquals(m.reasoning, true);
  assertEquals(m.specific?.pollen_pricing, undefined); // every rate mapped
});

Deno.test("pollinations keeps unmapped rates raw and splits audio modes", () => {
  const [tts] = parsePollinations([{
    name: "openai/tts-1",
    category: "audio",
    supported_endpoints: ["/v1/audio/speech"],
    pricing: {
      currency: "pollen",
      completionAudioTokens: "0.000015",
      completionAudioSeconds: "0.0001",
    },
  }]);
  assertEquals(tts.mode, "audio_speech");
  assertEquals(tts.costs?.output_cost_per_audio_token, 0.000015);
  assertEquals(tts.specific?.pollen_pricing, {
    currency: "pollen",
    completionAudioSeconds: "0.0001",
  });

  const [stt] = parsePollinations([{
    name: "openai/whisper-x",
    category: "audio",
    supported_endpoints: ["/v1/audio/transcriptions"],
  }]);
  assertEquals(stt.mode, "audio_transcription");
});

Deno.test("pollinations honours a non-1:1 pollen rate and a disabled rate", () => {
  const fixture = [{ name: "a/b", category: "text", pricing: { promptTextTokens: "0.002" } }];
  assertEquals(parsePollinations(fixture, 1000)[0].costs?.input_cost_per_token, 0.002 / 1000);
  assertEquals(parsePollinations(fixture, 0)[0].costs?.input_cost_per_token, undefined);
});

Deno.test("sail divides per-million prices onto each tier's cost fields", () => {
  const [m] = parseSail({
    object: "list",
    data: [{
      id: "deepseek-ai/DeepSeek-V4-Pro-0813",
      owned_by: "deepseek-ai",
      input_modalities: ["text", "image"],
      pricing_usd_per_million_tokens: {
        asap: { input: 1.5, cached_input: 0.2, output: 10 },
        balanced: { input: 1.2, cached_input: 0.15, output: 8 },
        flex: { input: 0.7, cached_input: 0.1, output: 6 },
      },
    }],
  });

  assertEquals(m.name, "deepseek-ai/DeepSeek-V4-Pro-0813");
  assertEquals(m.mode, "chat");
  // Matches the stock datasheet's own sail/* convention: asap is the plain
  // field, then _balanced and _flex.
  assertEquals(m.costs?.input_cost_per_token, 1.5 / 1e6);
  assertEquals(m.costs?.output_cost_per_token, 10 / 1e6);
  assertEquals(m.costs?.input_cost_per_token_balanced, 1.2 / 1e6);
  assertEquals(m.costs?.cache_read_input_token_cost_balanced, 0.15 / 1e6);
  assertEquals(m.costs?.output_cost_per_token_balanced, 8 / 1e6);
  assertEquals(m.costs?.input_cost_per_token_flex, 0.7 / 1e6);
  assertEquals(m.costs?.output_cost_per_token_flex, 6 / 1e6);
  assertEquals(m.specific?.pricing_tiers, ["asap", "balanced", "flex"]);
});

Deno.test("an entry Bifrost already publishes is extended, not replaced", () => {
  const stock: Datasheet = {
    "test/openai/gpt-x": {
      provider: "test",
      base_model: "gpt-x-core",
      mode: "chat",
      max_input_tokens: 128000,
      supports_reasoning: true,
      input_cost_per_token: 1e-6,
      output_cost_per_token: 3e-6,
    },
  };
  const { models, stats } = buildOverlay(stock, fakeProvider, [
    model({ costs: { input_cost_per_token: 2e-6, output_cost_per_token: 3e-6 } }),
  ]);

  // Only what changed, plus the identity fields.
  assertEquals(models["test/openai/gpt-x"], {
    provider: "test",
    base_model: "gpt-x-core",
    input_cost_per_token: 2e-6,
  });
  assertEquals(stats.extends_stock, 1);
  assertEquals(stats.joined_by.stock, 1);

  // Stock's own base_model and capabilities survive the merge.
  const merged = mergedDatasheet(stock, [
    { ...buildOverlay(stock, fakeProvider, [
      model({ costs: { input_cost_per_token: 2e-6, output_cost_per_token: 3e-6 } }),
    ]) },
  ]);
  assertEquals(merged["test/openai/gpt-x"].supports_reasoning, true);
  assertEquals(merged["test/openai/gpt-x"].mode, "chat");
  assertEquals(merged["test/openai/gpt-x"].input_cost_per_token, 2e-6);
  assertEquals(merged["test/openai/gpt-x"].output_cost_per_token, 3e-6);
});

Deno.test("an entry identical to stock is not repeated in the overlay", () => {
  const stock: Datasheet = {
    "test/openai/gpt-x": {
      provider: "test",
      base_model: "gpt-x",
      mode: "chat",
      input_cost_per_token: 2e-6,
    },
  };
  const overlay = buildOverlay(stock, fakeProvider, [
    model({ costs: { input_cost_per_token: 2e-6 } }),
  ]);
  assertEquals(overlay.models, {});
  assertEquals(overlay.stats.unchanged, 1);
  assertEquals(overlay.stats.emitted, 0);
  assertEquals(overlay.note?.includes("already match the stock datasheet"), true);
  assertEquals(mergedDatasheet(stock, [overlay]), stock);
});

Deno.test("sail models with no pricing block still produce an entry", () => {
  const [m] = parseSail({
    data: [{ id: "Qwen/Qwen3.6-35B-A3B", input_modalities: ["text", "image"] }],
  });
  assertEquals(m.costs, {});
  assertEquals(m.specific?.pricing_tiers, undefined);
});

Deno.test("sail provider sends the key as a bearer token", () => {
  const headers = sailProvider().headers((name) => name === "SAIL_API_KEY" ? "secret" : undefined);
  assertEquals(headers, { authorization: "Bearer secret" });
  assertEquals(sailProvider().headers(() => undefined), {});
  // Pollinations needs no auth on its listing.
  assertEquals(pollinationsProvider().headers(() => undefined), {});
});
