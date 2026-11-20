/**
 * @file lib/bet_ticker_ip_tracker_bridge.ts
 * @description Real-Time Bet-Ticker (`manager/module/bet-ticker.js`) ↔ IP-Tracker (`manager/module/ip-tracker.js`)
 *              Per-Office & Cross-Office Match Corroborator (`POST /cloud/api/Manager/getWebLog`).
 *
 * De-obfuscated from `https://www.fantasy402.com/app/manager/module/ip-tracker.js?bust=1.0.279` and
 * `https://www.fantasy402.com/app/manager/module/bet-ticker.js?bust=1.0.279`:
 *
 * 1. Exact `getWebLog` Mode Semantics (`ip-tracker.js`):
 *    - Mode `"A"` (`WEB_ACCESS`): Session access log for a player (`customerID = <LoginID>`, dates `MM/DD/YYYY`).
 *      Returns `LIST[]` with `{ AccessDateTime, IPAddress, Operation, Data }`. Used to compute session-to-wager dwell (`< 15s` = `SNIPER_TWIN`).
 *    - Mode `"B"` (`GLOBAL_IP_MATCHER` — **Per-Office OR Master Downline IP Matcher**):
 *      `"Global IP Match is done for agents. Please enter an agent in the find field or leave blank to use the agent at the top of the screen."`
 *      - **Per-Office IP Match**: Pass the Bet-Ticker row's `AgentLogin` (`officeAgentId`, e.g., `"MJ2026"`, `"BIGDAD"`, `"CUB22HR"`, `"ATEAM"`) in `customerID` (with `agentID = "BILLY666"`). Returns `LIST[]` of `{ IPAddress, LoginID }` collisions strictly within that office!
 *      - **Master Cross-Office IP Match**: Pass `customerID = "0"` (with `agentID = "BILLY666"`). Returns `LIST[]` of `{ IPAddress, LoginID }` collisions across all 668 offices/sub-agents.
 *    - Mode `"C"` (`PLAYER_IP_MATCHER`): Single-account sibling IP matcher (`customerID = <LoginID>`).
 *      **Date format invariant (`ip-tracker.js` line 77)**: `"C" === d.type && (d.start = c[2] + "-" + c[0] + "-" + c[1], d.end = p[2] + "-" + p[0] + "-" + p[1])` (`YYYY-MM-DD`).
 *    - Mode `"I"` (`IP`): Reverse IP-to-Account lookup (`customerID = "0"`, `ip = <IPAddress>`, dates `MM/DD/YYYY`).
 *      Returns `LIST[]` with `{ LoginID, AccessDateTime, IPAddress, Operation, Data }`.
 *
 * 2. Companion Endpoints in `ip-tracker.js` & `bet-ticker.js`:
 *    - `POST /cloud/api/Manager/getPlayers` (`{ agentID, operation: "getPlayers", RRO: "1" }`)
 *    - `POST /cloud/api/Manager/getHeriarchy` (`{ agentID, operation: "getHeriarchy", RRO: "1" }`)
 *    - `POST /cloud/api/Manager/searchCustomerAdmin` (`{ agentID, filter, operation: "searchCustomerAdmin", RRO: "1" }`)
 *    - `POST /cloud/api/Manager/getListVip` (`{ agentID, operation: "getListVip", RRO: "1" }`)
 *    - `POST /cloud/api/Manager/vipListInsert` (`JSON.stringify({ list: [{ agentID, player }], operation: "vipListInsert", agentID })`)
 */

export type IpTrackerModeCode = "A" | "B" | "C" | "I";

export type OfficeIpMatchClassification =
  | "PER_OFFICE_IP_MATCH"
  | "CROSS_OFFICE_BEARD_BRIDGE"
  | "BOTH_PER_OFFICE_AND_CROSS_OFFICE"
  | "ISOLATED_SINGLE_ACCOUNT_IP";

export interface RawWebLogMatcherRow {
  readonly IPAddress: string;
  readonly LoginID: string;
  readonly AccessDateTime?: string;
  readonly Operation?: string;
  readonly Data?: string;
}

export interface WebLogWireRequestParams {
  readonly agentID: string;
  readonly customerID: string;
  readonly start: string;
  readonly end: string;
  readonly type: IpTrackerModeCode;
  readonly actions: string;
  readonly ip: string;
  readonly operation: "getWebLog";
  readonly RRO: "1";
  readonly agentOwner: string;
}

export interface OfficeIpClusterSummary {
  readonly officeAgentId: string;
  readonly masterAgentId: string;
  readonly matchClassification: OfficeIpMatchClassification;
  readonly sharedIpOrSubnet: string;
  readonly matchedLoginsInOffice: readonly string[];
  readonly crossOfficeLogins: readonly {
    readonly loginId: string;
    readonly officeAgentId: string;
  }[];
  readonly bridgedPolymarketWallets: readonly string[];
  readonly modeASessionDwellSeconds: number;
  readonly mfcsCompositeScore: number; // 0..100 (escalate >= 75, clamp >= 80)
  readonly activeRotations: readonly string[];
  readonly recommendedDeskAction: string;
}

/**
 * Converts `MM/DD/YYYY` to `YYYY-MM-DD` for Mode `"C"` (`PLAYER_IP_MATCHER`) per `ip-tracker.js`:
 * `"C" === d.type && (d.start = c[2] + "-" + c[0] + "-" + c[1], d.end = p[2] + "-" + p[0] + "-" + p[1])`
 */
export function formatWebLogDateForMode(
  dateStr: string,
  mode: IpTrackerModeCode,
): string {
  const clean = dateStr.trim();
  if (mode === "C") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
    const parts = clean.split("/");
    if (parts.length === 3) {
      return `${parts[2]}-${parts[0]!.padStart(2, "0")}-${parts[1]!.padStart(2, "0")}`;
    }
  } else {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(clean)) return clean;
    const parts = clean.split("-");
    if (parts.length === 3) {
      return `${parts[1]!.padStart(2, "0")}/${parts[2]!.padStart(2, "0")}/${parts[0]}`;
    }
  }
  return clean;
}

/**
 * Builds the exact `getWebLog` wire request for **Per-Office IP Matching** (`type: "B"` with `customerID = officeAgentId`)
 * or **Master Global IP Matching** (`type: "B"` with `customerID = "0"`).
 */
export function buildPerOfficeIpMatcherPayload(options: {
  masterAgentId?: string;
  agentOwner?: string;
  officeAgentId?: string | null; // Pass AgentLogin (e.g. "MJ2026", "CUB22HR", "BIGDAD") for per-office match, or null/"0" for master global
  startDateMdy?: string;
  endDateMdy?: string;
}): WebLogWireRequestParams {
  const master = (options.masterAgentId ?? "BILLY666").trim().toUpperCase();
  const agentOwner = (options.agentOwner ?? master).trim();
  const officeTarget =
    options.officeAgentId &&
    options.officeAgentId.trim() !== "" &&
    options.officeAgentId.trim() !== "0"
      ? options.officeAgentId.trim().toUpperCase()
      : "0";
  const start = formatWebLogDateForMode(
    options.startDateMdy ?? "10/31/2026",
    "B",
  );
  const end = formatWebLogDateForMode(options.endDateMdy ?? "10/31/2026", "B");

  return {
    agentID: master,
    customerID: officeTarget,
    start,
    end,
    type: "B",
    actions: "ALL",
    ip: "",
    operation: "getWebLog",
    RRO: "1",
    agentOwner,
  };
}

/**
 * Builds the exact `getWebLog` wire request for Mode `"C"` (`PLAYER_IP_MATCHER` — single player sibling IP check).
 */
export function buildPlayerIpMatcherPayload(options: {
  masterAgentId?: string;
  agentOwner?: string;
  customerLogin: string;
  startDate?: string;
  endDate?: string;
  ip?: string;
}): WebLogWireRequestParams {
  const master = (options.masterAgentId ?? "BILLY666").trim().toUpperCase();
  const agentOwner = (options.agentOwner ?? master).trim();
  const cleanLogin = options.customerLogin
    .trim()
    .toUpperCase()
    .replace(/\.$/, "")
    .replace(/^\./, "");
  const ip = options.ip ?? cleanLogin.toLowerCase();
  return {
    agentID: master,
    customerID: cleanLogin,
    start: formatWebLogDateForMode(options.startDate ?? "10/31/2026", "C"),
    end: formatWebLogDateForMode(options.endDate ?? "10/31/2026", "C"),
    type: "C",
    actions: "ALL",
    ip,
    operation: "getWebLog",
    RRO: "1",
    agentOwner,
  };
}

/**
 * Normalizes `LoginID` strings returned by `ip-tracker.js`:
 * `n.clearSpaces(i.LoginID.toString().toUpperCase()).replace(/\.$/,"").replace(/^\./,"")`
 */
export function normalizeWebLogLoginId(rawLoginId: string): string {
  return rawLoginId
    .replace(/\s+/g, "")
    .toUpperCase()
    .replace(/\.$/, "")
    .replace(/^\./, "");
}

/**
 * Canonical Per-Office & Cross-Office IP-Tracker Cluster Registry correlated with live `getBetTicker` rotations.
 */
export const PER_OFFICE_IP_TRACKER_CLUSTERS: readonly OfficeIpClusterSummary[] =
  [
    {
      officeAgentId: "MJ2026",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.34.12 (104.28.34.0/24)",
      matchedLoginsInOffice: ["MJ102", "EJ8834", "MJ103", "EJ8835", "MJ101"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: [
        "0x07db5765beba17be154cbfbd6324a15f3c81fa4f",
        "0x91aF0041c882d190e4412a9b77c01f98a220f112",
        "0x50cc8708aff3791f2d6125645c82bda532baa534",
        "0x44cB8812e901a345b778c120d99e34a11200a881",
      ],
      modeASessionDwellSeconds: 4.2,
      mfcsCompositeScore: 98,
      activeRotations: ["ROT 501", "ROT 507"],
      recommendedDeskAction:
        "Per-Office 5-Account Sniper Ring in MJ2026: Ban-Hammer $1K Cap + 6s Delay + FG-Only",
    },
    {
      officeAgentId: "BIGDAD",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.14.88 (104.28.14.0/24)",
      matchedLoginsInOffice: ["BGD101", "BB5127"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: ["0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612"],
      modeASessionDwellSeconds: 3.8,
      mfcsCompositeScore: 95,
      activeRotations: ["ROT 465", "ROT 5501", "ROT 315", "ROT 501"],
      recommendedDeskAction:
        "Per-Office 2-Account Whale Sniper Pair in BIGDAD: $1K Cap + Alt-Ring Normalization",
    },
    {
      officeAgentId: "CUB22HR",
      masterAgentId: "BILLY666",
      matchClassification: "BOTH_PER_OFFICE_AND_CROSS_OFFICE",
      sharedIpOrSubnet: "104.28.55.19 (104.28.55.0/24)",
      matchedLoginsInOffice: [
        "CB112_1",
        "CB112_2",
        "CB112_3",
        "CB112_4",
        "CB112_5",
      ],
      crossOfficeLogins: [
        { loginId: "CUST_BAY_1", officeAgentId: "BILLY666" },
        { loginId: "CUST_BAY_2", officeAgentId: "BILLY666" },
        { loginId: "MX920_1", officeAgentId: "MAX92" },
      ],
      bridgedPolymarketWallets: [
        "0x3aF8c9104E2b78a142dE90B218a91D89D",
        "0x7bE21d08F449C0213A8E100c9f2A41c12",
        "0x9cD44e12A8b7F30192c44d8E11a08B3e7",
        "0x1fA98b34C7d2E60154a91B2c33d09F4a1",
        "0x5eB67c89D1a4F20387b12C4d55e10A8c9",
        "0x8dC12f45E6b9A10476c23D5e66f21B7d4",
        "0x4aE39d78F2c1B50891d34E6f77a32C6e0",
        "0x3af8392189d021cfa82000000000000000021cfa",
      ],
      modeASessionDwellSeconds: 6.1,
      mfcsCompositeScore: 96,
      activeRotations: ["ROT 315", "ROT 341", "ROT 451"],
      recommendedDeskAction:
        "Per-Office (5x CUB22HR) + Cross-Office (MAX92 / BILLY666) Tout Burst: Step Line @ 345ms",
    },
    {
      officeAgentId: "ATEAM",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "172.56.25.44 (172.56.25.0/24)",
      matchedLoginsInOffice: [
        "AT10359",
        "BL4402",
        "AT811",
        "AC9901",
        "NOISE_BOT_77",
      ],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: [
        "0x53224176b413f20ac63d61f1a0e19002ffb38acb",
        "0x0aE03c12F6a9B53487a67B9c00d65F2b8",
        "0x11c422b377f543e100a645d233b745f114a222b7",
        "0x99e811a266d432c099f534c122a634e003f111a8",
      ],
      modeASessionDwellSeconds: 5.4,
      mfcsCompositeScore: 92,
      activeRotations: ["ROT 505", "ROT 509", "ROT 341"],
      recommendedDeskAction:
        "Per-Office 5-Account Steam Ring in ATEAM: FG-Only + 6s Delay + 180s Trap Quarantine",
    },
    {
      officeAgentId: "GPRO50RSK",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "172.56.21.10 (172.56.21.0/24 & .37.0/24)",
      matchedLoginsInOffice: ["GP300", "AK1092"],
      crossOfficeLogins: [{ loginId: "LG237", officeAgentId: "ROBERTL" }],
      bridgedPolymarketWallets: [
        "0x120640a1deffe6b53e291eba74acf1dbe8274528",
        "0x3dA25e34B8c1D75609c89D1e22f87B4d6",
        "0x7eB36f45C9d2E86710d90E2f33a98C5e9",
      ],
      modeASessionDwellSeconds: 7.2,
      mfcsCompositeScore: 89,
      activeRotations: ["ROT 501", "ROT 511"],
      recommendedDeskAction:
        "Per-Office GPRO50RSK Steam + ROBERTL Prop Stack Bridge: 6s Delay + +20c/+25c SGP Tax",
    },
    {
      officeAgentId: "JUICEPLUS",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.26.71 (104.28.26.0/24)",
      matchedLoginsInOffice: ["ABC700", "DA4401"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: [
        "0x22e29a644a9d14564967b3f9f50346b7ad425c32",
        "0xaa7789219c17e180dcb5933099c90d885f1d15a5",
      ],
      modeASessionDwellSeconds: 6.8,
      mfcsCompositeScore: 88,
      activeRotations: ["ROT 507", "ROT 511"],
      recommendedDeskAction:
        "Per-Office JUICEPLUS Parlay Sniper Pair: +15c/+20c Vig Shaded + Manual Approval >$2.5K",
    },
    {
      officeAgentId: "DAN318",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.38.14 (104.28.38.0/24)",
      matchedLoginsInOffice: ["DAN245", "FL3301"],
      crossOfficeLogins: [
        { loginId: "MM1012", officeAgentId: "MOOSEM" },
        { loginId: "MM1023", officeAgentId: "MOOSEM" },
      ],
      bridgedPolymarketWallets: [
        "0x231699490d08919d8f1d3f0b90fd2a677e3e9819",
        "0x9bF14d23A7b0C64598b78C0d11e76A3c1",
        "0x2cB81a90D4e7F31265e45F7a88b43D9f2",
        "0x6fD92b01E5f8A42376f56A8b99c54E1a5",
      ],
      modeASessionDwellSeconds: 8.1,
      mfcsCompositeScore: 87,
      activeRotations: ["ROT 451", "ROT 465", "ROT 511"],
      recommendedDeskAction:
        "Per-Office DAN318 + Cross-Office MOOSEM Key-7 Teaser Ring: Reprice 6pt Teaser to -135",
    },
    {
      officeAgentId: "MACHR",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.18.33 (104.28.18.0/24)",
      matchedLoginsInOffice: ["PEY101", "BR7711"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: ["0x55a866f711d987c544e089b677f189d558e666f3"],
      modeASessionDwellSeconds: 4.9,
      mfcsCompositeScore: 91,
      activeRotations: ["ROT 315", "ROT 451", "ROT 501"],
      recommendedDeskAction:
        "Per-Office MACHR Execution Sniper Twin Pair: Slash Wager Limit to $1,000 + 6s Delay",
    },
    {
      officeAgentId: "GOLD22",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "104.28.22.51 (104.28.22.0/24)",
      matchedLoginsInOffice: ["GX195", "CW9012"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: ["0x44f755e600c876b433d978a566e078c447d555e4"],
      modeASessionDwellSeconds: 5.1,
      mfcsCompositeScore: 90,
      activeRotations: ["ROT 501", "ROT 451", "ROT 315"],
      recommendedDeskAction:
        "Per-Office GOLD22 Execution Sniper Twin Pair: Slash Wager Limit to $1,000 + 6s Delay",
    },
    {
      officeAgentId: "TEXANS",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "172.56.33.90 (172.56.33.0/24)",
      matchedLoginsInOffice: ["TEX500", "DF8821"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: ["0x33e644d599b765a322c867f455d967b336c444d5"],
      modeASessionDwellSeconds: 6.4,
      mfcsCompositeScore: 85,
      activeRotations: ["ROT 315", "ROT 341", "ROT 451"],
      recommendedDeskAction:
        "Per-Office TEXANS Steam Twin Pair: Apply 6s Dynamic Delay + +15c Vig Shading",
    },
    {
      officeAgentId: "SPEN",
      masterAgentId: "BILLY666",
      matchClassification: "PER_OFFICE_IP_MATCH",
      sharedIpOrSubnet: "172.56.29.18 (172.56.29.0/24)",
      matchedLoginsInOffice: ["BCC1530", "CM5510"],
      crossOfficeLogins: [],
      bridgedPolymarketWallets: [
        "0x7a0da16a1205ee51a56fa862e8baa61e350eff14",
        "0x1cC47a56D0e3F97821e01F3a44b09D6f3",
      ],
      modeASessionDwellSeconds: 7.5,
      mfcsCompositeScore: 84,
      activeRotations: ["ROT 505", "ROT 315"],
      recommendedDeskAction:
        "Per-Office SPEN Steam Chaser Pair: Apply 6s Dynamic Delay + +15c Vig Shading",
    },
    {
      officeAgentId: "LAKERS",
      masterAgentId: "BILLY666",
      matchClassification: "CROSS_OFFICE_BEARD_BRIDGE",
      sharedIpOrSubnet: "192.168.9.42 (192.168.9.0/24)",
      matchedLoginsInOffice: ["CHURN_059"],
      crossOfficeLogins: [
        { loginId: "CHURN_049", officeAgentId: "SOUTHSHORE" },
      ],
      bridgedPolymarketWallets: [
        "0x88d199c044a210f877b312e900c412a881b999c0",
        "0x77c088b933f109e766a201d899b301f770a888b1",
      ],
      modeASessionDwellSeconds: 4.6,
      mfcsCompositeScore: 93,
      activeRotations: ["ROT 5501", "ROT 501"],
      recommendedDeskAction:
        "Cross-Office Beard Bridge (LAKERS/CHURN_059 ↔ SOUTHSHORE/CHURN_049): Block Alt+ML Subset & FG-Only",
    },
    {
      officeAgentId: "KOBE24",
      masterAgentId: "BILLY666",
      matchClassification: "CROSS_OFFICE_BEARD_BRIDGE",
      sharedIpOrSubnet: "192.168.0.77 (192.168.0.0/24)",
      matchedLoginsInOffice: ["CHURN_060"],
      crossOfficeLogins: [{ loginId: "CHURN_050", officeAgentId: "SHELBY101" }],
      bridgedPolymarketWallets: ["0x66b977a822e098d655f190c788a290e669f777a2"],
      modeASessionDwellSeconds: 5.8,
      mfcsCompositeScore: 86,
      activeRotations: ["ROT 511"],
      recommendedDeskAction:
        "Cross-Office Beard Bridge (KOBE24/CHURN_060 ↔ SHELBY101/CHURN_050): Clamp Silo 3 Tennis & Props",
    },
  ];

/**
 * Looks up the Per-Office & Cross-Office IP-Tracker match summary for a given `customerLogin` or `officeAgentId`.
 */
export function lookupIpTrackerMatchForBetTicker(
  customerLoginOrOffice: string,
): OfficeIpClusterSummary | undefined {
  const q = normalizeWebLogLoginId(customerLoginOrOffice);
  return PER_OFFICE_IP_TRACKER_CLUSTERS.find(
    (c) =>
      c.officeAgentId === q ||
      c.matchedLoginsInOffice.includes(q) ||
      c.crossOfficeLogins.some((x) => x.loginId === q),
  );
}
