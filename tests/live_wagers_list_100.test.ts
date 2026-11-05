import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  findDupePairs,
  normalizeTicket,
  toSafeJson,
} from "../lib/live_ticket_view.ts";

/**
 * The fixture is synthetic (see its top-level `note`): it exercises the 100-row LIST envelope,
 * a P/M duplicate pair, and identity columns without committing a live capture.
 */
const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-LIST-100.json");
const payload = (await Bun.file(FIXTURE).json()) as {
  LIST: Array<Record<string, unknown>>;
};
const rows = payload.LIST;
const tickets = rows.map((row) => normalizeTicket(row));

describe("live-wagers LIST-100 fixture", () => {
  test("LIST envelope and row shape", () => {
    expect(tickets).toHaveLength(100);
    expect(tickets[0]!.wagerNumber).toBe("767465239");
    expect(tickets[0]!.stake).toBe(7500);
    expect(tickets[0]!.toWin).toBe(5000);
    expect(tickets[0]!.source).toBe("Internet");
    expect(tickets[0]!.legs[0]).toMatchObject({
      sport: "Hockey",
      selection: "Flames/Kraken O 1½",
      price: "-150",
    });
  });

  test("CustomerID underscores/dots and padded Login never leak", () => {
    const json = JSON.stringify(rows.map(toSafeJson));
    for (const id of [
      "ZZCUST1",
      "ZZCUST1.",
      "ZZCUST1.    ",
      "ZZCUST21",
      "ZZCUST22",
      "ZZAGENT1",
      "ZZAGENT2",
      "CustomerID",
      "Login",
      "AgentID",
      "AgentLogin",
      "TicketWriter",
    ]) {
      expect(json).not.toContain(id);
    }
    expect(Object.hasOwn(rows[0]!, "TicketWriter")).toBe(true);
  });

  test("dupe detector finds the P/M pair", () => {
    const pairs = findDupePairs(tickets);
    expect(pairs.length).toBeGreaterThan(0);
    expect(
      pairs.some(
        (group) =>
          group.wagerNumbers.includes("767465250") &&
          group.wagerNumbers.includes("767465271"),
      ),
    ).toBe(true);
  });
});
