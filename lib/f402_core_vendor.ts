/**
 * @file f402_core_vendor.ts
 * @description Specification-Grade TypeScript definitions and canonical logic ported directly
 * from the vendor's core AMD module (`core/class` / `app/util/util.js` v43.0.27).
 *
 * Pinned source artifact:
 *   - File: `verification/manager-boot-oracle/pinned/util.js`
 *   - SHA-256: `fba79858f48951d827b4fbb6db27531bb15cc519ae55d47e29848e066adf2ec0`
 *   - Vendor Version: 43.0.27
 */

export const F402_CORE_VENDOR_VERSION = "43.0.27" as const;
export const F402_CORE_VENDOR_UTIL_SHA256 =
  "fba79858f48951d827b4fbb6db27531bb15cc519ae55d47e29848e066adf2ec0" as const;

/** Vendor base endpoints & service paths. */
export const F402_VENDOR_PATHS = {
  apiPath: "/cloud/",
  imagePath: "https://cdn.fastassets.io/images/",
  logoPath: "https://cdn.fastassets.io/images/team-logos/",
  filePathJSON: "/app/file/json/",
  captchaUrl: "https://captcha.sportswidgets.pro/cloud/c-render.php",
  pathSportWidgetEZ: "wss://ezws.sportswidgets.pro",
  rulesDPUPath: "//cashier.vipclub.lv/apps/external/house-rules.php",
  collegeBookCashierURL:
    "//cashier.vipclub.lv/apps/external/player-cashier/v2/",
  collegeBookReferURL: "//cashier.vipclub.lv/apps/player-portal/rafFrame.php",
  dpuCashierURL: "//cashierm.vipclub.lv/cashier.php",
  dpuBonusURL: "//casino.vipclub.lv/bonus/index.php",
  dpuBannerURL: "//cashier.dealersportsbook.com/resources/modals/modal.php",
  dpuGetVerified:
    "//cashier.dealersportsbook.com/apps/verification/addVerification/verificationModal.php",
} as const;

/** Canonical office identifiers and groups. */
export const F402_OFFICES = {
  DSI: "DSIMA",
  BAS: "BAS",
  GAT: "GAT_",
  GAT_NAME: "GAT",
  XTK: "XTKCH",
  CASHIER_MANAGER: ["SHINBONE-SNAKE"],
  FIXED_PRICE: ["CASTROSP"],
} as const;

/** Vendor backend systems & virtual IDs. */
export const F402_SYSTEMS = {
  ONE: "buck1",
  TWO: "buck2",
  TEST: "test",
  VIRTUAL_LIVE_ID: "BUCK",
} as const;

/** Canonical delimiter & special symbol dictionary (`concat`). */
export const F402_CONCAT = {
  PICK: "PK",
  DECIMAL: "&#189;",
  MINUS: "-",
  PLUS: "+",
  PARAM: "‡",
  PIPE: "|",
  FRACTIONAL: "/",
  HALF_POINT: "½",
  NUM: "#",
  ROOF: "^",
  LINK: "±",
} as const;

/** `BET.TYPE` — Top-level wager types. */
export const F402_BET_TYPE = {
  STRAIGHT: {
    val: "Straight",
    text: "Straight",
    controls: 1,
    char: "S",
    freePlay: "N",
    lg: "L-83",
  },
  PARLAY: {
    val: "Parlay",
    text: "Parlay",
    char: "P",
    controls: 2,
    freePlay: "N",
    lg: "L-84",
  },
  IF_BET: {
    val: "IfBet",
    text: "IfBet",
    controls: 2,
    char: "I",
    freePlay: "N",
    lg: "L-86",
    type: {
      IF_WIN: "N",
      IF_WIN_PUSH: "Y",
    },
  },
  TEASER: {
    val: "Teaser",
    text: "Teaser",
    controls: 2,
    char: "T",
    freePlay: "N",
    lg: "L-85",
  },
  REVERSE: {
    val: "Reverse",
    text: "Reverse",
    controls: 2,
    char: "I",
    freePlay: "N",
    lg: "L-87",
  },
} as const;

/** `BET.SUB_TYPE` — Leg-level proposition / line sub-types. */
export const F402_BET_SUB_TYPE = {
  TOTAL: {
    val: "L",
    text: "total",
    OU: {
      OVER: "O",
      UNDER: "U",
    },
    lg: "L-144",
    optional: "T",
  },
  TEAM_TOTAL: {
    val: "E",
    text: "total-team",
    lg: "L-145",
    optional: "E",
  },
  SPREAD: {
    val: "S",
    text: "spread",
    lg: "L-142",
    optional: "S",
  },
  MONEY: {
    val: "M",
    text: "money",
    lg: "L-143",
    optional: "M",
  },
  LIVE_BETTING: {
    val: "G",
    text: "Live Betting",
  },
} as const;

/** `status` — Bet and system lifecycle status codes. */
export const F402_STATUS = {
  OPEN: "O",
  PENDING: "P",
  WIN: "W",
  LOSS: "L",
  CANCEL: "X",
  PLACED: "A",
  DEPOSIT: "E",
  CIRCLE: "I",
  PAY: "C",
  ZERO_BALANCE: "Z",
  ERROR: 0,
  OK: 1,
} as const;

/** `trans` — Transaction accounting codes and types. */
export const F402_TRANS = {
  DEBIT: "D",
  CREDIT: "C",
  CUSTOMER_DEPOSIT: { type: "E", code: "C" },
  CUSTOMER_WITHDRAWAL: { type: "I", code: "D" },
  CREDIT_ADJUSTMENT: { type: "C", code: "C" },
  DEBIT_ADJUSTMENT: { type: "D", code: "D" },
  FEES_CREDIT: { type: "F", code: "C" },
  FEES_DEBIT: { type: "H", code: "D" },
  PROMO_CREDIT: { type: "B", code: "C" },
  PROMO_DEBIT: { type: "N", code: "D" },
  TRANSFER_CREDIT: { type: "T", code: "C" },
  TRANSFER_DEBIT: { type: "U", code: "D" },
  ZERO_BALANCE_DEBIT: { type: "Z", code: "D" },
  AGENT_DISTRIBUTION: { type: "Q", code: "D", lg: "L-324" },
  RISK_REFUND: { type: "R", code: "C" },
} as const;

/** `commisionType` — Accounting commission types. */
export const F402_COMMISSION_TYPE = {
  Q: "Affiliate Weekly Profit",
  A: "Affiliate Split",
  T: "Affiliate Red Figure",
  P: "Agent Weekly Profit",
  S: "Agent Split",
  R: "Agent Red Figure",
} as const;

/** `commisionTypeAccounting` — Vendor accounting variant. */
export const F402_COMMISSION_TYPE_ACCOUNTING = {
  Q: "Affiliate Weekly Profit",
  A: "Affiliate Split",
  T: "Affiliate Red",
  P: "Agent Weekly Profit",
  S: "Agent Split",
  R: "Agent Red",
} as const;

/** `SPORT` taxonomy constants. */
export const F402_SPORT = {
  FOOTBALL: "FOOTBALL",
  BASKETBALL: "BASKETBALL",
  BASEBALL: "BASEBALL",
  HOCKEY: "HOCKEY",
  GOLF: "GOLF",
  AUTO_RACING: "AUTORACING",
  MARTIAL_ARTS: "MARTIALARTS",
  RUGBY: "RUGBY",
  TENNIS: "TENNIS",
  SOCCER: "SOCCER",
  BOXING: "BOXING",
  OTHER: "OTHER",
  LIVE: "LIVE",
  SUB: {
    NFL: "NFL",
    MLB: "MLB",
    NBA: "NBA",
    NHL: "NHL",
    COLLEGE: "COLLEGE",
    NCAA: "NCAA",
    COLLEXT: "COLLEXT",
    CANADIAN: "CANADIAN",
    NFL_PRESEASON: "NFLPRESEAS",
    NFL_PRESEASON_: "NFL PRESEAS",
    NCAA_EXTRA: "NCAA EXTRA",
  },
} as const;

/** `periodAbrev` — Period short codes. */
export const F402_PERIOD_ABREV = {
  1: "1H",
  2: "2H",
  3: "1Q",
  4: "2Q",
  5: "3Q",
  6: "4Q",
  7: "1P",
  8: "2P",
  9: "3P",
  10: "4P",
} as const;

/** `typePeriod` — Full period labels. */
export const F402_TYPE_PERIOD = {
  GAME: "Game",
  PROP: "Prop",
  FIRST_HALF: "1st Half",
  SECOND_HALF: "2nd Half",
  FIRST_QUARTER: "1st Quarter",
  SECOND_QUARTER: "2nd Quarter",
  THIRD_QUARTER: "3rd Quarter",
  FOURTH_QUARTER: "4th Quarter",
  FIRST_PERIOD: "1st Period",
  SECOND_PERIOD: "2nd Period",
  THIRD_PERIOD: "3rd Period",
  INNINGS: "1st 5 Innings",
} as const;

/** `skins` — Complete dictionary of player-facing site skins. */
export const F402_SKINS = {
  DEFAULT: "",
  VISOR_BASE: "RiseOfSnake",
  VISOR_A: "DPU",
  VISOR_B: "Sisepd",
  VISOR_C: "Buckeye",
  VISOR_D: "IBET",
  VISOR_E: "Ninja Cat",
  VISOR_F: "BLUE-SKY",
  VISOR_G: "MGM",
  VISOR_H: "Vegas Gold",
  VISOR_I: "Neon Lime",
  VISOR_J: "Wager Attack",
  VISOR_K: "Toronto",
  VISOR_EURO: "Euro",
  VISOR_LINE_PROS: "LINEPROS",
  VISOR_GROUP_BEAT_LINES: "BEATLINES",
  VISOR_BET_MELON: "BetMelon",
  VISOR_GOTHAM: "Gotham",
  VISOR_NO_LIMIT_BET: "NoLimitBet",
  VISOR_LATAM: "Latam",
  VISOR_EZ_BETSLIP: "EZ BetSlip",
  VISOR_EZ_CLASSIC: "EZ Classic",
  VISOR_EZ_CLASSIC_MOBILE: "EZ Classic Mobile",
} as const;

/** `skinsAgents` — Agent portal skin overrides. */
export const F402_SKINS_AGENTS = {
  DEFAULT: "",
  CLASSIC: "CLASSIC",
  NEWCLASSIC: "NewClassic",
  TORONTO: "Toronto",
  GROUP_BEAT_LINES: "BEATLINES",
  GOTHAM: "Gotham",
} as const;

/** `parlayRestricion` enum. */
export const F402_PARLAY_RESTRICTION = {
  ALLOW: 0,
  SAME: 1,
  DENY: 2,
} as const;

/** `pitchers` rules. */
export const F402_PITCHERS = {
  LISTED: "Listed",
  ACTION: "Action",
  FIXED: "Fixed",
} as const;

/** `odds` representations. */
export const F402_ODDS = {
  AMERICAN: "A",
  DECIMAL: "D",
  FRACTIONAL: "F",
  DESC: {
    A: "American Odds",
    D: "Decimal Odds",
    F: "Fractional Odds",
  },
} as const;

/** `currency` — Vendor symbol table (27 currencies). */
export const F402_CURRENCY = {
  USD: "$",
  COP: "$",
  PTS: "PTS ",
  EUR: "€",
  CRC: "₡",
  INR: "₹;",
  PHP: "₱",
  KRW: "₩",
  JPY: "¥",
  GBP: "£",
  CAD: "$",
  ARS: "$ ",
  JMD: "$",
  AUD: "$",
  DOP: "$",
  CLP: "$",
  MXP: "$",
  MXN: "$",
  ESP: "€",
  TWD: "$",
  VEB: "Bs",
  SOL: "¤",
  BSF: "Bs",
  BTC: "฿",
  HOM: "L",
  BDT: "BDT",
  GTQ: "GTQ",
} as const;

/** `timeZone` — Portal numeric timezone lookup. */
export const F402_TIMEZONE = {
  0: { SHORT: "EST", FULL: "Eastern" },
  1: { SHORT: "CST", FULL: "Central" },
  2: { SHORT: "MST", FULL: "Mountain" },
  3: { SHORT: "PST", FULL: "Pacific" },
  5: { SHORT: "HST", FULL: "Hawaii St" },
  6: { SHORT: "HST", FULL: "Hawaii St" },
  9.5: { SHORT: "9.5", FULL: "India" },
  10: { SHORT: "BST", FULL: "Bangladesh" },
} as const;

/** `typeAgent` — Agent hierarchy classification. */
export const F402_TYPE_AGENT = {
  M: "Master Agent",
  A: "Agent",
  MASTER: "M",
  AGENT: "A",
} as const;

/** `fixedPrice` — Vendor fixed-juice rule (CASTROSP). */
export const F402_FIXED_PRICE = {
  price: -130,
  minPrice: -101,
  maxPrice: -129,
  office: ["CASTROSP"],
} as const;

/** `domainTicketWriter` — Upstream ticket writer origins. */
export const F402_DOMAIN_TICKET_WRITER = {
  SYSTEM_1: "https://ticketwriter1.com",
  SYSTEM_2: "https://ticketwriter2.com",
  SYSTEM_3: "https://ticketwriter3.com",
} as const;

/** Context passed to `getTypeInfo`. */
export interface WagerTypeInfoContext {
  readonly wagerType: string;
  readonly birdCage?: string | number | null | undefined;
  readonly ARLink?: string | number | null | undefined;
  readonly PlacedOn?: string | null | undefined;
  readonly roundRobin?: number | null | undefined;
}

/**
 * Authoritative vendor implementation of `getTypeInfo(e)`.
 * Maps raw `WagerType` / wire codes into canonical operator labels.
 */
export function getVendorWagerTypeInfo(
  ctx:
    | WagerTypeInfoContext
    | { readonly WagerType: string; [key: string]: unknown },
): string {
  const code = (
    "wagerType" in ctx && typeof ctx.wagerType === "string"
      ? ctx.wagerType
      : String((ctx as { readonly WagerType?: unknown }).WagerType ?? "")
  ).trim();

  let label = "Not available";
  switch (code) {
    case "A":
      label = "Manual Play";
      break;
    case "M":
      label = "Moneyline";
      break;
    case "C":
      label = "Future/Props";
      break;
    case "S":
      label = "Spread";
      break;
    case "T":
      label = "Teaser";
      break;
    case "L":
      label = "Total";
      break;
    case "E":
      label = "Team Total";
      break;
    case "I": {
      const birdCage =
        "birdCage" in ctx
          ? ctx.birdCage
          : ((ctx as Record<string, unknown>)["birdCage"] as
              string | number | null | undefined);
      const arLink =
        "ARLink" in ctx
          ? ctx.ARLink
          : ((ctx as Record<string, unknown>)["ARLink"] as
              string | number | null | undefined);
      if (birdCage == null && arLink == null) {
        label = "If-Bet";
      } else if (String(birdCage) === "1") {
        label = "Action Reverse Box/Birdcage Item  ";
      } else {
        label = "Action Reverse Item";
      }
      break;
    }
    case "P":
      label = "Parlay";
      break;
    case "G": {
      const placedOn = String(
        ("PlacedOn" in ctx
          ? ctx.PlacedOn
          : (ctx as Record<string, unknown>)["PlacedOn"]) ?? "",
      ).trim();
      if (
        placedOn === "EZL - INTERNET" ||
        placedOn === "LIVEBETTINGCWS - ADMIN"
      ) {
        label = "Live Betting";
      } else if (
        placedOn === "GSLIVE" ||
        placedOn === "GSPREMATCH" ||
        placedOn === "PREMATCH"
      ) {
        label = "";
      } else {
        label = "Racebook";
      }
      break;
    }
  }

  const rr =
    "roundRobin" in ctx
      ? Number(ctx.roundRobin ?? 0)
      : Number((ctx as Record<string, unknown>)["roundRobin"] ?? 0);
  if (rr > 0) {
    label = "Round Robin";
  }

  return label;
}

/**
 * Authoritative vendor implementation of `getLineTypeDisplay(subType)`.
 */
export function getVendorLineTypeDisplay(subType: string): string {
  switch (subType) {
    case F402_BET_SUB_TYPE.TOTAL.val:
      return "Total";
    case F402_BET_SUB_TYPE.TEAM_TOTAL.val:
      return "Team Total";
    case F402_BET_SUB_TYPE.SPREAD.val:
      return "Spread";
    case F402_BET_SUB_TYPE.MONEY.val:
      return "MoneyLine";
    default:
      return "";
  }
}

/**
 * Authoritative vendor implementation of `getWagerStatus(e)`.
 */
export function getVendorWagerStatus(wagerStatus: string): string {
  switch (wagerStatus) {
    case "W":
      return "Won";
    case "X":
      return "Cancelled/Pushed ";
    case "L":
      return "Lost";
    default:
      return "Pending";
  }
}

/**
 * Authoritative vendor implementation of `formatPoints(e)`.
 */
export function formatVendorPoints(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value) || typeof value !== "number") {
    return "";
  }
  const trunc = Math.trunc(value);
  const diff = Math.abs(value) - Math.abs(trunc);
  if (value === 0) return "PK";
  if (trunc === 0 && value > 0) return "+½";
  if (trunc === 0 && value < 0) return "-½";
  if (diff >= 0.49 && diff <= 0.51) {
    return `${value > 0 ? "+" : ""}${trunc}½`;
  }
  return `${value > 0 ? "+" : ""}${trunc}`;
}

/**
 * Authoritative vendor implementation of `formatOdds(e)`.
 */
export function formatVendorOdds(
  price: number | null | undefined,
): string | undefined {
  if (price == null || Number.isNaN(price)) return "";
  if (Number.isInteger(price) && price > 0) return `+${price}`;
  if (Number.isInteger(price) && price < 0) return `${price}`;
  return undefined;
}

/**
 * Authoritative vendor implementation of `formatTotalPart(e)`.
 */
export function formatVendorTotalPart(value: number): string {
  const trunc = Math.trunc(value);
  const diff = Math.abs(value) - Math.abs(trunc);
  if (value === 0 && diff === 0) return "PK";
  if (trunc === 0 && diff >= 0.49 && diff <= 0.51) return "½";
  if (diff >= 0.49 && diff <= 0.51) return `${trunc}½`;
  return `${trunc}`;
}

/**
 * Authoritative vendor implementation of `formatTotal(e, t, a)`.
 * Formats standard or Asian split totals with OU prefix and juice.
 */
export function formatVendorTotal(
  points: number | null | undefined,
  odds: number | null | undefined,
  ou: string,
): string {
  if (points == null || odds == null) return "";
  const rem = Math.round(100 * Math.abs(points)) % 100;
  const formattedOdds = formatVendorOdds(odds) ?? "";
  if (rem === 25 || rem === 75) {
    const low = points - 0.25;
    const high = points + 0.25;
    return `${ou} ${formatVendorTotalPart(low)},${formatVendorTotalPart(high)} ${formattedOdds}`;
  }
  return `${ou} ${formatVendorTotalPart(points)} ${formattedOdds}`;
}

/**
 * Authoritative vendor implementation of `formatSpread(e, t, a, i, n)`.
 * Formats standard or Asian split spreads based on favorite / underdog alignment.
 */
export function formatVendorSpread(
  isAsian: boolean,
  points: number,
  odds: number,
  teamId: string,
  fav: string,
): string {
  const rem = Math.round(100 * Math.abs(points)) % 100;
  const isQuarter = (rem === 25 || rem === 75) && isAsian;
  const tNorm = teamId.trim().toUpperCase();
  const fNorm = fav.trim().toUpperCase();
  const isFav = tNorm === fNorm;
  const absPoints = Math.abs(points);
  const formattedOdds = formatVendorOdds(odds) ?? "";

  if (isQuarter) {
    if (isFav) {
      return `${formatVendorPoints(-1 * absPoints + 0.25)},${formatVendorPoints(-1 * absPoints - 0.25)} ${formattedOdds}`;
    }
    return `${formatVendorPoints(absPoints - 0.25)},${formatVendorPoints(absPoints + 0.25)} ${formattedOdds}`;
  }

  if (isFav) {
    return `${formatVendorPoints(-1 * absPoints)} ${formattedOdds}`;
  }
  return `${formatVendorPoints(absPoints)} ${formattedOdds}`;
}

/**
 * Authoritative vendor implementation of `isAsianLine({ type, line })`.
 * Spread quarter-lines end in `.25` or `.75`; totals are Asian when not half-integer multiples.
 */
export function isVendorAsianLine(
  type: "spread" | "total",
  line: number | string,
): boolean {
  const num = typeof line === "number" ? line : parseFloat(line);
  if (Number.isNaN(num)) return false;
  if (type === "spread") {
    const frac = String(num).split(".")[1];
    return frac === "25" || frac === "75";
  }
  return 2 * num !== Math.floor(2 * num);
}

/**
 * Authoritative vendor implementation of `getTotalOU({ OU })`.
 */
export function getVendorTotalOU(ou: string): string {
  switch (ou) {
    case "O":
      return "Ov";
    case "U":
      return "Un";
    default:
      return "";
  }
}

/**
 * Calculate to-win amount per vendor formula.
 */
export function calculateVendorToWinAmount(opts: {
  readonly riskAmt: number;
  readonly priceType: "A" | "D" | "F";
  readonly americanPrice?: number;
  readonly decimalPrice?: number;
  readonly numerator?: number;
  readonly denominator?: number;
}): number {
  switch (opts.priceType) {
    case F402_ODDS.AMERICAN: {
      const a = (opts.americanPrice ?? 0) / 100;
      return a > 0 ? opts.riskAmt * a : (opts.riskAmt / a) * -1;
    }
    case F402_ODDS.DECIMAL:
      return opts.riskAmt * ((opts.decimalPrice ?? 1) - 1);
    case F402_ODDS.FRACTIONAL:
      return (opts.riskAmt * (opts.numerator ?? 0)) / (opts.denominator ?? 1);
    default:
      return 0;
  }
}

/**
 * Calculate to-risk amount per vendor formula.
 */
export function calculateVendorToRiskAmount(opts: {
  readonly riskAmt: number;
  readonly priceType: "A" | "D" | "F";
  readonly americanPrice?: number;
  readonly decimalPrice?: number;
  readonly numerator?: number;
  readonly denominator?: number;
}): number {
  switch (opts.priceType) {
    case F402_ODDS.AMERICAN: {
      const a = 100 / (opts.americanPrice ?? 1);
      return a > 0 ? opts.riskAmt * a : (opts.riskAmt / a) * -1;
    }
    case F402_ODDS.DECIMAL:
      return opts.riskAmt * ((opts.decimalPrice ?? 1) - 1);
    case F402_ODDS.FRACTIONAL:
      return (opts.riskAmt / (opts.numerator ?? 1)) * (opts.denominator ?? 1);
    default:
      return 0;
  }
}
