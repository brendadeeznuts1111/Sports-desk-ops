import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildGsliveTallyRollup,
  computeSettledRoiBasisPoints,
  NULL_CLV_SENTINEL_BIGINT,
  parseCentsStrict,
  parseLineHundredths,
  roundDivHalfEven,
  streamBetReportBets,
} from "../lib/gslive_tally_rollup.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function bet(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    betGroupId: "100",
    ticketNumber: "900001",
    type: "0",
    state: "2",
    displaySportId: "8",
    period: "m",
    bet: "100",
    result: "-100",
    betGroupResult: "-100.000",
    betDetails: JSON.stringify({ f: "2.86" }),
    isFreePlay: null,
    ...partial,
  };
}

async function report(
  bets: readonly Record<string, unknown>[],
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gslive-tally-"));
  dirs.push(dir);
  const path = join(dir, "betReport-all.json");
  await writeFile(
    path,
    JSON.stringify({
      r: { bets },
      e: 0,
      d: "",
      from: 1793163600,
      to: 1793771999,
    }),
  );
  return path;
}

describe("fixed point", () => {
  test("parseCentsStrict matches the four-harness oracle and rejects overflow", () => {
    expect(parseCentsStrict("-12,037.64")).toBe(-1_203_764n);
    expect(parseCentsStrict("+$4,719.695")).toBe(471_970n);
    expect(parseCentsStrict("100")).toBe(10_000n);
    expect(() => parseCentsStrict("99999999999999999999.99")).toThrow();
  });

  test("banker's rounding is half-to-even and the residual is exact", () => {
    expect(roundDivHalfEven(312_5n, 10n)).toBe(312n);
    expect(roundDivHalfEven(937_5n, 10n)).toBe(938n);
    const exact = computeSettledRoiBasisPoints(10_000n, 10_000n);
    expect(exact.roiBps).toBe(10_000n);
    expect(exact.roundingResidualCents).toBe(0n);
    const half = computeSettledRoiBasisPoints(3n, 32n);
    expect(half.roiBps).toBe(938n);
    expect(half.roiBps! * 32n + half.roundingResidualCents).toBe(30_000n);
    expect(computeSettledRoiBasisPoints(1n, 0n)).toEqual({
      roiBps: null,
      roundingResidualCents: 0n,
    });
  });

  test("line hundredths and the missing-close sentinel", () => {
    expect(parseLineHundredths("2.86")).toBe(286n);
    expect(parseLineHundredths(undefined)).toBeNull();
    expect(NULL_CLV_SENTINEL_BIGINT).toBe(-2_147_483_648n);
  });
});

describe("streaming rollup", () => {
  test("streams across tiny chunk boundaries", async () => {
    const path = await report([
      bet({ betGroupId: "1" }),
      bet({ betGroupId: "2" }),
    ]);
    const seen: unknown[] = [];
    for await (const row of streamBetReportBets(path, { chunkBytes: 7 }))
      seen.push(row);
    expect(seen).toHaveLength(2);
  });

  test("dedupes M.G<betGroupId>, splits channels, keeps counts-only free play", async () => {
    const straight = [1, 2, 3, 4, 5].map((n) =>
      bet({ betGroupId: String(100 + n), ticketNumber: String(900000 + n) }),
    );
    const parlays = Array.from({ length: 5 }, (_, index) => {
      const gid = String(200 + index);
      const ticket = String(900200 + index);
      return [
        bet({
          betGroupId: gid,
          ticketNumber: ticket,
          type: "1",
          bet: "60",
          result: "-60",
          betGroupResult: "-60.000",
          displaySportId: "4",
        }),
        bet({
          betGroupId: gid,
          ticketNumber: ticket,
          type: "1",
          bet: "60",
          result: "43.47",
          betGroupResult: "-60.000",
          displaySportId: "8",
        }),
      ];
    }).flat();
    const freePlay = bet({
      betGroupId: "300",
      ticketNumber: "900300",
      isFreePlay: "1",
      bet: "50",
      displaySportId: "220",
      period: "s12",
    });
    const rollup = await buildGsliveTallyRollup(
      await report([...straight, ...parlays, freePlay]),
    );

    expect(rollup.rowCount).toBe(16);
    expect(rollup.distinctBetGroupCount).toBe(11);
    expect(rollup.totals.freePlayTickets).toBe(1);
    const all = rollup.cells.map((cell) => cell.channel);
    expect(all).toContain("GSLIVE");
    expect(all).toContain("GSBUILDER");
    expect(rollup.totals.ticketCount).toBe(11);
    expect(rollup.totals.legCount).toBe(16);
    // each parlay's risk counted once (6,000 cents); free play adds no money
    expect(rollup.totals.riskCents).toBe(5 * 10_000 + 5 * 6_000);
    expect(
      rollup.suppressed.ticketCount +
        rollup.cells.reduce((n, c) => n + c.ticketCount, 0),
    ).toBe(11);
    const text = JSON.stringify(rollup);
    expect(text).not.toContain("900001");
    expect(text).not.toContain('"betGroupId"');
    expect(rollup.gates.find((g) => g.gate === 8)?.status).toBe("skipped");
    expect(
      rollup.gates.filter((g) => g.gate <= 6).every((g) => g.status === "pass"),
    ).toBe(true);
  });

  test("k=5 suppression leaves a sparse cell out and reconciles totals", async () => {
    const dense = [1, 2, 3, 4, 5].map((n) =>
      bet({
        betGroupId: String(10 + n),
        ticketNumber: String(900010 + n),
        period: "m",
      }),
    );
    const sparse = bet({
      betGroupId: "99",
      ticketNumber: "900099",
      period: "s12",
    });
    const rollup = await buildGsliveTallyRollup(
      await report([...dense, sparse]),
    );
    expect(rollup.cells.length).toBe(1);
    expect(rollup.suppressed.cellCount).toBe(1);
    expect(rollup.suppressed.ticketCount).toBe(1);
    expect(rollup.cells[0]?.ticketCount).toBe(5);
    expect(rollup.totals.ticketCount).toBe(6);
  });

  test("CLV stays null when fc is missing and sums when present", async () => {
    const missing = [1, 2, 3, 4, 5].map((n) =>
      bet({
        betGroupId: String(20 + n),
        ticketNumber: String(900020 + n),
        betDetails: JSON.stringify({ f: "2.86" }),
      }),
    );
    const present = [6, 7, 8, 9, 10].map((n) =>
      bet({
        betGroupId: String(30 + n),
        ticketNumber: String(900030 + n),
        betDetails: JSON.stringify({ f: "2.90", fc: "2.80" }),
      }),
    );
    const rollup = await buildGsliveTallyRollup(
      await report([...missing, ...present]),
    );
    expect(rollup.clv.value).toBeNull();
    expect(rollup.clv.clvEligibleLegCount).toBe(5);
    expect(rollup.clv.clvSumLineHundredths).toBe(50);
  });
});
