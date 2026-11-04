import { describe, expect, test } from "bun:test";

import { publishGsliveTallyRollup } from "../lib/gslive_tally_sink.ts";
import type { GsliveTallyRollup } from "../lib/gslive_tally_rollup.ts";
import type { R2S3Client } from "../lib/r2_s3_client.ts";

function rollup(): GsliveTallyRollup {
  return {
    schemaVersion: 1,
    kind: "gslive-tally",
    deskDate: "2026-11-03",
    generatedAt: "2026-11-03T18:29:43.028Z",
    window: { fromEpochSec: 1793163600, toEpochSec: 1793771999 },
    rowCount: 10,
    malformedRowCount: 0,
    distinctTicketCount: 10,
    distinctBetGroupCount: 10,
    totals: {
      ticketCount: 10,
      legCount: 10,
      riskCents: 100000,
      settledNetCents: -100000,
      clvSumLineHundredths: 0,
      clvEligibleLegCount: 0,
      holdBps: 0,
      roiBps: -10000,
      roundingResidualCents: 0,
      freePlayTickets: 0,
      openExposureCents: 0,
    },
    suppressed: {
      cellCount: 0,
      ticketCount: 0,
      legCount: 0,
      riskCents: 0,
      settledNetCents: 0,
      clvSumLineHundredths: 0,
      clvEligibleLegCount: 0,
    },
    cells: [
      {
        channel: "GSLIVE",
        sport: "8",
        period: "m",
        settlementState: "lose",
        ticketCount: 10,
        legCount: 10,
        riskCents: 100000,
        settledNetCents: -100000,
        clvSumLineHundredths: 0,
        clvEligibleLegCount: 0,
      },
    ],
    clv: {
      clvSumLineHundredths: 0,
      clvEligibleLegCount: 0,
      value: null,
      sentinel: "-2147483648",
    },
    gates: [
      {
        gate: 8,
        name: "TemporalCutoffAndCrossSystemReconciliation",
        status: "skipped",
      },
    ],
    sourceSha256: "a".repeat(64),
  };
}

function fakeClient(options: { shortStat?: boolean } = {}) {
  const writes: Array<{
    key: string;
    bytes: number;
    metadata: Record<string, string>;
    body: string;
  }> = [];
  const client = {
    publicBase: "https://pub.test",
    async writeWithMetadata(
      key: string,
      data: Uint8Array | string,
      opts?: { metadata?: Record<string, string> },
    ) {
      writes.push({
        key,
        bytes: typeof data === "string" ? data.length : data.byteLength,
        metadata: opts?.metadata ?? {},
        body: typeof data === "string" ? data : new TextDecoder().decode(data),
      });
      return 1;
    },
    async stat() {
      return {
        size: options.shortStat === true ? 1 : (writes[0]?.bytes ?? 0),
        lastModified: new Date(0),
        etag: "e",
        type: "application/json",
      };
    },
  };
  return { client: client as unknown as R2S3Client, writes };
}

describe("gslive tally sink", () => {
  test("writes the daily rollup, verifies it, then advances the pointer", async () => {
    const { client, writes } = fakeClient();
    const result = await publishGsliveTallyRollup(rollup(), {
      r2Client: client,
    });
    expect(result.dailyKey).toBe("gslive-tally/2026-11-03/rollup.json");
    expect(result.pointerKey).toBe("gslive-tally/latest.json");
    expect(writes.map((w) => w.key)).toEqual([
      "gslive-tally/2026-11-03/rollup.json",
      "gslive-tally/latest.json",
    ]);
    expect(writes[0]?.metadata.pii).toBe("none");
    expect(writes[0]?.metadata.sha256).toBe("a".repeat(64));
    const pointer = JSON.parse(writes[1]?.body ?? "{}") as {
      key?: string;
      sha256?: string;
    };
    expect(pointer.key).toBe("gslive-tally/2026-11-03/rollup.json");
    expect(pointer.sha256).toBe("a".repeat(64));
  });

  test("a short daily write never advances the pointer", async () => {
    const { client, writes } = fakeClient({ shortStat: true });
    await expect(
      publishGsliveTallyRollup(rollup(), { r2Client: client }),
    ).rejects.toThrow(/size mismatch/);
    expect(writes).toHaveLength(1);
  });
});
