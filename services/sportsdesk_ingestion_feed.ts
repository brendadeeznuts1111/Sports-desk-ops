/**
 * Pull append-only ingestion JSONL from the authoritative feed source (HTTP/S).
 * SSOT object key aligns with `SPORTSDESK_INGESTION_LOG_DEFAULT`.
 */

import { resolve } from "node:path";
import {
  type SignalChannelCode,
  INGESTION_CHANNELS,
} from "../design/domain-branded-types.ts";
import { getR2Config } from "./sportsdesk_r2_sync.ts";

const INGESTION_AUDIT_OBJECT_KEY =
  Bun.env.SPORTSDESK_INGESTION_R2_KEY?.trim() || "ingestion-audit.jsonl";

export type IngestionFeedSource = {
  url: string;
  label: string;
};

/** Resolve feed URL: explicit > env > R2 public gateway default. */
export function resolveIngestionFeedSource(options?: {
  url?: string;
  channelCode?: SignalChannelCode;
}): IngestionFeedSource | null {
  if (options?.url?.trim()) {
    return { url: options.url.trim(), label: "explicit --pull-raw URL" };
  }

  if (options?.channelCode) {
    const envKey = `SPORTSDESK_FEED_URL_${options.channelCode}` as const;
    const laneUrl = Bun.env[envKey];
    if (laneUrl?.trim()) {
      return {
        url: laneUrl.trim(),
        label: `${options.channelCode} (${envKey})`,
      };
    }
    const ch = INGESTION_CHANNELS.find(
      (c) => c.channelCode === options.channelCode,
    );
    if (ch) {
      const portalEnv = Bun.env.SPORTSDESK_PORTAL_HTTP_BASE?.replace(/\/$/, "");
      if (portalEnv && ch.transportUri.startsWith("portal://")) {
        const path = ch.transportUri.replace(/^portal:\/\//, "");
        return {
          url: `${portalEnv}/${path}`,
          label: `${options.channelCode} portal (${ch.transportUri})`,
        };
      }
    }
  }

  const direct =
    Bun.env.SPORTSDESK_INGESTION_FEED_URL?.trim() ||
    Bun.env.SPORTSDESK_INGESTION_AUDIT_URL?.trim();
  if (direct) {
    return { url: direct, label: "SPORTSDESK_INGESTION_FEED_URL" };
  }

  const r2 = getR2Config();
  if (r2.publicUrl) {
    const base = r2.publicUrl.replace(/\/$/, "");
    return {
      url: `${base}/${INGESTION_AUDIT_OBJECT_KEY}`,
      label: `R2 public (${INGESTION_AUDIT_OBJECT_KEY})`,
    };
  }

  return null;
}

export async function pullRawIngestionFeed(
  source: IngestionFeedSource,
  options?: { timeoutMs?: number },
): Promise<{
  bytes: Uint8Array;
  contentType: string | null;
  status: number;
}> {
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const res = await fetch(source.url, {
    proxy: false,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(
      `Ingestion feed pull failed (${source.label}): ${res.status} ${res.statusText} — ${source.url}`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return {
    bytes: buf,
    contentType: res.headers.get("content-type"),
    status: res.status,
  };
}

export async function pullRawIngestionFeedToFile(
  outPath: string,
  sourceOptions?: { url?: string; channelCode?: SignalChannelCode },
): Promise<{ path: string; byteLength: number; source: IngestionFeedSource }> {
  const source = resolveIngestionFeedSource(sourceOptions);
  if (!source) {
    throw new Error(
      "No ingestion feed URL: pass --pull-raw <url>, set SPORTSDESK_INGESTION_FEED_URL, or configure R2_PUBLIC_URL",
    );
  }
  const { bytes } = await pullRawIngestionFeed(source);
  const path = resolve(outPath);
  await Bun.write(path, bytes);
  return { path, byteLength: bytes.byteLength, source };
}
