import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadF402TickerJsonlState,
  readF402TickerJsonl,
  saveF402TickerJsonlState,
} from "../lib/f402_bet_ticker_jsonl.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bridge3a-jsonl-"));
  dirs.push(dir);
  const path = join(dir, "f402-bets.jsonl");
  await writeFile(path, content);
  return path;
}

function rec(wagerNumber: number, ticketWriter = "Internet"): string {
  return JSON.stringify({
    WagerNumber: wagerNumber,
    AgentID: "TESTAGENT",
    CustomerID: "TESTCUST",
    Login: "TESTLOGIN",
    WagerType: "S",
    AmountWagered: 100,
    InsertDateTime: "2026-11-03 20:00:00.000",
    ToWinAmount: 90,
    TicketWriter: ticketWriter,
    VolumeAmount: 100,
    ShortDesc: "Football - Team A vs Team B / Game / Winner / Team A -110",
    VIP: "0",
    AgentLogin: "TESTAGENTLOGIN",
  });
}

describe("readF402TickerJsonl", () => {
  test("reads complete lines and holds back a partial trailing record", async () => {
    const path = await tempFile(`${rec(1)}\n${rec(2)}\n${rec(3)}`);
    const first = await readF402TickerJsonl(path, { windowBytes: 10_000_000 });
    expect(first.reset).toBe("initial");
    expect(first.skippedLines).toBe(0);
    expect(first.rows.map((row) => row.wagerNumber)).toEqual(["1", "2"]);
    expect(first.state.watermark).toBe(2);

    await appendFile(path, `\n${rec(4)}\n`);
    const second = await readF402TickerJsonl(path, {
      state: first.state,
      filterWatermark: true,
    });
    expect(second.reset).toBe("none");
    expect(second.rows.map((row) => row.wagerNumber)).toEqual(["3", "4"]);
    expect(second.state.watermark).toBe(4);
  });

  test("incremental reads skip rows at or below the watermark", async () => {
    const path = await tempFile(`${rec(1)}\n${rec(2)}\n${rec(3)}\n${rec(4)}\n`);
    const first = await readF402TickerJsonl(path);
    expect(first.rows).toHaveLength(4);

    await appendFile(path, `${rec(2)}\n${rec(5)}\n${rec(6, "BLOCKED")}\n`);
    const second = await readF402TickerJsonl(path, {
      state: first.state,
      filterWatermark: true,
    });
    expect(second.rows.map((row) => row.wagerNumber)).toEqual(["5", "6"]);
    expect(second.state.watermark).toBe(6);
    expect(second.rows[1]?.ticketWriter).toBe("BLOCKED");
  });

  test("the initial window begins on a line boundary", async () => {
    const lines = Array.from({ length: 100 }, (_, index) => rec(index + 1));
    const path = await tempFile(`${lines.join("\n")}\n`);
    const read = await readF402TickerJsonl(path, { windowBytes: 500 });
    expect(read.reset).toBe("initial");
    expect(read.skippedLines).toBe(0);
    expect(read.rows.length).toBeGreaterThan(0);
    expect(read.rows.length).toBeLessThan(20);
    expect(read.rows.at(-1)?.wagerNumber).toBe("100");
    expect(read.rows[0]?.wagerNumber).not.toBe("1");
    expect(read.state.offset).toBeLessThanOrEqual(read.fileSize);
  });

  test("a shrunken file is re-windowed instead of reading garbage", async () => {
    const path = await tempFile(`${rec(1)}\n${rec(2)}\n${rec(3)}\n`);
    const first = await readF402TickerJsonl(path);
    expect(first.rows).toHaveLength(3);

    await truncate(path, 0);
    await writeFile(path, `${rec(9)}\n`);
    const second = await readF402TickerJsonl(path, { state: first.state });
    expect(second.reset).toBe("shrunk");
    expect(second.rows.map((row) => row.wagerNumber)).toEqual(["9"]);
    expect(second.state.offset).toBeLessThanOrEqual(second.fileSize);
  });

  test("malformed lines are skipped, never guessed into rows", async () => {
    const path = await tempFile(`${rec(1)}\nnot json\n${rec(2)}\n`);
    const read = await readF402TickerJsonl(path);
    expect(read.rows).toHaveLength(2);
    expect(read.skippedLines).toBe(1);
  });

  test("persisted offset/watermark round-trips and is scoped to its file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge3a-jsonl-state-"));
    dirs.push(dir);
    const ticker = join(dir, "f402-bets.jsonl");
    const statePath = join(dir, "state.json");
    await writeFile(ticker, `${rec(1)}\n${rec(2)}\n`);
    const read = await readF402TickerJsonl(ticker);
    await saveF402TickerJsonlState(statePath, ticker, read.state);
    expect(await loadF402TickerJsonlState(statePath, ticker)).toEqual(
      read.state,
    );
    expect(
      await loadF402TickerJsonlState(statePath, join(dir, "other.jsonl")),
    ).toBeUndefined();
  });

  test("a corrupt state file is ignored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge3a-jsonl-state-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    await writeFile(statePath, "not json");
    expect(
      await loadF402TickerJsonlState(statePath, join(dir, "ticker.jsonl")),
    ).toBeUndefined();
  });

  test("a file that ends without a newline yields no row until it completes", async () => {
    const path = await tempFile(rec(1));
    const first = await readF402TickerJsonl(path);
    expect(first.rows).toHaveLength(0);
    expect(first.state.offset).toBe(0);

    await appendFile(path, "\n");
    const second = await readF402TickerJsonl(path, { state: first.state });
    expect(second.rows.map((row) => row.wagerNumber)).toEqual(["1"]);
  });
});
