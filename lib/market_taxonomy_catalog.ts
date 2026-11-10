/**
 * @file lib/market_taxonomy_catalog.ts
 * @description Zero-allocation hierarchical market taxonomy catalog & deterministic classifier:
 *   Level 1: Sport (`SportCode`)
 *   Level 2: SubSport (`SubSportCode`)
 *   Level 3: Period per SubSport (`PeriodCode` + `portalPeriodNumber` + `allowsPointBuys`)
 *   Level 4: Market (`MarketCode`)
 *
 * Adheres strictly to AGENTS.md data-handling budgets:
 *  - Dense Uint8 integer indices + 16-bit period validity bitmasks
 *  - Object.create(null) lookup tables (zero Map, Set, boolean[], Array.from, or .filter().map())
 */

import type {
  MarketCode,
  MarketFilter,
  PeriodCode,
  PeriodFilter,
  PointBuyPolicy,
  SportCode,
  SportFilter,
  SubSportCode,
  SubSportFilter,
  SubSportPeriodSpec,
  SubSportTaxonomySpec,
  TaxonomyRiskStatus,
} from "../types/shadow_pricing.ts";

export const SPORT_CODES: readonly SportCode[] = [
  "Football",
  "Basketball",
  "Hockey",
  "Baseball",
  "Soccer",
  "LIVE",
  "Other",
];
export const SPORT_COUNT = 7;

export const SPORT_LABELS: readonly string[] = [
  "Football (Pre-Game)",
  "Basketball (Pre-Game)",
  "Hockey (Pre-Game)",
  "Baseball (Pre-Game)",
  "Soccer (Global 90m)",
  "LIVE (In-Play #9000)",
  "Other (Tennis / MMA / Golf)",
];

export const SUBSPORT_CODES: readonly SubSportCode[] = [
  "NFL",
  "NCAAF",
  "NBA",
  "NCAAB",
  "WNBA",
  "NHL",
  "Hockey_Alter",
  "MLB",
  "Baseball_Series",
  "Soccer_Top",
  "NFL_Live",
  "NCAAF_Live",
  "NBA_Live",
  "NHL_Live",
  "MLB_Live",
  "Tennis_Tour",
  "Combat_Golf",
  "Other_General",
];
export const SUBSPORT_COUNT = 18;

export const PERIOD_CODES: readonly PeriodCode[] = [
  "game",
  "1h",
  "2h",
  "1q",
  "2q",
  "3q",
  "4q",
  "p1",
  "p2",
  "p3",
  "reg",
  "f5",
  "inning",
  "set",
  "round",
];
export const PERIOD_COUNT = 15;

export const PERIOD_DEFAULT_LABELS: readonly string[] = [
  "Full Game (P0)",
  "1st Half (P1)",
  "2nd Half (P2)",
  "1st Quarter (P3)",
  "2nd Quarter (P4)",
  "3rd Quarter (P5)",
  "4th Quarter (P6)",
  "1st Period (P3)",
  "2nd Period (P4)",
  "3rd Period (P5)",
  "Regulation Time",
  "1st 5 Innings (F5)",
  "Single Inning (1st–9th)",
  "Set Betting (1st–5th)",
  "Tournament / Fight Round",
];

export const PERIOD_PORTAL_NUMBERS: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 3, 4, 5, 0, 1, 3, 3, 3,
];

export const MARKET_CODES: readonly MarketCode[] = [
  "spread",
  "total",
  "moneyline",
  "team_total",
  "player_prop",
  "other",
];
export const MARKET_COUNT = 6;

export const MARKET_LABELS: readonly string[] = [
  "Spread / Handicap",
  "Total (Over / Under)",
  "Moneyline (2-Way / 3-Way)",
  "Team Total (Derivative)",
  "Player & Game Props",
  "Other / Exotic",
];

// Integer constants for fast hot-loop branching
export const SPORT_ID_FOOTBALL = 0;
export const SPORT_ID_BASKETBALL = 1;
export const SPORT_ID_HOCKEY = 2;
export const SPORT_ID_BASEBALL = 3;
export const SPORT_ID_SOCCER = 4;
export const SPORT_ID_LIVE = 5;
export const SPORT_ID_OTHER = 6;

export const SUB_ID_NFL = 0;
export const SUB_ID_NCAAF = 1;
export const SUB_ID_NBA = 2;
export const SUB_ID_NCAAB = 3;
export const SUB_ID_WNBA = 4;
export const SUB_ID_NHL = 5;
export const SUB_ID_HOCKEY_ALTER = 6;
export const SUB_ID_MLB = 7;
export const SUB_ID_BASEBALL_SERIES = 8;
export const SUB_ID_SOCCER_TOP = 9;
export const SUB_ID_NFL_LIVE = 10;
export const SUB_ID_NCAAF_LIVE = 11;
export const SUB_ID_NBA_LIVE = 12;
export const SUB_ID_NHL_LIVE = 13;
export const SUB_ID_MLB_LIVE = 14;
export const SUB_ID_TENNIS_TOUR = 15;
export const SUB_ID_COMBAT_GOLF = 16;
export const SUB_ID_OTHER_GENERAL = 17;

export const PERIOD_ID_GAME = 0;
export const PERIOD_ID_1H = 1;
export const PERIOD_ID_2H = 2;
export const PERIOD_ID_1Q = 3;
export const PERIOD_ID_2Q = 4;
export const PERIOD_ID_3Q = 5;
export const PERIOD_ID_4Q = 6;
export const PERIOD_ID_P1 = 7;
export const PERIOD_ID_P2 = 8;
export const PERIOD_ID_P3 = 9;
export const PERIOD_ID_REG = 10;
export const PERIOD_ID_F5 = 11;
export const PERIOD_ID_INNING = 12;
export const PERIOD_ID_SET = 13;
export const PERIOD_ID_ROUND = 14;

export const MARKET_ID_SPREAD = 0;
export const MARKET_ID_TOTAL = 1;
export const MARKET_ID_MONEYLINE = 2;
export const MARKET_ID_TEAM_TOTAL = 3;
export const MARKET_ID_PLAYER_PROP = 4;
export const MARKET_ID_OTHER = 5;

const FB_BB_QUARTER_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "Full Game (P0)",
    shortLabel: "Game",
    allowsPointBuys: true,
  },
  {
    code: "1h",
    portalPeriodNumber: 1,
    label: "1st Half (P1)",
    shortLabel: "1H",
    allowsPointBuys: false,
  },
  {
    code: "2h",
    portalPeriodNumber: 2,
    label: "2nd Half (P2)",
    shortLabel: "2H",
    allowsPointBuys: false,
  },
  {
    code: "1q",
    portalPeriodNumber: 3,
    label: "1st Quarter (P3)",
    shortLabel: "1Q",
    allowsPointBuys: false,
  },
  {
    code: "2q",
    portalPeriodNumber: 4,
    label: "2nd Quarter (P4)",
    shortLabel: "2Q",
    allowsPointBuys: false,
  },
  {
    code: "3q",
    portalPeriodNumber: 5,
    label: "3rd Quarter (P5)",
    shortLabel: "3Q",
    allowsPointBuys: false,
  },
  {
    code: "4q",
    portalPeriodNumber: 6,
    label: "4th Quarter (P6)",
    shortLabel: "4Q",
    allowsPointBuys: false,
  },
];

const NCAAB_HALVES_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "Full Game 40m (P0)",
    shortLabel: "Game",
    allowsPointBuys: true,
  },
  {
    code: "1h",
    portalPeriodNumber: 1,
    label: "1st Half 20m (P1)",
    shortLabel: "1H",
    allowsPointBuys: false,
  },
  {
    code: "2h",
    portalPeriodNumber: 2,
    label: "2nd Half 20m (P2)",
    shortLabel: "2H",
    allowsPointBuys: false,
  },
];

const NHL_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "Match Incl. OT/SO (P0)",
    shortLabel: "Game (OT)",
    allowsPointBuys: false,
  },
  {
    code: "reg",
    portalPeriodNumber: 0,
    label: "60m Regulation (3-Way)",
    shortLabel: "60m Reg",
    allowsPointBuys: false,
  },
  {
    code: "p1",
    portalPeriodNumber: 3,
    label: "1st Period (P1)",
    shortLabel: "P1",
    allowsPointBuys: false,
  },
  {
    code: "p2",
    portalPeriodNumber: 4,
    label: "2nd Period (P2)",
    shortLabel: "P2",
    allowsPointBuys: false,
  },
  {
    code: "p3",
    portalPeriodNumber: 5,
    label: "3rd Period (P3)",
    shortLabel: "P3",
    allowsPointBuys: false,
  },
];

const MLB_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "Full Game 9 Inn (P0)",
    shortLabel: "9 Inn Game",
    allowsPointBuys: false,
  },
  {
    code: "f5",
    portalPeriodNumber: 1,
    label: "1st 5 Innings (F5)",
    shortLabel: "F5",
    allowsPointBuys: false,
  },
  {
    code: "inning",
    portalPeriodNumber: 3,
    label: "Single Inning (NRFI / 1–9)",
    shortLabel: "Inning",
    allowsPointBuys: false,
  },
];

const SOCCER_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "90m Match + Stoppage (P0)",
    shortLabel: "90m Match",
    allowsPointBuys: false,
  },
  {
    code: "1h",
    portalPeriodNumber: 1,
    label: "1st Half 45m (P1)",
    shortLabel: "1H (45m)",
    allowsPointBuys: false,
  },
  {
    code: "2h",
    portalPeriodNumber: 2,
    label: "2nd Half 45m (P2)",
    shortLabel: "2H (45m)",
    allowsPointBuys: false,
  },
];

const LIVE_INPLAY_PERIODS: readonly SubSportPeriodSpec[] = [
  {
    code: "game",
    portalPeriodNumber: 0,
    label: "In-Play Full Game (#9000 P0)",
    shortLabel: "In-Play P0",
    allowsPointBuys: false,
  },
];

/**
 * Canonical 18-SubSport Catalog ordered identically to `SUBSPORT_CODES`.
 */
export const SUBSPORT_TAXONOMY_CATALOG: readonly SubSportTaxonomySpec[] = [
  {
    code: "NFL",
    label: "NFL Pro Football",
    shortLabel: "NFL",
    sport: "Football",
    isLive: false,
    pointBuyPolicy: "KEY_LEAK_EXPOSED",
    primaryRiskVector:
      "Key 3 (~15%) & Key 7 (~9%) margin clustering vs -120/-125 retail point buys on P0 Spread",
    validPeriods: FB_BB_QUARTER_PERIODS,
    primaryMarkets: [
      "spread",
      "total",
      "moneyline",
      "team_total",
      "player_prop",
    ],
  },
  {
    code: "NCAAF",
    label: "College Football (NCAAF)",
    shortLabel: "College FB",
    sport: "Football",
    isLive: false,
    pointBuyPolicy: "KEY_LEAK_EXPOSED",
    primaryRiskVector:
      "Key 3/7/10/14/21 spread buys + wide college blowout dispersion & 1H correlated steam",
    validPeriods: FB_BB_QUARTER_PERIODS,
    primaryMarkets: [
      "spread",
      "total",
      "moneyline",
      "team_total",
      "player_prop",
    ],
  },
  {
    code: "NBA",
    label: "NBA Pro Basketball",
    shortLabel: "NBA",
    sport: "Basketball",
    isLive: false,
    pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
    primaryRiskVector:
      "Bell-curve scoring (0.5pt fair = 3.2¢ vs 10¢ retail vig = +6.5¢ desk edge); guard late injury news & Qtr steam",
    validPeriods: FB_BB_QUARTER_PERIODS,
    primaryMarkets: [
      "spread",
      "total",
      "moneyline",
      "team_total",
      "player_prop",
    ],
  },
  {
    code: "NCAAB",
    label: "College Basketball (NCAAB)",
    shortLabel: "NCAAB",
    sport: "Basketball",
    isLive: false,
    pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
    primaryRiskVector:
      "Two 20m Halves ONLY (no quarters); positive retail buy hold (+6¢/half-pt); watch thin-conference 1H steam",
    validPeriods: NCAAB_HALVES_PERIODS,
    primaryMarkets: ["spread", "total", "moneyline", "team_total"],
  },
  {
    code: "WNBA",
    label: "WNBA Basketball",
    shortLabel: "WNBA",
    sport: "Basketball",
    isLive: false,
    pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
    primaryRiskVector:
      "Lower total variance increases half-point value slightly (~3.8¢), still well below 10¢ retail charge",
    validPeriods: FB_BB_QUARTER_PERIODS,
    primaryMarkets: ["spread", "total", "moneyline", "player_prop"],
  },
  {
    code: "NHL",
    label: "NHL Ice Hockey",
    shortLabel: "NHL",
    sport: "Hockey",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Point buys strictly blocked; fixed ±1.5 Puck Line (empty-net 2-goal clustering) & Goalie confirmation lag",
    validPeriods: NHL_PERIODS,
    primaryMarkets: ["moneyline", "spread", "total", "player_prop"],
  },
  {
    code: "Hockey_Alter",
    label: "Hockey Alter (Dynamic Alt Lines)",
    shortLabel: "Hockey Alter",
    sport: "Hockey",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Non-linear Poisson alt puck/total pricing (+185/-240); immune to flat -120 half-point buys",
    validPeriods: [NHL_PERIODS[0]!],
    primaryMarkets: ["spread", "total"],
  },
  {
    code: "MLB",
    label: "MLB Baseball",
    shortLabel: "MLB",
    sport: "Baseball",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Point buys strictly blocked; F5 vs Bullpen split pricing, ±1.5 Run Line & lineup scratch latency",
    validPeriods: MLB_PERIODS,
    primaryMarkets: ["moneyline", "spread", "total", "player_prop"],
  },
  {
    code: "Baseball_Series",
    label: "Baseball Series & Outrights",
    shortLabel: "MLB Series",
    sport: "Baseball",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Multi-game series moneyline & exact-games pricing; zero point-buy surface",
    validPeriods: [
      {
        code: "game",
        portalPeriodNumber: 0,
        label: "Full Series (P0)",
        shortLabel: "Series",
        allowsPointBuys: false,
      },
    ],
    primaryMarkets: ["moneyline", "player_prop"],
  },
  {
    code: "Soccer_Top",
    label: "Top Soccer (EPL / UCL / MLS / Intl)",
    shortLabel: "Top Soccer",
    sport: "Soccer",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Asian Handicap split-stake (±0.25 / ±0.75) replaces point buying; 90m + stoppage 3-way draw vig",
    validPeriods: SOCCER_PERIODS,
    primaryMarkets: ["spread", "moneyline", "total", "player_prop"],
  },
  {
    code: "NFL_Live",
    label: "NFL In-Play (#9000 LIVE)",
    shortLabel: "NFL Live",
    sport: "LIVE",
    isLive: true,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "ASI EZLive #9000-series: Point buys 100% DISABLED; primary hazard is clock/possession feed latency",
    validPeriods: LIVE_INPLAY_PERIODS,
    primaryMarkets: ["spread", "total", "moneyline"],
  },
  {
    code: "NCAAF_Live",
    label: "College FB In-Play (#9000 LIVE)",
    shortLabel: "NCAAF Live",
    sport: "LIVE",
    isLive: true,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "ASI EZLive #9000-series: Point buys 100% DISABLED; stadium clock lag & high-tempo drive swings",
    validPeriods: LIVE_INPLAY_PERIODS,
    primaryMarkets: ["spread", "total", "moneyline"],
  },
  {
    code: "NBA_Live",
    label: "NBA In-Play (#9000 LIVE)",
    shortLabel: "NBA Live",
    sport: "LIVE",
    isLive: true,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "ASI EZLive #9000-series: Point buys 100% DISABLED; possession-level court-siding & run volatility",
    validPeriods: LIVE_INPLAY_PERIODS,
    primaryMarkets: ["spread", "total", "moneyline"],
  },
  {
    code: "NHL_Live",
    label: "NHL In-Play (#9000 LIVE)",
    shortLabel: "NHL Live",
    sport: "LIVE",
    isLive: true,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "ASI EZLive #9000-series: Point buys 100% DISABLED; power-play & pulled-goalie state transitions",
    validPeriods: LIVE_INPLAY_PERIODS,
    primaryMarkets: ["total", "moneyline", "spread"],
  },
  {
    code: "MLB_Live",
    label: "MLB In-Play (#9000 LIVE)",
    shortLabel: "MLB Live",
    sport: "LIVE",
    isLive: true,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "ASI EZLive #9000-series: Point buys 100% DISABLED; pitch-by-pitch base-out state latency",
    validPeriods: LIVE_INPLAY_PERIODS,
    primaryMarkets: ["moneyline", "total", "spread"],
  },
  {
    code: "Tennis_Tour",
    label: "ATP / WTA / Challenger Tennis",
    shortLabel: "Tennis",
    sport: "Other",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Game/Set handicap & CSLEVEL2 syndicate court-speed steam; point buys blocked",
    validPeriods: [
      {
        code: "game",
        portalPeriodNumber: 0,
        label: "Full Match (P0)",
        shortLabel: "Match",
        allowsPointBuys: false,
      },
      {
        code: "set",
        portalPeriodNumber: 3,
        label: "Set Betting (1st–5th)",
        shortLabel: "Set",
        allowsPointBuys: false,
      },
    ],
    primaryMarkets: ["moneyline", "spread", "total"],
  },
  {
    code: "Combat_Golf",
    label: "UFC / Boxing / PGA Tour",
    shortLabel: "MMA & Golf",
    sport: "Other",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector:
      "Outright / H2H round matchups & method-of-victory props; point buys blocked",
    validPeriods: [
      {
        code: "game",
        portalPeriodNumber: 0,
        label: "Full Event / Fight (P0)",
        shortLabel: "Event",
        allowsPointBuys: false,
      },
      {
        code: "round",
        portalPeriodNumber: 3,
        label: "Round Matchup (R1–R5)",
        shortLabel: "Round",
        allowsPointBuys: false,
      },
    ],
    primaryMarkets: ["moneyline", "total", "spread", "player_prop"],
  },
  {
    code: "Other_General",
    label: "Other / Unclassified Markets",
    shortLabel: "Other",
    sport: "Other",
    isLive: false,
    pointBuyPolicy: "STRICTLY_BLOCKED",
    primaryRiskVector: "Miscellaneous / unlinked exotic wagers",
    validPeriods: [
      {
        code: "game",
        portalPeriodNumber: 0,
        label: "Full Event (P0)",
        shortLabel: "Game",
        allowsPointBuys: false,
      },
    ],
    primaryMarkets: ["moneyline", "spread", "total", "other"],
  },
];

// Fast O(1) lookup tables built once at module load with Object.create(null) + TypedArrays
const SPORT_INDEX_BY_CODE = Object.create(null) as Record<string, number>;
for (let i = 0; i < SPORT_CODES.length; i++) {
  SPORT_INDEX_BY_CODE[SPORT_CODES[i]!] = i;
}

const SUBSPORT_INDEX_BY_CODE = Object.create(null) as Record<string, number>;
export const SUBSPORT_PARENT_SPORT_ID = new Uint8Array(SUBSPORT_COUNT);
export const SUBSPORT_VALID_PERIOD_MASK = new Uint32Array(SUBSPORT_COUNT);
export const SUBSPORT_BUY_ELIGIBLE_PERIOD_MASK = new Uint32Array(
  SUBSPORT_COUNT,
);

const PERIOD_INDEX_BY_CODE = Object.create(null) as Record<string, number>;
for (let i = 0; i < PERIOD_CODES.length; i++) {
  PERIOD_INDEX_BY_CODE[PERIOD_CODES[i]!] = i;
}

const MARKET_INDEX_BY_CODE = Object.create(null) as Record<string, number>;
for (let i = 0; i < MARKET_CODES.length; i++) {
  MARKET_INDEX_BY_CODE[MARKET_CODES[i]!] = i;
}

for (let s = 0; s < SUBSPORT_TAXONOMY_CATALOG.length; s++) {
  const spec = SUBSPORT_TAXONOMY_CATALOG[s]!;
  SUBSPORT_INDEX_BY_CODE[spec.code] = s;
  SUBSPORT_PARENT_SPORT_ID[s] = SPORT_INDEX_BY_CODE[spec.sport] ?? 6;
  let validMask = 0;
  let buyMask = 0;
  for (let p = 0; p < spec.validPeriods.length; p++) {
    const vp = spec.validPeriods[p]!;
    const pid = PERIOD_INDEX_BY_CODE[vp.code];
    if (pid !== undefined) {
      validMask |= 1 << pid;
      if (vp.allowsPointBuys) {
        buyMask |= 1 << pid;
      }
    }
  }
  SUBSPORT_VALID_PERIOD_MASK[s] = validMask;
  SUBSPORT_BUY_ELIGIBLE_PERIOD_MASK[s] = buyMask;
}

export function sportIndexOf(filter: SportFilter | undefined): number {
  if (!filter || filter === "ALL") return -1;
  const idx = SPORT_INDEX_BY_CODE[filter];
  return idx !== undefined ? idx : -1;
}

export function subSportIndexOf(filter: SubSportFilter | undefined): number {
  if (!filter || filter === "ALL") return -1;
  const idx = SUBSPORT_INDEX_BY_CODE[filter];
  return idx !== undefined ? idx : -1;
}

export function periodIndexOf(filter: PeriodFilter | undefined): number {
  if (!filter || filter === "ALL") return -1;
  const idx = PERIOD_INDEX_BY_CODE[filter];
  return idx !== undefined ? idx : -1;
}

export function marketIndexOf(filter: MarketFilter | undefined): number {
  if (!filter || filter === "ALL") return -1;
  const idx = MARKET_INDEX_BY_CODE[filter];
  return idx !== undefined ? idx : -1;
}

export function isPeriodValidForSubSportId(
  subSportId: number,
  periodId: number,
): boolean {
  if (subSportId < 0 || subSportId >= SUBSPORT_COUNT) return true;
  if (periodId < 0 || periodId >= PERIOD_COUNT) return false;
  return (
    ((SUBSPORT_VALID_PERIOD_MASK[subSportId] ?? 0) & (1 << periodId)) !== 0
  );
}

export function isPeriodValidForSportId(
  sportId: number,
  periodId: number,
): boolean {
  if (sportId < 0 || sportId >= SPORT_COUNT) return true;
  if (periodId < 0 || periodId >= PERIOD_COUNT) return false;
  let unionMask = 0;
  for (let s = 0; s < SUBSPORT_COUNT; s++) {
    if (SUBSPORT_PARENT_SPORT_ID[s] === sportId) {
      unionMask |= SUBSPORT_VALID_PERIOD_MASK[s] ?? 0;
    }
  }
  return (unionMask & (1 << periodId)) !== 0;
}

export function getValidPeriodsForSelection(
  sportId: number,
  subSportId: number,
): readonly SubSportPeriodSpec[] {
  if (subSportId >= 0 && subSportId < SUBSPORT_COUNT) {
    return SUBSPORT_TAXONOMY_CATALOG[subSportId]!.validPeriods;
  }
  const out: SubSportPeriodSpec[] = [];
  let seenMask = 0;
  for (let s = 0; s < SUBSPORT_COUNT; s++) {
    if (sportId >= 0 && SUBSPORT_PARENT_SPORT_ID[s] !== sportId) continue;
    const periods = SUBSPORT_TAXONOMY_CATALOG[s]!.validPeriods;
    for (let p = 0; p < periods.length; p++) {
      const vp = periods[p]!;
      const pid = PERIOD_INDEX_BY_CODE[vp.code] ?? 0;
      if ((seenMask & (1 << pid)) === 0) {
        seenMask |= 1 << pid;
        out.push({
          code: vp.code,
          portalPeriodNumber: vp.portalPeriodNumber,
          label: PERIOD_DEFAULT_LABELS[pid] ?? vp.label,
          shortLabel: vp.shortLabel,
          allowsPointBuys:
            pid === PERIOD_ID_GAME &&
            (sportId === -1 ||
              sportId === SPORT_ID_FOOTBALL ||
              sportId === SPORT_ID_BASKETBALL),
        });
      }
    }
  }
  return out;
}

export function resolveSlicePolicyAndRisk(
  sportId: number,
  subSportId: number,
  periodId: number,
  marketId: number,
  holdPct: number,
  buyLegs: number,
): {
  readonly pointBuyPolicy: PointBuyPolicy;
  readonly riskStatus: TaxonomyRiskStatus;
  readonly primaryRiskVector: string;
} {
  // Specific SubSport overrides
  const subSpec =
    subSportId >= 0 && subSportId < SUBSPORT_COUNT
      ? SUBSPORT_TAXONOMY_CATALOG[subSportId]!
      : null;

  const effectiveSport =
    sportId >= 0
      ? sportId
      : subSpec !== null
        ? (SPORT_INDEX_BY_CODE[subSpec.sport] ?? -1)
        : -1;

  // Derivative period (anything other than ALL=-1 or Game=0) strictly blocks point buys
  if (periodId > PERIOD_ID_GAME) {
    return {
      pointBuyPolicy: "STRICTLY_BLOCKED",
      riskStatus: "IMMUNE_BLOCKED",
      primaryRiskVector:
        "Derivative period (P1–P6 / F5 / Set / Round): Point buying is 100% locked out; monitor correlated steam & stale derivative limits",
    };
  }

  // Non-buy market types (moneyline, team_total, player_prop, other)
  if (
    marketId === MARKET_ID_MONEYLINE ||
    marketId === MARKET_ID_TEAM_TOTAL ||
    marketId === MARKET_ID_PLAYER_PROP ||
    marketId === MARKET_ID_OTHER
  ) {
    return {
      pointBuyPolicy: "STRICTLY_BLOCKED",
      riskStatus: "IMMUNE_BLOCKED",
      primaryRiskVector:
        marketId === MARKET_ID_TEAM_TOTAL || marketId === MARKET_ID_PLAYER_PROP
          ? "Type E Derivative / Prop market: Point buying locked out; guard injury news asymmetry & SGP correlation"
          : "Moneyline / Outright market: Zero point-spread surface; monitor consensus devig lag",
    };
  }

  // LIVE in-play
  if (effectiveSport === SPORT_ID_LIVE || subSpec?.isLive) {
    return {
      pointBuyPolicy: "STRICTLY_BLOCKED",
      riskStatus: "IMMUNE_BLOCKED",
      primaryRiskVector:
        subSpec?.primaryRiskVector ??
        "ASI EZLive #9000-series: Point buys 100% DISABLED in-play; primary risk vector is scoreboard/clock latency",
    };
  }

  // Hockey, Baseball, Soccer, Other -> strictly blocked
  if (
    effectiveSport === SPORT_ID_HOCKEY ||
    effectiveSport === SPORT_ID_BASEBALL ||
    effectiveSport === SPORT_ID_SOCCER ||
    effectiveSport === SPORT_ID_OTHER
  ) {
    return {
      pointBuyPolicy: "STRICTLY_BLOCKED",
      riskStatus: "IMMUNE_BLOCKED",
      primaryRiskVector:
        subSpec?.primaryRiskVector ??
        "Fixed puck/run/Asian handicap or tour market: Point buying strictly blocked by catalog",
    };
  }

  // Basketball (Game Spread or Total) -> House Hold Advantage
  if (effectiveSport === SPORT_ID_BASKETBALL) {
    return {
      pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
      riskStatus: "DESK_ADVANTAGE",
      primaryRiskVector:
        subSpec?.primaryRiskVector ??
        "Smooth bell-curve scoring (σ ≈ 12): 0.5pt fair value is ~3.2¢ (-117) vs 10¢ (-120) retail charge (+6.5¢ pure house edge)",
    };
  }

  // Football Totals -> Positive Hold
  if (effectiveSport === SPORT_ID_FOOTBALL && marketId === MARKET_ID_TOTAL) {
    return {
      pointBuyPolicy: "HOUSE_HOLD_ADVANTAGE",
      riskStatus: "POSITIVE_HOLD",
      primaryRiskVector:
        "Football Game Totals (P0): Weak key-number clustering (41/44/47); -120 retail half-point buys yield net positive house hold",
    };
  }

  // Football (or ALL sports inclusive of Football Game Spreads)
  const riskStatus: TaxonomyRiskStatus =
    buyLegs > 0 && holdPct < -2
      ? "CRITICAL_LEAK"
      : buyLegs > 0
        ? "SEVERE_LEAK"
        : "POSITIVE_HOLD";

  return {
    pointBuyPolicy: "KEY_LEAK_EXPOSED",
    riskStatus,
    primaryRiskVector:
      subSpec?.primaryRiskVector ??
      "Football Full-Game Spread (P0): Key 3 (-138 fair) & Key 7 (-132 fair) exposed to -120/-125 retail point-purchase arbitrage",
  };
}

// ---------------------------------------------------------------------------
// Fast Deterministic Leg Classifier (Relational Hints + Description Fallback)
// ---------------------------------------------------------------------------

const TEAM_TOKEN_TO_SUBSPORT = Object.create(null) as Record<string, number>;

function registerTeams(subSportId: number, tokens: readonly string[]): void {
  for (let i = 0; i < tokens.length; i++) {
    TEAM_TOKEN_TO_SUBSPORT[tokens[i]!.toLowerCase()] = subSportId;
  }
}

// 32 NFL Franchises
registerTeams(SUB_ID_NFL, [
  "chiefs",
  "kansas city chiefs",
  "bills",
  "buffalo bills",
  "ravens",
  "baltimore ravens",
  "bengals",
  "cincinnati bengals",
  "browns",
  "cleveland browns",
  "steelers",
  "pittsburgh steelers",
  "texans",
  "houston texans",
  "colts",
  "indianapolis colts",
  "jaguars",
  "jacksonville jaguars",
  "titans",
  "tennessee titans",
  "broncos",
  "denver broncos",
  "chargers",
  "los angeles chargers",
  "raiders",
  "las vegas raiders",
  "dolphins",
  "miami dolphins",
  "patriots",
  "new england patriots",
  "jets",
  "new york jets",
  "eagles",
  "philadelphia eagles",
  "cowboys",
  "dallas cowboys",
  "commanders",
  "washington commanders",
  "packers",
  "green bay packers",
  "lions",
  "detroit lions",
  "vikings",
  "minnesota vikings",
  "bears",
  "chicago bears",
  "falcons",
  "atlanta falcons",
  "panthers",
  "carolina panthers",
  "saints",
  "new orleans saints",
  "buccaneers",
  "tampa bay buccaneers",
  "49ers",
  "san francisco 49ers",
  "rams",
  "los angeles rams",
  "seahawks",
  "seattle seahawks",
  "arizona cardinals",
]);

// 30 NBA Franchises
registerTeams(SUB_ID_NBA, [
  "lakers",
  "los angeles lakers",
  "celtics",
  "boston celtics",
  "warriors",
  "golden state warriors",
  "knicks",
  "new york knicks",
  "76ers",
  "sixers",
  "philadelphia 76ers",
  "nets",
  "brooklyn nets",
  "raptors",
  "toronto raptors",
  "bulls",
  "chicago bulls",
  "cavaliers",
  "cavs",
  "cleveland cavaliers",
  "pistons",
  "detroit pistons",
  "pacers",
  "indiana pacers",
  "bucks",
  "milwaukee bucks",
  "hawks",
  "atlanta hawks",
  "hornets",
  "charlotte hornets",
  "heat",
  "miami heat",
  "magic",
  "orlando magic",
  "wizards",
  "washington wizards",
  "nuggets",
  "denver nuggets",
  "timberwolves",
  "minnesota timberwolves",
  "thunder",
  "oklahoma city thunder",
  "trail blazers",
  "blazers",
  "portland trail blazers",
  "jazz",
  "utah jazz",
  "clippers",
  "la clippers",
  "los angeles clippers",
  "suns",
  "phoenix suns",
  "kings",
  "sacramento kings",
  "mavericks",
  "mavs",
  "dallas mavericks",
  "rockets",
  "houston rockets",
  "grizzlies",
  "memphis grizzlies",
  "pelicans",
  "new orleans pelicans",
  "spurs",
  "san antonio spurs",
]);

// WNBA Franchises
registerTeams(SUB_ID_WNBA, [
  "liberty",
  "new york liberty",
  "lynx",
  "minnesota lynx",
  "aces",
  "las vegas aces",
  "connecticut sun",
  "storm",
  "seattle storm",
  "fever",
  "indiana fever",
  "mercury",
  "phoenix mercury",
  "chicago sky",
  "mystics",
  "washington mystics",
  "sparks",
  "los angeles sparks",
  "dallas wings",
  "atlanta dream",
  "valkyries",
]);

// 32 NHL Franchises
registerTeams(SUB_ID_NHL, [
  "avalanche",
  "colorado avalanche",
  "flames",
  "calgary flames",
  "hurricanes",
  "carolina hurricanes",
  "blackhawks",
  "chicago blackhawks",
  "predators",
  "nashville predators",
  "mammoth",
  "utah mammoth",
  "uta mammoth",
  "blues",
  "st. louis blues",
  "winnipeg jets",
  "ducks",
  "anaheim ducks",
  "sharks",
  "san jose sharks",
  "stars",
  "dallas stars",
  "wild",
  "minnesota wild",
  "penguins",
  "pittsburgh penguins",
  "devils",
  "new jersey devils",
  "rangers",
  "new york rangers",
  "islanders",
  "new york islanders",
  "bruins",
  "boston bruins",
  "sabres",
  "buffalo sabres",
  "red wings",
  "detroit red wings",
  "senators",
  "ottawa senators",
  "maple leafs",
  "toronto maple leafs",
  "canadiens",
  "montreal canadiens",
  "lightning",
  "tampa bay lightning",
  "florida panthers",
  "blue jackets",
  "columbus blue jackets",
  "flyers",
  "philadelphia flyers",
  "capitals",
  "washington capitals",
  "kraken",
  "seattle kraken",
  "canucks",
  "vancouver canucks",
  "oilers",
  "edmonton oilers",
  "golden knights",
  "vegas golden knights",
  "coyotes",
]);

// 30 MLB Franchises
registerTeams(SUB_ID_MLB, [
  "yankees",
  "new york yankees",
  "dodgers",
  "los angeles dodgers",
  "mets",
  "new york mets",
  "braves",
  "atlanta braves",
  "phillies",
  "philadelphia phillies",
  "padres",
  "san diego padres",
  "rockies",
  "colorado rockies",
  "marlins",
  "miami marlins",
  "astros",
  "houston astros",
  "red sox",
  "boston red sox",
  "cubs",
  "chicago cubs",
  "white sox",
  "chicago white sox",
  "guardians",
  "cleveland guardians",
  "orioles",
  "baltimore orioles",
  "twins",
  "minnesota twins",
  "brewers",
  "milwaukee brewers",
  "tigers",
  "detroit tigers",
  "royals",
  "kansas city royals",
  "mariners",
  "seattle mariners",
  "rays",
  "tampa bay rays",
  "blue jays",
  "toronto blue jays",
  "reds",
  "cincinnati reds",
  "pirates",
  "pittsburgh pirates",
  "diamondbacks",
  "arizona diamondbacks",
  "athletics",
  "angels",
  "los angeles angels",
  "nationals",
  "washington nationals",
  "st. louis cardinals",
  "san francisco giants",
  "texas rangers",
]);

// Major NCAA Football / Basketball power programs (disambiguated by sport/total when needed)
registerTeams(SUB_ID_NCAAF, [
  "texas",
  "lsu",
  "mississippi",
  "ole miss",
  "ohio st",
  "ohio state",
  "texas tech",
  "oregon",
  "louisville",
  "tennessee",
  "smu",
  "clemson",
  "notre dame",
  "georgia",
  "alabama",
  "iowa",
  "usc",
  "colorado",
  "mississippi st",
  "penn st",
  "penn state",
  "michigan",
  "florida",
  "florida st",
  "miami fl",
  "oklahoma",
  "texas a&m",
  "auburn",
  "arkansas",
  "kentucky",
  "south carolina",
  "missouri",
  "vanderbilt",
  "washington",
  "ucla",
  "indiana",
  "illinois",
  "wisconsin",
  "nebraska",
  "minnesota",
  "purdue",
  "rutgers",
  "maryland",
  "byu",
  "utah",
  "kansas st",
  "kansas",
  "iowa st",
  "baylor",
  "tcu",
  "west virginia",
  "ucf",
  "cincinnati",
  "arizona st",
  "arizona",
  "boise st",
  "unlv",
  "tulane",
  "army",
  "navy",
  "duke",
  "north carolina",
  "nc state",
  "virginia tech",
  "virginia",
  "pittsburgh",
  "syracuse",
  "boston college",
  "stanford",
  "california",
  "wake forest",
  "georgia tech",
]);

export interface ClassifiedLegCoords {
  readonly sportId: number;
  readonly subSportId: number;
  readonly periodId: number;
  readonly marketId: number;
  readonly hasPointBuy: boolean;
}

const LIVE_MARKER_RE = /\(live\)|\blive\b/i;
const ROTATION_RE = /#(\d{3,5})\b/;
const OVER_UNDER_LINE_RE =
  /\b(?:over|under|o|u)\s+(\d+(?:\.\d+)?|\d*\s*[½¼¾])/i;
const SPREAD_ODDS_RE =
  /(?:point\s+spread|[+-]\s*(?:\d+(?:\.\d+)?|\d*\s*[½¼¾])\s+[+-]\d{3,4})/i;
const PLAYER_PROP_RE =
  /\b(?:pts\s*\+\s*reb|points|rebounds|assists|passing\s+yards|rushing\s+yards|receiving\s+yards|receptions|strikeouts|shots\s+on\s+goal|touchdown\s+scorer|anytime\s+td)\b|\|\s*(?:basketball|football|baseball|hockey)/i;
const TEAM_TOTAL_RE = /\bteam\s+total\b/i;
const ALTER_RE = /\bhockey\s+alter\b|\balt\s+(?:puck|spread|total)/i;
const ANY_BUYING_RE =
  /\bbuying\s+[+-]?(?:\d+\s*[½¼¾]|\d+(?:\.\d+)?|[½¼¾])(?=\s|$)/i;

function mapLiveSubSport(baseSubId: number): number {
  if (baseSubId === SUB_ID_NFL) return SUB_ID_NFL_LIVE;
  if (baseSubId === SUB_ID_NCAAF) return SUB_ID_NCAAF_LIVE;
  if (
    baseSubId === SUB_ID_NBA ||
    baseSubId === SUB_ID_NCAAB ||
    baseSubId === SUB_ID_WNBA
  ) {
    return SUB_ID_NBA_LIVE;
  }
  if (baseSubId === SUB_ID_NHL || baseSubId === SUB_ID_HOCKEY_ALTER) {
    return SUB_ID_NHL_LIVE;
  }
  if (baseSubId === SUB_ID_MLB || baseSubId === SUB_ID_BASEBALL_SERIES) {
    return SUB_ID_MLB_LIVE;
  }
  return SUB_ID_NFL_LIVE;
}

function detectPeriodFromText(desc: string, subSportId: number): number {
  const lower = desc.toLowerCase();
  if (lower.includes("1st 5") || lower.includes("first 5")) {
    return PERIOD_ID_F5;
  }
  if (/\b[1-9](?:st|nd|rd|th)\s+inning\b/.test(lower)) {
    return PERIOD_ID_INNING;
  }
  if (lower.includes("1st half") || lower.includes("first half")) {
    return PERIOD_ID_1H;
  }
  if (lower.includes("2nd half") || lower.includes("second half")) {
    return PERIOD_ID_2H;
  }
  if (lower.includes("1st quarter") || /\b1q\b/.test(lower)) {
    return PERIOD_ID_1Q;
  }
  if (lower.includes("2nd quarter") || /\b2q\b/.test(lower)) {
    return PERIOD_ID_2Q;
  }
  if (lower.includes("3rd quarter") || /\b3q\b/.test(lower)) {
    return PERIOD_ID_3Q;
  }
  if (lower.includes("4th quarter") || /\b4q\b/.test(lower)) {
    return PERIOD_ID_4Q;
  }
  if (lower.includes("1st period")) return PERIOD_ID_P1;
  if (lower.includes("2nd period")) return PERIOD_ID_P2;
  if (lower.includes("3rd period")) return PERIOD_ID_P3;
  if (
    subSportId === SUB_ID_NHL &&
    (lower.includes("reg time") || lower.includes("regulation"))
  ) {
    return PERIOD_ID_REG;
  }
  if (/\b[1-5](?:st|nd|rd|th)\s+set\b/.test(lower)) {
    return PERIOD_ID_SET;
  }
  if (/\bround\s+[1-5]\b/.test(lower)) {
    return PERIOD_ID_ROUND;
  }
  return PERIOD_ID_GAME;
}

function coerceValidPeriodForSubSport(
  subSportId: number,
  periodId: number,
): number {
  if (isPeriodValidForSubSportId(subSportId, periodId)) {
    return periodId;
  }
  // Map quarter <-> hockey period if needed
  if (subSportId === SUB_ID_NHL) {
    if (periodId === PERIOD_ID_1Q || periodId === PERIOD_ID_1H)
      return PERIOD_ID_P1;
    if (periodId === PERIOD_ID_2Q || periodId === PERIOD_ID_2H)
      return PERIOD_ID_P2;
    if (periodId === PERIOD_ID_3Q) return PERIOD_ID_P3;
    return PERIOD_ID_GAME;
  }
  if (subSportId === SUB_ID_NCAAB) {
    if (periodId === PERIOD_ID_1Q || periodId === PERIOD_ID_2Q)
      return PERIOD_ID_1H;
    if (periodId === PERIOD_ID_3Q || periodId === PERIOD_ID_4Q)
      return PERIOD_ID_2H;
    return PERIOD_ID_GAME;
  }
  if (subSportId === SUB_ID_MLB) {
    if (periodId === PERIOD_ID_1H) return PERIOD_ID_F5;
    return PERIOD_ID_GAME;
  }
  return PERIOD_ID_GAME;
}

function inferLeadTeamSubSport(
  desc: string,
  dynamicTeamMap?: Record<string, number>,
): number {
  // Strip optional compact prefix like "S.Football #185 " or "Football #112 "
  let cleaned = desc
    .replace(/^[A-Z]\.[A-Za-z ]+#\d+\s+/i, "")
    .replace(/^[A-Za-z ]+#\d+\s+/i, "")
    .replace(/\(live\)/gi, "")
    .trim();

  // Extract token before double-space, signed line, O/U, or " vs "
  const vsIdx = cleaned.toLowerCase().indexOf(" vs ");
  if (vsIdx > 0) {
    const afterDash = cleaned.indexOf(" - ");
    const leftSide =
      afterDash > 0 && afterDash < vsIdx
        ? cleaned.slice(afterDash + 3, vsIdx).trim()
        : cleaned.slice(0, vsIdx).trim();
    cleaned = leftSide;
  } else {
    const cutMatch = /\s{2,}|\s+[+-]?\d|\s+(?:O|U|Over|Under)\s+\d/i.exec(
      cleaned,
    );
    if (cutMatch !== null && cutMatch.index > 0) {
      cleaned = cleaned.slice(0, cutMatch.index).trim();
    }
  }

  const lower = cleaned.toLowerCase();
  if (lower === "") return -1;

  const direct = TEAM_TOKEN_TO_SUBSPORT[lower];
  if (direct !== undefined) return direct;

  if (dynamicTeamMap) {
    const dyn = dynamicTeamMap[lower];
    if (dyn !== undefined) return dyn;
  }

  // Try first word or two-word prefix for two-team compact totals like "76ers Rockets O 226.5" or "Flames Avalanche O 6.5"
  const words = lower.split(/\s+/);
  if (words.length >= 1) {
    const w1 = TEAM_TOKEN_TO_SUBSPORT[words[0]!];
    if (w1 !== undefined) return w1;
    if (dynamicTeamMap && dynamicTeamMap[words[0]!] !== undefined) {
      return dynamicTeamMap[words[0]!]!;
    }
  }
  if (words.length >= 2) {
    const w12 = `${words[0]} ${words[1]}`;
    const m12 = TEAM_TOKEN_TO_SUBSPORT[w12];
    if (m12 !== undefined) return m12;
    const wLast = TEAM_TOKEN_TO_SUBSPORT[words[words.length - 1]!];
    if (wLast !== undefined) return wLast;
  }
  return -1;
}

export function classifyLegIntoTaxonomy(input: {
  readonly rawDescription: string;
  readonly sportCode?: string | null | undefined;
  readonly leagueName?: string | null | undefined;
  readonly marketPeriod?: string | null | undefined;
  readonly marketType?: string | null | undefined;
  readonly hasPositiveBuyPoints: boolean;
  readonly dynamicTeamMap?: Record<string, number> | undefined;
}): ClassifiedLegCoords {
  const desc = input.rawDescription ?? "";
  const lowerDesc = desc.toLowerCase();
  const hasAnyBuy = input.hasPositiveBuyPoints || ANY_BUYING_RE.test(desc);

  // Detect live state from rotation #9000-9999 or "(Live)"
  let isLive = LIVE_MARKER_RE.test(desc);
  let rotNum = 0;
  const rotMatch = ROTATION_RE.exec(desc);
  if (rotMatch !== null) {
    rotNum = Number(rotMatch[1]);
    if (rotNum >= 9000 && rotNum <= 9999) {
      isLive = true;
    }
  }

  let subSportId = -1;
  let periodId = -1;
  let marketId = -1;

  // 1. Primary Relational SQLite Classification (when selection_id IS NOT NULL)
  if (input.sportCode || input.leagueName) {
    const sp = (input.sportCode ?? "").toLowerCase();
    const lg = (input.leagueName ?? "").toUpperCase();

    if (lg.startsWith("1H-")) {
      periodId = PERIOD_ID_1H;
    } else if (lg.startsWith("2H-")) {
      periodId = PERIOD_ID_2H;
    } else if (lg.startsWith("F5-")) {
      periodId = PERIOD_ID_F5;
    } else if (lg.startsWith("ROUND-")) {
      periodId = PERIOD_ID_ROUND;
    }

    if (sp === "football") {
      subSportId =
        lg.includes("NCAAF") || lg.includes("CFB") ? SUB_ID_NCAAF : SUB_ID_NFL;
    } else if (sp === "basketball") {
      if (lg.includes("WNBA")) subSportId = SUB_ID_WNBA;
      else if (lg.includes("NCAAB") || lg.includes("CBB"))
        subSportId = SUB_ID_NCAAB;
      else subSportId = SUB_ID_NBA;
    } else if (sp === "hockey") {
      subSportId = ALTER_RE.test(desc) ? SUB_ID_HOCKEY_ALTER : SUB_ID_NHL;
    } else if (sp === "baseball") {
      subSportId = lg === "SERIES" ? SUB_ID_BASEBALL_SERIES : SUB_ID_MLB;
    } else if (sp === "soccer") {
      subSportId = SUB_ID_SOCCER_TOP;
    } else if (sp === "tennis") {
      subSportId = SUB_ID_TENNIS_TOUR;
    } else if (sp === "fighting" || sp === "golf") {
      subSportId = SUB_ID_COMBAT_GOLF;
    } else {
      subSportId = SUB_ID_OTHER_GENERAL;
    }

    if (periodId === -1 && input.marketPeriod) {
      const mp = input.marketPeriod.toLowerCase();
      if (mp === "full_game" || mp === "extras") periodId = PERIOD_ID_GAME;
      else if (mp === "1h") periodId = PERIOD_ID_1H;
      else if (mp === "2h") periodId = PERIOD_ID_2H;
      else if (mp === "f5") periodId = PERIOD_ID_F5;
      else if (mp === "round") periodId = PERIOD_ID_ROUND;
      else if (mp === "set") periodId = PERIOD_ID_SET;
    }

    if (input.marketType) {
      const mt = input.marketType.toLowerCase();
      if (mt === "spread") marketId = MARKET_ID_SPREAD;
      else if (mt === "total") marketId = MARKET_ID_TOTAL;
      else if (mt === "moneyline") marketId = MARKET_ID_MONEYLINE;
      else if (mt === "team_total") marketId = MARKET_ID_TEAM_TOTAL;
      else if (mt === "prop" || mt === "player_prop")
        marketId = MARKET_ID_PLAYER_PROP;
      else marketId = MARKET_ID_OTHER;
    }
  }

  // 2. Deterministic Description Fallback (when unlinked or missing fields)
  if (subSportId === -1) {
    const teamSub = inferLeadTeamSubSport(desc, input.dynamicTeamMap);

    if (lowerDesc.includes("football")) {
      if (teamSub === SUB_ID_NFL) subSportId = SUB_ID_NFL;
      else if (teamSub === SUB_ID_NCAAF) subSportId = SUB_ID_NCAAF;
      else if (rotNum >= 301 && rotNum <= 449) subSportId = SUB_ID_NCAAF;
      else if (rotNum >= 151 && rotNum <= 209) subSportId = SUB_ID_NCAAF;
      else subSportId = SUB_ID_NFL;
    } else if (lowerDesc.includes("basketball")) {
      if (lowerDesc.includes("wnba") || teamSub === SUB_ID_WNBA) {
        subSportId = SUB_ID_WNBA;
      } else if (
        lowerDesc.includes("ncaa") ||
        teamSub === SUB_ID_NCAAF ||
        (rotNum >= 601 && rotNum <= 899)
      ) {
        subSportId = SUB_ID_NCAAB;
      } else {
        subSportId = SUB_ID_NBA;
      }
    } else if (lowerDesc.includes("hockey")) {
      subSportId = ALTER_RE.test(desc) ? SUB_ID_HOCKEY_ALTER : SUB_ID_NHL;
    } else if (lowerDesc.includes("baseball") || lowerDesc.includes("mlb")) {
      subSportId = SUB_ID_MLB;
    } else if (lowerDesc.includes("soccer")) {
      subSportId = SUB_ID_SOCCER_TOP;
    } else if (lowerDesc.includes("tennis")) {
      subSportId = SUB_ID_TENNIS_TOUR;
    } else if (
      lowerDesc.includes("ufc") ||
      lowerDesc.includes("mma") ||
      lowerDesc.includes("boxing") ||
      lowerDesc.includes("golf")
    ) {
      subSportId = SUB_ID_COMBAT_GOLF;
    } else if (teamSub !== -1) {
      // Disambiguate NCAA school names on high basketball totals (> 98 points)
      if (teamSub === SUB_ID_NCAAF) {
        const ouMatch = OVER_UNDER_LINE_RE.exec(desc);
        const totVal = ouMatch ? Number(ouMatch[1]) : 0;
        subSportId = totVal > 98 ? SUB_ID_NCAAB : SUB_ID_NCAAF;
      } else {
        subSportId = teamSub;
      }
    } else if (hasAnyBuy) {
      // Unrecognized team with point buy: check total magnitude (> 105 -> Basketball, else Football)
      const ouMatch = OVER_UNDER_LINE_RE.exec(desc);
      const totVal = ouMatch ? Number(ouMatch[1]) : 0;
      subSportId = totVal > 105 ? SUB_ID_NBA : SUB_ID_NCAAF;
    } else {
      subSportId = SUB_ID_OTHER_GENERAL;
    }
  }

  // Promote to LIVE SubSport if live marker or #9000-series rotation detected
  if (isLive) {
    subSportId = mapLiveSubSport(subSportId);
  }

  // Refine period from text if not set or if text explicitly names a sub-period
  const textPeriod = detectPeriodFromText(desc, subSportId);
  if (periodId === -1 || (periodId === PERIOD_ID_GAME && textPeriod !== 0)) {
    periodId = textPeriod;
  }
  periodId = coerceValidPeriodForSubSport(subSportId, periodId);

  // Refine market type from text if needed
  if (TEAM_TOTAL_RE.test(desc)) {
    marketId = MARKET_ID_TEAM_TOTAL;
  } else if (PLAYER_PROP_RE.test(desc)) {
    marketId = MARKET_ID_PLAYER_PROP;
  } else if (marketId === -1) {
    if (
      OVER_UNDER_LINE_RE.test(desc) ||
      lowerDesc.includes("total over") ||
      lowerDesc.includes("total under")
    ) {
      marketId = MARKET_ID_TOTAL;
    } else if (hasAnyBuy || SPREAD_ODDS_RE.test(desc)) {
      marketId = MARKET_ID_SPREAD;
    } else if (
      lowerDesc.includes("winner") ||
      lowerDesc.includes("money line") ||
      /[+-]\d{3,4}/.test(desc)
    ) {
      marketId = MARKET_ID_MONEYLINE;
    } else {
      marketId = MARKET_ID_OTHER;
    }
  }

  const sportId = SUBSPORT_PARENT_SPORT_ID[subSportId] ?? SPORT_ID_OTHER;

  return {
    sportId,
    subSportId,
    periodId,
    marketId,
    hasPointBuy: hasAnyBuy,
  };
}
