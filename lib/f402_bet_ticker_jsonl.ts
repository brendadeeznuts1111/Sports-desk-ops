/**
 * @file f402_bet_ticker_jsonl.ts
 * @description Tail ingestion for Bridge 3a. The live F402 bet ticker is archived by the 4C
 * collector as append-only JSONL (`probes/out13/f402-bets.jsonl`, hundreds of MB). Bridge 3a can
 * project that stream without opening a second Fantasy402 session: this reader keeps a byte offset
 * and a wager-number watermark, reads only the bytes appended since the last read, holds back a
 * partial trailing line, and never loads the whole file.
 *
 * The record shape is the captured `getBetTicker` row (13 flat fields, `WagerNumber` numeric): it
 * is parsed by the same `parseF402TickerRow` the HTTP probe uses, so both sources share one
 * normalization and one PII boundary.
 *
 * First read: the last `windowBytes` (default 2 MB) of the file, aligned to a line boundary — that
 * is the "current live window" for a baseline snapshot. Later reads: only new appends.
 */

import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { numericWagerNumber } from "./f402_bet_ticker_delta.ts";
import { parseF402TickerRow, type F402TickerRow } from "./f402_ingest.ts";

/** Default initial tail window; the live window is far smaller, this is a safe bound. */
export const F402_BET_TICKER_JSONL_WINDOW_BYTES = 2_000_000;

export interface F402TickerJsonlState {
  /** Byte offset of the next unread byte. */
  readonly offset: number;
  /** Highest wager number already consumed from this file. */
  readonly watermark: number;
  readonly initialized: boolean;
}

export interface F402TickerJsonlRead {
  readonly rows: readonly F402TickerRow[];
  readonly state: F402TickerJsonlState;
  readonly bytesRead: number;
  /** Lines that were not JSON or not a ticker row; skipped, never guessed into rows. */
  readonly skippedLines: number;
  /** `initial` = first tail window, `shrunk` = the file moved backwards and was re-windowed. */
  readonly reset: "none" | "initial" | "shrunk";
  readonly fileSize: number;
}

export interface F402TickerJsonlOptions {
  readonly state?: F402TickerJsonlState;
  readonly windowBytes?: number;
  /** Drop rows at or below the previous watermark (incremental polls). */
  readonly filterWatermark?: boolean;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/**
 * Read the ticker JSONL from the previous offset (or the initial tail window).
 *
 * A partial trailing line is not consumed: the returned offset points at the byte after the last
 * newline, so the next read starts exactly where the incomplete record begins. A file that shrank
 * below the recorded offset (rotation/truncation) is re-windowed instead of reading garbage.
 */
export async function readF402TickerJsonl(
  path: string,
  options: F402TickerJsonlOptions = {},
): Promise<F402TickerJsonlRead> {
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    throw new Error(
      `readF402TickerJsonl: cannot stat ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const windowBytes = positiveInt(
    options.windowBytes,
    F402_BET_TICKER_JSONL_WINDOW_BYTES,
  );
  const prior = options.state;
  const previousWatermark = prior?.watermark ?? 0;
  if (/\.(zst|gz)$/i.test(path)) {
    const format = path.toLowerCase().endsWith(".zst") ? "zstd" : "gzip";
    const stream = Bun.file(path)
      .stream()
      .pipeThrough(new DecompressionStream(format as never));
    let text = "";
    for await (const chunk of new Response(stream).textStream()) text += chunk;
    const rows: F402TickerRow[] = [];
    let skippedLines = 0;
    let watermark = previousWatermark;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let payload: unknown;
      try {
        payload = JSON.parse(line);
      } catch {
        skippedLines += 1;
        continue;
      }
      const row = parseF402TickerRow(payload);
      if (row === null) {
        skippedLines += 1;
        continue;
      }
      const wagerNumber = numericWagerNumber(row);
      if (
        options.filterWatermark === true &&
        wagerNumber !== null &&
        wagerNumber <= previousWatermark
      )
        continue;
      rows.push(row);
      if (wagerNumber !== null && wagerNumber > watermark)
        watermark = wagerNumber;
    }
    return {
      rows,
      state: { offset: fileSize, watermark, initialized: true },
      bytesRead: fileSize,
      skippedLines,
      reset: "initial",
      fileSize,
    };
  }

  let start: number;
  let reset: F402TickerJsonlRead["reset"];
  if (prior === undefined || !prior.initialized) {
    start = Math.max(0, fileSize - windowBytes);
    reset = "initial";
  } else if (prior.offset > fileSize) {
    start = Math.max(0, fileSize - windowBytes);
    reset = "shrunk";
  } else {
    start = prior.offset;
    reset = "none";
  }

  if (start >= fileSize) {
    return {
      rows: [],
      state: {
        offset: start,
        watermark: previousWatermark,
        initialized: true,
      },
      bytesRead: 0,
      skippedLines: 0,
      reset,
      fileSize,
    };
  }

  const length = fileSize - start;
  const buffer = new Uint8Array(length);
  const handle = await open(path, "r");
  try {
    let read = 0;
    while (read < length) {
      const chunk = await handle.read(
        buffer,
        read,
        length - read,
        start + read,
      );
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    const view = buffer.subarray(0, read);

    // Only complete lines are consumed; anything after the final newline is left for the next read.
    let lastNewline = -1;
    for (let index = view.length - 1; index >= 0; index -= 1) {
      if (view[index] === 0x0a) {
        lastNewline = index;
        break;
      }
    }
    if (lastNewline < 0) {
      return {
        rows: [],
        state: {
          offset: start,
          watermark: previousWatermark,
          initialized: true,
        },
        bytesRead: read,
        skippedLines: 0,
        reset,
        fileSize,
      };
    }

    // The initial window can begin mid-line; drop that fragment (checked against the previous byte).
    let skip = 0;
    if ((reset === "initial" || reset === "shrunk") && start > 0) {
      const previous = new Uint8Array(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        const firstNewline = view.indexOf(0x0a);
        skip = firstNewline === -1 ? view.length : firstNewline + 1;
      }
    }

    const rows: F402TickerRow[] = [];
    let skippedLines = 0;
    let watermark = previousWatermark;
    const accept = (payload: unknown): void => {
      const row = parseF402TickerRow(payload);
      if (row === null) {
        skippedLines += 1;
        return;
      }
      const wagerNumber = numericWagerNumber(row);
      if (
        options.filterWatermark === true &&
        wagerNumber !== null &&
        wagerNumber <= previousWatermark
      ) {
        return;
      }
      rows.push(row);
      if (wagerNumber !== null && wagerNumber > watermark) {
        watermark = wagerNumber;
      }
    };

    const completeEnd = lastNewline + 1;
    const parseChunk = Bun.JSONL?.parseChunk;
    let consumed = skip;
    if (typeof parseChunk === "function") {
      const chunk = parseChunk(view.subarray(skip, completeEnd));
      if (chunk.error === null || chunk.error === undefined) {
        for (const payload of chunk.values) accept(payload);
        // `chunk.read` is a BYTE count for a Uint8Array chunk (it is a character count for string
        // input; moving a byte buffer here would corrupt every multi-byte UTF-8 record). It also
        // excludes the newline that terminates the final parsed record, so advance over the
        // delimiter: the recorded offset must be the first unread byte, never a replayed newline.
        consumed = skip + chunk.read;
        while (consumed < completeEnd && view[consumed] === 0x0a) consumed += 1;
      } else {
        // Malformed line mid-chunk: fall back to per-line parsing of complete lines so valid
        // records before/after the bad one are still consumed deterministically.
        const lines = new TextDecoder()
          .decode(view.subarray(skip, completeEnd))
          .split("\n");
        for (const line of lines) {
          if (line.trim() === "") continue;
          try {
            accept(JSON.parse(line));
          } catch {
            skippedLines += 1;
          }
        }
        consumed = completeEnd;
      }
    } else {
      const lines = new TextDecoder()
        .decode(view.subarray(skip, completeEnd))
        .split("\n");
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          accept(JSON.parse(line));
        } catch {
          skippedLines += 1;
        }
      }
      consumed = completeEnd;
    }

    return {
      rows,
      state: {
        offset: start + consumed,
        watermark,
        initialized: true,
      },
      bytesRead: read,
      skippedLines,
      reset,
      fileSize,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Whether a loop tick should refresh the R2 window snapshot: every `every` ticks, and only when
 * new bytes actually arrived since the last window write (no empty rewrites).
 */
export function shouldRefreshWindowSnapshot(input: {
  readonly tick: number;
  readonly every: number;
  readonly bytesSinceLastWrite: number;
}): boolean {
  const { tick, every, bytesSinceLastWrite } = input;
  if (bytesSinceLastWrite <= 0) return false;
  if (!Number.isSafeInteger(every) || every < 1) return false;
  return tick > 0 && tick % every === 0;
}

export interface F402TickerJsonlPersistedState extends F402TickerJsonlState {
  readonly version: 1;
  readonly path: string;
}

/**
 * Load the persisted tail state for one ticker file. A missing, unreadable, corrupt, or
 * different-file state is ignored (a fresh tail window), because reading from a foreign offset
 * would silently skip records.
 */
export async function loadF402TickerJsonlState(
  statePath: string,
  tickerPath: string,
): Promise<F402TickerJsonlState | undefined> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return undefined;
    if (resolve(String(record.path ?? "")) !== resolve(tickerPath)) {
      return undefined;
    }
    const offset = record.offset;
    const watermark = record.watermark;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      typeof watermark !== "number" ||
      !Number.isSafeInteger(watermark) ||
      watermark < 0
    ) {
      return undefined;
    }
    return { offset, watermark, initialized: true };
  } catch {
    return undefined;
  }
}

/** Persist the tail state atomically, scoped to the ticker path it belongs to. */
export async function saveF402TickerJsonlState(
  statePath: string,
  tickerPath: string,
  state: F402TickerJsonlState,
): Promise<void> {
  const payload: F402TickerJsonlPersistedState = {
    version: 1,
    path: resolve(tickerPath),
    offset: state.offset,
    watermark: state.watermark,
    initialized: true,
  };
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await rename(temporary, statePath);
}
