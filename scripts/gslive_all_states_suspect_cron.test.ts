import { afterEach, describe, expect, test } from "bun:test";
import { readTickerBetsJsonl } from "./gslive_all_states_suspect_cron.ts";

const dir = `Scratch/jsonl-reader-${Date.now()}`;
let n = 0;

async function fixture(name: string, content: string): Promise<string> {
  const path = `${dir}/${n++}-${name}.jsonl`;
  await Bun.write(path, content);
  return path;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

describe("readTickerBetsJsonl (Bun.JSONL.parseChunk streaming)", () => {
  test("parses, filters by CustomerID, and lets later rows win per WagerNumber", async () => {
    const path = await fixture(
      "basic",
      [
        `{"WagerNumber":1,"CustomerID":"CCC107    ","InsertDateTime":"2026-10-29 00:00:01"}`,
        `{"WagerNumber":2,"CustomerID":"OTHER     ","InsertDateTime":"2026-10-29 00:00:02"}`,
        `{"WagerNumber":1,"CustomerID":"CCC107    ","InsertDateTime":"2026-10-29 00:00:03"}`,
      ].join("\n") + "\n",
    );
    const bets = await readTickerBetsJsonl(path, "CCC107");
    expect(bets.size).toBe(1);
    expect(bets.get(1)).toMatchObject({
      InsertDateTime: "2026-10-29 00:00:03",
    });
  });

  test("falls back to Login when CustomerID is absent", async () => {
    const path = await fixture(
      "login",
      `{"WagerNumber":7,"Login":"CCC107","InsertDateTime":"2026-10-29 00:00:01"}\n`,
    );
    const bets = await readTickerBetsJsonl(path, "CCC107");
    expect(bets.size).toBe(1);
  });

  test("skips malformed lines but keeps the good rows around them", async () => {
    const path = await fixture(
      "badline",
      [
        `{bad json`,
        `{"WagerNumber":1,"CustomerID":"CCC107","InsertDateTime":"t1"}`,
        `{"WagerNumber":2,"CustomerID":"CCC107",BROKEN`,
        `{"WagerNumber":3,"CustomerID":"CCC107","InsertDateTime":"t3"}`,
        `not json at all`,
        `{"WagerNumber":4,"CustomerID":"CCC107","InsertDateTime":"t4"}`,
      ].join("\n") + "\n",
    );
    const bets = await readTickerBetsJsonl(path, "CCC107");
    expect([...bets.keys()].sort((a, b) => a - b)).toEqual([1, 3, 4]);
  });

  test("drops the trailing partial line like the old loop", async () => {
    const path = await fixture(
      "partial",
      `{"WagerNumber":1,"CustomerID":"CCC107","InsertDateTime":"t1"}\n{"WagerNumber":2,"CustomerID":"CCC10`,
    );
    const bets = await readTickerBetsJsonl(path, "CCC107");
    expect([...bets.keys()]).toEqual([1]);
  });

  test("handles CRLF, blank lines, and non-object values", async () => {
    const path = await fixture(
      "misc",
      `{"WagerNumber":1,"CustomerID":"CCC107","InsertDateTime":"t1"}\r\n\r\n42\r\n"str"\r\n{"WagerNumber":2,"CustomerID":"CCC107","InsertDateTime":"t2"}\r\n`,
    );
    const bets = await readTickerBetsJsonl(path, "CCC107");
    expect([...bets.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  test("missing file yields an empty map", async () => {
    const bets = await readTickerBetsJsonl(
      `${dir}/does-not-exist.jsonl`,
      "CCC107",
    );
    expect(bets.size).toBe(0);
  });

  test("empty file yields an empty map", async () => {
    const bets = await readTickerBetsJsonl(
      await fixture("empty", ""),
      "CCC107",
    );
    expect(bets.size).toBe(0);
  });
});
