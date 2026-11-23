/**
 * Source fetching. Every source is public; the Pollinations key is accepted but
 * does not change the listing payload (verified: identical bytes with/without),
 * so it is optional and never required to build the datasheet.
 */

export const BIFROST_DATASHEET_URL = "https://getbifrost.ai/datasheet";
export const POLLINATIONS_MODELS_URL = "https://gen.pollinations.ai/models";
export const POLLINATIONS_IMAGE_MODELS_URL = "https://gen.pollinations.ai/image/models";

export interface SourceMeta {
  url: string;
  status: number;
  bytes: number;
  entries: number;
  ms: number;
}

export interface Fetched<T> {
  data: T;
  meta: SourceMeta;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function fetchJson<T>(
  url: string,
  opts: { key?: string; timeoutMs?: number } = {},
): Promise<Fetched<T>> {
  const target = new URL(url);
  if (opts.key) target.searchParams.set("key", opts.key);

  const started = performance.now();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(target, { signal, headers: { accept: "application/json" } });
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`${url} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  let data: T;
  try {
    data = JSON.parse(body) as T;
  } catch (err) {
    // A parse failure on a big payload is almost always truncation, not schema.
    throw new Error(
      `${url}: JSON parse failed at ${body.length} chars (${(err as Error).message}) — ` +
        `tail: ${body.slice(-120).replace(/\s+/g, " ")}`,
    );
  }

  const meta: SourceMeta = {
    url,
    status: res.status,
    bytes: body.length,
    entries: Array.isArray(data)
      ? data.length
      : typeof data === "object" && data !== null
      ? Object.keys(data as Record<string, unknown>).length
      : 0,
    ms: Math.round(performance.now() - started),
  };
  return { data, meta };
}
