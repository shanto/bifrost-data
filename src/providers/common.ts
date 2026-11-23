/** Helpers shared by every provider adapter. */

const MODES: Record<string, string> = {
  text: "chat",
  image: "image_generation",
  video: "video_generation",
  embedding: "embedding",
  realtime: "realtime",
  decision: "decisions",
  "3d": "3d",
};

/** Provider category → Bifrost `mode`. Audio splits on the endpoints it publishes. */
export function modeFromCategory(
  category: string | undefined,
  endpoints: string[] | undefined,
): string | undefined {
  if (category === "audio") {
    return (endpoints ?? []).includes("/v1/audio/transcriptions")
      ? "audio_transcription"
      : "audio_speech";
  }
  return category ? MODES[category] : undefined;
}

/**
 * Scale a rate into the unit Bifrost stores. Providers that quote per million
 * tokens pass 1_000_000; anything already per-unit passes 1.
 */
export function scaleRate(value: unknown, divisor: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Trim binary-float noise: 0.2 / 1e6 must read as 2e-07, not 2.0000000000000002e-07.
  return Number((n / divisor).toPrecision(15));
}
