# bifrost-data

Pollinations model data infused into the stock [Bifrost](https://getbifrost.ai/datasheet) model
datasheet. A Deno engine turns the Pollinations model list into **stock Bifrost datasheet entries**
and publishes them from a GitHub Action.

- `https://shanto.github.io/bifrost-data/datasheet.json` — stock datasheet + the pollinations entries
- `https://shanto.github.io/bifrost-data/pollinations.json` — only the pollinations entries
- Upstream: `https://getbifrost.ai/datasheet` · `https://gen.pollinations.ai/models`

## Shape

Entries are keyed `provider/author/model` and use the same field names as the stock datasheet, the
same way `openrouter/openai/gpt-6.2-astra` extends `openai/gpt-6.2-astra`:

```jsonc
"pollinations/openai/gpt-6.2-astra": {
  "provider": "pollinations",
  "base_model": "gpt-6.2-astra",
  "source": "https://gen.pollinations.ai/models",
  "mode": "chat",
  "input_cost_per_token": 6e-06,
  "output_cost_per_token": 3e-05,
  "cache_read_input_token_cost": 3e-07,
  "cache_creation_input_token_cost": 7.5e-06,
  "max_input_tokens": 1050000,
  "supported_endpoints": ["/v1/chat/completions", "/text", "/text/{prompt}", "/v1/responses", "/v1/messages"],
  "supported_modalities": ["text", "image"],
  "supported_output_modalities": ["text"],
  "supports_function_calling": true,
  "supports_reasoning": true,
  "supports_vision": true,
  "provider_specific_entry": {
    "title": "GPT-6.2 Astra",
    "paid_only": true,
    "pricing_variants": [{ "name": "long_context", "pricing": { "currency": "pollen", "promptTextTokens": "0.000012", "…": "…" } }]
  }
}
```

Every top-level field in a pollinations entry exists in the stock datasheet vocabulary — the build
asserts that; nothing is invented. Anything Pollinations publishes that Bifrost has no field for
(its raw per-unit pollen rates, price variants, title, `per_user_rpm`, community/paid flags) goes
into `provider_specific_entry`, which is the stock slot for provider-only data.

The base model keeps its own prices untouched. A consumer groups by `base_model`:

```ts
import { baseOf } from "https://raw.githubusercontent.com/shanto/bifrost-data/master/src/merge.ts";
baseOf(datasheet, "pollinations/openai/gpt-6.2-astra");
// → { "openai/gpt-6.2-astra": …, "azure/gpt-6.2-astra": …, "openrouter/openai/gpt-6.2-astra": …, … }
```

`pollinations.json` wraps the same entries in a small document:

```jsonc
{
  "schema": "bifrost-data/pollinations@1",
  "generated_at": "…",
  "provider": "pollinations",
  "units": "pollen treated as USD (1:1)",
  "sources": [{ "url": "https://gen.pollinations.ai/models", "status": 200, "bytes": 468512, "entries": 487, "ms": 729 }],
  "stats": { "pollinations_entries": 488, "emitted": 488, "matched_cores": 352, "unmatched_cores": 136,
             "with_prices": 457, "joined_by": { "name": 14, "basename": 329, "alias": 9 } },
  "models": { "pollinations/openai/gpt-6.2-astra": { … } }
}
```

## Join rules

`base_model` comes from the stock datasheet, in this order:

1. **name** — the core name equals the Pollinations name.
2. **basename** — the core equals the model name with the `publisher/` prefix stripped.
3. Pollinations' own `base_model`, by the same two rules (community models delegate to a core).
4. **alias** — a normalised name or one of Pollinations' own aliases matches exactly one core
   (`claude-opus-4-5` ≡ `claude-opus-4.5`). This is upstream's claim, not ours: Pollinations lists
   `claude-opus-4.5` as an alias of `anthropic/claude-opus-4.6`, so the entry lands on that core and
   is flagged `provider_specific_entry.joined_by_alias`.

An alias matching several cores is refused rather than guessed; `--strict` skips step 4 entirely.

## Prices

**Pollen is treated as USD 1:1.** Each Pollinations rate maps onto the Bifrost field that means the
same thing:

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

Rates with no Bifrost equivalent stay raw under `provider_specific_entry.pollen_pricing`. Models
Pollinations publishes no rates for (31 of 488 today — mostly free community models) simply carry
no cost fields.

Sanity check on 1:1: Pollinations quotes `gpt-6.2-astra` at 6e-06/3e-05 while OpenAI's own entries
say 8e-06/4e-05 — same order, plausible discount, not a unit mismatch.

```bash
deno task datasheet --pollen-per-usd 1000   # if 1:1 ever stops holding
deno task datasheet --no-prices             # no cost fields at all
```

## Usage

```bash
deno task datasheet                                  # writes both files into dist/
deno task datasheet --stdout | jq '.stats'           # overlay document to stdout
deno task datasheet --resolve pollinations/openai/gpt-6.2-astra
deno task serve --port 8080 --ttl 60                 # GET /datasheet.json, /pollinations.json
deno task test                                       # merge-rule tests, no network
```

Flags: `-o/--out` (overlay path, default `dist/pollinations.json`), `--merged-out` (default
`dist/datasheet.json`), `--stdout`, `--resolve <key>`, `--serve`, `--port`, `--ttl` (0 = rebuild
every request), `--key` (or `POLLI_API_KEY`), `--pollen-per-usd` (default `1`), `--no-prices`,
`--strict`, `--quiet`.

The Pollinations key is optional: `/models` is public and a keyed request returns byte-identical
bytes. The flag exists only so a private deployment can pass one through.

## Publishing

`.github/workflows/publish.yml` runs on push to `master`, daily at 05:17 UTC, and on manual
dispatch. It typechecks, runs the tests, builds both files into `site/`, and deploys with
`actions/deploy-pages` — Pages uses **GitHub Actions** as its source, so there is no `gh-pages`
branch and nothing is committed.

The daily cron is deliberate: both upstreams churn constantly, and every build carries
`generated_at` plus per-source byte counts so two builds can be diffed.

## Notes on sources

- `getbifrost.ai/datasheet/model-parameters` (27 MB) is **not** fetched. It only carries parameter
  schemas, and parsing it is what pushes peak memory to ~143 MB. Dropping it keeps a build near
  ~15 MB and ~2–3 s.
- `gen.pollinations.ai/image/models` is a filtered view of `/models` (98 image + 30 video), not an
  extra catalog. It is merged anyway so a future divergence can't be lost.
- `health` counters are never emitted: they change on every request and would make every build
  look different.
