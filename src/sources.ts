/**
 * Source fetching. Providers own their own URLs and auth headers; this module
 * only knows how to pull JSON and report what it got.
 */

export const BIFROST_DATASHEET_URL = "https://getbifrost.ai/datasheet";

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
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Fetched<T>> {
  const started = performance.now();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const res = await fetch(url, {
    signal,
    headers: { accept: "application/json", ...(opts.headers ?? {}) },
  });
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

  const entries = Array.isArray(data)
    ? data.length
    : Array.isArray((data as { data?: unknown[] })?.data)
    ? ((data as { data: unknown[] }).data).length
    : typeof data === "object" && data !== null
    ? Object.keys(data as Record<string, unknown>).length
    : 0;

  return {
    data,
    meta: { url, status: res.status, bytes: body.length, entries, ms: Math.round(performance.now() - started) },
  };
}
