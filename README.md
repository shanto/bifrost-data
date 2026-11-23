# bifrost-data

Third-party model catalogs turned into stock [Bifrost](https://getbifrost.ai/datasheet) datasheet
entries and published from a GitHub Action. Two providers today: **Pollinations** and **Sail**.

- `https://shanto.github.io/bifrost-data/datasheet.json` — stock datasheet + every provider's entries
- `…/pollinations.json`, `…/sail.json` — per-provider overlays
- Upstreams: `https://getbifrost.ai/datasheet` · `https://gen.pollinations.ai/models` ·
  `https://api.sailresearch.com/v1/models`

## Shape

Entries are keyed `provider/author/model` and use the stock field vocabulary, the same way
`openrouter/openai/gpt-6.2-astra` extends `openai/gpt-6.2-astra`:

```jsonc
"pollinations/openai/gpt-6.2-astra": {          // pollen priced, treated as USD 1:1
  "provider": "pollinations",
  "base_model": "gpt-6.2-astra",
  "source": "https://gen.pollinations.ai/models",
  "mode": "chat",
  "input_cost_per_token": 6e-06,
  "output_cost_per_token": 3e-05,
  "cache_read_input_token_cost": 3e-07,
  "max_input_tokens": 1050000,
  "supported_endpoints": ["/v1/chat/completions", "/text", "…"],
  "supported_modalities": ["text", "image"],
  "supports_function_calling": true,
  "provider_specific_entry": { "title": "GPT-6.2 Astra", "paid_only": true }
}

"sail/moonshotai/Kimi-K3.1-Pro": {              // already USD, per-million divided out
  "provider": "sail",
  "base_model": "Kimi-K3.1-Pro",
  "source": "https://api.sailresearch.com/v1/models",
  "mode": "chat",
  "input_cost_per_token": 1.5e-06,              // "asap" tier — the plain fields
  "output_cost_per_token": 1e-05,
  "input_cost_per_token_balanced": 1.2e-06,     // "balanced" tier
  "output_cost_per_token_balanced": 8e-06,
  "input_cost_per_token_flex": 7e-07,           // "flex" tier
  "output_cost_per_token_flex": 6e-06,
  "supported_modalities": ["text", "image"],
  "supports_vision": true,
  "provider_specific_entry": { "pricing_tiers": ["asap", "balanced", "flex"], "owned_by": "moonshotai" }
}
```

Every top-level field in an entry exists in the stock datasheet vocabulary — the build throws on
anything else. Provider-only data (raw rates, price variants, titles, tier names, community flags)
goes into `provider_specific_entry`, the stock slot for it.

Consumers group by `base_model`:

```ts
import { baseOf } from "https://raw.githubusercontent.com/shanto/bifrost-data/master/src/merge.ts";
baseOf(datasheet, "sail/deepseek-ai/DeepSeek-V4-Pro-0813");
// → every entry for that model, stock ones included
```

## Layout

```
src/merge.ts                   provider-agnostic: core join, entry building, overlay + merge
src/providers/types.ts         NormalizedModel + Provider contract
src/providers/common.ts        category→mode, rate scaling
src/providers/pollinations.ts
src/providers/sail.ts
src/cli.ts                     build / --resolve / HTTP server / alignment guard
src/sources.ts                 fetch + truncation-aware parse errors
test/merge_test.ts             15 tests: core rules, both adapters, no network
```

A provider answers only four things — `id`, `sourceUrl`, `urls()`, `headers(env)` and
`parse(payload) → NormalizedModel[]`. Keys, `base_model` joins, cost fields and the stock-vocabulary
guard are shared, so a third catalog is one adapter file plus a line in `allProviders()`.

## Join rules

`base_model` comes from the stock datasheet, in this order:

0. **stock key** — if Bifrost already publishes `<provider>/<model>`, that entry is the authority:
   its `base_model`, limits and capability flags are kept and only prices/sizes are overridden. If
   nothing differs, the model is not repeated in the overlay at all (`note` and `stats.unchanged`
   say how many).
1. **name** — the core name equals the provider's model id.
2. **basename** — the core equals the model id with the `publisher/` prefix stripped.
3. the provider's own declared parent (Pollinations' `base_model` field).
4. **alias** — a normalised name or a provider alias matches exactly one core
   (`claude-opus-4-5` ≡ `claude-opus-4.5`). This is upstream's claim, not ours, and the entry is
   flagged `provider_specific_entry.joined_by_alias`.

An alias matching several cores is refused rather than guessed; `--strict` skips step 4.

## Prices

Every adapter converts to **USD per unit** before the entry is built, so the datasheet never mixes
currencies.

**Pollinations** quotes pollen; pollen is treated as USD 1:1 (`--pollen-per-usd <n>` to override,
`--no-prices` to drop cost fields). Rates map onto the Bifrost field with the same meaning:

| Pollinations | Bifrost |
|---|---|
| `promptTextTokens` / `completionTextTokens` | `input_cost_per_token` / `output_cost_per_token` |
| `promptCachedTokens` / `promptCacheWriteTokens` | `cache_read_input_token_cost` / `cache_creation_input_token_cost` |
| `promptAudioTokens` / `completionAudioTokens` | `input_cost_per_audio_token` / `output_cost_per_audio_token` |
| `promptAudioSeconds` | `input_cost_per_audio_per_second` |
| `promptImageTokens` / `completionImageTokens` | `input_cost_per_image_token` / `output_cost_per_image_token` |
| `promptVideoTokens` / `completionVideoTokens` | `input_cost_per_video_token` / `output_cost_per_video_token` |
| `promptVideoSeconds` / `completionVideoSeconds` | `input_cost_per_video_per_second` / `output_cost_per_video_second` |
| `completionReasoningTokens` | `output_cost_per_reasoning_token` |

Anything without an equivalent stays raw under `provider_specific_entry.pollen_pricing`; models the
provider publishes no rates for simply carry no cost fields.

**Sail** quotes USD per **million** tokens, so each rate is divided by 1e6. Its three service tiers
land on the per-mode fields Bifrost already uses for the same idea:

| Sail tier | Bifrost field |
|---|---|
| `asap` | `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost` |
| `balanced` | the same three with a `_balanced` suffix |
| `flex` | the same three with a `_flex` suffix |

Bifrost already ships `sail/*` entries sourced from Sail's docs, and this is the convention it uses
there — the API's numbers match them exactly today, so normally only new models reach the overlay.

## Usage

```bash
deno task datasheet                                   # every provider, into dist/
deno task datasheet --provider sail --stdout | jq .stats
deno task datasheet --env-file ../Bifrost/.env        # SAIL_API_KEY from a file
deno task datasheet --resolve sail/deepseek-ai/DeepSeek-V4-Pro-0813
deno task serve --port 8080 --ttl 60                  # /datasheet.json + /<provider>.json
deno task test
```

Flags: `--provider <id>`, `--out-dir` (default `dist`), `--merged-out`, `--stdout`,
`--resolve <key>`, `--env-file`, `--serve`, `--port`, `--ttl` (0 = rebuild per request),
`--pollen-per-usd` (default `1`), `--no-prices`, `--strict`, `--quiet`.

Keys come from the environment or `--env-file`: `SAIL_API_KEY` (required for Sail) and an optional
`POLLI_API_KEY`. Pollinations' listing is public — a keyed request returns byte-identical bytes — so
a missing Sail key only skips that provider, with a warning.

## Publishing

`.github/workflows/publish.yml` runs on push to `master`, daily at 05:17 UTC, and on manual
dispatch: typecheck → tests → build every provider into `site/` → `actions/deploy-pages`. Pages uses
GitHub Actions as its source, so there is no `gh-pages` branch and nothing is committed.

**One-time setup:** add `SAIL_API_KEY` as an Actions secret (Settings → Secrets and variables →
Actions). Without it the build skips Sail and publishes the rest.

## Notes on sources

- `getbifrost.ai/datasheet/model-parameters` (27 MB) is **not** fetched. It only carries parameter
  schemas, and parsing it is what pushed peak memory to ~143 MB. Dropping it keeps a build near
  ~15 MB and ~2–3 s.
- `gen.pollinations.ai/image/models` is a filtered view of `/models` (98 image + 30 video), not an
  extra catalog. It is merged anyway so a future divergence can't be lost.
- `health` counters are never emitted: they change on every request and would make every build
  look different.
- Sail publishes no context length, so its entries carry no `max_input_tokens` — read that off the
  core the entry extends (`baseOf`).
