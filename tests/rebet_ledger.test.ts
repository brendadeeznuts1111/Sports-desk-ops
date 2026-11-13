import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RebetOpportunity } from "../lib/rebet_engine.ts";
import {
  appendRebetOpportunities,
  decideRebetOpportunity,
  REBET_LEDGER_RELATIVE,
  readRebetLedger,
  rebetDedupeKey,
  resolveRebetLedgerPath,
} from "../lib/rebet_ledger.ts";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "rebet-ledger-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let counter = 0;
/** A fresh ledger root per test; the shared mkdtemp parent is removed once. */
function freshRoot(): string {
  counter += 1;
  return join(root, `case-${counter}`);
}

function opportunity(
  overrides: Partial<RebetOpportunity> = {},
): RebetOpportunity {
  return {
    id: "b1|kalshi|taker",
    betKey: "b1",
    eventLabel: "Event One",
    league: "NFL",
    marketType: "moneyline",
    line: null,
    side: "home",
    venue: "kalshi",
    style: "taker",
    fairProb: 0.55,
    venuePrice: 0.5,
    limitPrice: null,
    edgeBps: 500,
    stakeUsd: 10,
    contracts: 20,
    marketTicker: "KX-NFL-1",
    polyMarketId: null,
    outcomeName: "Home",
    reasons: ["edge"],
    ...overrides,
  };
}

function writeRows(ledgerRoot: string, rows: unknown[]): void {
  const path = resolveRebetLedgerPath(ledgerRoot);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

describe("path and key helpers", () => {
  test("resolves the ledger under the given root", () => {
    expect(resolveRebetLedgerPath("/tmp/x")).toBe(
      join("/tmp/x", REBET_LEDGER_RELATIVE),
    );
    expect(REBET_LEDGER_RELATIVE).toBe("Scratch/rebet/ledger.jsonl");
  });

  test("builds the dedupe key from bet, venue and style", () => {
    expect(
      rebetDedupeKey({ betKey: "b1", venue: "kalshi", style: "maker" }),
    ).toBe("b1|kalshi|maker");
  });
});

describe("readRebetLedger", () => {
  test("returns an empty ledger when the file is missing", async () => {
    const ledger = await readRebetLedger(freshRoot());
    expect(ledger.rows).toEqual([]);
    expect(ledger.dedupeKeys.size).toBe(0);
    expect(ledger.opportunities.size).toBe(0);
  });

  test("skips malformed lines and rows the schema does not accept", async () => {
    const ledgerRoot = freshRoot();
    const path = resolveRebetLedgerPath(ledgerRoot);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      [
        "not json",
        JSON.stringify({
          schemaVersion: 2,
          kind: "opportunity",
          dedupeKey: "k",
        }),
        JSON.stringify({ schemaVersion: 1, kind: "opportunity" }),
        JSON.stringify({
          schemaVersion: 1,
          kind: "decision",
          dedupeKey: "k",
          opportunityId: "b1|kalshi|taker",
          action: "maybe",
        }),
        // `typeof null === "object"` used to crash the fold; now it is skipped like any bad row.
        JSON.stringify({
          schemaVersion: 1,
          kind: "opportunity",
          atIso: "x",
          dedupeKey: "k",
          status: "pending",
          opportunity: null,
        }),
        JSON.stringify({
          schemaVersion: 1,
          kind: "opportunity",
          atIso: "x",
          dedupeKey: "k",
          status: "pending",
          opportunity: opportunity(),
        }),
      ].join("\n"),
      "utf8",
    );
    const ledger = await readRebetLedger(ledgerRoot);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.opportunities.size).toBe(1);
    expect(ledger.opportunities.get("b1|kalshi|taker")?.status).toBe("pending");
  });

  test("folds decisions onto the opportunity they name", async () => {
    const ledgerRoot = freshRoot();
    writeRows(ledgerRoot, [
      {
        schemaVersion: 1,
        kind: "opportunity",
        atIso: "t0",
        dedupeKey: "b1|kalshi|taker",
        status: "pending",
        opportunity: opportunity(),
      },
      {
        schemaVersion: 1,
        kind: "decision",
        atIso: "t1",
        dedupeKey: "b1|kalshi|taker|decision",
        status: "approved",
        opportunityId: "b1|kalshi|taker",
        action: "approve",
        actor: "operator",
      },
      {
        schemaVersion: 1,
        kind: "decision",
        atIso: "t2",
        dedupeKey: "other|decision",
        status: "rejected",
        opportunityId: "unknown-id",
        action: "reject",
        actor: "operator",
        reason: "no",
      },
    ]);
    const ledger = await readRebetLedger(ledgerRoot);
    expect(ledger.dedupeKeys.size).toBe(3);
    const state = ledger.opportunities.get("b1|kalshi|taker");
    expect(state?.status).toBe("approved");
    expect(state?.decidedBy).toBe("operator");
    // A decision with no matching opportunity row contributes no state.
    expect(ledger.opportunities.size).toBe(1);
  });

  test("keeps the rejection reason on the resolved state", async () => {
    const ledgerRoot = freshRoot();
    writeRows(ledgerRoot, [
      {
        schemaVersion: 1,
        kind: "opportunity",
        atIso: "t0",
        dedupeKey: "b1|kalshi|taker",
        status: "pending",
        opportunity: opportunity(),
      },
      {
        schemaVersion: 1,
        kind: "decision",
        atIso: "t1",
        dedupeKey: "d",
        status: "rejected",
        opportunityId: "b1|kalshi|taker",
        action: "reject",
        actor: "operator",
        reason: "stale",
      },
    ]);
    const state = (await readRebetLedger(ledgerRoot)).opportunities.get(
      "b1|kalshi|taker",
    );
    expect(state?.status).toBe("rejected");
    expect(state?.reason).toBe("stale");
  });
});

describe("appendRebetOpportunities", () => {
  test("writes pending rows, creates the directory and reports the counts", async () => {
    const ledgerRoot = freshRoot();
    const first = opportunity();
    const second = opportunity({
      id: "b2|polymarket|maker",
      betKey: "b2",
      venue: "polymarket",
      style: "maker",
    });
    const result = await appendRebetOpportunities(ledgerRoot, [first, second], {
      now: new Date("2026-11-11T00:00:00.000Z"),
    });
    expect(result).toEqual({ written: 2, skipped: 0 });

    const ledger = await readRebetLedger(ledgerRoot);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]!.atIso).toBe("2026-11-11T00:00:00.000Z");
    expect(ledger.rows.every((row) => row.status === "pending")).toBe(true);
  });

  test("is idempotent for the same bet, venue and style", async () => {
    const ledgerRoot = freshRoot();
    await appendRebetOpportunities(ledgerRoot, [opportunity()]);
    const again = await appendRebetOpportunities(ledgerRoot, [opportunity()]);
    expect(again).toEqual({ written: 0, skipped: 1 });
    expect((await readRebetLedger(ledgerRoot)).rows).toHaveLength(1);
  });

  test("skips duplicates inside one batch", async () => {
    const ledgerRoot = freshRoot();
    const result = await appendRebetOpportunities(ledgerRoot, [
      opportunity(),
      opportunity(),
    ]);
    expect(result).toEqual({ written: 1, skipped: 1 });
  });

  test("does not create the ledger for an empty batch", async () => {
    const ledgerRoot = freshRoot();
    expect(await appendRebetOpportunities(ledgerRoot, [])).toEqual({
      written: 0,
      skipped: 0,
    });
    expect(existsSync(resolveRebetLedgerPath(ledgerRoot))).toBe(false);
  });
});

describe("decideRebetOpportunity", () => {
  async function seeded(): Promise<string> {
    const ledgerRoot = freshRoot();
    await appendRebetOpportunities(ledgerRoot, [opportunity()]);
    return ledgerRoot;
  }

  test("requires an actor, an opportunity id and a reason for rejection", async () => {
    const ledgerRoot = await seeded();
    await expect(
      decideRebetOpportunity(ledgerRoot, {
        opportunityId: " b1|kalshi|taker ",
        action: "approve",
        actor: "  ",
      }),
    ).rejects.toThrow("actor is required");
    await expect(
      decideRebetOpportunity(ledgerRoot, {
        opportunityId: " ",
        action: "approve",
        actor: "op",
      }),
    ).rejects.toThrow("opportunityId is required");
    await expect(
      decideRebetOpportunity(ledgerRoot, {
        opportunityId: "b1|kalshi|taker",
        action: "reject",
        actor: "op",
        reason: "  ",
      }),
    ).rejects.toThrow("a rejection requires a reason");
  });

  test("refuses an unknown opportunity and a second decision", async () => {
    const ledgerRoot = await seeded();
    await expect(
      decideRebetOpportunity(ledgerRoot, {
        opportunityId: "nope",
        action: "approve",
        actor: "op",
      }),
    ).rejects.toThrow("unknown opportunity: nope");

    await decideRebetOpportunity(ledgerRoot, {
      opportunityId: "b1|kalshi|taker",
      action: "approve",
      actor: "op",
    });
    await expect(
      decideRebetOpportunity(ledgerRoot, {
        opportunityId: "b1|kalshi|taker",
        action: "reject",
        actor: "op",
        reason: "again",
      }),
    ).rejects.toThrow("opportunity already approved: b1|kalshi|taker");
  });

  test("an approval appends the decision and a simulated fill", async () => {
    const ledgerRoot = await seeded();
    const result = await decideRebetOpportunity(ledgerRoot, {
      opportunityId: "b1|kalshi|taker",
      action: "approve",
      actor: " operator ",
      atIso: "2026-11-11T01:00:00.000Z",
    });
    expect(result.decision).toMatchObject({
      kind: "decision",
      status: "approved",
      action: "approve",
      actor: "operator",
      dedupeKey: "b1|kalshi|taker|decision",
      atIso: "2026-11-11T01:00:00.000Z",
      reason: null,
    });
    expect(result.fill).toMatchObject({
      kind: "paper_fill",
      status: "simulated",
      dedupeKey: "b1|kalshi|taker|fill",
    });
    expect(result.fill?.opportunity).toEqual(opportunity());

    const ledger = await readRebetLedger(ledgerRoot);
    expect(ledger.rows).toHaveLength(3);
    expect(ledger.rows.filter((row) => row.kind === "paper_fill")).toHaveLength(
      1,
    );
    expect(ledger.opportunities.get("b1|kalshi|taker")?.status).toBe(
      "approved",
    );
  });

  test("a rejection appends the decision only, with the reason trimmed", async () => {
    const ledgerRoot = await seeded();
    const result = await decideRebetOpportunity(ledgerRoot, {
      opportunityId: "b1|kalshi|taker",
      action: "reject",
      actor: "op",
      reason: "  stale price  ",
    });
    expect(result.fill).toBeNull();
    expect(result.decision.reason).toBe("stale price");
    const ledger = await readRebetLedger(ledgerRoot);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.opportunities.get("b1|kalshi|taker")?.status).toBe(
      "rejected",
    );
  });
});
