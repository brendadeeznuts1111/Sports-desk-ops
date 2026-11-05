/**
 * Feed pull provenance: HTTP metadata, content digest, JSONL drain audit, local divergence.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  probeHistoricalJsonlBytes,
  type HistoricalLogReplayResult,
} from "../lib/jsonl_stream_replay.ts";
import {
  pullRawIngestionFeed,
  resolveIngestionFeedSource,
  type IngestionFeedSource,
} from "./sportsdesk_ingestion_feed.ts";
import type {
  Sha256Hex,
  SignalChannelCode,
} from "../design/domain-branded-types.ts";
import { sha256Bytes } from "../lib/schema_binary.ts";

export type IngestionFeedHttpMeta = {
  status: number;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  contentLength: number | null;
};

export type IngestionFeedPullProvenance = {
  source: IngestionFeedSource;
  pulledAt: string;
  byteLength: number;
  sha256Hex: Sha256Hex;
  http: IngestionFeedHttpMeta;
  jsonl: HistoricalLogReplayResult;
  priorSha256Hex: Sha256Hex | null;
  divergedFromPrior: boolean;
  sidecarPath: string;
};

export function sha256HexOfBytes(bytes: Uint8Array): Sha256Hex {
  return sha256Bytes(bytes);
}

export async function sha256HexOfFile(path: string): Promise<Sha256Hex | null> {
  if (!existsSync(path)) return null;
  const bytes = await Bun.file(path).bytes();
  return sha256HexOfBytes(bytes);
}

export function ingestionFeedSidecarPath(jsonlPath: string): string {
  return `${resolve(jsonlPath)}.provenance.json`;
}

export async function fetchIngestionFeedHttpMeta(
  source: IngestionFeedSource,
  timeoutMs = 30_000,
): Promise<IngestionFeedHttpMeta | null> {
  if (!source.url.startsWith("http://") && !source.url.startsWith("https://")) {
    return null;
  }
  try {
    const res = await fetch(source.url, {
      method: "HEAD",
      proxy: false,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const len = res.headers.get("content-length");
    return {
      status: res.status,
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentType: res.headers.get("content-type"),
      contentLength: len ? Number(len) : null,
    };
  } catch {
    return null;
  }
}

export type PullIngestionFeedWithProvenanceOptions = {
  url?: string;
  channelCode?: SignalChannelCode;
  timeoutMs?: number;
};

export async function pullIngestionFeedWithProvenance(
  outPath: string,
  options?: PullIngestionFeedWithProvenanceOptions,
): Promise<{
  path: string;
  provenance: IngestionFeedPullProvenance;
}> {
  const source = resolveIngestionFeedSource(options);
  if (!source) {
    throw new Error(
      "No ingestion feed URL: pass --pull-raw <url>, set SPORTSDESK_INGESTION_FEED_URL, or configure R2_PUBLIC_URL",
    );
  }

  const path = resolve(outPath);
  const priorSha256Hex = await sha256HexOfFile(path);
  const headMeta = await fetchIngestionFeedHttpMeta(source, options?.timeoutMs);

  const pullOpts =
    options?.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : undefined;
  const { bytes, contentType, status } = await pullRawIngestionFeed(
    source,
    pullOpts,
  );
  const sha256Hex = sha256HexOfBytes(bytes);
  const jsonl = await probeHistoricalJsonlBytes(bytes);

  await Bun.write(path, bytes);

  const sidecarPath = ingestionFeedSidecarPath(path);
  const provenance: IngestionFeedPullProvenance = {
    source,
    pulledAt: new Date().toISOString(),
    byteLength: bytes.byteLength,
    sha256Hex,
    http: {
      status,
      etag: headMeta?.etag ?? null,
      lastModified: headMeta?.lastModified ?? null,
      contentType: contentType ?? headMeta?.contentType ?? null,
      contentLength: headMeta?.contentLength ?? null,
    },
    jsonl,
    priorSha256Hex,
    divergedFromPrior: priorSha256Hex !== null && priorSha256Hex !== sha256Hex,
    sidecarPath,
  };

  await Bun.write(sidecarPath, `${JSON.stringify(provenance, null, 2)}\n`);

  return { path, provenance };
}

/** Pull integrity: incomplete JSONL or poison lines → non-zero (use before trusting replay). */
export function ingestionFeedPullExitCode(
  provenance: Pick<IngestionFeedPullProvenance, "jsonl" | "divergedFromPrior">,
  options?: { failOnDivergence?: boolean },
): number {
  if (provenance.jsonl.corruptedLineSkips > 0) return 1;
  if (provenance.jsonl.trailingPartialBytes > 0) return 1;
  if (options?.failOnDivergence && provenance.divergedFromPrior) return 1;
  return 0;
}
