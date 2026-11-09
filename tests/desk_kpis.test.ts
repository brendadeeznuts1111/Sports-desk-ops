import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  deriveDeskKpis,
  freshness,
  kpiBasisFromSource,
  readCustomerBookSummary,
  recordedTime,
  STALE_AFTER_SECONDS,
  type DeskKpiInputs,
} from "../lib/desk_kpis.ts";
import { buildArtifact, readPendingRows } from "../lib/live_bets.ts";
import { readWagerListArtifact } from "../lib/live_wagers.ts";

const ROOT = resolve(import.meta.dir, "..");
const NOW = new Date("2026-11-02T04:00:00.000Z");
const hoursBefore = (hours: number) =>
  new Date(NOW.getTime() - hours * 3600 * 1000);

const none: DeskKpiInputs = {
  agentTree: null,
  liveBets: null,
  liveWagers: null,
  customerBook: null,
};

describe("deriveDeskKpis", () => {
  test("an absent artifact is a null block, not a zero", () => {
    expect(deriveDeskKpis(none, NOW)).toEqual({
      agents: null,
      pending: null,
      ticker: null,
      customerBook: null,
    });
  });

  test("agent counts come from the tree's node types, aged by file mtime", () => {
    const kpis = deriveDeskKpis(
      {
        ...none,
        agentTree: {
          value: {
            nodes: { A1: { t: "A" }, A2: { t: "A" }, M1: { t: "M" }, X: {} },
          },
          mtime: hoursBefore(2),
        },
      },
      NOW,
    );
    expect(kpis.agents).toMatchObject({
      total: 4,
      agents: 2,
      masters: 1,
      unclassified: 1,
    });
    expect(kpis.agents?.provenance).toMatchObject({
      asOfFrom: "file-mtime",
      ageSeconds: 7200,
      stale: false,
    });
  });

  test("scratch graph source is fixture basis even when the file is old", () => {
    const kpis = deriveDeskKpis(
      {
        ...none,
        agentTree: {
          value: {
            source: "scratch/agent-graph.json",
            nodes: { A1: { t: "A" } },
          },
          mtime: hoursBefore(200),
        },
      },
      NOW,
    );
    expect(kpis.agents?.provenance).toMatchObject({
      source: "scratch/agent-graph.json",
      basis: "fixture",
      stale: false,
    });
  });

  test("live pending dataSource is capture basis, not fixture", () => {
    const kpis = deriveDeskKpis(
      {
        ...none,
        liveBets: {
          value: {
            schemaVersion: 1,
            dataSource:
              "live:/cloud/api/Report/Pending@2026-11-09T03:00:00.000Z",
            capturedAt: NOW.toISOString(),
            operation: "/cloud/api/Report/Pending",
            pendingCount: 0,
            agents: {
              hierarchyLoaded: false,
              collisions: [],
              agents: [],
              unresolved: [],
              unassignedGames: 0,
              maxLevel: null,
            },
            games: [],
          },
          mtime: NOW,
        },
      },
      NOW,
    );
    expect(kpis.pending?.provenance).toMatchObject({
      basis: "capture",
      source: "live:/cloud/api/Report/Pending@2026-11-09T03:00:00.000Z",
    });
    expect(kpiBasisFromSource("live:/cloud/api/Manager/getBetTicker@x")).toBe(
      "capture",
    );
  });

  test("pending totals sum the capture and go stale after an hour", async () => {
    const sample = await Bun.file(
      resolve(ROOT, "tests/f402-pending-wager-sample.json"),
    ).json();
    const rows = readPendingRows(sample);
    const artifact = buildArtifact(rows, {
      operation: "/cloud/api/Report/Pending",
      capturedAt: hoursBefore(25).toISOString(),
    });
    const kpis = deriveDeskKpis(
      { ...none, liveBets: { value: artifact, mtime: hoursBefore(1) } },
      NOW,
    );
    const pending = kpis.pending;
    expect(pending?.wagers).toBe(artifact.pendingCount);
    expect(pending?.wageredCents).toBe(
      artifact.games.reduce((sum, g) => sum + g.wagered, 0),
    );
    // The capture's own timestamp wins over the file's mtime.
    expect(pending?.provenance.asOfFrom).toBe("artifact");
    expect(pending?.provenance.ageSeconds).toBe(25 * 3600);
    expect(pending?.provenance.ageSeconds).toBeGreaterThan(
      STALE_AFTER_SECONDS.liveBets,
    );
    expect(pending?.provenance.stale).toBe(true);
  });

  test("a pasted, partial ticker says so", () => {
    const artifact = readWagerListArtifact({
      schemaVersion: 1,
      source: "paste:clipboard-ticker",
      partial: true,
      LIST: [
        {
          WagerNumber: 1,
          WagerType: "S",
          AmountWagered: 1000,
          ToWinAmount: 900,
          VolumeAmount: 1000,
          ShortDesc: "S\r\nFootball - A vs B / Game / Spread / A -3 -110",
        },
      ],
    });
    const kpis = deriveDeskKpis(
      { ...none, liveWagers: { value: artifact, mtime: hoursBefore(0.5) } },
      NOW,
    );
    expect(kpis.ticker).toMatchObject({
      wagers: 1,
      excludedRows: 0,
      riskCents: 1000,
      volumeCents: 1000,
    });
    expect(kpis.ticker?.provenance).toMatchObject({
      basis: "paste",
      partial: true,
      stale: false,
    });
  });

  test("ticker wagers and stake leave out alert mirrors and blocked sentinels", () => {
    const row = {
      WagerType: "S",
      AmountWagered: 1000,
      ToWinAmount: 900,
      ShortDesc: "S\r\nFootball - A vs B / Game / Spread / A -3 -110",
    };
    const artifact = readWagerListArtifact({
      source: `capture:/cloud/api/Manager/getBetTicker@${NOW.toISOString()}`,
      observedAt: NOW.toISOString(),
      partial: false,
      LIST: [
        {
          ...row,
          WagerNumber: 1,
          TicketWriter: "Internet",
          VolumeAmount: 1000,
        },
        { ...row, WagerNumber: 2, TicketWriter: "ALERT", VolumeAmount: 0 },
        { ...row, WagerNumber: 3, TicketWriter: "BLOCKED", VolumeAmount: 0 },
      ],
    });
    const kpis = deriveDeskKpis(
      { ...none, liveWagers: { value: artifact, mtime: NOW } },
      NOW,
    );
    expect(kpis.ticker).toMatchObject({
      wagers: 1,
      excludedRows: 2,
      riskCents: 1000,
      volumeCents: 1000,
    });
  });

  test("the customer book is a fixture, in cents, and never stale", () => {
    const summary = readCustomerBookSummary({
      generatedAt: hoursBefore(500).toISOString(),
      source: { book: "./enriched_customers_full.json" },
      summary: { customers: 220, tickets: 1100, lifetimeNetUsd: -1181208.94 },
    });
    expect(summary).not.toBeNull();
    if (summary === null) return;
    const kpis = deriveDeskKpis(
      { ...none, customerBook: { value: summary, mtime: NOW } },
      NOW,
    );
    expect(kpis.customerBook).toMatchObject({
      customers: 220,
      tickets: 1100,
      customerNetCents: -118120894,
    });
    expect(kpis.customerBook?.provenance).toMatchObject({
      basis: "fixture",
      stale: false,
    });
  });

  test("no block carries an identifier", () => {
    const kpis = deriveDeskKpis(
      {
        ...none,
        agentTree: {
          value: { nodes: { BILLY667: { t: "A" } } },
          mtime: NOW,
        },
      },
      NOW,
    );
    expect(JSON.stringify(kpis)).not.toContain("BILLY667");
  });
});

describe("freshness", () => {
  test("the artifact's own time wins over the file mtime", () => {
    expect(
      freshness(hoursBefore(2).toISOString(), hoursBefore(0.5), 3600, NOW),
    ).toEqual({
      asOf: hoursBefore(2).toISOString(),
      asOfFrom: "artifact",
      ageSeconds: 7200,
      stale: true,
    });
  });

  test("falls back to the mtime when the recorded time is absent or unparseable", () => {
    for (const recorded of [null, "not a date"]) {
      expect(freshness(recorded, hoursBefore(0.5), 3600, NOW)).toEqual({
        asOf: hoursBefore(0.5).toISOString(),
        asOfFrom: "file-mtime",
        ageSeconds: 1800,
        stale: false,
      });
    }
  });

  test("stale only past the threshold, and never without one", () => {
    expect(freshness(null, hoursBefore(1), 3600, NOW).stale).toBe(false);
    expect(
      freshness(null, new Date(hoursBefore(1).getTime() - 1000), 3600, NOW)
        .stale,
    ).toBe(true);
    expect(freshness(null, hoursBefore(10_000), null, NOW).stale).toBe(false);
  });

  test("a recorded time in the future falls back to the file mtime", () => {
    const tomorrow = new Date(NOW.getTime() + 24 * 3600 * 1000).toISOString();
    expect(freshness(tomorrow, hoursBefore(3), 3600, NOW)).toEqual({
      asOf: hoursBefore(3).toISOString(),
      asOfFrom: "file-mtime",
      ageSeconds: 3 * 3600,
      stale: true,
    });
  });
});

describe("recordedTime", () => {
  test("allows a few minutes of clock skew and no more", () => {
    const ahead = (minutes: number) =>
      new Date(NOW.getTime() + minutes * 60 * 1000).toISOString();
    expect(recordedTime(ahead(4), NOW)).toBe(Date.parse(ahead(4)));
    expect(recordedTime(ahead(6), NOW)).toBeNull();
    expect(recordedTime("not a date", NOW)).toBeNull();
    expect(recordedTime(null, NOW)).toBeNull();
  });
});

describe("readCustomerBookSummary", () => {
  test("rejects a file without a summary", () => {
    expect(readCustomerBookSummary({ profiles: [] })).toBeNull();
    expect(readCustomerBookSummary(null)).toBeNull();
  });
});
