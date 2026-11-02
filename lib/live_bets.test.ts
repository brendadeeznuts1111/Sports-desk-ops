import { describe, expect, test } from "bun:test";
import {
  agentKeyOf,
  agentsAboveLevel,
  buildArtifact,
  buildHierarchyIndex,
  customerKeyOf,
  extractRowsFromPreview,
  logoUrlFor,
  PII_KEYS,
  readHierarchyRows,
  readPendingRows,
  resolveAgent,
  stripPII,
  summarizeAgents,
  summarizeGames,
  ticketKeyOf,
  toLiveBetGame,
  type PendingRow,
} from "./live_bets.ts";
import { agentLoginKey } from "./f402_hierarchy_agents.ts";
import type { ListAgentsByAgentGeneralWireRow } from "./f402_list_agents_by_agent.ts";

/** A real row shape as returned by /cloud/api/Report/Pending (values from a 2026-11-01 capture).
 *  `NameFirst`/`Password` are not part of the typed row contract, but the live feed does send
 *  them — which is exactly why `stripPII` has to remove them by name. */
const soccerRow: PendingRow & { NameFirst: string; Password: string } = {
  TicketNumber: 1072983884,
  WagerNumber: 1,
  agentID: undefined,
  customerID: "H1716     ",
  NameFirst: "John Hoeft II",
  Password: "not-a-real-secret",
  Login: "H1716     ",
  WagerStatus: "P",
  Outcome: "P",
  WagerType: "S",
  AmountWagered: 6500,
  ToWinAmount: 6500,
  Description: "Soccer #200153 Arsenal PK,-&#189; +100 - For Game",
  totalPicks: 1,
  PeriodDescription: "Game                ",
  SportType: "Soccer              ",
  SportSubType: "ENG PREM            ",
  Team1ID: "Arsenal",
  Team2ID: "Liverpool",
  Team1RotNum: 200153,
  Team2RotNum: 200154,
  ChosenTeamID: "Arsenal",
  ShortName1: "Arsenal",
  ShortName2: "Liverpool",
  Team1FinalScore: 0,
  Team2FinalScore: 0,
  LogoTeam1: "Arsenal FC.png",
  LogoTeam2: "Liverpool FC.png",
  GameDateTime: "2026-11-01 11:30:00.000",
  AcceptedDateTime: "2026-10-31 21:26:44.917",
};

describe("stripPII", () => {
  test("drops every credential-bearing field", () => {
    const clean = stripPII(soccerRow) as Record<string, unknown>;
    for (const key of PII_KEYS) expect(clean).not.toHaveProperty(key);
    expect(JSON.stringify(clean)).not.toContain("not-a-real-secret");
  });

  test("keeps the fields the scoreboard needs", () => {
    const clean = stripPII(soccerRow) as Record<string, unknown>;
    expect(clean.TicketNumber).toBe(1072983884);
    expect(clean.AmountWagered).toBe(6500);
    expect(clean.LogoTeam1).toBe("Arsenal FC.png");
  });
});

describe("toLiveBetGame", () => {
  test("maps a real row onto the scoreboard shape", () => {
    const game = toLiveBetGame(soccerRow);

    expect(game.ticketNumber).toBe("1072983884");
    expect(game.wagerNumber).toBe("1");
    expect(String(game.ticketKey)).toBe("1072983884-1");
    expect(game.subSport).toBe("ENG PREM");
    expect(game.status).toBe("P");
    expect(game.period).toBe("Game");
    expect(game.chosenTeam).toBe("Arsenal");
    expect(String(game.customerID)).toBe("H1716");
  });

  test("preserves integer cents rather than reformatting money", () => {
    const game = toLiveBetGame(soccerRow);
    expect(game.wagered).toBe(6500);
    expect(game.toWin).toBe(6500);
  });

  test("carries team logos through to absolute URLs", () => {
    const game = toLiveBetGame(soccerRow);
    expect(game.team1.logo).toBe("Arsenal FC.png");
    expect(game.team1.logoUrl).toBe(
      "https://cdn.fastassets.io/images/team-logos/Arsenal%20FC.png",
    );
    expect(game.team2.name).toBe("Liverpool");
  });

  test("does not invent home/away or a winner", () => {
    const game = toLiveBetGame(soccerRow) as unknown as Record<string, unknown>;
    expect(game).not.toHaveProperty("home");
    expect(game).not.toHaveProperty("away");
  });

  test("tolerates missing logos and absent agent ids", () => {
    const game = toLiveBetGame({
      ...soccerRow,
      LogoTeam1: null,
      agentID: undefined,
    });
    expect(game.team1.logo).toBeNull();
    expect(game.team1.logoUrl).toBeNull();
    expect(String(game.agent.key)).toBe("");
    expect(game.agent.id).toBe("");
    expect(game.agent.level).toBeNull();
  });
});

describe("readPendingRows", () => {
  test("accepts the live {Pending: []} envelope", () => {
    expect(readPendingRows({ Pending: [soccerRow] })).toHaveLength(1);
  });

  test("accepts a bare array", () => {
    expect(readPendingRows([soccerRow, soccerRow])).toHaveLength(2);
  });

  test("accepts a single row object", () => {
    expect(readPendingRows(soccerRow)).toHaveLength(1);
  });

  test("returns nothing for unrelated payloads instead of throwing", () => {
    expect(readPendingRows(null)).toEqual([]);
    expect(readPendingRows({ ok: true })).toEqual([]);
    expect(readPendingRows("nope")).toEqual([]);
  });
});

describe("extractRowsFromPreview", () => {
  test("recovers complete rows from a truncated probe preview", () => {
    const body = JSON.stringify({
      Pending: [soccerRow, { TicketNumber: 999 }],
    });
    const preview = `{"Pending":${body.slice(body.indexOf(":") + 1)}`.slice(
      0,
      1200,
    );
    const rows = extractRowsFromPreview(preview);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.TicketNumber).toBe(1072983884);
  });

  test("drops a row cut off by the preview limit", () => {
    const full = JSON.stringify(soccerRow);
    const truncated = `{"Pending":[${full.slice(0, full.length - 40)}`;
    expect(extractRowsFromPreview(truncated)).toEqual([]);
  });
});

describe("buildArtifact", () => {
  test("dedupes by the portal's TicketNumber-WagerNumber key", () => {
    const artifact = buildArtifact([soccerRow, soccerRow], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: "2026-11-01T02:22:35.774Z",
    });
    expect(artifact.games).toHaveLength(1);
    expect(artifact.pendingCount).toBe(1);
    expect(String(artifact.games[0]?.ticketKey)).toBe("1072983884-1");
  });

  test("labels the artifact with its capture provenance", () => {
    const artifact = buildArtifact([soccerRow], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: "2026-11-01T02:22:35.774Z",
    });
    expect(artifact.dataSource).toBe(
      "capture:/cloud/api/Report/Pending@2026-11-01T02:22:35.774Z",
    );
    expect(artifact.capturedAt).toBe("2026-11-01T02:22:35.774Z");
    expect(artifact.schemaVersion).toBe(1);
  });

  test("never serialises a password or customer name", () => {
    const artifact = buildArtifact([soccerRow], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: null,
    });
    const serialised = JSON.stringify(artifact);
    expect(serialised).not.toContain("not-a-real-secret");
    expect(serialised).not.toContain("John Hoeft");
    for (const key of PII_KEYS) expect(serialised).not.toContain(`"${key}"`);
  });

  test("keeps distinct wagers of the same ticket as separate legs", () => {
    const artifact = buildArtifact(
      [
        soccerRow,
        { ...soccerRow, WagerNumber: 2 },
        { ...soccerRow, WagerNumber: 3 },
      ],
      { operation: "/cloud/api/Report/Pending", capturedAt: null },
    );
    expect(artifact.games.map((g) => String(g.ticketKey))).toEqual([
      "1072983884-1",
      "1072983884-2",
      "1072983884-3",
    ]);
  });

  test("orders games chronologically for a stable artifact", () => {
    const late = {
      ...soccerRow,
      TicketNumber: 2,
      GameDateTime: "2026-11-02 20:00:00.000",
    };
    const early = {
      ...soccerRow,
      TicketNumber: 3,
      GameDateTime: "2026-10-30 12:00:00.000",
    };
    const artifact = buildArtifact([late, soccerRow, early], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: null,
    });
    expect(artifact.games.map((g) => g.ticketNumber)).toEqual([
      "3",
      "1072983884",
      "2",
    ]);
  });
});

describe("summarizeGames", () => {
  const games = [
    toLiveBetGame(soccerRow),
    toLiveBetGame({
      ...soccerRow,
      TicketNumber: 2,
      SportSubType: "NFL",
      AmountWagered: 1000,
      ToWinAmount: 2000,
    }),
  ];

  test("totals the games and reports the data source", () => {
    const summary = summarizeGames(
      games,
      7,
      "capture:test@2026-11-01",
      "2026-11-01",
    );
    expect(summary.totalGames).toBe(2);
    expect(summary.totalWagered).toBe(7500);
    expect(summary.totalToWin).toBe(8500);
    expect(summary.totalPending).toBe(7);
    expect(summary.dataSource).toBe("capture:test@2026-11-01");
    expect(summary.capturedAt).toBe("2026-11-01");
  });

  test("breakdowns sum to the totals", () => {
    const summary = summarizeGames(games, 0, "capture:test", null);
    for (const bucket of [summary.bySubSport, summary.byAgent]) {
      const values = Object.values(bucket);
      expect(values.reduce((n, b) => n + b.games, 0)).toBe(summary.totalGames);
      expect(values.reduce((n, b) => n + b.wagered, 0)).toBe(
        summary.totalWagered,
      );
      expect(values.reduce((n, b) => n + b.toWin, 0)).toBe(summary.totalToWin);
    }
  });

  test("handles an empty capture without inventing a row", () => {
    const summary = summarizeGames([], 0, "capture:empty", null);
    expect(summary.totalGames).toBe(0);
    expect(summary.totalWagered).toBe(0);
    expect(summary.bySubSport).toEqual({});
  });
});

describe("logoUrlFor", () => {
  test("encodes spaces so the proxy path survives", () => {
    expect(logoUrlFor("Arsenal FC.png")).toContain("Arsenal%20FC.png");
  });

  test("returns null when the feed had no logo", () => {
    expect(logoUrlFor(null)).toBeNull();
  });
});

/** Rows shaped like the real `GENERAL` envelope, including a padded login and one collision. */
const hierarchyRows: ListAgentsByAgentGeneralWireRow[] = [
  {
    AgentID: "HRGROUP ",
    Login: "HRGROUP ",
    Level: 6,
    SeqNumber: 7644,
    AgentType: "A",
  },
  {
    AgentID: "MJ2026  ",
    Login: "MJ2026  ",
    Level: 3,
    SeqNumber: 5183,
    AgentType: "A",
  },
  // Real capture: two distinct agents normalise to the same login key.
  { AgentID: "BRANDON.", Login: "BRANDON", Level: 6, SeqNumber: 5452 },
  { AgentID: "BRANDON.. ", Login: "BRANDON ", Level: 10, SeqNumber: 6132 },
];

describe("identity keys", () => {
  test("agentKeyOf matches the hierarchy's own normalization", () => {
    for (const row of hierarchyRows) {
      expect(String(agentKeyOf(row))).toBe(agentLoginKey(row));
    }
    expect(String(agentKeyOf({ AgentID: "hrgroup   " }))).toBe("HRGROUP");
  });

  test("customer and ticket keys are canonical", () => {
    expect(String(customerKeyOf("  h1716  "))).toBe("H1716");
    expect(String(customerKeyOf(undefined))).toBe("");
    expect(String(ticketKeyOf(soccerRow))).toBe("1072983884-1");
  });

  test("resolveAgent attaches the hierarchy level and refuses to guess", () => {
    const { index } = buildHierarchyIndex(hierarchyRows, {
      onCollision: "skip",
    });

    const known = resolveAgent({ agentID: "hrgroup  " }, index);
    expect(String(known.key)).toBe("HRGROUP");
    expect(known.level).toBe(6);
    expect(known.agentType).toBe("A");

    const ambiguous = resolveAgent({ agentID: "BRANDON" }, index);
    expect(ambiguous.level).toBeNull();

    const absent = resolveAgent({ agentID: "NOSUCHAGENT" }, index);
    expect(absent.key).not.toBe("");
    expect(absent.level).toBeNull();

    const unassigned = resolveAgent({}, index);
    expect(String(unassigned.key)).toBe("");
    expect(unassigned.level).toBeNull();
  });
});

describe("buildHierarchyIndex", () => {
  test("throws on collisions by default", () => {
    expect(() => buildHierarchyIndex(hierarchyRows)).toThrow(
      /login collisions/,
    );
  });

  test("reports collisions and omits the ambiguous key when asked to skip", () => {
    const { index, collisions } = buildHierarchyIndex(hierarchyRows, {
      onCollision: "skip",
    });
    expect(collisions.map((c) => c.key)).toEqual(["BRANDON"]);
    expect(collisions[0]?.agentIds).toEqual(["BRANDON.", "BRANDON.."]);
    expect(collisions[0]?.seqNumbers).toEqual([5452, 6132]);
    expect(index.has("BRANDON" as never)).toBe(false);
    expect(index.get("HRGROUP" as never)?.level).toBe(6);
  });

  test("readHierarchyRows accepts the wire envelope and bare arrays", () => {
    expect(readHierarchyRows({ GENERAL: hierarchyRows })).toHaveLength(4);
    expect(readHierarchyRows(hierarchyRows)).toHaveLength(4);
    expect(readHierarchyRows({ PLAYERS: [] })).toEqual([]);
    expect(readHierarchyRows(null)).toEqual([]);
  });

  test("agentsAboveLevel exposes deeper rows", () => {
    expect(
      agentsAboveLevel(hierarchyRows, 6).map((r) => r.AgentID?.trim()),
    ).toEqual(["BRANDON.."]);
  });
});

describe("summarizeAgents", () => {
  const { index } = buildHierarchyIndex(hierarchyRows, { onCollision: "skip" });
  const games = [
    toLiveBetGame({ ...soccerRow, agentID: "HRGROUP" }, index),
    toLiveBetGame(
      { ...soccerRow, TicketNumber: 2, agentID: "HRGROUP " },
      index,
    ),
    toLiveBetGame({ ...soccerRow, TicketNumber: 3, agentID: "GHOST" }, index),
    toLiveBetGame({ ...soccerRow, TicketNumber: 4, agentID: undefined }, index),
  ];

  test("rolls wagers up by canonical key", () => {
    const scope = summarizeAgents(games, hierarchyRows);
    expect(scope.agents.map((a) => String(a.key))).toEqual([
      "HRGROUP",
      "GHOST",
    ]);
    expect(scope.agents[0]?.games).toBe(2);
    expect(scope.agents[0]?.wagered).toBe(13000);
    expect(scope.agents[0]?.level).toBe(6);
  });

  test("separates unresolved agents from unassigned wagers", () => {
    const scope = summarizeAgents(games, hierarchyRows);
    expect(scope.unresolved.map(String)).toEqual(["GHOST"]);
    expect(scope.unassignedGames).toBe(1);
    expect(scope.hierarchyLoaded).toBe(true);
    expect(scope.maxLevel).toBe(10);
  });

  test("carries collision warnings through to the scope", () => {
    const { collisions } = buildHierarchyIndex(hierarchyRows, {
      onCollision: "skip",
    });
    const scope = summarizeAgents(games, hierarchyRows, collisions);
    expect(scope.collisions.map((c) => c.key)).toEqual(["BRANDON"]);
  });

  test("reports no hierarchy rather than a fake level", () => {
    const plain = [
      toLiveBetGame({ ...soccerRow, agentID: "HRGROUP" }),
      toLiveBetGame({ ...soccerRow, TicketNumber: 2, agentID: "GHOST" }),
    ];
    const scope = summarizeAgents(plain);
    expect(scope.hierarchyLoaded).toBe(false);
    expect(scope.maxLevel).toBeNull();
    expect(scope.unresolved).toEqual([]);
    expect(scope.agents.every((a) => a.level === null)).toBe(true);
  });
});

describe("artifact with hierarchy", () => {
  test("levels land on the games and the scope", () => {
    const artifact = buildArtifact([{ ...soccerRow, agentID: "HRGROUP" }], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: null,
      hierarchy: hierarchyRows,
    });
    expect(artifact.games[0]?.agent.level).toBe(6);
    expect(artifact.agents.hierarchyLoaded).toBe(true);
    expect(artifact.agents.collisions.map((c) => c.key)).toEqual(["BRANDON"]);
  });

  test("stays PII-free with a hierarchy attached", () => {
    const artifact = buildArtifact([soccerRow], {
      operation: "/cloud/api/Report/Pending",
      capturedAt: null,
      hierarchy: hierarchyRows,
    });
    const serialised = JSON.stringify(artifact);
    expect(serialised).not.toContain("not-a-real-secret");
    for (const key of PII_KEYS) expect(serialised).not.toContain(`"${key}"`);
  });
});
