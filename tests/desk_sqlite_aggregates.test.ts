import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  InvalidOddsError,
  MissingOrderKeyError,
  NegativeStakeError,
  NonFiniteInputError,
  americanToDecimalOdds,
  clvBps,
  maxDrawdown,
  registerDeskAggregates,
} from "../lib/desk_sqlite_aggregates.ts";
import {
  type FlatLegRecord,
  createComboObservationsLegsStore,
} from "../lib/combo_observations_legs_store.ts";

interface BetRow {
  readonly placedAt: string;
  readonly stake: number;
  readonly taken: number;
  readonly close: number;
  readonly pnl: number;
}

function betsDb(rows: readonly BetRow[]): Database {
  const db = new Database(":memory:");
  registerDeskAggregates(db);
  db.run(
    "CREATE TABLE bets (id INTEGER PRIMARY KEY, placed_at TEXT, stake REAL, taken REAL, close REAL, pnl REAL)",
  );
  const insert = db.prepare(
    "INSERT INTO bets (placed_at, stake, taken, close, pnl) VALUES (?1, ?2, ?3, ?4, ?5)",
  );
  for (const r of rows)
    insert.run(r.placedAt, r.stake, r.taken, r.close, r.pnl);
  return db;
}

function scalar<T>(db: Database, sql: string, ...params: unknown[]): T {
  const row = db.query(sql).values(...(params as never[]))[0];
  return row?.[0] as T;
}

const bet = (
  placedAt: string,
  stake: number,
  pnl = 0,
  taken = 2,
  close = 2,
): BetRow => ({ placedAt, stake, taken, close, pnl });

describe("desk_decimal_odds", () => {
  it("converts American prices", () => {
    expect(americanToDecimalOdds(150)).toBe(2.5);
    expect(americanToDecimalOdds(-200)).toBe(1.5);
    const db = betsDb([]);
    expect(scalar<number>(db, "SELECT desk_decimal_odds(-110)")).toBeCloseTo(
      1.909090909,
      9,
    );
  });

  it("rejects prices inside (-100, 100) and non-numbers", () => {
    const db = betsDb([]);
    expect(() => scalar(db, "SELECT desk_decimal_odds(50)")).toThrow(
      InvalidOddsError,
    );
    expect(() => scalar(db, "SELECT desk_decimal_odds(NULL)")).toThrow(
      NonFiniteInputError,
    );
  });
});

describe("desk_stake_sum", () => {
  it("is 0 on an empty set", () => {
    expect(
      scalar<number>(betsDb([]), "SELECT desk_stake_sum(stake) FROM bets"),
    ).toBe(0);
  });

  it("returns the single row's stake", () => {
    const db = betsDb([bet("2026-11-01T00:00:00Z", 2500)]);
    expect(scalar<number>(db, "SELECT desk_stake_sum(stake) FROM bets")).toBe(
      2500,
    );
  });

  it("sums stake inside a time window", () => {
    const db = betsDb([
      bet("2026-11-01T10:00:00Z", 1000),
      bet("2026-11-02T10:00:00Z", 2000),
      bet("2026-11-03T10:00:00Z", 4000),
    ]);
    expect(
      scalar<number>(
        db,
        "SELECT desk_stake_sum(stake) FROM bets WHERE placed_at >= ?1 AND placed_at < ?2",
        "2026-11-02T00:00:00Z",
        "2026-11-04T00:00:00Z",
      ),
    ).toBe(6000);
  });

  it("works as a trailing time-window function", () => {
    const db = betsDb([
      bet("2026-11-01T10:00:00Z", 1000),
      bet("2026-11-02T10:00:00Z", 2000),
      bet("2026-11-04T10:00:00Z", 4000),
    ]);
    const rows = db
      .query(
        `SELECT desk_stake_sum(stake) OVER (
           ORDER BY unixepoch(placed_at) RANGE BETWEEN 86400 PRECEDING AND CURRENT ROW
         ) AS s FROM bets ORDER BY placed_at`,
      )
      .values()
      .map((r) => r[0]);
    expect(rows).toEqual([1000, 3000, 4000]);
  });

  it("rejects negative stake and NaN", () => {
    expect(() =>
      scalar(
        betsDb([bet("2026-11-01T00:00:00Z", -1)]),
        "SELECT desk_stake_sum(stake) FROM bets",
      ),
    ).toThrow(NegativeStakeError);
    expect(() =>
      scalar(betsDb([]), "SELECT desk_stake_sum(?1)", Number.NaN),
    ).toThrow(NonFiniteInputError);
  });
});

describe("desk_clv_bps", () => {
  it("is NULL on an empty set", () => {
    expect(
      scalar(betsDb([]), "SELECT desk_clv_bps(stake, taken, close) FROM bets"),
    ).toBeNull();
  });

  it("returns the single bet's CLV", () => {
    const db = betsDb([bet("2026-11-01T00:00:00Z", 1000, 0, 2.1, 2)]);
    expect(
      scalar<number>(db, "SELECT desk_clv_bps(stake, taken, close) FROM bets"),
    ).toBeCloseTo(500, 9);
  });

  it("weights by stake", () => {
    const db = betsDb([
      bet("2026-11-01T00:00:00Z", 3000, 0, 2.1, 2),
      bet("2026-11-02T00:00:00Z", 1000, 0, 1.9, 2),
    ]);
    expect(
      scalar<number>(db, "SELECT desk_clv_bps(stake, taken, close) FROM bets"),
    ).toBeCloseTo((3000 * 500 + 1000 * -500) / 4000, 9);
  });

  it("rolls over the last N bets as a window function", () => {
    const rows: BetRow[] = [
      bet("2026-11-01T00:00:00Z", 1000, 0, 2.2, 2),
      bet("2026-11-02T00:00:00Z", 1000, 0, 2.0, 2),
      bet("2026-11-03T00:00:00Z", 2000, 0, 1.8, 2),
      bet("2026-11-04T00:00:00Z", 1000, 0, 2.1, 2),
    ];
    const db = betsDb(rows);
    const rolling = db
      .query(
        `SELECT desk_clv_bps(stake, taken, close) OVER (
           ORDER BY placed_at ROWS BETWEEN 1 PRECEDING AND CURRENT ROW
         ) FROM bets ORDER BY placed_at`,
      )
      .values()
      .map((r) => r[0] as number);
    const expected = rows.map((r, i) => {
      const window = rows.slice(Math.max(0, i - 1), i + 1);
      const stake = window.reduce((s, w) => s + w.stake, 0);
      return (
        window.reduce((s, w) => s + w.stake * clvBps(w.taken, w.close), 0) /
        stake
      );
    });
    rolling.forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 9));
  });

  it("rejects decimal odds <= 1, negative stake and NaN", () => {
    const run = (row: BetRow) =>
      scalar(
        betsDb([row]),
        "SELECT desk_clv_bps(stake, taken, close) FROM bets",
      );
    expect(() => run(bet("2026-11-01T00:00:00Z", 100, 0, 1, 2))).toThrow(
      InvalidOddsError,
    );
    expect(() => run(bet("2026-11-01T00:00:00Z", 100, 0, 2, 0.5))).toThrow(
      InvalidOddsError,
    );
    expect(() => run(bet("2026-11-01T00:00:00Z", -100, 0, 2, 2))).toThrow(
      NegativeStakeError,
    );
    expect(() =>
      scalar(betsDb([]), "SELECT desk_clv_bps(100, ?1, 2)", Number.NaN),
    ).toThrow(NonFiniteInputError);
  });
});

describe("desk_max_drawdown", () => {
  const dd = (rows: readonly BetRow[]) =>
    scalar<number>(
      betsDb(rows),
      "SELECT desk_max_drawdown(placed_at, pnl) FROM bets",
    );

  it("is 0 on an empty set", () => {
    expect(dd([])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });

  it("handles a single row", () => {
    expect(dd([bet("2026-11-01T00:00:00Z", 100, 250)])).toBe(0);
    expect(dd([bet("2026-11-01T00:00:00Z", 100, -250)])).toBe(250);
  });

  it("measures from the running peak and resets after recovery", () => {
    const rows = [
      bet("2026-11-01T00:00:00Z", 100, 100),
      bet("2026-11-02T00:00:00Z", 100, -150),
      bet("2026-11-03T00:00:00Z", 100, 200),
      bet("2026-11-04T00:00:00Z", 100, -50),
    ];
    expect(dd(rows)).toBe(150);
    const deeperAfterRecovery = [
      ...rows,
      bet("2026-11-05T00:00:00Z", 100, -180),
    ];
    expect(dd(deeperAfterRecovery)).toBe(230);
  });

  it("orders by the key, not by insertion order", () => {
    const rows = [
      bet("2026-11-03T00:00:00Z", 100, 200),
      bet("2026-11-01T00:00:00Z", 100, 100),
      bet("2026-11-04T00:00:00Z", 100, -50),
      bet("2026-11-02T00:00:00Z", 100, -150),
    ];
    expect(dd(rows)).toBe(150);
  });

  it("rejects NaN P&L and a NULL order key", () => {
    expect(() =>
      scalar(betsDb([]), "SELECT desk_max_drawdown('k', ?1)", Number.NaN),
    ).toThrow(NonFiniteInputError);
    expect(() =>
      scalar(betsDb([]), "SELECT desk_max_drawdown(NULL, 5)"),
    ).toThrow(MissingOrderKeyError);
  });
});

describe("ComboObservationsLegsStore desk aggregates", () => {
  const leg = (
    overrides: Partial<FlatLegRecord> &
      Pick<FlatLegRecord, "sourceTicket" | "placedAt">,
  ): FlatLegRecord => ({
    sourceVenue: "f402",
    walletOrAccount: "CUST1",
    gameId: "G1",
    subject: "TEAM_A",
    marketKind: "spread",
    side: "home",
    lineHundredths: null,
    productClass: "straight",
    stakeCents: 1000,
    oddsAmerican: -110,
    identitySha256: "i",
    shapeSha256: "s",
    pickShapeSha256: "p",
    status: "settled",
    ...overrides,
  });

  function seeded() {
    const store = createComboObservationsLegsStore();
    const ids = [
      store.insertFlatLeg(
        leg({
          sourceTicket: "T1",
          placedAt: "2026-11-01T10:00:00Z",
          stakeCents: 2000,
          oddsAmerican: 120,
        }),
      ),
      store.insertFlatLeg(
        leg({
          sourceTicket: "T1",
          placedAt: "2026-11-01T10:00:00Z",
          stakeCents: 2000,
          oddsAmerican: 120,
          subject: "TEAM_B",
        }),
      ),
      store.insertFlatLeg(
        leg({
          sourceTicket: "T2",
          placedAt: "2026-11-02T10:00:00Z",
          stakeCents: 1000,
          oddsAmerican: -110,
        }),
      ),
      store.insertFlatLeg(
        leg({
          sourceTicket: "T3",
          placedAt: "2026-11-03T10:00:00Z",
          stakeCents: 3000,
          oddsAmerican: 150,
        }),
      ),
      store.insertFlatLeg(
        leg({
          sourceTicket: "X1",
          placedAt: "2026-11-02T10:00:00Z",
          walletOrAccount: "CUST2",
          stakeCents: 9999,
        }),
      ),
    ];
    return { store, ids };
  }

  it("sums one stake per ticket inside the window", () => {
    const { store } = seeded();
    expect(
      store.stakeCentsInWindow(
        "cust1",
        "2026-11-01T00:00:00Z",
        "2026-11-03T00:00:00Z",
      ),
    ).toBe(3000);
    expect(
      store.stakeCentsInWindow(
        "CUST1",
        "2026-12-01T00:00:00Z",
        "2026-12-02T00:00:00Z",
      ),
    ).toBe(0);
  });

  it("computes CLV over the latest N priced legs", () => {
    const { store, ids } = seeded();
    const closes = new Map<number, number>([
      [ids[0]!, 2.1],
      [ids[2]!, 1.95],
      [ids[3]!, 2.4],
    ]);
    const t3 = clvBps(2.5, 2.4);
    const t2 = clvBps(americanToDecimalOdds(-110), 1.95);
    expect(store.rollingClvBps("CUST1", 1, closes)).toBeCloseTo(t3, 9);
    expect(store.rollingClvBps("CUST1", 2, closes)).toBeCloseTo(
      (3000 * t3 + 1000 * t2) / 4000,
      9,
    );
    expect(store.rollingClvBps("CUST1", 5, new Map())).toBeNull();
    expect(() => store.rollingClvBps("CUST1", 0, closes)).toThrow(
      "lastN must be a positive integer",
    );
    expect(() =>
      store.rollingClvBps("CUST1", 1, new Map([[ids[3]!, Number.NaN]])),
    ).toThrow(NonFiniteInputError);
  });

  it("weights a 4-leg parlay and a single equally at equal stake", () => {
    const store = createComboObservationsLegsStore();
    const single = store.insertFlatLeg(
      leg({
        sourceTicket: "S1",
        placedAt: "2026-11-01T10:00:00Z",
        stakeCents: 4000,
        oddsAmerican: 150,
      }),
    );
    const parlay = ["TEAM_A", "TEAM_B", "TEAM_C", "TEAM_D"].map((subject) =>
      store.insertFlatLeg(
        leg({
          sourceTicket: "P4",
          placedAt: "2026-11-02T10:00:00Z",
          productClass: "parlay",
          stakeCents: 4000,
          oddsAmerican: -110,
          subject,
        }),
      ),
    );
    const parlayCloses = [1.95, 1.9, 1.85, 2.0];
    const closes = new Map<number, number>([
      [single, 2.4],
      ...parlay.map((id, i): [number, number] => [id, parlayCloses[i]!]),
    ]);
    const singleClv = clvBps(2.5, 2.4);
    const parlayClv =
      parlayCloses
        .map((close) => clvBps(americanToDecimalOdds(-110), close))
        .reduce((a, b) => a + b, 0) / parlayCloses.length;
    expect(store.rollingClvBps("CUST1", 5, closes)).toBeCloseTo(
      (singleClv + parlayClv) / 2,
      9,
    );
    expect(store.rollingClvBps("CUST1", 4, closes)).toBeCloseTo(parlayClv, 9);
  });

  it("computes ticket-level max drawdown with recovery", () => {
    const { store } = seeded();
    expect(store.maxDrawdownCents("CUST1", new Map())).toBe(0);
    const pnl = new Map([
      [
        "f402" as const,
        new Map([
          ["T3", -500],
          ["T1", 2400],
          ["T2", -1000],
        ]),
      ],
    ]);
    expect(store.maxDrawdownCents("CUST1", pnl)).toBe(1500);
    expect(
      store.maxDrawdownCents(
        "CUST1",
        new Map([["f402" as const, new Map([["T2", -1000]])]]),
      ),
    ).toBe(1000);
  });

  it("keys drawdown P&L by venue and ticket, not ticket alone", () => {
    const { store } = seeded();
    store.insertFlatLeg(
      leg({
        sourceVenue: "polymarket",
        sourceTicket: "T2",
        placedAt: "2026-11-02T12:00:00Z",
      }),
    );
    const pnl = new Map<"f402" | "polymarket", ReadonlyMap<string, number>>([
      [
        "f402",
        new Map([
          ["T1", 2400],
          ["T2", -1000],
        ]),
      ],
      ["polymarket", new Map([["T2", 300]])],
    ]);
    expect(store.maxDrawdownCents("CUST1", pnl)).toBe(1000);
    expect(
      store.maxDrawdownCents(
        "CUST1",
        new Map([["polymarket" as const, new Map([["T2", -700]])]]),
      ),
    ).toBe(700);
  });
});
