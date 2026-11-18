/**
 * @file lib/live_feed_source.ts
 * @description Read the live-positions artifacts from the public R2 gateway.
 *
 * The 10-minute cron publishes `data/live-wagers.json` and `data/live-bets.json` to
 * `live-wagers/latest.json` and `live-bets/latest.json` in the public bucket. This reader fetches
 * one object and reports the URL, the payload's own `observedAt`, the fetch time and the byte
 * count, so a caller can record where a position came from and how stale it is. It never falls
 * back silently; the caller decides what to do with an error.
 */

import { R2_PUBLIC_BASE } from "./r2_staleness.ts";

export interface LiveFeedObject {
  readonly key: string;
  readonly url: string;
  readonly doc: unknown;
  /** The payload's own observation time (`observedAt`, else `capturedAt`), or null. */
  readonly observedAtIso: string | null;
  readonly fetchedAtIso: string;
  readonly bytes: number;
}

export type LiveFeedFetcher = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface LiveFeedFetchOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: LiveFeedFetcher;
  readonly timeoutMs?: number;
}

function observedAtOf(doc: unknown): string | null {
  if (doc === null || typeof doc !== "object") return null;
  const record = doc as Record<string, unknown>;
  const value = record.observedAt ?? record.capturedAt;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** Fetch one published live artifact. Throws on transport, HTTP or JSON failure. */
export async function fetchLiveFeedObject(
  key: string,
  options: LiveFeedFetchOptions = {},
): Promise<LiveFeedObject> {
  const base = (options.baseUrl ?? R2_PUBLIC_BASE).replace(/\/$/, "");
  const url = `${base}/${key.replace(/^\//, "")}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 5_000,
  );
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`live feed ${key} returned HTTP ${response.status}`);
    }
    const text = await response.text();
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Error(`live feed ${key} did not return JSON`);
    }
    return {
      key,
      url,
      doc,
      observedAtIso: observedAtOf(doc),
      fetchedAtIso: new Date().toISOString(),
      bytes: text.length,
    };
  } finally {
    clearTimeout(timer);
  }
}
