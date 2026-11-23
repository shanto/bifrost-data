/**
 * Deno engine for the infused datasheet.
 *
 *   deno task datasheet                                  # overlay + merged sheet
 *   deno task datasheet --stdout | jq 'keys[:5]'
 *   deno task datasheet --resolve pollinations/openai/gpt-5.4-nano
 *   deno task serve --port 8080 --ttl 30
 *
 * The same build() feeds the CLI, the HTTP server and the GitHub Action, so
 * there is exactly one merge code path on exactly one set of sources.
 */

import {
  BIFROST_DATASHEET_URL,
  fetchJson,
  POLLINATIONS_IMAGE_MODELS_URL,
  POLLINATIONS_MODELS_URL,
  type SourceMeta,
} from "./sources.ts";
import {
  baseOf,
  buildOverlay,
  type Datasheet,
  mergedDatasheet,
  type OverlayDoc,
  type PollModel,
} from "./merge.ts";

interface BuildOptions {
  key?: string;
  pollenPerUsd?: number;
  strict?: boolean;
}

interface BuildResult {
  overlay: OverlayDoc;
  merged: Datasheet;
  meta: { ms: number; sources: SourceMeta[]; mergedEntries: number };
}

export async function build(opts: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();

  // /datasheet/model-parameters (27 MB) is deliberately not fetched: entries
  // only need costs and limits, and that payload is what pushed peak memory to
  // ~143 MB. This keeps a full build around ~15 MB.
  const [bifrost, models, imageModels] = await Promise.all([
    fetchJson<Datasheet>(BIFROST_DATASHEET_URL, { key: opts.key }),
    fetchJson<PollModel[]>(POLLINATIONS_MODELS_URL, { key: opts.key }),
    fetchJson<PollModel[]>(POLLINATIONS_IMAGE_MODELS_URL, { key: opts.key }),
  ]);

  // /image/models is a filtered view (image + video) of /models and adds no
  // names, but it is merged anyway so a future divergence is never lost.
  const seen = new Set<string>();
  const poll: PollModel[] = [];
  for (const model of [...models.data, ...imageModels.data]) {
    if (seen.has(model.name)) continue;
    seen.add(model.name);
    poll.push(model);
  }

  const overlay = buildOverlay(bifrost.data, poll, {
    pollenPerUsd: opts.pollenPerUsd,
    strict: opts.strict,
  });
  const sources: SourceMeta[] = [bifrost.meta, models.meta, imageModels.meta];
  overlay.sources = sources;

  // Alignment guard: an entry may only use fields the stock datasheet already
  // uses. Anything else belongs in provider_specific_entry.
  const stockFields = new Set<string>();
  for (const entry of Object.values(bifrost.data)) {
    for (const field of Object.keys(entry)) stockFields.add(field);
  }
  for (const [key, entry] of Object.entries(overlay.models)) {
    for (const field of Object.keys(entry)) {
      if (!stockFields.has(field)) throw new Error(`field "${field}" on ${key} is not stock`);
    }
  }

  const merged = mergedDatasheet(bifrost.data, overlay);

  return {
    overlay,
    merged,
    meta: { ms: Math.round(performance.now() - started), sources, mergedEntries: Object.keys(merged).length },
  };
}

// ---------------------------------------------------------------- CLI parsing

interface Args {
  out?: string;
  mergedOut?: string;
  stdout: boolean;
  serve: boolean;
  port: number;
  ttl: number;
  key?: string;
  pollenPerUsd?: number;
  strict: boolean;
  resolve?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
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
      case "--out":
      case "-o":
        args.out = value();
        break;
      case "--merged-out":
        args.mergedOut = value();
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
      case "--key":
        args.key = value();
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

function printHelp(): void {
  console.log(`bifrost-data — Pollinations model data as stock Bifrost datasheet entries

Usage:
  deno task datasheet
  deno task datasheet --stdout
  deno task datasheet --resolve pollinations/openai/gpt-5.4-nano
  deno task serve --port 8080 --ttl 60

Outputs (both on by default):
  dist/datasheet.json     stock datasheet + pollinations/... entries  (drop-in)
  dist/pollinations.json  only the pollinations/... entries           (overlay)

Flags:
  -o, --out <path>        overlay output path (default dist/pollinations.json)
      --merged-out <path> merged output path (default dist/datasheet.json)
      --stdout            print the overlay document, write nothing
      --resolve <key>     print one entry plus the entries it extends
      --serve             run the HTTP server
  -p, --port <n>          server port (default 8080)
      --ttl <seconds>     server rebuild interval, 0 = every request (default 60)
      --key <key>         Pollinations key (optional; listing is public)
      --pollen-per-usd <n> pollen units per USD (default 1 — pollen treated as USD)
      --no-prices         never emit cost fields
      --strict            join on model names only, never on aliases
  -q, --quiet             only print the summary line`);
}

// -------------------------------------------------------------------- server

async function serve(args: Args): Promise<void> {
  let cached: BuildResult | null = null;
  let builtAt = 0;
  let inflight: Promise<BuildResult> | null = null;

  const current = async (): Promise<BuildResult> => {
    const fresh = args.ttl > 0 && cached && Date.now() - builtAt < args.ttl * 1000;
    if (fresh) return cached!;
    if (!inflight) {
      inflight = build(args)
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
    if (pathname === "/pollinations.json") {
      const { overlay } = await current();
      return Response.json(overlay, { headers });
    }
    if (pathname === "/" || pathname === "/health") {
      return Response.json({
        service: "bifrost-data",
        endpoints: ["/datasheet.json", "/pollinations.json"],
        sources: [BIFROST_DATASHEET_URL, POLLINATIONS_MODELS_URL, POLLINATIONS_IMAGE_MODELS_URL],
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
  const key = args.key ?? Deno.env.get("POLLI_API_KEY") ?? undefined;

  if (args.serve) {
    await serve({ ...args, key });
  } else {
    const result = await build({ ...args, key });

    if (args.resolve) {
      const target = result.merged[args.resolve] ?? result.overlay.models[args.resolve];
      if (!target) {
        console.error(`no such model: ${args.resolve}`);
        Deno.exit(1);
      }
      console.log(JSON.stringify({ [args.resolve]: target }, null, 2));
      const parents = baseOf(result.merged, args.resolve);
      const parentKeys = Object.keys(parents);
      if (parentKeys.length) {
        console.error(`extends ${target.base_model} via: ${parentKeys.join(", ")}`);
      }
    } else if (args.stdout) {
      console.log(JSON.stringify(result.overlay, null, 2));
    } else {
      const overlayPath = args.out ?? "dist/pollinations.json";
      const mergedPath = args.mergedOut ?? "dist/datasheet.json";
      for (const path of [overlayPath, mergedPath]) {
        await Deno.mkdir(path.replace(/\/[^/]+$/, "") || ".", { recursive: true });
      }
      await Deno.writeTextFile(overlayPath, JSON.stringify(result.overlay) + "\n");
      await Deno.writeTextFile(mergedPath, JSON.stringify(result.merged) + "\n");
      if (!args.quiet) {
        console.error(
          `wrote ${overlayPath} (${(JSON.stringify(result.overlay).length / 1024).toFixed(1)} KiB)`,
        );
        console.error(
          `wrote ${mergedPath} (${(JSON.stringify(result.merged).length / 1024 / 1024).toFixed(1)} MiB, ` +
            `${result.meta.mergedEntries} entries)`,
        );
      }
    }

    if (!args.quiet) {
      const s = result.overlay.stats;
      console.error(
        `pollinations ${s.pollinations_entries} models · emitted ${s.emitted} · ` +
          `matched cores ${s.matched_cores} · unmatched ${s.unmatched_cores} · ` +
          `with prices ${s.with_prices} · ` +
          `joined ${s.joined_by.name}/${s.joined_by.basename}/${s.joined_by.alias} ` +
          `(name/basename/alias) · ${result.meta.ms} ms`,
      );
    }
  }
}
