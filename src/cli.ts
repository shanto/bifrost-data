/**
 * Deno engine for the infused datasheet.
 *
 *   deno task datasheet                                  # per-provider overlays + merged sheet
 *   deno task datasheet --provider sail --stdout         # one provider
 *   deno task datasheet --resolve sail/deepseek-ai/DeepSeek-V4-Pro
 *   deno task serve --port 8080 --ttl 30
 *
 * The same build() feeds the CLI, the HTTP server and the GitHub Action, so
 * there is exactly one merge code path on exactly one set of sources. Provider
 * quirks live in src/providers/, never here.
 */

import { BIFROST_DATASHEET_URL, fetchJson, type SourceMeta } from "./sources.ts";
import {
  baseOf,
  buildOverlay,
  type Datasheet,
  mergedDatasheet,
  type OverlayDoc,
  stockFields,
} from "./merge.ts";
import { pollinationsProvider } from "./providers/pollinations.ts";
import { sailProvider } from "./providers/sail.ts";
import type { NormalizedModel, Provider } from "./providers/types.ts";

export interface BuildOptions {
  /** Pollen units per 1 USD (Pollinations only). Default 1. */
  pollenPerUsd?: number;
  strict?: boolean;
  /** Provider ids to include; default: all known providers. */
  providers?: string[];
  /** Extra environment (e.g. parsed from a .env file). */
  env?: (name: string) => string | undefined;
}

export interface BuildResult {
  overlays: OverlayDoc[];
  merged: Datasheet;
  meta: { ms: number; sources: SourceMeta[]; mergedEntries: number };
}

export function allProviders(opts: BuildOptions = {}): Provider[] {
  return [
    pollinationsProvider({ pollenPerUsd: opts.pollenPerUsd ?? 1 }),
    sailProvider(),
  ];
}

/**
 * Every provider is rebuilt on every run. Where Bifrost already publishes the
 * same key (all of `sail/*` today), the entry is a diff against stock: only
 * prices and sizes that actually moved are emitted, so the API stays the source
 * of truth for price drift without duplicating the sheet.
 */
export const DEFAULT_PROVIDERS = ["pollinations", "sail"];

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const env = opts.env ?? ((name: string) => Deno.env.get(name));
  const wanted = new Set(opts.providers?.length ? opts.providers : DEFAULT_PROVIDERS);
  const providers = allProviders(opts).filter((p) => !wanted || wanted.has(p.id));

  if (providers.length === 0) {
    throw new Error(`no known provider matched: ${[...wanted].join(", ")}`);
  }

  // /datasheet/model-parameters (27 MB) is deliberately not fetched: entries
  // only need costs and limits, and that payload is what pushed peak memory to
  // ~143 MB. This keeps a full build around ~15 MB.
  const bifrost = await fetchJson<Datasheet>(BIFROST_DATASHEET_URL);
  const sources: SourceMeta[] = [bifrost.meta];

  const overlays: OverlayDoc[] = [];
  for (const provider of providers) {
    let payloads: Awaited<ReturnType<typeof fetchJson<unknown>>>[];
    try {
      payloads = await Promise.all(
        provider.urls().map((url) => fetchJson<unknown>(url, { headers: provider.headers(env) })),
      );
    } catch (err) {
      if (!provider.optional) throw err;
      console.error(`skipping ${provider.id}: ${(err as Error).message}`);
      continue;
    }
    sources.push(...payloads.map((p) => p.meta));

    // Several endpoints can describe the same catalog (e.g. /models and
    // /image/models); dedupe on the provider's own model id.
    const seen = new Set<string>();
    const models: NormalizedModel[] = [];
    for (const payload of payloads) {
      for (const model of provider.parse(payload.data)) {
        if (seen.has(model.name)) continue;
        seen.add(model.name);
        models.push(model);
      }
    }

    const overlay = buildOverlay(bifrost.data, provider, models, { strict: opts.strict });
    overlay.units = provider.units;
    overlay.sources = payloads.map((p) => p.meta);
    overlays.push(overlay);
  }

  // Alignment guard: an entry may only use fields the stock datasheet already
  // uses. Anything else belongs in provider_specific_entry.
  const allowed = stockFields(bifrost.data);
  for (const overlay of overlays) {
    for (const [key, entry] of Object.entries(overlay.models)) {
      for (const field of Object.keys(entry)) {
        if (!allowed.has(field)) {
          throw new Error(`${overlay.provider}: field "${field}" on ${key} is not stock`);
        }
      }
    }
  }

  const merged = mergedDatasheet(bifrost.data, overlays);

  return {
    overlays,
    merged,
    meta: {
      ms: Math.round(performance.now() - started),
      sources,
      mergedEntries: Object.keys(merged).length,
    },
  };
}

// ---------------------------------------------------------------- CLI parsing

interface Args {
  outDir: string;
  mergedOut?: string;
  provider?: string;
  stdout: boolean;
  serve: boolean;
  port: number;
  ttl: number;
  pollenPerUsd: number;
  strict: boolean;
  resolve?: string;
  envFile?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    outDir: "dist",
    stdout: false,
    serve: false,
    port: 8080,
    ttl: 60,
    strict: false,
    quiet: false,
    // Pollen is treated as USD 1:1 unless a rate says otherwise.
    pollenPerUsd: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--out-dir":
        args.outDir = value();
        break;
      case "--merged-out":
        args.mergedOut = value();
        break;
      case "--provider":
        args.provider = value();
        break;
      case "--stdout":
        args.stdout = true;
        break;
      case "--serve":
        args.serve = true;
        break;
      case "--port":
      case "-p":
        args.port = Number(value());
        break;
      case "--ttl":
        args.ttl = Number(value());
        break;
      case "--pollen-per-usd":
        args.pollenPerUsd = Number(value());
        break;
      case "--no-prices":
        args.pollenPerUsd = 0;
        break;
      case "--strict":
        args.strict = true;
        break;
      case "--resolve":
        args.resolve = value();
        break;
      case "--env-file":
        args.envFile = value();
        break;
      case "--quiet":
      case "-q":
        args.quiet = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        Deno.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return args;
}

/** Minimal .env reader: KEY=VALUE, `#` comments, optional quotes. */
async function loadEnvFile(path: string): Promise<(name: string) => string | undefined> {
  const text = await Deno.readTextFile(path);
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    vars.set(match[1], match[2].trim().replace(/^["']|["']$/g, ""));
  }
  return (name) => vars.get(name) ?? Deno.env.get(name);
}

function printHelp(): void {
  console.log(`bifrost-data — provider model data as stock Bifrost datasheet entries

Usage:
  deno task datasheet
  deno task datasheet --provider sail --stdout
  deno task datasheet --resolve pollinations/openai/gpt-5.4-nano
  deno task serve --port 8080 --ttl 60

Outputs (default out dir dist/):
  datasheet.json         stock datasheet + every provider's entries  (drop-in)
  <provider>.json        only that provider's entries                (overlay)

Flags:
      --provider <id>     limit to one provider (pollinations, sail)
      --out-dir <dir>     where overlays are written (default dist)
      --merged-out <path> merged output path (default <out-dir>/datasheet.json)
      --stdout            print the overlay document, write nothing
      --resolve <key>     print one entry plus the entries it extends
      --env-file <path>   read keys from a .env file (SAIL_API_KEY, POLLI_API_KEY)
      --serve             run the HTTP server
  -p, --port <n>          server port (default 8080)
      --ttl <seconds>     server rebuild interval, 0 = every request (default 60)
      --pollen-per-usd <n> pollen units per USD (default 1 — pollen treated as USD)
      --no-prices         never emit Pollinations cost fields
      --strict            join on model names only, never on aliases
  -q, --quiet             only print the summary lines`);
}

// -------------------------------------------------------------------- server

async function serve(args: Args, env: (name: string) => string | undefined): Promise<void> {
  let cached: BuildResult | null = null;
  let builtAt = 0;
  let inflight: Promise<BuildResult> | null = null;

  const buildOptions: BuildOptions = {
    pollenPerUsd: args.pollenPerUsd,
    strict: args.strict,
    providers: args.provider ? [args.provider] : undefined,
    env,
  };

  const current = async (): Promise<BuildResult> => {
    const fresh = args.ttl > 0 && cached && Date.now() - builtAt < args.ttl * 1000;
    if (fresh) return cached!;
    if (!inflight) {
      inflight = build(buildOptions)
        .then((result) => {
          cached = result;
          builtAt = Date.now();
          return result;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return await inflight;
  };

  Deno.serve({ port: args.port }, async (req) => {
    const { pathname } = new URL(req.url);
    const headers = {
      "cache-control": args.ttl > 0 ? `public, max-age=${args.ttl}` : "no-store",
    };

    if (pathname === "/datasheet.json") {
      const { merged } = await current();
      return Response.json(merged, { headers });
    }
    const overlayMatch = pathname.match(/^\/([a-z0-9_-]+)\.json$/);
    if (overlayMatch) {
      const { overlays } = await current();
      const doc = overlays.find((o) => o.provider === overlayMatch[1]);
      if (doc) return Response.json(doc, { headers });
    }
    if (pathname === "/" || pathname === "/health") {
      const { overlays } = await current();
      return Response.json({
        service: "bifrost-data",
        endpoints: ["/datasheet.json", ...overlays.map((o) => `/${o.provider}.json`)],
        cached_for_seconds: cached ? Math.round((Date.now() - builtAt) / 1000) : null,
        ttl_seconds: args.ttl,
      });
    }
    return new Response("not found\n", { status: 404 });
  });

  console.error(`bifrost-data listening on http://127.0.0.1:${args.port}/datasheet.json`);
}

// ----------------------------------------------------------------------- main

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const env = args.envFile ? await loadEnvFile(args.envFile) : (name: string) => Deno.env.get(name);
  const buildOptions: BuildOptions = {
    pollenPerUsd: args.pollenPerUsd,
    strict: args.strict,
    providers: args.provider ? [args.provider] : undefined,
    env,
  };

  if (args.serve) {
    await serve(args, env);
  } else {
    const result = await build(buildOptions);

    if (args.resolve) {
      const target = result.merged[args.resolve] ??
        result.overlays.flatMap((o) => Object.entries(o.models)).find(([k]) => k === args.resolve)?.[1];
      if (!target) {
        console.error(`no such model: ${args.resolve}`);
        Deno.exit(1);
      }
      console.log(JSON.stringify({ [args.resolve]: target }, null, 2));
      const parentKeys = Object.keys(baseOf(result.merged, args.resolve));
      if (parentKeys.length) {
        console.error(`extends ${target.base_model} via: ${parentKeys.join(", ")}`);
      }
    } else if (args.stdout) {
      const doc = result.overlays.length === 1 ? result.overlays[0] : { datasheet: result.merged };
      console.log(JSON.stringify(doc, null, 2));
    } else {
      const mergedPath = args.mergedOut ?? `${args.outDir}/datasheet.json`;
      const paths = [mergedPath, ...result.overlays.map((o) => `${args.outDir}/${o.provider}.json`)];
      for (const path of paths) {
        await Deno.mkdir(path.replace(/\/[^/]+$/, "") || ".", { recursive: true });
      }

      for (const overlay of result.overlays) {
        const path = `${args.outDir}/${overlay.provider}.json`;
        await Deno.writeTextFile(path, JSON.stringify(overlay) + "\n");
        if (!args.quiet) {
          console.error(
            `wrote ${path} (${(JSON.stringify(overlay).length / 1024).toFixed(1)} KiB, ` +
              `${overlay.stats.emitted} entries)`,
          );
        }
      }
      await Deno.writeTextFile(mergedPath, JSON.stringify(result.merged) + "\n");
      if (!args.quiet) {
        console.error(
          `wrote ${mergedPath} (${(JSON.stringify(result.merged).length / 1024 / 1024).toFixed(1)} MiB, ` +
            `${result.meta.mergedEntries} entries)`,
        );
      }
    }

    if (!args.quiet) {
      for (const o of result.overlays) {
        const s = o.stats;
        console.error(
          `${o.provider}: ${s.models} models · matched cores ${s.matched_cores} · ` +
            `unmatched ${s.unmatched_cores} · with prices ${s.with_prices} · ` +
            `extends stock ${s.extends_stock} · ` +
            `joined ${s.joined_by.stock}/${s.joined_by.name}/${s.joined_by.basename}/${s.joined_by.alias} ` +
            `(stock/name/basename/alias)`,
        );
      }
      console.error(`${result.meta.ms} ms`);
    }
  }
}
