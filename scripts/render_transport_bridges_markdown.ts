#!/usr/bin/env bun
/**
 * Render the canonical 10-bridge transport specification Markdown table
 * directly from TRANSPORT_BRIDGE_SPECIFICATION_TABLE so docs never drift
 * between legacy Bridge 1..N prose and Bridge 00..09 IDs.
 */

import {
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  type TransportBridgeSpecification,
} from "../lib/bridge_and_channel_router.ts";

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

function formatOrdinalTag(ordinal4: number): string {
  return String(ordinal4).padStart(2, "0");
}

/** Render the sorted Bridge 00-09 Markdown specification table. */
export function renderTransportBridgesMarkdownTable(
  table: Readonly<
    Record<string, TransportBridgeSpecification>
  > = TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
): string {
  const rows = Object.values(table).sort(
    (left, right) => left.bridgeOrdinal4 - right.bridgeOrdinal4,
  );

  const lines: string[] = [
    "| Bridge ID | Ordinal | Origin Domain | WebSocket Topic | R2 Latest Key | Upstream Wire Endpoint | Dedup Watermark | Freshness SLA (ms) |",
    "| :--- | :--- | :--- | :--- | :--- | :--- | :--- | ---: |",
  ];

  for (const spec of rows) {
    lines.push(
      [
        `\`${escapeMarkdownCell(spec.bridgeId)}\``,
        `\`${formatOrdinalTag(spec.bridgeOrdinal4)}\``,
        `\`${escapeMarkdownCell(spec.originDomain)}\``,
        `\`${escapeMarkdownCell(spec.webSocketSubscriptionTopic)}\``,
        `\`${escapeMarkdownCell(spec.r2LatestObjectKey)}\``,
        `\`${escapeMarkdownCell(spec.upstreamWireEndpoint)}\``,
        `\`${escapeMarkdownCell(spec.deduplicationWatermarkContract)}\``,
        String(spec.freshnessSlaDurationMs),
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .concat(" |"),
    );
  }

  return lines.join("\n");
}

if (import.meta.main) {
  console.log(renderTransportBridgesMarkdownTable());
}
