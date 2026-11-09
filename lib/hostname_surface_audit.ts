import url from "node:url";
import type { DiagnosticModeNumber } from "./forensic_diagnostic_modes.ts";

export type EndpointRole = "source" | "sink" | "doc";
export type ConnectTransport =
  "https" | "http" | "wss" | "ws" | "unix" | "none";
export type SocketTransport = "tcp" | "unix" | "none";

export const ModeBit = Object.freeze({
  MODE_1: 1 << 1,
  MODE_2: 1 << 2,
  MODE_3: 1 << 3,
  MODE_4: 1 << 4,
  MODE_5: 1 << 5,
  MODE_6: 1 << 6,
  MODE_7: 1 << 7,
  MODE_8: 1 << 8,
  MODE_9: 1 << 9,
  MODE_10: 1 << 10,
} as const);

export const DomainMask = Object.freeze({
  RISK_EXPOSURE: (1 << 1) | (1 << 8) | (1 << 9),
  IDENTITY_NETWORK: (1 << 2) | (1 << 3) | (1 << 4) | (1 << 5) | (1 << 6),
  CROSS_MARKET: 1 << 7,
  DATA_INTEGRITY: 1 << 10,
  ALL_MODES: 0x07fe,
} as const);

export interface RegisteredEndpointSpec {
  readonly endpointId: string;
  readonly name: string;
  readonly role: EndpointRole;
  readonly rawUrl: string;
  readonly modesMask: number;
  readonly connectTransport: ConnectTransport;
  readonly socketTransport: SocketTransport;
  readonly isUnix?: boolean;
}

export interface AuditedEndpointRow {
  readonly endpointId: string;
  readonly name: string;
  readonly role: EndpointRole;
  readonly rawUrl: string;
  readonly effectiveRoute: string;
  readonly spaHashRoute: string | null;
  readonly spaHashQuery: string | null;
  readonly whatwgHostname: string;
  readonly legacyUrlHostname: string | null;
  readonly isWhatwgAndLegacyHostnameIdentical: boolean | null;
  readonly connectTransport: ConnectTransport;
  readonly socketTransport: SocketTransport;
  readonly modesMask: number;
  readonly modes: readonly DiagnosticModeNumber[];
}

const H_F =
  String.fromCharCode(102, 97, 110, 116, 97, 115, 121, 52, 48, 50) + ".com";
const H_G = String.fromCharCode(
  112,
  108,
  105,
  118,
  101,
  46,
  115,
  112,
  111,
  114,
  116,
  115,
  119,
  105,
  100,
  103,
  101,
  116,
  115,
  46,
  112,
  114,
  111,
);
const H_P = String.fromCharCode(
  112,
  111,
  108,
  121,
  109,
  97,
  114,
  107,
  101,
  116,
  46,
  99,
  111,
  109,
);
const H_R = ["pub-", "d061f943df0e4477", "ba7ff200721eddb1", ".r2.dev"].join(
  "",
);

const epDefsPart1: [
  string,
  string,
  EndpointRole,
  string,
  number,
  ConnectTransport,
  SocketTransport,
  boolean?,
][] = [
  [
    "F402-REST-01",
    "Feed 01",
    "source",
    `https://${H_F}/cloud/api/Report/getDailyFiguresByCustomer`,
    ModeBit.MODE_1 | ModeBit.MODE_8 | ModeBit.MODE_10,
    "https",
    "tcp",
  ],
  [
    "F402-REST-02",
    "Feed 02",
    "source",
    `https://${H_F}/cloud/api/Report/Pending`,
    ModeBit.MODE_1 | ModeBit.MODE_6 | ModeBit.MODE_7 | ModeBit.MODE_9,
    "https",
    "tcp",
  ],
  [
    "F402-REST-03",
    "Feed 03",
    "source",
    `https://${H_F}/cloud/api/Manager/getWebLog`,
    ModeBit.MODE_1 |
      ModeBit.MODE_2 |
      ModeBit.MODE_3 |
      ModeBit.MODE_4 |
      ModeBit.MODE_5 |
      ModeBit.MODE_6,
    "https",
    "tcp",
  ],
  [
    "F402-REST-04",
    "Feed 04",
    "source",
    `https://${H_F}/cloud/api/Manager/getInfoPlayer`,
    ModeBit.MODE_1,
    "https",
    "tcp",
  ],
  [
    "F402-REST-05",
    "Feed 05",
    "source",
    `https://${H_F}/cloud/api/Manager/getBetTicker`,
    ModeBit.MODE_6 | ModeBit.MODE_7,
    "https",
    "tcp",
  ],
  [
    "F402-REST-06",
    "Feed 06",
    "source",
    `https://${H_F}/cloud/api/Report/getGradedWagerByCustomer`,
    ModeBit.MODE_8 | ModeBit.MODE_10,
    "https",
    "tcp",
  ],
  [
    "F402-REST-07",
    "Feed 07",
    "source",
    `https://${H_F}/cloud/api/Report/getGrading`,
    ModeBit.MODE_8,
    "https",
    "tcp",
  ],
  [
    "F402-REST-08",
    "Feed 08",
    "source",
    `https://${H_F}/cloud/api/Report/getTransactions`,
    ModeBit.MODE_8 | ModeBit.MODE_10,
    "https",
    "tcp",
  ],
  [
    "F402-REST-09",
    "Feed 09",
    "source",
    `https://${H_F}/cloud/api/Report/getPendingByTicket`,
    ModeBit.MODE_9,
    "https",
    "tcp",
  ],
  [
    "F402-REST-10",
    "Feed 10",
    "source",
    `https://${H_F}/cloud/api/Manager/getHistory`,
    ModeBit.MODE_8,
    "https",
    "tcp",
  ],
];

const epDefsPart2: [
  string,
  string,
  EndpointRole,
  string,
  number,
  ConnectTransport,
  SocketTransport,
  boolean?,
][] = [
  [
    "GSLIVE-UI-01",
    "Feed GSLIVE-01",
    "source",
    `https://${H_G}/manager-tools/#/reports/users?partnerId=118`,
    ModeBit.MODE_1,
    "https",
    "tcp",
  ],
  [
    "GSLIVE-UI-02",
    "Feed GSLIVE-02",
    "source",
    `https://${H_G}/manager-tools/#/events/bet-history?partnerId=118`,
    ModeBit.MODE_6 | ModeBit.MODE_7,
    "https",
    "tcp",
  ],
  [
    "GSLIVE-API-03",
    "Feed GSLIVE-03",
    "source",
    `https://${H_G}/manager-tools/ajax.php`,
    ModeBit.MODE_1 | ModeBit.MODE_6,
    "https",
    "tcp",
  ],
  [
    "POLY-GAMMA-01",
    "Feed POLY-01",
    "source",
    `https://gamma-api.${H_P}/events`,
    ModeBit.MODE_7,
    "https",
    "tcp",
  ],
  [
    "POLY-CLOB-02",
    "Feed POLY-02",
    "source",
    `https://clob.${H_P}/order`,
    ModeBit.MODE_7,
    "https",
    "tcp",
  ],
  [
    "POLY-CLOB-03",
    "Feed POLY-03",
    "source",
    `wss://ws-subscriptions-clob.${H_P}/ws/market`,
    ModeBit.MODE_7,
    "wss",
    "tcp",
  ],
  [
    "POLY-DATA-04",
    "Feed POLY-04",
    "source",
    `https://data-api.${H_P}/v2/positions`,
    ModeBit.MODE_1 | ModeBit.MODE_7,
    "https",
    "tcp",
  ],
];

const epDefsPart3: [
  string,
  string,
  EndpointRole,
  string,
  number,
  ConnectTransport,
  SocketTransport,
  boolean?,
][] = [
  [
    "LOCAL-UWS-02",
    "Feed LOCAL-02",
    "source",
    "ws://localhost:3000/api/live-bets",
    ModeBit.MODE_1 | ModeBit.MODE_6,
    "ws",
    "tcp",
  ],
  [
    "LOCAL-UNIX-03",
    "Feed LOCAL-03",
    "source",
    "unix://sportsdesk-ops.sock",
    ModeBit.MODE_2 | ModeBit.MODE_6,
    "unix",
    "unix",
    true,
  ],
  [
    "BUN-DOC-01",
    "Doc BUN-01",
    "doc",
    "https://bun.sh/reference/globals/bun",
    0,
    "https",
    "tcp",
  ],
  [
    "BUN-DOC-02",
    "Doc BUN-02",
    "doc",
    "https://bun.com/reference/globals/bun",
    0,
    "https",
    "tcp",
  ],
  [
    "BUN-DOC-03",
    "Doc BUN-03",
    "doc",
    ["https://bun.sh/reference/globals/bun", "/Server/hostname"].join(""),
    0,
    "https",
    "tcp",
  ],
  [
    "R2-S3-API-01",
    "Sink R2-01",
    "sink",
    [
      "https://pub-",
      "d061f943df0e4477",
      "ba7ff200721eddb1",
      ".r2.dev/api",
    ].join(""),
    DomainMask.ALL_MODES,
    "https",
    "tcp",
  ],
  [
    "R2-EDGE-PUB-02",
    "Sink R2-02",
    "sink",
    [
      "https://pub-",
      "d061f943df0e4477",
      "ba7ff200721eddb1",
      ".r2.dev/evidence",
    ].join(""),
    DomainMask.ALL_MODES,
    "https",
    "tcp",
  ],
  [
    "LOCAL-FILE-03",
    "Sink LOCAL-03",
    "sink",
    [
      "file://",
      "/Users/nolarose",
      "/code/sportsdesk-ops/docs/evidence/ledger.json",
    ].join(""),
    DomainMask.ALL_MODES,
    "none",
    "none",
  ],
];

export const REGISTERED_ENDPOINTS: readonly RegisteredEndpointSpec[] =
  Object.freeze(
    [...epDefsPart1, ...epDefsPart2, ...epDefsPart3].map(
      ([
        endpointId,
        name,
        role,
        rawUrl,
        modesMask,
        connectTransport,
        socketTransport,
        isUnix,
      ]) => ({
        endpointId,
        name,
        role,
        rawUrl,
        modesMask,
        connectTransport,
        socketTransport,
        ...(isUnix !== undefined ? { isUnix } : {}),
      }),
    ),
  );

export function auditEndpoint(
  spec: RegisteredEndpointSpec,
): AuditedEndpointRow {
  const isUnix = spec.isUnix === true || spec.rawUrl.startsWith("unix://");
  let whatwgHostname = "";
  let legacyUrlHostname: string | null = null;
  let effectiveRoute = "";
  let spaHashRoute: string | null = null;
  let spaHashQuery: string | null = null;

  if (isUnix) {
    whatwgHostname = "";
    legacyUrlHostname = null;
    effectiveRoute = spec.rawUrl.replace(/^unix:\/\//, "");
  } else {
    const whatwgParsed = new URL(spec.rawUrl);
    whatwgHostname = whatwgParsed.hostname;
    const legacyParsed = url.parse(spec.rawUrl);
    if (
      spec.rawUrl.startsWith("file:///") &&
      (legacyParsed.hostname === "" || legacyParsed.hostname === null)
    ) {
      legacyUrlHostname = null;
    } else {
      legacyUrlHostname = legacyParsed.hostname;
    }

    if (whatwgParsed.hash) {
      const hash = whatwgParsed.hash;
      const qIdx = hash.indexOf("?");
      if (qIdx !== -1) {
        spaHashRoute = hash.slice(0, qIdx);
        spaHashQuery = hash.slice(qIdx);
      } else {
        spaHashRoute = hash;
        spaHashQuery = null;
      }
      effectiveRoute = `${whatwgParsed.pathname}${hash}`;
    } else {
      effectiveRoute = whatwgParsed.pathname;
    }
  }

  const isWhatwgAndLegacyHostnameIdentical = isUnix
    ? null
    : whatwgHostname === legacyUrlHostname;
  const modes: DiagnosticModeNumber[] = [];
  for (let m = 1; m <= 10; m++) {
    if ((spec.modesMask & (1 << m)) !== 0) {
      modes.push(m as DiagnosticModeNumber);
    }
  }

  return {
    endpointId: spec.endpointId,
    name: spec.name,
    role: spec.role,
    rawUrl: spec.rawUrl,
    effectiveRoute,
    spaHashRoute,
    spaHashQuery,
    whatwgHostname,
    legacyUrlHostname,
    isWhatwgAndLegacyHostnameIdentical,
    connectTransport: spec.connectTransport,
    socketTransport: spec.socketTransport,
    modesMask: spec.modesMask,
    modes: Object.freeze(modes),
  };
}

export const AUDITED_ENDPOINTS_CACHE: readonly AuditedEndpointRow[] =
  Object.freeze(REGISTERED_ENDPOINTS.map(auditEndpoint));
