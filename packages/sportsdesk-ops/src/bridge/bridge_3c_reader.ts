// packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts
// SPDX-License-Identifier: MIT

import {
  createWagerSoATable,
  type WagerOddsColumn,
  type WagerSoATableLayout,
  type WagerSpreadColumn,
  type WagerTotalColumn,
} from "../types/wager_soa";

export type Bridge3cCompression = "gzip" | "zstd" | "deflate" | "none";

/** Bun/Node SystemError: an Error from a failed system call. */
export interface SystemError extends Error {
  readonly cause?: unknown;
  readonly code?: string;
  readonly errno?: number;
  readonly path?: string;
  readonly syscall?: string;
}

/** True when `error` carries system-call metadata (errno/code/path/syscall). */
export function isSystemError(error: unknown): error is SystemError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<SystemError>;
  return (
    typeof candidate.errno === "number" ||
    typeof candidate.code === "string" ||
    typeof candidate.syscall === "string" ||
    typeof candidate.path === "string"
  );
}
export type Bridge3cParseMode = "auto" | "bun-native-jsonl" | "text-stream";

export interface ProcessBridge3cOptions {
  /** Explicit compression override; if omitted, automatically sniffed from headers & magic bytes. */
  readonly compression?: Bridge3cCompression;
  /** Parser engine mode ('auto', 'bun-native-jsonl' via C++ SIMD, or 'text-stream'). Default 'auto'. */
  readonly parseMode?: Bridge3cParseMode;
  /** Initial allocation slab row capacity (default 1,024, auto-doubles on overflow). */
  readonly initialCapacity?: number;
  /** Maximum bytes permitted in a single line buffer before throwing (default 1 MiB). */
  readonly maxLineBytes?: number;
  /** Error handling policy when an unparseable line is encountered (default 'throw'). */
  readonly errorMode?: "throw" | "skip";
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** Diagnostic hook for malformed rows encountered when errorMode === 'skip'. */
  readonly onMalformedLine?: (rawLine: string, error: unknown) => void;
}

export interface WagerSoAColumnarView {
  readonly rowCount: number;
  readonly spreadCol: Int32Array;
  readonly totalCol: Int32Array;
  readonly oddsCol: Int32Array;
}

export interface Bridge3cStreamResult extends WagerSoATableLayout {
  readonly rowCount: number;
  readonly bytesConsumed: number;
  readonly malformedRows: number;
  readonly detectedCompression: Bridge3cCompression;
  readonly engineUsed: "bun-native-jsonl" | "text-stream";
  /** Returns a zero-copy subview of columns clamped to actual populated rowCount. */
  view(): WagerSoAColumnarView;
  /** Serializes the entire SoA table into a binary ArrayBuffer snapshot with an SOA1 header. */
  toBinary(): ArrayBuffer;
}

export interface WagerSoAMetrics {
  readonly rowCount: number;
  readonly minSpread: number;
  readonly maxSpread: number;
  readonly avgSpread: number;
  readonly minTotal: number;
  readonly maxTotal: number;
  readonly avgTotal: number;
  readonly minOdds: number;
  readonly maxOdds: number;
  readonly avgOdds: number;
}

const SOA_BINARY_MAGIC = 0x534f4131; // ASCII 'SOA1'
const SOA_BINARY_VERSION = 1;
const SOA_HEADER_BYTES = 16;

/** Sniffs compression algorithm from first bytes (null = uncompressed). */
export function sniffStreamCompression(
  head: Uint8Array<ArrayBufferLike>,
): Bridge3cCompression | null {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return "gzip";
  if (
    head.length >= 4 &&
    head[0] === 0x28 &&
    head[1] === 0xb5 &&
    head[2] === 0x2f &&
    head[3] === 0xfd
  ) {
    return "zstd";
  }
  if (
    head.length >= 2 &&
    head[0] === 0x78 &&
    (head[1] === 0x01 || head[1] === 0x9c || head[1] === 0xda)
  ) {
    return "deflate";
  }
  return null;
}

/** Concatenates two Uint8Arrays with zero allocations if either is empty. */
function concatUint8(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Trims leading newlines and whitespace bytes from an ArrayBuffer slice. */
function trimLeadingWhitespace(
  arr: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  let start = 0;
  while (
    start < arr.length &&
    (arr[start] === 0x0a ||
      arr[start] === 0x0d ||
      arr[start] === 0x20 ||
      arr[start] === 0x09)
  ) {
    start++;
  }
  return start > 0 ? arr.subarray(start) : arr;
}

/**
 * Resolves body stream into a decompressed byte stream, auto-sniffing
 * gzip, zstd, and deflate if not explicitly configured.
 */
async function resolveDecompressedStream(
  body: ReadableStream<Uint8Array>,
  explicitCompression?: Bridge3cCompression,
  contentEncodingHeader?: string | null,
): Promise<{
  stream: ReadableStream<Uint8Array>;
  compression: Bridge3cCompression;
}> {
  if (explicitCompression !== undefined) {
    if (explicitCompression === "none") {
      return { stream: body, compression: "none" };
    }
    return {
      stream: (body as ReadableStream).pipeThrough(
        new DecompressionStream(explicitCompression as never) as never,
      ) as ReadableStream<Uint8Array>,
      compression: explicitCompression,
    };
  }

  // 1. Inspect Content-Encoding header
  if (contentEncodingHeader) {
    const enc = contentEncodingHeader.toLowerCase().trim();
    if (enc === "gzip" || enc === "zstd" || enc === "deflate") {
      return {
        stream: (body as ReadableStream).pipeThrough(
          new DecompressionStream(enc as never) as never,
        ) as ReadableStream<Uint8Array>,
        compression: enc as Bridge3cCompression,
      };
    }
  }

  // 2. Sniff magic bytes from stream head
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done || !first.value || first.value.length === 0) {
    return {
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      compression: "none",
    };
  }

  const sniffed = sniffStreamCompression(first.value) ?? "none";

  const reconstructed = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(first.value);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            break;
          }
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  if (sniffed === "none") {
    return { stream: reconstructed, compression: "none" };
  }

  return {
    stream: (reconstructed as ReadableStream).pipeThrough(
      new DecompressionStream(sniffed as never) as never,
    ) as ReadableStream<Uint8Array>,
    compression: sniffed,
  };
}

/**
 * High-performance Bun native binary stream parser using `Bun.JSONL.parseChunk`.
 * Bypasses string chunking and operates directly on raw UTF-8 byte buffers.
 */
async function processNativeJsonlStream(
  decompressedStream: ReadableStream<Uint8Array>,
  compression: Bridge3cCompression,
  options: ProcessBridge3cOptions,
): Promise<Bridge3cStreamResult> {
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  const errorMode = options.errorMode ?? "throw";

  let table = createWagerSoATable(options.initialCapacity ?? 1024);
  let rowIndex = 0;
  let bytesConsumed = 0;
  let malformedRows = 0;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  const reader = decompressedStream.getReader();

  const writeRecord = (record: {
    spread?: number;
    total?: number;
    odds?: number;
  }): void => {
    if (rowIndex >= table.capacity) {
      const nextCapacity = table.capacity * 2;
      const nextTable = createWagerSoATable(nextCapacity);
      nextTable.spreadCol.set(table.spreadCol);
      nextTable.totalCol.set(table.totalCol);
      nextTable.oddsCol.set(table.oddsCol);
      table = nextTable;
    }
    table.spreadCol[rowIndex] = record.spread ?? 0;
    table.totalCol[rowIndex] = record.total ?? 0;
    table.oddsCol[rowIndex] = record.odds ?? 0;
    rowIndex++;
  };

  try {
    while (true) {
      if (options.signal?.aborted) {
        throw (
          options.signal.reason ??
          new Error("ERR_STREAM_ABORTED: Processing aborted.")
        );
      }

      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;

      bytesConsumed += value.length;
      pending = concatUint8(pending, value);

      if (pending.length > maxLineBytes && pending.indexOf(0x0a) < 0) {
        throw new Error(
          `ERR_BRIDGE3C_LINE_OVERFLOW: JSONL record exceeds maximum bound (${maxLineBytes} bytes).`,
        );
      }

      pending = trimLeadingWhitespace(pending);

      while (pending.length > 0) {
        const res = Bun.JSONL.parseChunk(pending) as {
          values: Array<{ spread?: number; total?: number; odds?: number }>;
          read: number;
          error?: unknown;
        };

        for (let i = 0; i < res.values.length; i++) {
          const rec = res.values[i];
          if (rec) writeRecord(rec);
        }

        pending = trimLeadingWhitespace(pending.subarray(res.read));

        if (res.error) {
          // A failed syscall is not a malformed row: never skip it, and never
          // bury its errno/code/path/syscall under a wrapper's `cause`.
          if (isSystemError(res.error)) throw res.error;
          malformedRows++;
          const nextNl = pending.indexOf(0x0a);
          const poisonLine =
            nextNl >= 0
              ? new TextDecoder().decode(pending.subarray(0, nextNl))
              : new TextDecoder().decode(pending);

          if (options.onMalformedLine) {
            options.onMalformedLine(poisonLine, res.error);
          }

          if (errorMode === "throw") {
            throw new Error(
              `ERR_BRIDGE3C_MALFORMED_JSON: Cannot parse record: ${
                res.error instanceof Error
                  ? res.error.message
                  : String(res.error)
              }`,
              { cause: res.error },
            );
          }

          // In skip mode: jump past poison line
          if (nextNl >= 0) {
            pending = trimLeadingWhitespace(pending.subarray(nextNl + 1));
          } else {
            pending = new Uint8Array(0);
            break;
          }
        } else {
          // If no error, remaining bytes are an incomplete line waiting for next chunk
          break;
        }

        if (pending.length > maxLineBytes) {
          throw new Error(
            `ERR_BRIDGE3C_LINE_OVERFLOW: JSONL record exceeds maximum bound (${maxLineBytes} bytes).`,
          );
        }
      }
    }

    // Trailing record check
    pending = trimLeadingWhitespace(pending);
    if (pending.length > 0) {
      if (pending.length > maxLineBytes) {
        throw new Error(
          `ERR_BRIDGE3C_LINE_OVERFLOW: JSONL record exceeds maximum bound (${maxLineBytes} bytes).`,
        );
      }
      const trimmed = new TextDecoder().decode(pending).trim();
      if (trimmed.length > 0) {
        try {
          const rec = JSON.parse(trimmed) as {
            spread?: number;
            total?: number;
            odds?: number;
          };
          writeRecord(rec);
        } catch (err) {
          malformedRows++;
          if (options.onMalformedLine) options.onMalformedLine(trimmed, err);
          if (errorMode === "throw") {
            throw new Error(
              `ERR_BRIDGE3C_MALFORMED_JSON: Trailing line corrupt: ${trimmed}`,
              { cause: err },
            );
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return assembleResult(
    table,
    rowIndex,
    bytesConsumed,
    malformedRows,
    compression,
    "bun-native-jsonl",
  );
}

/**
 * Fallback / portable text streaming reader using `Response.textStream()`.
 */
async function processTextStream(
  decompressedStream: ReadableStream<Uint8Array>,
  compression: Bridge3cCompression,
  options: ProcessBridge3cOptions,
): Promise<Bridge3cStreamResult> {
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  const errorMode = options.errorMode ?? "throw";
  const textStream = new Response(decompressedStream).textStream();

  let table = createWagerSoATable(options.initialCapacity ?? 1024);
  let rowIndex = 0;
  let bytesConsumed = 0;
  let malformedRows = 0;
  let remainder = "";

  const ingestRecord = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    let record: { spread?: number; total?: number; odds?: number };
    try {
      record = JSON.parse(trimmed);
    } catch (err) {
      malformedRows++;
      if (options.onMalformedLine) options.onMalformedLine(trimmed, err);
      if (errorMode === "skip") return;
      throw new Error(
        `ERR_BRIDGE3C_MALFORMED_JSON: Cannot parse record: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    if (rowIndex >= table.capacity) {
      const nextCapacity = table.capacity * 2;
      const nextTable = createWagerSoATable(nextCapacity);
      nextTable.spreadCol.set(table.spreadCol);
      nextTable.totalCol.set(table.totalCol);
      nextTable.oddsCol.set(table.oddsCol);
      table = nextTable;
    }

    table.spreadCol[rowIndex] = record.spread ?? 0;
    table.totalCol[rowIndex] = record.total ?? 0;
    table.oddsCol[rowIndex] = record.odds ?? 0;
    rowIndex++;
  };

  for await (const chunk of textStream) {
    if (options.signal?.aborted) {
      throw (
        options.signal.reason ??
        new Error("ERR_STREAM_ABORTED: Processing aborted.")
      );
    }
    bytesConsumed += chunk.length;
    const combined = remainder + chunk;
    const lines = combined.split("\n");
    remainder = lines.pop() ?? "";

    if (remainder.length > maxLineBytes) {
      throw new Error(
        `ERR_BRIDGE3C_LINE_OVERFLOW: JSONL record exceeds maximum bound (${maxLineBytes} bytes).`,
      );
    }

    for (const line of lines) {
      ingestRecord(line);
    }
  }

  if (remainder.length > 0) {
    if (remainder.length > maxLineBytes) {
      throw new Error(
        `ERR_BRIDGE3C_LINE_OVERFLOW: JSONL record exceeds maximum bound (${maxLineBytes} bytes).`,
      );
    }
    ingestRecord(remainder);
  }

  return assembleResult(
    table,
    rowIndex,
    bytesConsumed,
    malformedRows,
    compression,
    "text-stream",
  );
}

function assembleResult(
  table: WagerSoATableLayout,
  rowCount: number,
  bytesConsumed: number,
  malformedRows: number,
  compression: Bridge3cCompression,
  engineUsed: "bun-native-jsonl" | "text-stream",
): Bridge3cStreamResult {
  return {
    ...table,
    rowCount,
    bytesConsumed,
    malformedRows,
    detectedCompression: compression,
    engineUsed,
    view() {
      return {
        rowCount,
        spreadCol: table.spreadCol.subarray(0, rowCount),
        totalCol: table.totalCol.subarray(0, rowCount),
        oddsCol: table.oddsCol.subarray(0, rowCount),
      };
    },
    toBinary() {
      return serializeWagerSoABinary(table, rowCount);
    },
  };
}

/**
 * Streams, decompresses, and ingests JSONL wager lines into zero-allocation SoA slabs.
 * Selects between `Bun.JSONL.parseChunk` and `Response.textStream()` based on engine mode.
 */
export async function processBridge3cStream(
  response: Response,
  options: ProcessBridge3cOptions = {},
): Promise<Bridge3cStreamResult> {
  if (!response.body) {
    throw new Error("ERR_ROUTER_STREAM_NULL: Response body is empty.");
  }

  const encodingHeader = response.headers?.get("content-encoding") ?? null;
  const { stream: decompressedStream, compression } =
    await resolveDecompressedStream(
      response.body,
      options.compression,
      encodingHeader,
    );

  const mode = options.parseMode ?? "auto";
  const useNative =
    (mode === "auto" || mode === "bun-native-jsonl") &&
    typeof Bun !== "undefined" &&
    typeof Bun.JSONL?.parseChunk === "function";

  if (useNative) {
    return processNativeJsonlStream(decompressedStream, compression, options);
  }

  return processTextStream(decompressedStream, compression, options);
}

/**
 * Serializes a WagerSoATable into a binary ArrayBuffer with a 16-byte SOA1 header.
 * Ideal for streaming directly to Cloudflare R2 snapshots without JSON encoding overhead.
 */
export function serializeWagerSoABinary(
  table: WagerSoATableLayout,
  rowCount: number,
): ArrayBuffer {
  const bytesPerCol = table.capacity * Int32Array.BYTES_PER_ELEMENT;
  const totalBytes = SOA_HEADER_BYTES + bytesPerCol * 3;
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  // 16-byte Header
  view.setUint32(0, SOA_BINARY_MAGIC, false); // Magic 'SOA1'
  view.setUint32(4, SOA_BINARY_VERSION, false);
  view.setUint32(8, rowCount, false);
  view.setUint32(12, table.capacity, false);

  // Copy contiguous slab
  const slabPayload = new Uint8Array(buffer, SOA_HEADER_BYTES);
  slabPayload.set(new Uint8Array(table.spreadCol.buffer, 0, bytesPerCol * 3));

  return buffer;
}

/**
 * Deserializes an ArrayBuffer containing an SOA1 binary snapshot with zero payload parsing overhead.
 */
export function deserializeWagerSoABinary(
  buffer: ArrayBuffer,
): Bridge3cStreamResult {
  if (buffer.byteLength < SOA_HEADER_BYTES) {
    throw new Error(
      "ERR_SOA_BINARY_TRUNCATED: ArrayBuffer is smaller than SOA1 header.",
    );
  }

  const view = new DataView(buffer);
  const magic = view.getUint32(0, false);
  if (magic !== SOA_BINARY_MAGIC) {
    throw new Error(
      `ERR_SOA_BINARY_BAD_MAGIC: Expected SOA1 (0x534F4131), found 0x${magic.toString(16)}.`,
    );
  }

  const version = view.getUint32(4, false);
  if (version !== SOA_BINARY_VERSION) {
    throw new Error(
      `ERR_SOA_BINARY_VERSION_MISMATCH: Unsupported version ${version}.`,
    );
  }

  const rowCount = view.getUint32(8, false);
  const capacity = view.getUint32(12, false);

  const bytesPerCol = capacity * Int32Array.BYTES_PER_ELEMENT;
  const expectedTotalBytes = SOA_HEADER_BYTES + bytesPerCol * 3;
  if (buffer.byteLength < expectedTotalBytes) {
    throw new Error(
      `ERR_SOA_BINARY_PAYLOAD_TRUNCATED: Expected ${expectedTotalBytes} bytes, got ${buffer.byteLength}.`,
    );
  }

  // Construct zero-copy views directly over the buffer slab
  const stride = bytesPerCol;
  const spreadCol = new Int32Array(
    buffer,
    SOA_HEADER_BYTES,
    capacity,
  ) as WagerSpreadColumn;
  const totalCol = new Int32Array(
    buffer,
    SOA_HEADER_BYTES + stride,
    capacity,
  ) as WagerTotalColumn;
  const oddsCol = new Int32Array(
    buffer,
    SOA_HEADER_BYTES + stride * 2,
    capacity,
  ) as WagerOddsColumn;

  const table: WagerSoATableLayout = { capacity, spreadCol, totalCol, oddsCol };

  return assembleResult(
    table,
    rowCount,
    buffer.byteLength,
    0,
    "none",
    "bun-native-jsonl",
  );
}

/**
 * Computes analytic reductions over the SoA table in a single memory pass.
 * Adheres to zero-collection-allocation invariants (no Map, Set, or Object allocations in the loop).
 */
export function computeWagerSoAMetrics(
  table: WagerSoATableLayout,
  rowCount: number,
): WagerSoAMetrics {
  if (rowCount === 0) {
    return {
      rowCount: 0,
      minSpread: 0,
      maxSpread: 0,
      avgSpread: 0,
      minTotal: 0,
      maxTotal: 0,
      avgTotal: 0,
      minOdds: 0,
      maxOdds: 0,
      avgOdds: 0,
    };
  }

  let minSpread = table.spreadCol[0]!;
  let maxSpread = table.spreadCol[0]!;
  let sumSpread = 0;

  let minTotal = table.totalCol[0]!;
  let maxTotal = table.totalCol[0]!;
  let sumTotal = 0;

  let minOdds = table.oddsCol[0]!;
  let maxOdds = table.oddsCol[0]!;
  let sumOdds = 0;

  for (let i = 0; i < rowCount; i++) {
    const s = table.spreadCol[i]!;
    if (s < minSpread) minSpread = s;
    if (s > maxSpread) maxSpread = s;
    sumSpread += s;

    const t = table.totalCol[i]!;
    if (t < minTotal) minTotal = t;
    if (t > maxTotal) maxTotal = t;
    sumTotal += t;

    const o = table.oddsCol[i]!;
    if (o < minOdds) minOdds = o;
    if (o > maxOdds) maxOdds = o;
    sumOdds += o;
  }

  return {
    rowCount,
    minSpread,
    maxSpread,
    avgSpread: sumSpread / rowCount,
    minTotal,
    maxTotal,
    avgTotal: sumTotal / rowCount,
    minOdds,
    maxOdds,
    avgOdds: sumOdds / rowCount,
  };
}
