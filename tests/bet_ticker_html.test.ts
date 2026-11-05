import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  htmlHeaderMap,
  loadCapture,
  parseBetTickerHtml,
} from "../lib/bet_ticker_html.ts";
import { toSafeJson } from "../lib/live_ticket_view.ts";

/**
 * The fixture is synthetic (see its top comment): it reproduces the real table's column order,
 * nested `<font>` spans, `<br>`-separated legs and double-encoded `Culiac&amp;#038;aacute;n`
 * without committing any live agent or customer identifier.
 */
const FIXTURE = join(import.meta.dir, "fixtures/bet-ticker.html");
const HTML = await Bun.file(FIXTURE).text();
const rows = parseBetTickerHtml(HTML);
const by = Object.fromEntries(
  rows.map((ticket) => [ticket.wagerNumber, ticket]),
);

describe("HTML bet ticker", () => {
  test("parses every <tr> with a wager number", () => {
    expect(rows.length).toBeGreaterThan(90);
    expect(by["767465239"]).toBeDefined();
    expect(by["767469630"]).toBeDefined();
  });

  test("header map matches the captured <th> order", () => {
    expect(htmlHeaderMap(HTML).map((header) => header.key)).toEqual([
      "L-213",
      "L-152",
      "L-318",
      "L-207",
      "L-244",
      "L-393",
      "L-1029",
      "L-1030",
    ]);
  });

  test("columns map to the view", () => {
    const ticket = by["767465259"];
    expect(ticket).toBeDefined();
    expect(ticket!.source).toBe("GSLIVE");
    expect(ticket!.ticketStructure).toBe("Straight");
    expect(ticket!.wagerTypeLabel).toBe("Straight");
    expect(ticket!.timeOnly).toBe("9:55:08 PM");
    expect(ticket!.descCode).toBe("320198818");
    expect(ticket!.stake).toBeNull();
    expect(ticket!.amountSource).toBe("html-display");
    expect(ticket!.legs).toHaveLength(1);
    expect(ticket!.legs[0]!.selection).toBe("Indiana Pacers");
  });

  test("nested <font> and &amp; decode", () => {
    expect(by["767469589"]!.legs[0]!.price).toBe("-115");
    expect(by["767469622"]!.legs[0]!.eventName).toContain("Culiacán");
  });

  test("customer/agent never leak from the table", () => {
    const json = JSON.stringify(
      rows.map((row) => toSafeJson(row as unknown as Record<string, unknown>)),
    );
    for (const id of [
      "ZZAGT001",
      "ZZAGENT001",
      "ZZAGT002",
      "ZZAGENT002",
      "Customer",
      "Agent",
    ]) {
      expect(json).not.toContain(id);
    }
    // The parser deliberately does not store the agent/agent-login cells at all.
    expect(Object.hasOwn(rows[0]!, "agent")).toBe(false);
    expect(Object.hasOwn(rows[0]!, "agentLogin")).toBe(false);
  });

  test("--currency-scale only touches the JSON path", async () => {
    const htmlCapture = await loadCapture(FIXTURE, { currencyScale: 0.01 });
    expect(htmlCapture.format).toBe("html");
    expect(htmlCapture.tickets.every((ticket) => ticket.stake === null)).toBe(
      true,
    );

    const jsonCapture = await loadCapture(
      join(import.meta.dir, "fixtures/live-wagers-list-sample.json"),
      { currencyScale: 0.01 },
    );
    expect(jsonCapture.format).toBe("json");
    expect(jsonCapture.tickets[0]?.stake).toBeCloseTo(10);
    expect(jsonCapture.tickets[0]?.amountSource).toBe("json");
  });
});
