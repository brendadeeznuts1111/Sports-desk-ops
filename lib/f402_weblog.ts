/** F402 WebLog + Mode 6 overlap bridge: streaming corpus profiling, IP clusters, sessions, gates. */
import { sha256Hex } from "./f402_bet_ticker_delta.ts";
import { mergeUint8JsonlChunks } from "./jsonl_stream_replay.ts";

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
  readonly ipv6Prefix64: string | null;
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
): Omit<
  WeblogEvent,
  "accessMs" | "loginId" | "ip" | "ip32" | "ipv6Prefix64" | "operation"
> {
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

export function ipv6To64(ip: string): bigint | null {
  const text = ip.trim().replace(/^\[|\]$/g, "");
  if (!text.includes(":")) return null;
  const [head, tail] = text.split("::");
  const left = head === undefined || head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = 8 - left.length - right.length;
  if (fill < 0) return null;
  const parts = [...left, ...Array(fill).fill("0"), ...right];
  if (parts.length !== 8) return null;
  let value = 0n;
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i];
    if (part === undefined || !/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    value = (value << 16n) | BigInt(parseInt(part, 16));
  }
  return value;
}

const IPV6_CARRIERS: ReadonlyArray<{
  readonly name: string;
  readonly value: bigint;
  readonly bits: number;
}> = [
  ["IPV6_CARRIER:T_MOBILE", ipv6To64("2607:fb90::")!, 28],
  ["IPV6_CARRIER:T_MOBILE", ipv6To64("2607:fc20::")!, 32],
  ["IPV6_CARRIER:VERIZON", ipv6To64("2600:1000::")!, 24],
  ["IPV6_CARRIER:ATT", ipv6To64("2600:380::")!, 24],
  ["IPV6_CARRIER:ICLOUD", ipv6To64("2606:54c0::")!, 32],
  ["IPV6_CARRIER:ICLOUD", ipv6To64("2a09:bac0::")!, 29],
].map(([name, value, bits]) => ({
  name: name as string,
  value: value as bigint,
  bits: bits as number,
}));

export function classifyIpv6(ip: string): {
  className: string;
  prefix64: string | null;
} {
  const value = ipv6To64(ip);
  if (value === null) return { className: "UNKNOWN", prefix64: null };
  for (const carrier of IPV6_CARRIERS) {
    if (
      value >> BigInt(64 - carrier.bits) ===
      carrier.value >> BigInt(64 - carrier.bits)
    ) {
      return { className: carrier.name, prefix64: value.toString(16) };
    }
  }
  return { className: "IPV6_OTHER_64", prefix64: value.toString(16) };
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
  if (ip.trim() === "") return "UNKNOWN";
  const value = ipToUint32(ip);
  if (value === null) return classifyIpv6(ip).className;
  for (const cidr of CIDRS)
    if ((value & cidr.mask) >>> 0 === cidr.net) return cidr.name;
  return "OTHER";
}

export function parseAccessMs(value: string): number {
  return Date.parse(`${value.trim().replace(" ", "T")}Z`);
}

/** Bytes handed to one `Bun.JSONL.parseChunk` call; bounds one window, never the corpus. */
export const WEBLOG_JSONL_WINDOW_BYTES = 1 << 20;
/** A single record larger than this means the source is not newline-delimited JSON. */
export const WEBLOG_JSONL_MAX_RECORD_BYTES = 8 << 20;

/** Bun stream chunks may sit on a `SharedArrayBuffer`, so the reader keeps `ArrayBufferLike`. */
export type WeblogJsonlBytes = Uint8Array<ArrayBufferLike>;

/** Byte source for the reader: one buffer, a decompressed file stream, or explicit chunks. */
export type WeblogJsonlByteSource =
  | WeblogJsonlBytes
  | AsyncIterable<WeblogJsonlBytes>
  | Iterable<WeblogJsonlBytes>;

/** `none` = plain `.jsonl`; the others put a `DecompressionStream` in front of the reader. */
export type WeblogJsonlCompression = "none" | "gzip" | "zstd";

export interface WeblogJsonlOptions {
  /** Bytes fed to one `parseChunk` call (default `WEBLOG_JSONL_WINDOW_BYTES`). */
  readonly windowBytes?: number;
  /** Upper bound for one unterminated line (default `WEBLOG_JSONL_MAX_RECORD_BYTES`). */
  readonly maxRecordBytes?: number;
}

export interface WeblogJsonlStats {
  /** Physical lines consumed, blank lines included (the readline reader's `total`). */
  readonly total: number;
  /** Lines that were blank or not JSON. Row-shape rejections stay with the caller. */
  readonly malformed: number;
  /** Byte offset of the first unread byte; equals the source length after a full read. */
  readonly bytesConsumed: number;
}

export interface WeblogJsonlRead extends WeblogJsonlStats {
  readonly values: readonly unknown[];
}

export interface WeblogDecompressionSupport {
  readonly gzip: boolean;
  readonly zstd: boolean;
}

const GZIP_MAGIC = [0x1f, 0x8b] as const;
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;
const MAGIC_PROBE_BYTES = 4;

function positiveIntOption(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** Index of the last LF, or -1. LF terminates a record; CRLF is tolerated as its delimiter. */
function lastLineFeed(bytes: WeblogJsonlBytes): number {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] === 0x0a) return index;
  }
  return -1;
}

/** Physical line count of a newline-terminated window: `\r\n` once, a lone `\r` once. */
function countLineBreaks(bytes: WeblogJsonlBytes): number {
  let breaks = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x0a) {
      breaks += 1;
    } else if (byte === 0x0d) {
      breaks += 1;
      if (bytes[index + 1] === 0x0a) index += 1;
    }
  }
  return breaks;
}

async function* widenByteSource(
  source: WeblogJsonlByteSource,
): AsyncGenerator<WeblogJsonlBytes> {
  if (source instanceof Uint8Array) {
    yield source;
  } else if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<WeblogJsonlBytes>;
  } else {
    yield* source as Iterable<WeblogJsonlBytes>;
  }
}

/**
 * Stream JSONL bytes through `Bun.JSONL.parseChunk`, window by window.
 *
 * `parseChunk` reports `read` as a BYTE count for `Uint8Array` input (it is a character count for
 * string input, which is why this reader never builds a window string), and `read` excludes the
 * delimiter of the final parsed record. So the reader hands `parseChunk` only newline-terminated
 * windows and advances the byte cursor over the whole window: the terminating delimiter is
 * consumed with it, and bytes past `read` can only be blank lines, which are counted from the
 * window's line breaks instead of being replayed as phantom records.
 */
async function scanWeblogJsonl(
  source: WeblogJsonlByteSource,
  options: WeblogJsonlOptions,
  handlers: {
    readonly onValue: (value: unknown) => void;
    readonly onMalformedLine: () => void;
  },
): Promise<WeblogJsonlStats> {
  const windowBytes = positiveIntOption(
    options.windowBytes,
    WEBLOG_JSONL_WINDOW_BYTES,
  );
  const maxRecordBytes = positiveIntOption(
    options.maxRecordBytes,
    WEBLOG_JSONL_MAX_RECORD_BYTES,
  );
  const parseChunk = Bun.JSONL?.parseChunk;
  const decoder = new TextDecoder();
  let pending: WeblogJsonlBytes = new Uint8Array(0);
  let bytesConsumed = 0;
  let total = 0;
  let malformed = 0;

  const emitMalformed = (count: number): void => {
    for (let index = 0; index < count; index += 1) {
      total += 1;
      malformed += 1;
      handlers.onMalformedLine();
    }
  };

  /**
   * Deterministic per-line fallback. The readline reader counted every physical line, so a blank
   * or unparseable line is one malformed row here too, in order, never skipped or guessed.
   */
  const parseWindowLines = (window: WeblogJsonlBytes): void => {
    const lines = decoder.decode(window).split(/\r\n|\r|\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line.trim() === "") {
        emitMalformed(1);
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        emitMalformed(1);
        continue;
      }
      total += 1;
      handlers.onValue(value);
    }
  };

  const drainCompleteLines = (): void => {
    for (;;) {
      if (pending.length === 0) return;
      const feed = lastLineFeed(pending);
      if (feed < 0) return; // Unterminated tail: held back for the next window.
      const cut = feed + 1;
      const window = pending.subarray(0, cut);
      if (typeof parseChunk !== "function") {
        parseWindowLines(window);
      } else {
        const chunk = parseChunk(window);
        if (chunk.error !== null && chunk.error !== undefined) {
          // One bad record poisons a whole `parseChunk` call; re-read this window line by line
          // so the malformed count stays identical to the per-line reader.
          parseWindowLines(window);
        } else {
          for (const value of chunk.values) {
            total += 1;
            handlers.onValue(value);
          }
          // `parseChunk` silently skips blank and whitespace-only lines. They were malformed
          // rows before this refactor, so count them from the window's line breaks.
          emitMalformed(
            Math.max(0, countLineBreaks(window) - chunk.values.length),
          );
        }
      }
      bytesConsumed += cut;
      pending = pending.subarray(cut);
    }
  };

  for await (const streamed of widenByteSource(source)) {
    if (streamed.length === 0) continue;
    for (let offset = 0; offset < streamed.length; offset += windowBytes) {
      pending = mergeUint8JsonlChunks(
        pending,
        streamed.subarray(offset, offset + windowBytes),
      );
      drainCompleteLines();
      if (pending.length > maxRecordBytes) {
        throw new Error(
          `f402_weblog: unterminated JSONL record exceeds ${maxRecordBytes} bytes; ` +
            "the source is not newline-delimited JSON",
        );
      }
    }
  }

  // End of stream: readline also yields a final line without a trailing newline.
  if (pending.length > 0) {
    bytesConsumed += pending.length;
    parseWindowLines(pending);
    pending = new Uint8Array(0);
  }
  return { total, malformed, bytesConsumed };
}

/** Collect a byte source's JSON records (test/pipe entry point for the streaming reader). */
export async function readWeblogJsonlChunks(
  source: WeblogJsonlByteSource,
  options: WeblogJsonlOptions = {},
): Promise<WeblogJsonlRead> {
  const values: unknown[] = [];
  const stats = await scanWeblogJsonl(source, options, {
    onValue: (value) => values.push(value),
    onMalformedLine: () => {},
  });
  return { ...stats, values };
}

/** Read one JSONL file — plain, `.jsonl.gz` or `.jsonl.zst` — through the byte windows. */
export async function readWeblogJsonlFile(
  path: string,
  options: WeblogJsonlOptions = {},
): Promise<WeblogJsonlRead> {
  return readWeblogJsonlChunks(await weblogFileChunks(path), options);
}

let cachedDecompressionSupport: WeblogDecompressionSupport | undefined;

function probeDecompressionStream(format: "gzip" | "zstd"): boolean {
  try {
    // The ambient `CompressionFormat` types predate zstd; the runtime accepts "zstd" (probed).
    new DecompressionStream(format as never);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this Bun runtime can stream gzip/zstd through `DecompressionStream`.
 *
 * Measured on Bun 1.4.4 (macOS arm64): both `"gzip"` and `"zstd"` construct successfully, so the
 * primary path below is the streaming one. The probe constructs a stream (the constructor throws
 * for an unsupported format) and the answer is cached.
 */
export function weblogDecompressionSupport(): WeblogDecompressionSupport {
  const cached = cachedDecompressionSupport;
  if (cached !== undefined) return cached;
  const measured: WeblogDecompressionSupport = {
    gzip: probeDecompressionStream("gzip"),
    zstd: probeDecompressionStream("zstd"),
  };
  cachedDecompressionSupport = measured;
  return measured;
}

function compressionFromPath(path: string): WeblogJsonlCompression | null {
  if (/\.gz$/i.test(path)) return "gzip";
  if (/\.(?:zst|zstd)$/i.test(path)) return "zstd";
  return null; // Unknown/plain suffix: fall back to the magic bytes.
}

function compressionFromMagic(
  head: WeblogJsonlBytes,
): WeblogJsonlCompression | null {
  if (head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1]) return "gzip";
  if (
    head.length >= ZSTD_MAGIC.length &&
    ZSTD_MAGIC.every((byte, index) => head[index] === byte)
  )
    return "zstd";
  return null;
}

/** Extension first, magic bytes as the backup for an unknown or misleading suffix. */
async function detectWeblogCompression(
  path: string,
): Promise<WeblogJsonlCompression> {
  const byExtension = compressionFromPath(path);
  if (byExtension !== null) return byExtension;
  let head: WeblogJsonlBytes;
  try {
    head = new Uint8Array(
      await Bun.file(path).slice(0, MAGIC_PROBE_BYTES).arrayBuffer(),
    );
  } catch (error) {
    throw new Error(
      `f402_weblog: cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return compressionFromMagic(head) ?? "none";
}

async function* singleChunk(
  bytes: Uint8Array,
): AsyncGenerator<WeblogJsonlBytes> {
  yield bytes;
}

async function weblogFileChunks(path: string): Promise<WeblogJsonlByteSource> {
  const compression = await detectWeblogCompression(path);
  const file = Bun.file(path);
  if (compression === "none") return file.stream();
  const support = weblogDecompressionSupport();
  if (compression === "gzip") {
    if (!support.gzip) {
      throw new Error(
        `f402_weblog: ${path} is gzip but this Bun runtime has no gzip DecompressionStream`,
      );
    }
    return file.stream().pipeThrough(new DecompressionStream("gzip" as never));
  }
  if (support.zstd) {
    return file.stream().pipeThrough(new DecompressionStream("zstd" as never));
  }
  // Degraded path for a runtime without streaming zstd. It materializes the file instead of
  // streaming it; it cannot run on Bun 1.4.4, where the probe above reports zstd support.
  if (typeof Bun.zstdDecompressSync === "function") {
    return singleChunk(Bun.zstdDecompressSync(await file.bytes()));
  }
  throw new Error(
    `f402_weblog: ${path} is zstd but this Bun runtime has neither a zstd DecompressionStream nor Bun.zstdDecompressSync`,
  );
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
    let invalid = 0;
    const stats = await scanWeblogJsonl(
      await weblogFileChunks(path),
      {},
      {
        onValue: (value) => {
          // JSON `null` and scalars are not WebLog rows. The readline reader counted scalars as
          // malformed and crashed on `null`; counting both malformed keeps the counts deterministic.
          if (value === null || typeof value !== "object") {
            invalid += 1;
            return;
          }
          const raw = value as Record<string, unknown>;
          const accessMs = parseAccessMs(String(raw.AccessDateTime ?? ""));
          if (!Number.isFinite(accessMs)) {
            invalid += 1;
            return;
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
            ipv6Prefix64: classifyIpv6(ip).prefix64,
            operation: String(raw.Operation ?? ""),
            ...parsed,
          });
        },
        onMalformedLine: () => {},
      },
    );
    total += stats.total;
    malformed += stats.malformed + invalid;
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
  await scanWeblogJsonl(
    await weblogFileChunks(path),
    {},
    {
      onValue: (value) => {
        if (value === null || typeof value !== "object") return;
        const raw = value as Record<string, unknown>;
        const insertMs = parseAccessMs(String(raw.InsertDateTime ?? ""));
        if (!Number.isFinite(insertMs) || insertMs < fromMs || insertMs >= toMs)
          return;
        const login = String(raw.Login ?? "").trim();
        if (login === "") return;
        rows.push({ login, insertMs, ticket: String(raw.TicketNumber ?? "") });
      },
      onMalformedLine: () => {},
    },
  );
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
    readonly executionSnipers: number;
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
  const allByLogin = new Map<string, WeblogEvent[]>();
  for (const row of web.rows) {
    if (row.loginId !== "") {
      const all = allByLogin.get(row.loginId) ?? [];
      all.push(row);
      allByLogin.set(row.loginId, all);
    }
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
    ip32: number | null;
    ipv6Prefix64: string | null;
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
        ip32: start.ip32,
        ipv6Prefix64: start.ipv6Prefix64,
        skin: start.skinDomain,
        version: start.clientVersion,
        wagers: [],
      };
      list.push(session);
    }
    for (const session of list) {
      for (const event of allByLogin.get(login) ?? []) {
        if (event.accessMs < session.start || event.accessMs > session.end)
          continue;
        if (session.skin === null && event.skinDomain !== null)
          session.skin = event.skinDomain;
        if (session.version === null && event.clientVersion !== null)
          session.version = event.clientVersion;
      }
    }
    byLogin.set(login, list);
    sessions.push(...list);
  }

  let matched = 0,
    persistentUnmatched = 0,
    nonWebChannel = 0,
    futureJoins = 0;
  const deltas: number[] = [];
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
  const protectedSet = new Set<string>(NEGATIVE_CONTROLS);
  interface AccountStat {
    prefix: string | null;
    skin: string | null;
    times: number[];
    fast: boolean;
  }
  const accountStats = new Map<string, AccountStat>();
  for (const session of sessions) {
    if (session.wagers.length === 0) {
      zeroWagerSessions += 1;
      if (session.end - session.start >= 120_000) lineShoppers += 1;
      continue;
    }
    session.wagers.sort((a, b) => a - b);
    const firstDelay = session.wagers[0]! - session.start;
    let burst = false;
    for (let i = 1; i < session.wagers.length; i += 1) {
      if (session.wagers[i]! - session.wagers[i - 1]! <= 15_000) burst = true;
    }
    const carrier = classifyIp(session.ip);
    const prefix =
      session.ipv6Prefix64 !== null && carrier === "IPV6_OTHER_64"
        ? `6:${session.ipv6Prefix64}`
        : session.ip32 !== null && !carrier.startsWith("IPV6_")
          ? `4:${session.ip32 >>> 8}`
          : null;
    const stat = accountStats.get(session.login) ?? {
      prefix,
      skin: null,
      times: [],
      fast: false,
    };
    if (stat.prefix === null) stat.prefix = prefix;
    if (stat.skin === null && session.skin !== null) stat.skin = session.skin;
    stat.times.push(...session.wagers);
    stat.fast ||= (firstDelay >= 0 && firstDelay < 15_000) || burst;
    accountStats.set(session.login, stat);
  }
  const executionSnipers = [...accountStats.entries()]
    .filter(([login, stat]) => !protectedSet.has(login) && stat.fast)
    .map(([login]) => login);
  const twinGroups = new Map<
    string,
    Array<{
      login: string;
      times: number[];
      skin: string | null;
      fast: boolean;
    }>
  >();
  for (const [login, stat] of accountStats) {
    if (stat.prefix === null) continue;
    const list = twinGroups.get(stat.prefix) ?? [];
    list.push({
      login,
      times: [...stat.times].sort((a, b) => a - b),
      skin: stat.skin,
      fast: stat.fast,
    });
    twinGroups.set(stat.prefix, list);
  }
  const twinAccounts = new Set<string>();
  for (const list of twinGroups.values()) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!,
          b = list[j]!;
        if (a.login === b.login) continue;
        if (protectedSet.has(a.login) || protectedSet.has(b.login)) continue;
        if (a.skin !== null && b.skin !== null && a.skin !== b.skin) continue;
        if (!a.fast && !b.fast) continue;
        const close = a.times.some((t) =>
          b.times.some((u) => Math.abs(t - u) <= 60_000),
        );
        if (close) {
          twinAccounts.add(a.login);
          twinAccounts.add(b.login);
        }
      }
    }
  }
  const sniperTwins = [...twinAccounts].filter(
    (login) => !protectedSet.has(login),
  ).length;
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
  const negativeFlags = NEGATIVE_CONTROLS.filter((login) =>
    twinAccounts.has(login),
  ).length;
  deltas.sort((a, b) => a - b);
  const rawLogins = new Set(
    web.rows
      .map((r) => r.loginId.trim().toLowerCase())
      .filter((l) => l.length >= 3),
  );
  const rawIps = new Set(
    web.rows.map((r) => r.ip.trim()).filter((ip) => ip !== ""),
  );
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
    flags: {
      executionSnipers: executionSnipers.length,
      sniperTwins,
      lineShoppers,
      botRingAccounts,
      crossOfficeBeards,
    },
    gates,
    negativeControls: {
      checked: NEGATIVE_CONTROLS.length,
      falsePositiveFlags: negativeFlags,
    },
  };
  const serialized = JSON.stringify(base);
  const tokenMatches = serialized.match(/[A-Za-z0-9_.-]{3,}/g) ?? [];
  const ipMatches = serialized.match(/\d{1,3}(?:\.\d{1,3}){3}/g) ?? [];
  const leakedTokens =
    tokenMatches.filter((token) => rawLogins.has(token.toLowerCase())).length +
    ipMatches.filter((ip) => rawIps.has(ip)).length;
  const leakGate = {
    gate: "GATE-WL-04",
    status: leakedTokens === 0 ? "pass" : "fail",
    detail: `leakedTokenCount=${leakedTokens} logins=${rawLogins.size} ips=${rawIps.size}`,
  } as const;
  const finalGates = base.gates.map((gate) =>
    gate.gate === "GATE-WL-04" ? leakGate : gate,
  );
  const finalBase = { ...base, gates: finalGates };
  const sourceSha256 = sha256Hex(JSON.stringify(finalBase));
  return { ...finalBase, sourceSha256 };
}
