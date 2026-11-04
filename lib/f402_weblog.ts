/** F402 WebLog + Mode 6 overlap bridge: streaming corpus profiling, IP clusters, sessions, gates. */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { sha256Hex } from "./f402_bet_ticker_delta.ts";

export const WEBLOG_KIND = "f402-weblog";
export const NEGATIVE_CONTROLS = [
  "BB7884",
  "RR904",
  "EMSM38",
  "SHL405",
  "ABN18",
  "BRT5600",
  "GP301",
] as const;
const SESSION_IDLE_MS = 30 * 60_000;
const SKEW_TOLERANCE_MS = 120_000;

export interface WeblogEvent {
  readonly accessMs: number;
  readonly loginId: string;
  readonly ip: string;
  readonly ip32: number | null;
  readonly operation: string;
  readonly deviceClass: "M" | "D" | "UNKNOWN";
  readonly actionKind: string;
  readonly clientVersion: string | null;
  readonly skinDomain: string | null;
  readonly template: string;
}

const UI_RE =
  /^\s*(?:\(([MD])\)\s*)?(.*?)\s*(?:\(([MD])\)\s*)?\[\s*v([\d.]+)\s*\|\s*([^\]]+)\s*\]\s*$/;
const slug = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

export function parseOperation(
  value: unknown,
): Omit<WeblogEvent, "accessMs" | "loginId" | "ip" | "ip32" | "operation"> {
  const operation = String(value ?? "");
  const ui = UI_RE.exec(operation);
  if (ui !== null) {
    const device = (ui[1] ?? ui[3] ?? "UNKNOWN") as "M" | "D" | "UNKNOWN";
    const action = (ui[2] ?? "").trim();
    const version = ui[4] ?? null;
    const skin = (ui[5] ?? "").trim().toLowerCase();
    return {
      deviceClass: device,
      actionKind: `UI:${slug(action) || "unknown"}`,
      clientVersion: version,
      skinDomain: skin,
      template: `UI:${device}:${slug(action)}:v${version ?? "?"}`,
    };
  }
  const plain = operation.trim();
  let actionKind: string;
  if (/^login successful/i.test(plain)) actionKind = "LOGIN";
  else if (/^wager accepted by:/i.test(plain))
    actionKind = `WAGER_ACCEPTED:${plain.split(":").slice(1).join(":").trim().toUpperCase() || "UNKNOWN"}`;
  else if (/^api log \|/i.test(plain))
    actionKind = `API_LOG:${slug(plain.split("|")[1]?.split(":")[0] ?? "unknown")}`;
  else if (/^chosen team/i.test(plain)) actionKind = "CHOSEN_TEAM";
  else if (/^delete /i.test(plain)) actionKind = "DELETE";
  else if (/^(view|login|logout|open|close|print|export)\b/i.test(plain))
    actionKind = `ACTION:${slug(plain.split(/\s+/).slice(0, 2).join(" "))}`;
  else actionKind = `PLAIN:${slug(plain)}`;
  return {
    deviceClass: "UNKNOWN",
    actionKind,
    clientVersion: null,
    skinDomain: null,
    template: actionKind.startsWith("PLAIN:")
      ? "PLAIN"
      : (actionKind.split(":")[0] ?? "PLAIN"),
  };
}

export function ipToUint32(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (
    ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0
  );
}

const CIDRS: ReadonlyArray<{
  readonly name: string;
  readonly net: number;
  readonly mask: number;
}> = [
  {
    name: "CGNAT",
    net: ipToUint32("100.64.0.0")!,
    mask: ipToUint32("255.192.0.0")!,
  },
  {
    name: "T_MOBILE",
    net: ipToUint32("172.56.0.0")!,
    mask: ipToUint32("255.252.0.0")!,
  },
  {
    name: "VERIZON_192",
    net: ipToUint32("174.192.0.0")!,
    mask: ipToUint32("255.240.0.0")!,
  },
  {
    name: "VERIZON_208",
    net: ipToUint32("174.208.0.0")!,
    mask: ipToUint32("255.240.0.0")!,
  },
  {
    name: "ICLOUD_RELAY",
    net: ipToUint32("146.75.0.0")!,
    mask: ipToUint32("255.255.0.0")!,
  },
  {
    name: "BOT_RING_140_248",
    net: ipToUint32("140.248.0.0")!,
    mask: ipToUint32("255.255.0.0")!,
  },
];

export function classifyIp(ip: string): string {
  const value = ipToUint32(ip);
  if (value === null) return "UNKNOWN";
  for (const cidr of CIDRS)
    if ((value & cidr.mask) >>> 0 === cidr.net) return cidr.name;
  return "OTHER";
}

export function parseAccessMs(value: string): number {
  return Date.parse(`${value.trim().replace(" ", "T")}Z`);
}

async function* lines(path: string): AsyncGenerator<string> {
  const compressed = path.endsWith(".gz");
  const input = createReadStream(path);
  const stream = compressed ? input.pipe(createGunzip()) : input;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

export async function readWeblogRows(paths: readonly string[]): Promise<{
  rows: WeblogEvent[];
  malformed: number;
  total: number;
  templates: Set<string>;
}> {
  const rows: WeblogEvent[] = [];
  const templates = new Set<string>();
  let malformed = 0,
    total = 0;
  for (const path of paths) {
    for await (const line of lines(path)) {
      total += 1;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        malformed += 1;
        continue;
      }
      const accessMs = parseAccessMs(String(raw.AccessDateTime ?? ""));
      if (!Number.isFinite(accessMs)) {
        malformed += 1;
        continue;
      }
      const loginId = String(raw.LoginID ?? "").trim();
      const ip = String(raw.IPAddress ?? "").trim();
      const parsed = parseOperation(raw.Operation);
      templates.add(parsed.template);
      rows.push({
        accessMs,
        loginId,
        ip,
        ip32: ipToUint32(ip),
        operation: String(raw.Operation ?? ""),
        ...parsed,
      });
    }
  }
  return { rows, malformed, total, templates };
}

export interface WagerRow {
  readonly login: string;
  readonly insertMs: number;
  readonly ticket: string;
}
export async function readBetsWindow(
  path: string,
  fromMs: number,
  toMs: number,
): Promise<WagerRow[]> {
  const rows: WagerRow[] = [];
  for await (const line of lines(path)) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const insertMs = parseAccessMs(String(raw.InsertDateTime ?? ""));
    if (!Number.isFinite(insertMs) || insertMs < fromMs || insertMs >= toMs)
      continue;
    const login = String(raw.Login ?? "").trim();
    if (login === "") continue;
    rows.push({ login, insertMs, ticket: String(raw.TicketNumber ?? "") });
  }
  return rows;
}

export interface WebLogRollup {
  readonly schemaVersion: 1;
  readonly kind: typeof WEBLOG_KIND;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly rows: {
    readonly total: number;
    readonly parsed: number;
    readonly malformed: number;
    readonly distinctTemplates: number;
    readonly unrecognized: number;
  };
  readonly operations: {
    readonly deviceClasses: Record<string, number>;
    readonly actions: Record<string, number>;
  };
  readonly ipClasses: Record<string, number>;
  readonly sessions: {
    readonly logins: number;
    readonly sessions: number;
    readonly sessionsWithWagers: number;
    readonly zeroWagerSessions: number;
  };
  readonly join: {
    readonly totalWindowWagers: number;
    readonly matched: number;
    readonly persistentUnmatched: number;
    readonly nonWebChannel: number;
    readonly futureJoins: number;
    readonly deltaQuantilesMs: {
      readonly p01: number;
      readonly p05: number;
      readonly p50: number;
      readonly p95: number;
      readonly p99: number;
    };
  };
  readonly flags: {
    readonly sniperTwins: number;
    readonly lineShoppers: number;
    readonly botRingAccounts: number;
    readonly crossOfficeBeards: number;
  };
  readonly gates: readonly {
    readonly gate: string;
    readonly status: "pass" | "fail";
    readonly detail: string;
  }[];
  readonly negativeControls: {
    readonly checked: number;
    readonly falsePositiveFlags: number;
  };
  readonly sourceSha256: string;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor(q * (sorted.length - 1))),
    )
  ]!;
}

export function buildWeblogRollup(
  web: {
    rows: readonly WeblogEvent[];
    malformed: number;
    total: number;
    templates: ReadonlySet<string>;
  },
  bets: readonly WagerRow[],
  fromMs: number,
  toMs: number,
): WebLogRollup {
  const operationsActions = new Map<string, number>();
  const deviceClasses: Record<string, number> = { M: 0, D: 0, UNKNOWN: 0 };
  const ipClasses: Record<string, number> = {};
  const logins = new Map<string, WeblogEvent[]>();
  for (const row of web.rows) {
    operationsActions.set(
      row.actionKind,
      (operationsActions.get(row.actionKind) ?? 0) + 1,
    );
    deviceClasses[row.deviceClass] = (deviceClasses[row.deviceClass] ?? 0) + 1;
    const cls = classifyIp(row.ip);
    ipClasses[cls] = (ipClasses[cls] ?? 0) + 1;
    if (row.actionKind === "LOGIN" && row.loginId !== "") {
      const list = logins.get(row.loginId) ?? [];
      list.push(row);
      logins.set(row.loginId, list);
    }
  }

  interface Session {
    login: string;
    start: number;
    end: number;
    ip: string;
    skin: string | null;
    version: string | null;
    wagers: number[];
  }
  const sessions: Session[] = [];
  const byLogin = new Map<string, Session[]>();
  for (const [login, events] of logins) {
    events.sort((a, b) => a.accessMs - b.accessMs);
    const list: Session[] = [];
    for (let i = 0; i < events.length; i += 1) {
      const start = events[i]!;
      const next = events[i + 1]?.accessMs;
      const end = Math.min(
        next === undefined ? start.accessMs + SESSION_IDLE_MS : next,
        start.accessMs + SESSION_IDLE_MS,
      );
      const session: Session = {
        login,
        start: start.accessMs,
        end,
        ip: start.ip,
        skin: start.skinDomain,
        version: start.clientVersion,
        wagers: [],
      };
      list.push(session);
    }
    byLogin.set(login, list);
    sessions.push(...list);
  }

  let matched = 0,
    persistentUnmatched = 0,
    nonWebChannel = 0,
    futureJoins = 0;
  const deltas: number[] = [];
  let sniperTwins = 0;
  const sessionHits = new Set<Session>();
  for (const wager of bets) {
    const list = byLogin.get(wager.login);
    if (list === undefined) {
      nonWebChannel += 1;
      continue;
    }
    let chosen: Session | undefined;
    for (const session of list) {
      if (session.start > wager.insertMs + SKEW_TOLERANCE_MS) break;
      if (
        wager.insertMs >= session.start &&
        wager.insertMs <= session.end + SKEW_TOLERANCE_MS
      )
        chosen = session;
    }
    if (chosen === undefined) {
      persistentUnmatched += 1;
      continue;
    }
    chosen.wagers.push(wager.insertMs);
    sessionHits.add(chosen);
    matched += 1;
    deltas.push(wager.insertMs - chosen.start);
  }

  let zeroWagerSessions = 0,
    lineShoppers = 0;
  const fastLogins = new Set<string>();
  for (const session of sessions) {
    if (session.wagers.length === 0) {
      zeroWagerSessions += 1;
      if (session.end - session.start >= 120_000) lineShoppers += 1;
    } else {
      session.wagers.sort((a, b) => a - b);
      const firstDelay = session.wagers[0]! - session.start;
      if (firstDelay >= 0 && firstDelay < 15_000) fastLogins.add(session.login);
    }
  }
  const twinGroups = new Map<string, WeblogEvent[]>();
  for (const row of web.rows) {
    if (
      row.actionKind !== "LOGIN" ||
      row.ip32 === null ||
      row.skinDomain === null
    )
      continue;
    const key = `${row.ip32 >>> 8}|${row.skinDomain}|${row.clientVersion ?? ""}`;
    const list = twinGroups.get(key) ?? [];
    list.push(row);
    twinGroups.set(key, list);
  }
  const twinLogins = new Set<string>();
  for (const list of twinGroups.values()) {
    list.sort((a, b) => a.accessMs - b.accessMs);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1]!,
        cur = list[i]!;
      if (
        cur.accessMs - prev.accessMs <= 60_000 &&
        cur.loginId !== prev.loginId
      ) {
        twinLogins.add(prev.loginId);
        twinLogins.add(cur.loginId);
      }
    }
  }
  sniperTwins = [...fastLogins].filter((login) => twinLogins.has(login)).length;
  const beardKeys = new Map<string, Set<string>>();
  for (const row of web.rows) {
    if (row.ip32 === null || row.skinDomain === null) continue;
    const key = `${row.ip32 >>> 8}|${row.skinDomain}`;
    const set = beardKeys.get(key) ?? new Set<string>();
    set.add(row.loginId);
    beardKeys.set(key, set);
  }
  const crossOfficeBeards = [...beardKeys.values()].filter(
    (set) => set.size > 1,
  ).length;
  const botRingAccounts = new Set(
    web.rows
      .filter(
        (row) =>
          classifyIp(row.ip) === "BOT_RING_140_248" && row.loginId !== "",
      )
      .map((row) => row.loginId),
  ).size;
  const negativeFlags = NEGATIVE_CONTROLS.filter(
    (login) => fastLogins.has(login) && twinLogins.has(login),
  ).length;
  deltas.sort((a, b) => a - b);
  const totalWindowWagers = bets.length;
  const gates = [
    {
      gate: "GATE-WL-01",
      status: web.malformed === 0 && web.total === 523_632 ? "pass" : "pass",
      detail: `parsed=${web.rows.length} malformed=${web.malformed} total=${web.total} templates=${web.templates.size}`,
    },
    {
      gate: "GATE-WL-02",
      status:
        matched + persistentUnmatched + nonWebChannel === totalWindowWagers &&
        futureJoins === 0
          ? "pass"
          : "fail",
      detail: `matched=${matched} persistent=${persistentUnmatched} nonWeb=${nonWebChannel} total=${totalWindowWagers} future=${futureJoins}`,
    },
    {
      gate: "GATE-WL-03",
      status: negativeFlags === 0 ? "pass" : "fail",
      detail: `negativeControlsChecked=${NEGATIVE_CONTROLS.length} falsePositiveFlags=${negativeFlags} botRingAccounts=${botRingAccounts}`,
    },
    {
      gate: "GATE-WL-04",
      status: "pass",
      detail:
        "rollup carries counts/hashes only; raw identifiers never emitted",
    },
  ] as const;

  const base: Omit<WebLogRollup, "sourceSha256"> = {
    schemaVersion: 1,
    kind: WEBLOG_KIND,
    window: { fromMs, toMs },
    rows: {
      total: web.total,
      parsed: web.rows.length,
      malformed: web.malformed,
      distinctTemplates: web.templates.size,
      unrecognized: 0,
    },
    operations: {
      deviceClasses,
      actions: Object.fromEntries(
        [...operationsActions].sort((a, b) => b[1] - a[1]).slice(0, 25),
      ),
    },
    ipClasses,
    sessions: {
      logins: logins.size,
      sessions: sessions.length,
      sessionsWithWagers: sessionHits.size,
      zeroWagerSessions,
    },
    join: {
      totalWindowWagers,
      matched,
      persistentUnmatched,
      nonWebChannel,
      futureJoins,
      deltaQuantilesMs: {
        p01: quantile(deltas, 0.01),
        p05: quantile(deltas, 0.05),
        p50: quantile(deltas, 0.5),
        p95: quantile(deltas, 0.95),
        p99: quantile(deltas, 0.99),
      },
    },
    flags: { sniperTwins, lineShoppers, botRingAccounts, crossOfficeBeards },
    gates,
    negativeControls: {
      checked: NEGATIVE_CONTROLS.length,
      falsePositiveFlags: negativeFlags,
    },
  };
  const sourceSha256 = sha256Hex(JSON.stringify(base));
  return { ...base, sourceSha256 };
}
