import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Keep mutation boundaries in the same stderr stream as JavaScriptCore's GC log.
function recordMutationBoundary(boundary: "begin" | "end"): void {
  if (process.env.BUN_JSC_logGC === "1") {
    writeSync(
      2,
      `\narray-mutation ${boundary} pid=${process.pid} monotonic_ns=${process.hrtime.bigint()}\n`,
    );
  }
}

describe.skipIf(process.platform !== "linux")("Linux runtime contracts", () => {
  // https://github.com/oven-sh/WebKit/commit/2e2aa2290fac856d6f451ceacb58f7f5b44dd057
  test("surviving objects retain their values after shift, splice, truncation and collection", () => {
    const entries = Array.from({ length: 64 }, (_, id) => ({ id }));
    recordMutationBoundary("begin");
    expect(entries.shift()?.id).toBe(0);
    expect(entries.splice(5, 3).map((entry) => entry.id)).toEqual([6, 7, 8]);
    entries.length = 8;
    recordMutationBoundary("end");
    Bun.gc(true);
    expect(entries.map((entry) => entry.id)).toEqual([
      1, 2, 3, 4, 5, 9, 10, 11,
    ]);
  });

  // https://github.com/oven-sh/bun/commit/3044dc6834e5449d20317ad7c41f04013d32e5b0
  test("successive FIFO writers deliver their payloads to the same reader", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bun-filesink-"));
    const fifo = join(directory, "events");
    try {
      execFileSync("mkfifo", [fifo]);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        for (const message of ["first", "second"]) {
          const writer = Bun.file(fifo).writer();
          writer.write(message);
          await writer.end();
          const bytes = Buffer.alloc(32);
          const count = readSync(reader, bytes, 0, bytes.length, null);
          expect(bytes.toString("utf8", 0, count)).toBe(message);
        }
      } finally {
        closeSync(reader);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
