import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  anchorFromAccountInfo,
  checkAgentScope,
  isInScope,
} from "../lib/scope_checks.ts";
import { parseAccountInfo } from "../lib/account_info.ts";
import { lineValue, margin, resolveSpreads } from "../lib/game_line.ts";

/**
 * The anchor fixture is the observed account-info response for BILLY666 (2026-11-02), projected to
 * the fields the pipeline reads. Everything below is one walk through it.
 */

const fixture = (await Bun.file(
  join(import.meta.dir, "fixtures/f402-account-info-billy666-2026-11-02.json"),
).json()) as unknown;

describe("the anchor fixture", () => {
  const info = parseAccountInfo(fixture);
  const anchor = anchorFromAccountInfo(info);

  test("anchors on customerID, the unpadded copy", () => {
    expect(anchor).toEqual({
      office: "NOLAROSE",
      store: "PPHINSIDER",
      rootId: "BILLY666",
    });
    // Login is padded in this payload and would fail an equality test against the ticker.
    expect(info.login).toBe("BILLY666");
    expect(JSON.parse(JSON.stringify(fixture)).accountInfo.Login).toBe(
      "BILLY666  ",
    );
  });

  test("a master account has no AgentID, and that is not an error", () => {
    expect(info.agentType).toBe("M");
    expect(info.agentId).toBeNull();
    expect(isInScope(info, anchor)).toBe(true);
    expect(checkAgentScope("BILLY666", info, anchor)).toEqual([]);
  });

  test("DenyLiveBetting is carried, because the scope check needs it", () => {
    expect(info.denyLiveBetting).toBe("Y");
  });

  /**
   * `SERVER.date` has no zone, and the epoch field next to it settles which one it is:
   * `test` = 1793589916 = 2026-11-02T03:25:16Z, which is exactly `22:25:16` on 2026-11-01 at
   * UTC-5. So server timestamps are Eastern, not UTC — reading them as UTC puts every row five
   * hours out.
   */
  test("server timestamps are Eastern, proven by the epoch beside them", () => {
    const doc = JSON.parse(JSON.stringify(fixture)) as {
      test: number;
      SERVER: { date: string };
    };
    const epoch = new Date(doc.test * 1000);
    expect(epoch.toISOString()).toBe("2026-11-02T03:25:16.000Z");
    const printed = new Date(`${doc.SERVER.date.replace(" ", "T")}Z`);
    // 5 hours minus the 233 ms the printed field rounds to whole seconds.
    expect((epoch.getTime() - printed.getTime()) / 60_000).toBeCloseTo(300, 2);
  });
});

describe("spreads", () => {
  /**
   * Both observed games agree that `Spread` belongs to Team2 and `Favorito` names Team2. The
   * module takes the Team2-relative reading and reports the cross-check rather than choosing
   * between the two rules.
   */
  const clippers = {
    team1Id: "Los Angeles Clippers",
    team2Id: "Golden St Warriors",
    spread: -2,
    favorito: "Golden St Warriors",
  };
  const eagles = {
    team1Id: "Philadelphia Eagles",
    team2Id: "Washington Commanders",
    spread: -5.5,
    favorito: "Washington Commanders",
  };

  test("the favourite is negative on its own side, and the other side flips", () => {
    expect(resolveSpreads(clippers)).toEqual({
      team1: 2,
      team2: -2,
      favoritoIsTeam2: true,
      agrees: true,
    });
    expect(resolveSpreads(eagles)).toEqual({
      team1: 5.5,
      team2: -5.5,
      favoritoIsTeam2: true,
      agrees: true,
    });
  });

  test("a Favorito that names Team1 is reported, not silently overruled", () => {
    const flipped = resolveSpreads({
      team1Id: "Eagles",
      team2Id: "Commanders",
      spread: -5.5,
      favorito: "Eagles",
    });
    // Spread says Team2 is the favourite; Favorito says Team1. Both readings are returned.
    expect(flipped.team2).toBe(-5.5);
    expect(flipped.favoritoIsTeam2).toBe(false);
    expect(flipped.agrees).toBe(false);
  });

  test("a missing spread or Favorito is null, not zero", () => {
    expect(
      resolveSpreads({
        team1Id: "A",
        team2Id: "B",
        spread: null,
        favorito: "B",
      }),
    ).toEqual({
      team1: null,
      team2: null,
      favoritoIsTeam2: null,
      agrees: null,
    });
  });

  test("the bettor at +3.5 against a +5.5 market is two points behind", () => {
    // Eagles +3.5 held; the market now has them +5.5.
    expect(lineValue(3.5, 5.5)).toBe(-2);
    // Holding +5.5 while the market moved to +3.5 is two points ahead.
    expect(lineValue(5.5, 3.5)).toBe(2);
  });

  test("margin covers when score plus the spread is positive", () => {
    // Eagles 10, Commanders 10, Eagles +3.5.
    expect(margin(10, 10, 3.5)).toBe(3.5);
    // Down 17-10 with +5.5 is still behind.
    expect(margin(10, 17, 5.5)).toBe(-1.5);
    expect(margin(null, 10, 3.5)).toBeNull();
  });
});
