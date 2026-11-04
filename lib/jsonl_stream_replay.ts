/**
 * Self-healing JSONL stream replay (SportsDesk-local; mirror of dotfiles `plane3-historical-log-replay.ts`).
 */

/** Bun stream chunks may use SharedArrayBuffer-backed views. */
export type JsonlByteBuffer = Uint8Array<ArrayBufferLike>;

export type HistoricalLogReplayResult = {
  recordCount: number;
  corruptedLineSkips: number;
  trailingPartialBytes: number;
};

export type HistoricalLogReplayHandlers = {
  onRecord: (value: unknown, index: number) => void | Promise<void>;
  onCorruptedLine?: (
    error: SyntaxError,
    byteOffsetInStream: number,
  ) => void | Promise<void>;
};

export function mergeUint8JsonlChunks(
  buffer: JsonlByteBuffer,
  chunk: JsonlByteBuffer,
): JsonlByteBuffer {
  if (chunk.length === 0) return buffer;
  if (buffer.length === 0) return chunk;
  return Bun.concatArrayBuffers(
    [buffer, chunk],
    buffer.length + chunk.length,
    true,
  );
}

export function carryForwardJsonlBuffer(
  buffer: JsonlByteBuffer,
  result: { read: number },
): JsonlByteBuffer {
  if (result.read <= 0) return buffer;
  return buffer.subarray(result.read);
}

export function skipPoisonJsonlLine(buffer: JsonlByteBuffer): JsonlByteBuffer {
  let at = 0;
  while (at < buffer.length && (buffer[at] === 0x0a || buffer[at] === 0x0d)) {
    at += 1;
  }
  const nl = buffer.indexOf(0x0a, at);
  if (nl < 0) return buffer;
  return buffer.subarray(nl + 1);
}

function trimTrailingJsonlNewlines(buffer: JsonlByteBuffer): JsonlByteBuffer {
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) {
    end -= 1;
  }
  return end === buffer.length ? buffer : buffer.subarray(0, end);
}

async function drainJsonlParseChunkBuffer(
  buffer: JsonlByteBuffer,
  handlers: HistoricalLogReplayHandlers,
  state: {
    recordCount: number;
    corruptedLineSkips: number;
    streamByteOffset: number;
  },
): Promise<JsonlByteBuffer> {
  let buf = buffer;
  while (buf.length > 0) {
    const result = Bun.JSONL.parseChunk(buf);
    for (const value of result.values) {
      await handlers.onRecord(value, state.recordCount);
      state.recordCount += 1;
    }
    buf = carryForwardJsonlBuffer(buf, result);
    state.streamByteOffset += result.read;

    if (!result.error) break;

    await handlers.onCorruptedLine?.(result.error, state.streamByteOffset);
    state.corruptedLineSkips += 1;

    const beforeSkip = buf.length;
    buf = skipPoisonJsonlLine(buf);
    state.streamByteOffset += beforeSkip - buf.length;
    if (buf.length === beforeSkip) break;
  }
  return buf;
}

export async function replayHistoricalJsonlStream(
  stream: ReadableStream<Uint8Array>,
  handlers: HistoricalLogReplayHandlers,
): Promise<HistoricalLogReplayResult> {
  const state = {
    recordCount: 0,
    corruptedLineSkips: 0,
    streamByteOffset: 0,
  };
  let buffer: JsonlByteBuffer = new Uint8Array(0);

  for await (const chunk of stream) {
    buffer = mergeUint8JsonlChunks(buffer, chunk);
    buffer = await drainJsonlParseChunkBuffer(buffer, handlers, state);
  }

  if (buffer.length > 0) {
    buffer = await drainJsonlParseChunkBuffer(buffer, handlers, state);
  }

  const tail = trimTrailingJsonlNewlines(buffer);
  return {
    recordCount: state.recordCount,
    corruptedLineSkips: state.corruptedLineSkips,
    trailingPartialBytes: tail.length,
  };
}

export async function replayHistoricalJsonlFile(
  path: string,
  handlers: HistoricalLogReplayHandlers,
): Promise<HistoricalLogReplayResult> {
  return replayHistoricalJsonlStream(Bun.file(path).stream(), handlers);
}

/** Drain-only JSONL audit on raw bytes (same parser as Plane 3 replay). */
export async function probeHistoricalJsonlBytes(
  bytes: Uint8Array,
): Promise<HistoricalLogReplayResult> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return replayHistoricalJsonlStream(stream, { onRecord() {} });
}
