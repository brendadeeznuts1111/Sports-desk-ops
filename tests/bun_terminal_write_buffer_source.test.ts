/**
 * @file tests/bun_terminal_write_buffer_source.test.ts
 * @description Measured `Bun.Terminal.write(data: string | BufferSource)` & `BufferSource`
 * contract: UTF-8 string byte counts, every `BufferSource` view/buffer variant, non-zero
 * `byteOffset` slice isolation, `SharedArrayBuffer`, multi-byte `TypedArray` byte lengths,
 * large-write internal buffering + `drain`, detached buffers, invalid args, and closed PTY refusals.
 *
 * @see https://bun.sh/reference/bun/Terminal/write
 * @see https://bun.sh/reference/bun/BufferSource
 */

import { describe, expect, test } from "bun:test";
import {
  TerminalSession,
  requireSubprocessTerminal,
  terminalInputByteLength,
  type TerminalInputData,
} from "../lib/bun_terminal.ts";
import { hasPty } from "./support/capabilities.ts";

// @bun-behavior: terminal-write-buffer-source

describe("Bun.Terminal.write & BufferSource", () => {
  test.skipIf(!hasPty)(
    "returns UTF-8 byte length for strings and exact byteLength for every BufferSource variant",
    () => {
      const term = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data() {},
      });
      try {
        expect(term.write("")).toBe(0);
        expect(term.write("hello")).toBe(5);
        // Multi-byte UTF-8 string: .length === 3 UTF-16 code units, 7 UTF-8 bytes
        const multiByte = "€🚀";
        expect(multiByte.length).toBe(3);
        expect(term.write(multiByte)).toBe(7);
        // Lone surrogate becomes 3-byte UTF-8 replacement character U+FFFD
        expect(term.write("\uD800")).toBe(3);

        const u8Backing = new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x00]);
        const u8Sub = u8Backing.subarray(1, 4);
        const buf = Buffer.from("XYZ");
        const bufSub = Buffer.from("012345").subarray(2, 5);
        const ab = new Uint8Array([0x64, 0x65]).buffer;
        const sab = new SharedArrayBuffer(6);
        const sabU8 = new Uint8Array(sab);
        sabU8.set([0x30, 0x31, 0x32, 0x33, 0x34, 0x35]);
        const sabDv = new DataView(sab, 1, 2);
        const abDv = new DataView(u8Backing.buffer, 2, 3);
        const u16 = new Uint16Array([0x4142, 0x4344]);
        const i32 = new Int32Array([0x41424344]);
        const f64 = new Float64Array([1.5]);
        const bi64 = new BigInt64Array([1n, 2n]);

        const cases: readonly {
          readonly label: string;
          readonly payload: TerminalInputData;
          readonly expectedBytes: number;
        }[] = [
          {
            label: "empty Uint8Array",
            payload: new Uint8Array(0),
            expectedBytes: 0,
          },
          {
            label: "full Uint8Array",
            payload: new Uint8Array([1, 2, 3]),
            expectedBytes: 3,
          },
          { label: "Uint8Array subarray", payload: u8Sub, expectedBytes: 3 },
          { label: "full Buffer", payload: buf, expectedBytes: 3 },
          { label: "Buffer subarray", payload: bufSub, expectedBytes: 3 },
          { label: "ArrayBuffer", payload: ab, expectedBytes: 2 },
          { label: "SharedArrayBuffer", payload: sab, expectedBytes: 6 },
          {
            label: "Uint8Array on SharedArrayBuffer",
            payload: sabU8,
            expectedBytes: 6,
          },
          {
            label: "DataView on SharedArrayBuffer",
            payload: sabDv,
            expectedBytes: 2,
          },
          { label: "DataView on ArrayBuffer", payload: abDv, expectedBytes: 3 },
          {
            label: "Uint16Array (byteLength, not element count)",
            payload: u16,
            expectedBytes: 4,
          },
          {
            label: "Int32Array (byteLength, not element count)",
            payload: i32,
            expectedBytes: 4,
          },
          { label: "Float64Array", payload: f64, expectedBytes: 8 },
          { label: "BigInt64Array", payload: bi64, expectedBytes: 16 },
        ];

        for (const item of cases) {
          expect(term.write(item.payload), item.label).toBe(item.expectedBytes);
          expect(terminalInputByteLength(item.payload), item.label).toBe(
            item.expectedBytes,
          );
        }
      } finally {
        term.close();
      }
    },
  );

  test.skipIf(!hasPty)(
    "preserves slice byteOffset/byteLength bounds and raw binary bytes in a raw-mode PTY",
    async () => {
      const strPart = "Hi€🚀";
      const u8Backing = new Uint8Array([0x58, 0x41, 0x42, 0x43, 0x59]); // guard bytes 0x58/0x59
      const u8Slice = u8Backing.subarray(1, 4); // ABC
      const ab = new Uint8Array([0x30, 0x31, 0x32, 0x33]).buffer; // 0123
      const sab = new SharedArrayBuffer(6);
      new Uint8Array(sab).set([0x7a, 0x44, 0x45, 0x46, 0x47, 0x7a]); // guard 0x7a
      const sabDv = new DataView(sab, 1, 4); // DEFG
      const bufSlice = Buffer.from("__PQRS__").subarray(2, 6); // PQRS
      const u16 = new Uint16Array([0x3534, 0x3736]);
      const rawCtl = new Uint8Array([0x00, 0x03, 0x04, 0xff]); // NUL, ETX, EOT, 0xFF

      const expected = Buffer.concat([
        Buffer.from(strPart, "utf8"),
        u8Slice,
        new Uint8Array(ab),
        new Uint8Array(sab, 1, 4),
        bufSlice,
        new Uint8Array(u16.buffer, u16.byteOffset, u16.byteLength),
        rawCtl,
      ]);

      let outBuf = "";
      const childScript = `
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        const target = ${expected.byteLength};
        const chunks = [];
        let total = 0;
        process.stdout.write("READY\\n");
        for await (const c of Bun.stdin.stream()) {
          chunks.push(c);
          total += c.byteLength;
          if (total >= target) break;
        }
        const joined = Buffer.concat(chunks).subarray(0, target);
        process.stdout.write("HEX:" + joined.toString("hex") + "\\n");
      `;

      const proc = Bun.spawn([process.execPath, "-e", childScript], {
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, data) {
            outBuf += new TextDecoder().decode(data);
          },
        },
      });
      const term = requireSubprocessTerminal(proc);
      try {
        const deadline = Date.now() + 5000;
        while (!outBuf.includes("READY") && Date.now() < deadline) {
          await Bun.sleep(5);
        }
        expect(outBuf).toContain("READY");

        const counts = [
          term.write(strPart),
          term.write(u8Slice),
          term.write(ab),
          term.write(sabDv),
          term.write(bufSlice),
          term.write(u16),
          term.write(rawCtl),
        ];
        expect(counts).toEqual([
          terminalInputByteLength(strPart),
          3,
          4,
          4,
          4,
          4,
          4,
        ]);
        expect(counts.reduce((sum, n) => sum + n, 0)).toBe(expected.byteLength);

        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        const match = /HEX:([0-9a-f]+)/.exec(outBuf);
        expect(match?.[1]).toBe(expected.toString("hex"));
      } finally {
        term.close();
      }
    },
  );

  test.skipIf(!hasPty)(
    "buffers 128 KiB single write internally, returns full byteLength, and fires drain",
    async () => {
      const size = 128 * 1024;
      const payload = new Uint8Array(size);
      for (let i = 0; i < payload.byteLength; i++) {
        payload[i] = (i * 31 + 7) & 0xff;
      }
      const expectedSha256 = new Bun.CryptoHasher("sha256")
        .update(payload)
        .digest("hex");

      let outBuf = "";
      let drainCount = 0;
      const childScript = `
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        const target = ${size};
        let total = 0;
        const hasher = new Bun.CryptoHasher("sha256");
        process.stdout.write("READY\\n");
        for await (const c of Bun.stdin.stream()) {
          const take = Math.min(c.byteLength, target - total);
          hasher.update(c.subarray(0, take));
          total += take;
          if (total >= target) break;
        }
        process.stdout.write("SUM:" + total + ":" + hasher.digest("hex") + "\\n");
      `;

      const proc = Bun.spawn([process.execPath, "-e", childScript], {
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, data) {
            outBuf += new TextDecoder().decode(data);
          },
          drain() {
            drainCount += 1;
          },
        },
      });
      const term = requireSubprocessTerminal(proc);
      try {
        const deadline = Date.now() + 5000;
        while (!outBuf.includes("READY") && Date.now() < deadline) {
          await Bun.sleep(5);
        }
        expect(outBuf).toContain("READY");

        const written = term.write(payload);
        expect(written).toBe(size);

        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
        expect(drainCount).toBeGreaterThanOrEqual(1);
        const match = /SUM:(\d+):([0-9a-f]+)/.exec(outBuf);
        expect(Number(match?.[1])).toBe(size);
        expect(match?.[2]).toBe(expectedSha256);
      } finally {
        term.close();
      }
    },
  );

  test.skipIf(!hasPty)(
    "returns 0 for detached buffers and throws on invalid types or closed terminal",
    () => {
      const term = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data() {},
      });
      try {
        const detached = new ArrayBuffer(8);
        const detachedView = new Uint8Array(detached, 2, 4);
        structuredClone(detached, { transfer: [detached] });
        expect(term.write(detached)).toBe(0);
        expect(term.write(detachedView)).toBe(0);

        expect(() => term.write(null as unknown as TerminalInputData)).toThrow(
          /requires data argument/i,
        );
        expect(() =>
          term.write(undefined as unknown as TerminalInputData),
        ).toThrow(/requires data argument/i);
        expect(() => term.write(42 as unknown as TerminalInputData)).toThrow(
          /string or ArrayBuffer/i,
        );
        expect(() => term.write({} as unknown as TerminalInputData)).toThrow(
          /string or ArrayBuffer/i,
        );
      } finally {
        term.close();
      }

      expect(() => term.write("after-close")).toThrow(/Terminal is closed/i);
    },
  );

  test.skipIf(!hasPty)(
    "TerminalSession.write forwards BufferSource payloads and audits exact byte counts",
    async () => {
      await using session = await TerminalSession.start([
        process.execPath,
        "-e",
        "if (process.stdin.isTTY) process.stdin.setRawMode(true); setTimeout(() => process.exit(0), 100);",
      ]);
      const backing = new Uint8Array([0x00, 0x41, 0x42, 0x43, 0x00]);
      const b1 = session.write(backing.subarray(1, 4));
      const b2 = session.write(new DataView(backing.buffer, 2, 2));
      expect(b1).toBe(3);
      expect(b2).toBe(2);

      const exitCode = await session.wait();
      expect(exitCode).toBe(0);

      const writes = session.auditEvents.filter((e) => e.type === "write");
      expect(writes.map((e) => e.bytes)).toEqual([3, 2]);
    },
  );
});
