/**
 * Plane 3 — SportsDesk append-only ingestion JSONL replay (Bun.JSONL.parseChunk + Bun.XML + WAL SQLite).
 * SSOT drain: ./lib/jsonl_stream_replay.ts (mirror of dotfiles plane3-historical-log-replay)
 *
 * SQLite: bun:sqlite only (triggers, sync transactions, fileControl) — see lib/sportsdesk_sqlite.ts.
 */

import type { Database } from "bun:sqlite";
import {
  openSportsdeskSqlite,
  sqlInt,
  sqlIntOrNull,
  truncateWalAndDisablePersist,
} from "../lib/sportsdesk_sqlite.ts";
import {
  parseAsCents,
  parseAsColorHexInt,
  colorHexIntToHexString,
  sha256HexFromDigest,
  type ColorHexInt,
  type Sha256Hex,
  INGESTION_CHANNELS,
  SIGNAL_SLA_MS,
  type SignalChannelCode,
  type SignalChannelStatus,
} from "../design/domain-branded-types.ts";
import type { Insert, Row } from "../lib/sqlite_schema_derive.ts";
import {
  assertSqliteStoreMatchesRegistry,
  INGESTION_TRADES_SCHEMA,
  renderCreateTableDdl,
} from "../lib/sqlite_schema_registry.ts";
import { ms } from "../lib/units.ts";
import {
  replayHistoricalJsonlFile,
  type HistoricalLogReplayResult,
} from "../lib/jsonl_stream_replay.ts";
import { xmlGoldenAstSha256ForIngest } from "../lib/bun_xml_golden_ast.ts";
import {
  accumulateIngestionJsonlXmlGoldenAst,
  emptyIngestionXmlGoldenAstReplayStats,
  exitCodeFromIngestionXmlGoldenAstStats,
  type IngestionXmlGoldenAstReplayStats,
} from "../lib/bun_xml_golden_ast_replay.ts";

const INGESTION_CHANNEL_BY_CODE = new Map(
  INGESTION_CHANNELS.map((c) => [c.channelCode, c] as const),
);

const SIGNAL_CHANNEL_CODES = new Set<string>(
  INGESTION_CHANNELS.map((c) => c.channelCode),
);

const SIGNAL_CHANNEL_STATUSES = new Set<string>([
  "ACTIVE",
  "DROPPED",
  "ALERT",
  "STEERABLE",
  "CRITICAL",
  "SUPPRESSED",
]);

export function isSignalChannelCode(value: string): value is SignalChannelCode {
  return SIGNAL_CHANNEL_CODES.has(value);
}

export function isSignalChannelStatus(
  value: string,
): value is SignalChannelStatus {
  return SIGNAL_CHANNEL_STATUSES.has(value);
}

export function defaultChannelStatusForCode(
  code: SignalChannelCode,
): SignalChannelStatus {
  return INGESTION_CHANNEL_BY_CODE.get(code)!.channelStatus;
}

/** Plane 2 — latency SLA from SSOT; `null` for sentinel_drop lanes (e.g. BLOCKED). */
export function latencySlaMsForChannelCode(
  code: SignalChannelCode,
): number | null {
  const ms = SIGNAL_SLA_MS[code];
  return ms ?? null;
}

export function validTimeEnd(row: SportsdeskIngestionLogRow): number | null {
  const end = row.valid_to ?? row.vt ?? row.v_to;
  if (typeof end === "bigint") return Number(end);
  return typeof end === "number" ? end : null;
}

/**
 * Open valid-time end for overlap SQL (`valid_to IS NULL`).
 * i64 max — use as `bigint`; never bind as a JS `number` (exceeds MAX_SAFE_INTEGER).
 * Trigger SQL embeds {@link VALID_TIME_OPEN_SENTINEL_SQL} as a literal only.
 */
export const VALID_TIME_OPEN_SENTINEL = 9223372036854775807n;

/** SQL integer literal for triggers — not for parameter binding. */
export const VALID_TIME_OPEN_SENTINEL_SQL = VALID_TIME_OPEN_SENTINEL.toString();

export function hasClosedValidInterval(
  row: SportsdeskIngestionLogRow,
): boolean {
  return validTimeEnd(row) !== null;
}

export const SPORTSDESK_INGESTION_LOG_DEFAULT =
  "reports/ingestion-audit.jsonl" as const;

export type SportsdeskPricePattern =
  "NORMAL" | "UP" | "DOWN" | "SPIKE_UP" | "SPIKE_DOWN";

export type SportsdeskIngestionLogRow = {
  id: number;
  /** Valid-time start (alias: valid_from / vf). */
  v_t: number;
  xml: string;
  channel_id?: string;
  /** SSOT lane code alias (writer shorthand). */
  channel_code?: string;
  ch?: string;
  link_id?: string;
  /** Operational state (prefer `channel_status`; legacy `status` / `st`). */
  channel_status?: string;
  status?: string;
  st?: string;
  /** Valid-time end (alias: valid_to / vt / v_to). */
  valid_to?: number;
  vt?: number;
  v_to?: number;
  /** Observed ingest latency ms (alias: `lat`). */
  latency_ms?: number;
  lat?: number;
  /** Transaction-time start (optional; default `performance.now()` at insert). */
  tx_from?: number;
  tf?: number;
  color_int?: ColorHexInt;
  /** Plane 1 golden AST pin (JSON5.stringify(Bun.XML.parse xml, { compact: false })). */
  xml_golden_ast_sha256?: string;
  bun_version?: string;
};

export type ResolvedIngestionChannel = {
  channelCode: SignalChannelCode;
  channelStatus: SignalChannelStatus;
};

/** Resolve lane + operational state; JSON may use `channel_status`, `st`, or SSOT default. */
export function resolveIngestionChannel(
  row: SportsdeskIngestionLogRow,
): ResolvedIngestionChannel | null {
  const rawCode = row.channel_id ?? row.channel_code ?? row.ch ?? "Internet";
  if (!isSignalChannelCode(rawCode)) return null;

  const rawStatus = row.channel_status ?? row.st ?? row.status;
  if (rawStatus !== undefined) {
    if (!isSignalChannelStatus(rawStatus)) return null;
    return { channelCode: rawCode, channelStatus: rawStatus };
  }
  return {
    channelCode: rawCode,
    channelStatus: defaultChannelStatusForCode(rawCode),
  };
}

export type SportsdeskReplayTradeRow = {
  id: number;
  v_t: number;
  valid_to: number | null;
  price: number;
  channel_id: SignalChannelCode;
  channel_status: SignalChannelStatus;
  link_id: string | null;
  xml_hash: string;
  latency_ms: number | null;
  pattern: SportsdeskPricePattern;
};

export type SportsdeskIngestionReplayResult = HistoricalLogReplayResult & {
  trades: SportsdeskReplayTradeRow[];
  skippedInserts: number;
  droppedChannelSkips: number;
  /** SLA breaches on every row checked (includes rejected inserts). */
  latencyViolationsSeen: number;
  /** SLA breaches on rows that were actually inserted. */
  latencyViolationsAccepted: number;
  droppedByChannel: Partial<Record<SignalChannelCode, number>>;
  /** Duplicate JSONL `id` closed the prior open transaction (`tx_to` set). */
  transactionSupersedes: number;
  /** Out-of-order or CHECK-invalid transaction interval on supersede. */
  txAxisViolations: number;
  physicalRowCount: number;
  currentRowCount: number;
  xmlGoldenAst: IngestionXmlGoldenAstReplayStats;
};

/** Exit: corrupt (1) > tx-axis (2) > SLA (3) > XML golden drift (4) > ok (0). */
export function replayIngestionExitCode(
  result: Pick<
    SportsdeskIngestionReplayResult,
    | "corruptedLineSkips"
    | "txAxisViolations"
    | "latencyViolationsSeen"
    | "recordCount"
    | "trades"
    | "xmlGoldenAst"
  >,
): number {
  if (result.corruptedLineSkips > 0) return 1;
  if (result.txAxisViolations > 0) return 2;
  if (result.latencyViolationsSeen > 0) return 3;
  if (exitCodeFromIngestionXmlGoldenAstStats(result.xmlGoldenAst) === 4) {
    return 4;
  }
  return result.trades.length > 0 || result.recordCount > 0 ? 0 : 1;
}

export function parseSportsdeskIngestionLogRow(
  value: unknown,
): SportsdeskIngestionLogRow | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = row.id;
  const xml = row.xml;
  const vf = row.v_t ?? row.valid_from ?? row.vf;
  if (typeof id !== "number" || typeof vf !== "number") return null;
  if (typeof xml !== "string" || xml.length === 0) return null;
  const out: SportsdeskIngestionLogRow = { id, v_t: vf, xml };
  if (typeof row.channel_id === "string") out.channel_id = row.channel_id;
  if (typeof row.channel_code === "string") out.channel_code = row.channel_code;
  if (typeof row.ch === "string") out.ch = row.ch;
  if (typeof row.link_id === "string") out.link_id = row.link_id;
  if (typeof row.channel_status === "string") {
    out.channel_status = row.channel_status;
  }
  if (typeof row.status === "string") out.status = row.status;
  if (typeof row.st === "string") out.st = row.st;
  const vTo = row.valid_to ?? row.vt ?? row.v_to;
  if (typeof vTo === "number") out.valid_to = vTo;
  const lat = row.latency_ms ?? row.lat;
  if (typeof lat === "number") out.latency_ms = lat;
  const tf = row.tx_from ?? row.tf;
  if (typeof tf === "number") out.tx_from = tf;
  if (typeof row.color_int === "number") {
    try {
      out.color_int = parseAsColorHexInt(row.color_int);
    } catch {
      /* optional field */
    }
  }
  const pin = row.xml_golden_ast_sha256;
  if (typeof pin === "string" && pin.length > 0) {
    out.xml_golden_ast_sha256 = pin;
  }
  const bunVer = row.bun_version;
  if (typeof bunVer === "string" && bunVer.length > 0) {
    out.bun_version = bunVer;
  }
  return out;
}

/** SHA256 of JSON5 AST — append at Plane 1 ingest for replay drift checks. */
export function goldenAstSha256ForSportsdeskXml(xml: string): string {
  return xmlGoldenAstSha256ForIngest(xml);
}

/** `{ compact: false }` XML board price — text at children[0].children[0]. */
export function extractXmlBoardPrice(xml: string): number {
  const doc = Bun.XML.parse(xml, { compact: false });
  const first = doc.children?.[0];
  if (
    first === undefined ||
    typeof first === "string" ||
    !("children" in first)
  ) {
    throw new Error("SportsDesk XML: missing root child");
  }
  const inner = first.children?.[0];
  const text =
    typeof inner === "string"
      ? inner
      : inner && typeof inner === "object" && "children" in inner
        ? inner.children?.[0]
        : undefined;
  const price = Number(text);
  if (!Number.isFinite(price)) {
    throw new Error(`SportsDesk XML: non-numeric price from ${String(text)}`);
  }
  return price;
}

export function classifySportsdeskPricePattern(
  price: number,
  previousPrice: number,
): SportsdeskPricePattern {
  if (previousPrice <= 0) return "NORMAL";
  if (price > previousPrice * 1.2) return "SPIKE_UP";
  if (price < previousPrice * 0.8) return "SPIKE_DOWN";
  if (price > previousPrice) return "UP";
  if (price < previousPrice) return "DOWN";
  return "NORMAL";
}

export function analyzeSportsdeskPricePatterns(
  rows: readonly { id: number; v_t: number; price: number }[],
): SportsdeskReplayTradeRow[] {
  const sorted = [...rows].sort((a, b) => a.v_t - b.v_t);
  let prev = 0;
  return sorted.map((r) => {
    const pattern = classifySportsdeskPricePattern(r.price, prev);
    if (prev <= 0 || r.price > 0) prev = r.price;
    return {
      id: r.id,
      v_t: r.v_t,
      price: r.price,
      channel_id: "Internet",
      channel_status: "ACTIVE",
      valid_to: null,
      link_id: null,
      xml_hash: "",
      latency_ms: null,
      pattern,
    };
  });
}

export function createIngestionReplayDatabase(): Database {
  const db = openSportsdeskSqlite(":memory:");
  initReplayDatabase(db);
  return db;
}

export { truncateWalAndDisablePersist };

/** Bitemporal as-of: valid-time `validAt` and transaction-time `txAt`. */
export function queryIngestionTradesAsOf(
  db: Database,
  channelId: SignalChannelCode,
  validAt: number,
  txAt: number,
): {
  id: number;
  price: number;
  tx_from: number;
  tx_to: number | null;
}[] {
  const rows = db
    .query(
      `SELECT id, price, tx_from, tx_to FROM ingestion_trades
       WHERE channel_id = ?
         AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
         AND tx_from <= ? AND (tx_to IS NULL OR tx_to > ?)`,
    )
    .all(channelId, validAt, validAt, txAt, txAt) as {
    id: number | bigint;
    price: number | bigint;
    tx_from: number | bigint;
    tx_to: number | bigint | null;
  }[];
  return rows.map((r) => ({
    id: Number(r.id),
    price: Number(r.price),
    tx_from: Number(r.tx_from),
    tx_to: r.tx_to === null ? null : Number(r.tx_to),
  }));
}

/**
 * Business key for open transaction rows is `(channel_id, id)` — ids are not global.
 */
export type ResolvedIngestionTxTime =
  | { ok: true; txFrom: number }
  | { ok: false; requested: number; maxTxFrom: number };

/**
 * Monotonic transaction time for `(channel_id, id)`.
 * Nudges same-millisecond supersede so `tx_to > tx_from` on the closed row.
 * Rejects corrections strictly before `MAX(tx_from)` (out-of-order).
 */
export function resolveIngestionTransactionTime(
  db: Database,
  channelId: SignalChannelCode,
  tradeId: number,
  requestedTxFrom: number,
): ResolvedIngestionTxTime {
  const maxRow = db
    .query(
      `SELECT MAX(tx_from) AS m FROM ingestion_trades WHERE channel_id = ? AND id = ?`,
    )
    .get(channelId, tradeId) as { m: number | bigint | null };
  const maxTx = sqlInt(maxRow?.m);

  if (maxTx > 0 && requestedTxFrom < maxTx) {
    return { ok: false, requested: requestedTxFrom, maxTxFrom: maxTx };
  }

  const open = db
    .query(
      `SELECT tx_from FROM ingestion_trades WHERE channel_id = ? AND id = ? AND tx_to IS NULL`,
    )
    .get(channelId, tradeId) as { tx_from: number | bigint } | null;

  if (open && requestedTxFrom <= sqlInt(open.tx_from)) {
    return { ok: true, txFrom: sqlInt(open.tx_from) + 1 };
  }

  return { ok: true, txFrom: requestedTxFrom };
}

export function closeOpenIngestionTransactionForId(
  db: Database,
  channelId: SignalChannelCode,
  tradeId: number,
  txTo: number,
): { closed: number; txAxisRejected: boolean } {
  try {
    const closed = db.run(
      `UPDATE ingestion_trades SET tx_to = ?
       WHERE channel_id = ? AND id = ? AND tx_to IS NULL`,
      [txTo, channelId, tradeId],
    ).changes;
    return { closed, txAxisRejected: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("CHECK constraint failed")) {
      return { closed: 0, txAxisRejected: true };
    }
    throw e;
  }
}

export type IngestionTradesSsotRow = Row<"ingestion_trades">;
export type IngestionTradesSsotInsert = Insert<"ingestion_trades">;

function initReplayDatabase(db: Database): void {
  db.run("PRAGMA journal_mode=WAL");
  db.exec(
    renderCreateTableDdl(INGESTION_TRADES_SCHEMA, {
      extraChecks: [
        "valid_to IS NULL OR valid_to > valid_from",
        "tx_to IS NULL OR tx_to > tx_from",
      ],
      recreateUniqueIndexes: true,
    }),
  );
  assertSqliteStoreMatchesRegistry(db, INGESTION_TRADES_SCHEMA);
  db.run("DROP TRIGGER IF EXISTS enforce_bitemporal_overlap");
  db.run(`
    CREATE TRIGGER enforce_bitemporal_overlap
    BEFORE INSERT ON ingestion_trades
    FOR EACH ROW
    WHEN NEW.channel_status != 'DROPPED'
    BEGIN
      SELECT RAISE(ABORT, 'Bitemporal Overlap on ' || NEW.channel_id)
      WHERE EXISTS (
        SELECT 1 FROM ingestion_trades
        WHERE channel_id = NEW.channel_id
          AND tx_to IS NULL
          AND NEW.valid_from < IFNULL(valid_to, ${VALID_TIME_OPEN_SENTINEL_SQL})
          AND IFNULL(NEW.valid_to, ${VALID_TIME_OPEN_SENTINEL_SQL}) > valid_from
      );
    END;
  `);
}

export type ReplaySportsdeskIngestionOptions = {
  path: string;
  /**
   * Fixture contract: every non-DROPPED row must include `v_to` (closed interval policy).
   * Interval well-formedness (`v_to > v_t`) is always enforced by SQLite CHECK.
   */
  bitemporal?: boolean;
  onCorruptedLine?: (byteOffset: number, message: string) => void;
  onDroppedChannel?: (info: {
    id: number;
    channelCode: SignalChannelCode;
    channelStatus: SignalChannelStatus;
  }) => void;
  onLatencyViolation?: (info: {
    id: number;
    channelCode: SignalChannelCode;
    latencyMs: number;
    slaMs: number;
  }) => void;
  onTxAxisViolation?: (info: {
    id: number;
    channelCode: SignalChannelCode;
    txTo: number;
    message: string;
  }) => void;
  /** Default true — verify `xml_golden_ast_sha256` when present on JSONL rows. */
  verifyXmlGoldenAst?: boolean;
  /** Fail rows that include `xml` without a golden pin. */
  strictXmlGoldenPins?: boolean;
  expectedBunVersion?: string;
  /** Categorized `[XML-GOLDEN]` line from verify (AST drift, missing pin, version mismatch). */
  onXmlGoldenAstFailure?: (message: string) => void;
};

async function runIngestionReplayOnDatabase(
  db: Database,
  options: ReplaySportsdeskIngestionOptions,
): Promise<Omit<SportsdeskIngestionReplayResult, "trades"> & { db: Database }> {
  const strictIntervalContract = options.bitemporal === true;
  const verifyXmlGolden = options.verifyXmlGoldenAst !== false;
  const xmlGoldenAst = emptyIngestionXmlGoldenAstReplayStats();
  const goldenOpts = {
    strictPins: options.strictXmlGoldenPins === true,
    ...(options.expectedBunVersion !== undefined
      ? { expectedBunVersion: options.expectedBunVersion }
      : {}),
    ...(options.onXmlGoldenAstFailure !== undefined
      ? { onFailure: options.onXmlGoldenAstFailure }
      : {}),
  };

  const insertTrade = db.prepare(
    `INSERT INTO ingestion_trades (
            id, channel_id, channel_status, valid_from, valid_to, tx_from, tx_to,
            price, link_id, xml_hash, latency_ms
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );

  let skippedInserts = 0;
  let droppedChannelSkips = 0;
  let latencyViolationsSeen = 0;
  let latencyViolationsAccepted = 0;
  let transactionSupersedes = 0;
  let txAxisViolations = 0;
  const droppedByChannel: Partial<Record<SignalChannelCode, number>> = {};

  const base = await replayHistoricalJsonlFile(options.path, {
    onRecord(value) {
      if (verifyXmlGolden) {
        accumulateIngestionJsonlXmlGoldenAst(value, xmlGoldenAst, goldenOpts);
      }

      const row = parseSportsdeskIngestionLogRow(value);
      if (!row) return;

      const channel = resolveIngestionChannel(row);
      if (!channel) {
        skippedInserts += 1;
        return;
      }

      if (channel.channelStatus === "DROPPED") {
        droppedChannelSkips += 1;
        droppedByChannel[channel.channelCode] =
          (droppedByChannel[channel.channelCode] ?? 0) + 1;
        options.onDroppedChannel?.({
          id: row.id,
          channelCode: channel.channelCode,
          channelStatus: channel.channelStatus,
        });
        return;
      }

      if (strictIntervalContract && !hasClosedValidInterval(row)) {
        throw new Error(
          `v_to required under --bitemporal (id ${row.id}, channel ${channel.channelCode})`,
        );
      }

      const latencyMs = row.latency_ms ?? row.lat ?? null;
      const slaMs = latencySlaMsForChannelCode(channel.channelCode);
      const slaViolation =
        slaMs !== null && typeof latencyMs === "number" && latencyMs > slaMs;
      if (slaViolation) {
        latencyViolationsSeen += 1;
        options.onLatencyViolation?.({
          id: row.id,
          channelCode: channel.channelCode,
          latencyMs,
          slaMs,
        });
      }

      let price: number;
      try {
        price = extractXmlBoardPrice(row.xml);
      } catch {
        skippedInserts += 1;
        return;
      }
      const xmlHash: Sha256Hex = sha256HexFromDigest(
        Bun.CryptoHasher.hash("sha256", row.xml, "hex"),
      );
      const validTo = validTimeEnd(row);
      const requestedTxFrom =
        row.tx_from ??
        row.tf ??
        Math.floor(performance.timeOrigin + performance.now());
      const txResolved = resolveIngestionTransactionTime(
        db,
        channel.channelCode,
        row.id,
        requestedTxFrom,
      );
      if (!txResolved.ok) {
        txAxisViolations += 1;
        skippedInserts += 1;
        options.onTxAxisViolation?.({
          id: row.id,
          channelCode: channel.channelCode,
          txTo: requestedTxFrom,
          message: `tx_from ${txResolved.requested} before lane max ${txResolved.maxTxFrom}`,
        });
        return;
      }
      const txFrom = txResolved.txFrom;
      const closeResult = closeOpenIngestionTransactionForId(
        db,
        channel.channelCode,
        row.id,
        txFrom,
      );
      if (closeResult.txAxisRejected) {
        txAxisViolations += 1;
        skippedInserts += 1;
        options.onTxAxisViolation?.({
          id: row.id,
          channelCode: channel.channelCode,
          txTo: txFrom,
          message: "tx_to must be greater than tx_from (interval inverted)",
        });
        return;
      }
      if (closeResult.closed > 0) transactionSupersedes += closeResult.closed;
      const insertRow: IngestionTradesSsotInsert = {
        id: row.id,
        channel_id: channel.channelCode,
        channel_status: channel.channelStatus,
        valid_from: row.v_t,
        valid_to: validTo,
        tx_from: txFrom,
        tx_to: null,
        price: parseAsCents(price),
        link_id: row.link_id ?? null,
        xml_hash: xmlHash,
        latency_ms: latencyMs !== null ? ms(latencyMs) : null,
      };
      try {
        insertTrade.run(
          insertRow.id,
          insertRow.channel_id,
          insertRow.channel_status,
          insertRow.valid_from,
          insertRow.valid_to ?? null,
          insertRow.tx_from,
          insertRow.price,
          insertRow.link_id ?? null,
          insertRow.xml_hash,
          insertRow.latency_ms ?? null,
        );
        if (slaViolation) latencyViolationsAccepted += 1;
      } catch (e) {
        skippedInserts += 1;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("Bitemporal Overlap")) {
          /* expected on same-lane interval overlap */
        }
        if (msg.includes("one_open_tx_per_lane_id")) {
          /* duplicate open row — replay idempotency / hot-path race */
        }
      }
    },
    onCorruptedLine(err, byteOffset) {
      options.onCorruptedLine?.(byteOffset, err.message);
    },
  });

  const physicalRowCount = Number(
    (
      db.query(`SELECT COUNT(*) AS n FROM ingestion_trades`).get() as {
        n: number | bigint;
      }
    ).n,
  );
  const currentRowCount = Number(
    (
      db
        .query(`SELECT COUNT(*) AS n FROM ingestion_trades WHERE tx_to IS NULL`)
        .get() as {
        n: number | bigint;
      }
    ).n,
  );

  return {
    ...base,
    skippedInserts,
    droppedChannelSkips,
    latencyViolationsSeen,
    latencyViolationsAccepted,
    droppedByChannel,
    transactionSupersedes,
    txAxisViolations,
    physicalRowCount,
    currentRowCount,
    xmlGoldenAst,
    db,
  };
}

function loadCurrentIngestionTrades(db: Database): SportsdeskReplayTradeRow[] {
  const fromDb = db
    .query(
      `SELECT id, valid_from AS v_t, valid_to, price, channel_id, channel_status,
              link_id, xml_hash, latency_ms
       FROM ingestion_trades WHERE tx_to IS NULL ORDER BY valid_from`,
    )
    .all() as {
    id: number | bigint;
    v_t: number | bigint;
    valid_to: number | bigint | null;
    price: number | bigint;
    channel_id: SignalChannelCode;
    channel_status: SignalChannelStatus;
    link_id: string | null;
    xml_hash: string;
    latency_ms: number | bigint | null;
  }[];

  let prev = 0;
  const trades: SportsdeskReplayTradeRow[] = fromDb.map((r) => {
    const price = sqlInt(r.price);
    const pattern = classifySportsdeskPricePattern(price, prev);
    if (prev <= 0 || price > 0) prev = price;
    return {
      id: sqlInt(r.id),
      v_t: sqlInt(r.v_t),
      valid_to: sqlIntOrNull(r.valid_to),
      price,
      channel_id: r.channel_id,
      channel_status: r.channel_status,
      link_id: r.link_id,
      xml_hash: r.xml_hash,
      latency_ms: sqlIntOrNull(r.latency_ms),
      pattern,
    };
  });

  return trades;
}

export async function replaySportsdeskIngestionLog(
  options: ReplaySportsdeskIngestionOptions,
): Promise<SportsdeskIngestionReplayResult> {
  const db = createIngestionReplayDatabase();
  const partial = await runIngestionReplayOnDatabase(db, options);
  const trades = loadCurrentIngestionTrades(db);
  const { db: _db, ...rest } = partial;
  void _db;
  return { ...rest, trades };
}

/** Test / audit hook: same as replay but returns the SQLite handle for as-of queries. */
export async function replaySportsdeskIngestionLogWithDb(
  options: ReplaySportsdeskIngestionOptions,
): Promise<{ result: SportsdeskIngestionReplayResult; db: Database }> {
  const db = createIngestionReplayDatabase();
  const partial = await runIngestionReplayOnDatabase(db, options);
  const trades = loadCurrentIngestionTrades(db);
  const { db: _db, ...rest } = partial;
  void _db;
  return { result: { ...rest, trades }, db };
}

export function renderSportsdeskPatternMarkdown(
  trades: readonly SportsdeskReplayTradeRow[],
): string {
  const header =
    "| ID | v_t | v_to | Price | Channel | Status | Latency | Pattern |\n|---|---|---|---|---|---|---|---|\n";
  const body = trades
    .map(
      (r) =>
        `| ${r.id} | ${r.v_t} | ${r.valid_to ?? "—"} | ${r.price} | ${r.channel_id} | ${r.channel_status} | ${r.latency_ms != null ? `${r.latency_ms}ms` : "—"} | \`${r.pattern}\` |`,
    )
    .join("\n");
  return header + body;
}

const SPORTSDESK_REPLAY_TABLE_COL_WIDTH = 14;

export function renderSportsdeskPatternAnsi(markdown: string): string {
  const red = Bun.color("#EF4444", "ansi") ?? "";
  const green = Bun.color("#22C55E", "ansi") ?? "";
  const blue = Bun.color("#3B82F1", "ansi") ?? "";
  const reset = "\x1b[0m";
  const pad = SPORTSDESK_REPLAY_TABLE_COL_WIDTH;
  // trusted-markdown: ANSI rows for the replay CLI; escape sequences are this module's own.
  return Bun.markdown.render(markdown, {
    tr: (children) => `${children}\n`,
    th: (c) => `\x1b[1;36m${String(c).padEnd(pad)}${reset}`,
    td: (c) => {
      let out = String(c).padEnd(pad);
      if (out.includes("SPIKE_UP")) {
        out = out.replace("SPIKE_UP", `${red}SPIKE_UP${reset}`);
      } else if (out.includes("SPIKE_DOWN")) {
        out = out.replace("SPIKE_DOWN", `${red}SPIKE_DOWN${reset}`);
      } else if (out.includes("UP")) {
        out = out.replace(/\bUP\b/, `${green}UP${reset}`);
      } else if (out.includes("DOWN")) {
        out = out.replace(/\bDOWN\b/, `${blue}DOWN${reset}`);
      }
      return out;
    },
    codespan: (c) => `\x1b[33m${c}${reset}`,
  });
}

/** Terminal-native box table (no markdown callbacks). */
export function formatSportsdeskReplayTradesTable(
  trades: readonly SportsdeskReplayTradeRow[],
  colors = true,
): string {
  return `${Bun.inspect.table(
    trades,
    [
      "id",
      "v_t",
      "valid_to",
      "price",
      "channel_id",
      "channel_status",
      "latency_ms",
      "pattern",
    ],
    { colors },
  )}\n`;
}

export function formatIngestionChannelColorInt(
  channelCode: string,
): ColorHexInt | null {
  const ch = INGESTION_CHANNELS.find((c) => c.channelCode === channelCode);
  if (!ch) return null;
  return parseAsColorHexInt(ch.hex);
}

export function ingestionColorIntToCss(value: ColorHexInt): string {
  return colorHexIntToHexString(value);
}
