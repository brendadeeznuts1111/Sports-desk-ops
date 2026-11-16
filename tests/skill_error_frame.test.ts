import { describe, expect, test } from "bun:test";
import {
  BUN_CI_GOVERNOR_LANE,
  BUN_CI_GOVERNOR_R2_KEY,
  BUN_CI_GOVERNOR_SKILL_ORDINAL,
  ErrorClassCode,
  TELEMETRY_FRAME_BYTES,
  TELEMETRY_FRAME_STATE,
  consumePreflightErrorFrame256B,
  createR2LaneFlusher,
  encodePreflightErrorFrame256B,
  packSkillErrorCodeU16,
  readPreflightErrorFrame256B,
  waitForPreflightErrorFrame256B,
} from "../src/telemetry/skill-error-frame.ts";
import {
  runPreflightOrExit,
  type RuntimePreflightReport,
} from "../src/telemetry/runtime-preflight.ts";
import type { LaneR2Key } from "../src/telemetry/skill-error-frame.ts";

const DNS = { errors: 0, totalCount: 0, size: 0 } as const;

function descriptor(sab: ArrayBufferLike): {
  magic: number;
  state: number;
  errorCodeU16: number;
  skill: number;
  exitCode: number;
  failures: number;
  circuit: number;
  dnsBps: number;
  dnsSize: number;
  dnsTotal: number;
  lane: string;
  code: string;
  detail: string;
} {
  const view = new DataView(sab);
  const bytes = new Uint8Array(sab);
  const text = (start: number, end: number): string =>
    new TextDecoder().decode(bytes.subarray(start, end)).replace(/\0+$/u, "");
  return {
    magic: view.getUint32(0, true),
    state: new Int32Array(sab)[1] ?? -1,
    errorCodeU16: view.getUint16(16, true),
    skill: view.getUint8(18),
    exitCode: view.getUint8(19),
    failures: view.getUint8(20),
    circuit: view.getUint8(21),
    dnsBps: view.getUint16(22, true),
    dnsSize: view.getUint32(24, true),
    dnsTotal: view.getUint32(28, true),
    lane: text(32, 96),
    code: text(96, 160),
    detail: text(160, 256),
  };
}

function exitSignal(): { exit: (code: number) => never; codes: number[] } {
  const codes: number[] = [];
  const exit = (code: number): never => {
    codes.push(code);
    throw new Error(`__EXIT_${code}__`);
  };
  return { exit, codes };
}

describe("SkillErrorTelemetryFrame256B", () => {
  test("packs the three preflight discriminators exactly as specified", () => {
    expect(
      packSkillErrorCodeU16(
        BUN_CI_GOVERNOR_SKILL_ORDINAL,
        ErrorClassCode.T1_TERMINAL,
        0,
        77,
      ),
    ).toBe(0x0a0d);
    expect(
      packSkillErrorCodeU16(
        BUN_CI_GOVERNOR_SKILL_ORDINAL,
        ErrorClassCode.T1_TERMINAL,
        1,
        77,
      ),
    ).toBe(0x0a1d);
    expect(
      packSkillErrorCodeU16(
        BUN_CI_GOVERNOR_SKILL_ORDINAL,
        ErrorClassCode.T3_TRANSIENT,
        3,
        75,
      ),
    ).toBe(0x0e3b);
  });

  test("writes every header field, lane, code and detail", () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const result = encodePreflightErrorFrame256B(
      sab,
      0,
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      "ratio 600 bps",
      1,
      {
        nowMs: 1_700_000_000_000,
        dnsStats: { errors: 1, totalCount: 1_000, size: 7 },
      },
    );
    expect(result.errorCodeU16).toBe(0x0e3b);
    expect(result.exitCode).toBe(75);

    const frame = descriptor(sab);
    expect(frame.magic).toBe(0x45524631);
    expect(frame.state).toBe(2);
    expect(frame.errorCodeU16).toBe(0x0e3b);
    expect(frame.skill).toBe(BUN_CI_GOVERNOR_SKILL_ORDINAL);
    expect(frame.exitCode).toBe(75);
    expect(frame.failures).toBe(1);
    expect(frame.circuit).toBe(0); // T3 + first failure
    expect(frame.dnsBps).toBe(10); // 1 / 1000
    expect(frame.dnsSize).toBe(7);
    expect(frame.dnsTotal).toBe(1_000);
    expect(frame.lane).toBe(BUN_CI_GOVERNOR_LANE);
    expect(frame.code).toBe("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE");
    expect(frame.detail).toContain("ratio 600 bps");
    expect(new DataView(sab).getBigUint64(8, true)).toBe(1_700_000_000_000n);
  });

  test("trips the circuit OPEN for terminal classes and on the fourth transient failure", () => {
    const terminal = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    encodePreflightErrorFrame256B(
      terminal,
      0,
      "ERR_CF_TOKEN_BLEED_10000",
      "x",
      1,
      {
        dnsStats: DNS,
      },
    );
    expect(descriptor(terminal).circuit).toBe(2);

    const fourth = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    encodePreflightErrorFrame256B(
      fourth,
      0,
      "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
      "x",
      4,
      { dnsStats: DNS },
    );
    expect(descriptor(fourth).circuit).toBe(2);
  });

  test("a claimed slot is one-shot and a second writer gets BUSY", () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES * 2);
    encodePreflightErrorFrame256B(
      sab,
      0,
      "ERR_INSP_SECRET_REDACTION_LEAK",
      "first",
      1,
      {
        dnsStats: DNS,
      },
    );
    expect(() =>
      encodePreflightErrorFrame256B(
        sab,
        0,
        "ERR_CF_TOKEN_BLEED_10000",
        "second",
        1,
        {
          dnsStats: DNS,
        },
      ),
    ).toThrow("ERR_TELEMETRY_FRAME_BUSY");
    expect(() =>
      encodePreflightErrorFrame256B(
        sab,
        256,
        "ERR_CF_TOKEN_BLEED_10000",
        "other slot",
        1,
        {
          dnsStats: DNS,
        },
      ),
    ).not.toThrow();
  });

  test("rejects short buffers, misalignment and out-of-range bitfields", () => {
    expect(() =>
      encodePreflightErrorFrame256B(
        new SharedArrayBuffer(128),
        0,
        "ERR_INSP_SECRET_REDACTION_LEAK",
        "x",
      ),
    ).toThrow(RangeError);
    expect(() =>
      encodePreflightErrorFrame256B(
        new SharedArrayBuffer(256),
        2,
        "ERR_INSP_SECRET_REDACTION_LEAK",
        "x",
      ),
    ).toThrow(RangeError);
    expect(() =>
      packSkillErrorCodeU16(32, ErrorClassCode.T1_TERMINAL, 0, 77),
    ).toThrow(RangeError);
    expect(() =>
      packSkillErrorCodeU16(1, ErrorClassCode.T1_TERMINAL, 0, 64 + 16),
    ).toThrow(RangeError);
  });

  test("truncates oversized detail inside the 96-byte field", () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    encodePreflightErrorFrame256B(
      sab,
      0,
      "ERR_INSP_SECRET_REDACTION_LEAK",
      "d".repeat(300),
      1,
      { dnsStats: DNS },
    );
    expect(descriptor(sab).detail.length).toBeLessThanOrEqual(96);
    expect(descriptor(sab).detail.length).toBeGreaterThan(0);
  });
});

describe("runPreflightOrExit", () => {
  test("flushes the token-bleed frame and exits 77", async () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const flushed: { key: LaneR2Key; frame: Uint8Array }[] = [];
    const { exit, codes } = exitSignal();
    await expect(
      runPreflightOrExit(
        sab,
        0,
        async (frame, key) => {
          flushed.push({ key, frame: new Uint8Array(frame) });
        },
        {
          runPreflight: async () => {
            throw new Error("ERR_CF_TOKEN_BLEED_10000: both tokens");
          },
          exit,
        },
      ),
    ).rejects.toThrow("__EXIT_77__");

    expect(codes).toEqual([77]);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.key).toBe(BUN_CI_GOVERNOR_R2_KEY);
    const frame = descriptor(flushed[0]!.frame.buffer);
    expect(frame.errorCodeU16).toBe(0x0a1d);
    expect(frame.exitCode).toBe(77);
    expect(frame.code).toBe("ERR_CF_TOKEN_BLEED_10000");
    expect(frame.detail).not.toContain("both tokens");
  });

  test("flushes the DNS frame and exits 75", async () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const frames: Uint8Array[] = [];
    const { exit } = exitSignal();
    await expect(
      runPreflightOrExit(
        sab,
        0,
        async (frame) => {
          frames.push(new Uint8Array(frame));
        },
        {
          runPreflight: async () => {
            throw new Error("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE: ratio 600 bps");
          },
          exit,
        },
      ),
    ).rejects.toThrow("__EXIT_75__");
    const frame = descriptor(frames[0]!.buffer);
    expect(frame.errorCodeU16).toBe(0x0e3b);
    expect(frame.exitCode).toBe(75);
    expect(frame.detail).toContain("600 bps");
  });

  test("maps an unclassified failure to the terminal leak discriminator", async () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const frames: Uint8Array[] = [];
    const { exit } = exitSignal();
    await expect(
      runPreflightOrExit(
        sab,
        0,
        async (frame) => {
          frames.push(new Uint8Array(frame));
        },
        {
          runPreflight: async () => {
            throw new Error("something else entirely");
          },
          exit,
        },
      ),
    ).rejects.toThrow("__EXIT_77__");
    expect(descriptor(frames[0]!.buffer).errorCodeU16).toBe(0x0a0d);
  });

  test("returns the report when preflight passes", async () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const report = { bunVersion: Bun.version } as RuntimePreflightReport;
    const { exit, codes } = exitSignal();
    const result = await runPreflightOrExit(sab, 0, async () => {}, {
      runPreflight: async () => report,
      exit,
    });
    expect(result).toBe(report);
    expect(codes).toEqual([]);
    expect(new Int32Array(sab)[1]).toBe(0);
  });
});

describe("SkillErrorTelemetryFrame256B reader handshake", () => {
  test("read does not consume; consume returns the slot to FREE exactly once", () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    encodePreflightErrorFrame256B(
      sab,
      0,
      "ERR_CF_TOKEN_BLEED_10000",
      "token bleed",
      1,
      { dnsStats: DNS, nowMs: 1_700_000_000_000 },
    );

    const read = readPreflightErrorFrame256B(sab, 0);
    expect(read.code).toBe("ERR_CF_TOKEN_BLEED_10000");
    expect(read.exitCode).toBe(77);
    expect(new Int32Array(sab)[1]).toBe(TELEMETRY_FRAME_STATE.COMMITTED);

    const consumed = consumePreflightErrorFrame256B(sab, 0);
    expect(consumed).toEqual(read);
    expect(new Int32Array(sab)[1]).toBe(TELEMETRY_FRAME_STATE.FREE);
    expect(() => consumePreflightErrorFrame256B(sab, 0)).toThrow(
      "ERR_TELEMETRY_FRAME_NOT_READY",
    );

    // The slot is reusable once consumed.
    expect(() =>
      encodePreflightErrorFrame256B(
        sab,
        0,
        "ERR_INSP_SECRET_REDACTION_LEAK",
        "next",
        1,
        {
          dnsStats: DNS,
        },
      ),
    ).not.toThrow();
  });

  test("read rejects FREE and corrupted frames", () => {
    const free = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    expect(() => readPreflightErrorFrame256B(free, 0)).toThrow(
      "ERR_TELEMETRY_FRAME_NOT_READY",
    );

    const corrupt = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    encodePreflightErrorFrame256B(
      corrupt,
      0,
      "ERR_INSP_SECRET_REDACTION_LEAK",
      "x",
      1,
      {
        dnsStats: DNS,
      },
    );
    new Uint8Array(corrupt)[0] = 0;
    expect(() => readPreflightErrorFrame256B(corrupt, 0)).toThrow(
      "ERR_TELEMETRY_FRAME_CORRUPT",
    );
  });

  test("wait resolves when another task publishes, without consuming", async () => {
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const pending = waitForPreflightErrorFrame256B(sab, 0, 500);
    setTimeout(() => {
      encodePreflightErrorFrame256B(
        sab,
        0,
        "ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE",
        "ratio 600 bps",
        1,
        { dnsStats: DNS },
      );
    }, 10);
    const frame = await pending;
    expect(frame.code).toBe("ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE");
    expect(frame.exitCode).toBe(75);
    expect(new Int32Array(sab)[1]).toBe(TELEMETRY_FRAME_STATE.COMMITTED);
  });

  test("wait times out on a slot that never publishes", async () => {
    await expect(
      waitForPreflightErrorFrame256B(
        new SharedArrayBuffer(TELEMETRY_FRAME_BYTES),
        0,
        20,
      ),
    ).rejects.toThrow("ERR_TELEMETRY_FRAME_TIMEOUT");
  });

  test("the R2 lane flusher writes the governor key and exact 256 bytes", async () => {
    const writes: {
      path: string;
      bytes: Uint8Array;
      type: string | undefined;
    }[] = [];
    const flusher = createR2LaneFlusher({
      async write(path, data, options) {
        writes.push({ path, bytes: new Uint8Array(data), type: options?.type });
        return data.byteLength;
      },
    });
    const sab = new SharedArrayBuffer(TELEMETRY_FRAME_BYTES);
    const encoded = encodePreflightErrorFrame256B(
      sab,
      0,
      "ERR_CF_TOKEN_BLEED_10000",
      "x",
      1,
      { dnsStats: DNS },
    );
    await flusher(encoded.frame);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(BUN_CI_GOVERNOR_R2_KEY);
    expect(writes[0]?.bytes).toHaveLength(256);
    expect(writes[0]?.type).toBe("application/octet-stream");
    expect(new DataView(writes[0]!.bytes.buffer).getUint32(0, true)).toBe(
      0x45524631,
    );
  });
});
