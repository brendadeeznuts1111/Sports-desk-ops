import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  parseBetTickerHtml,
  type HtmlBetTicket,
} from "../lib/bet_ticker_html.ts";
import { parseShortDesc } from "../lib/live_wagers.ts";
import { normalizeLeg } from "../lib/live_ticket_view.ts";
import { decodeEntities } from "../lib/ticket_html.ts";

/**
 * Prototype only: the production parser is still `lib/bet_ticker_html.ts`. This golden test
 * proves an `HTMLRewriter` version can reproduce it exactly before anything is swapped.
 *
 * Two regressions the naive rewriter had, and this one keeps guarded:
 *   - `<br>` separates parlay legs; text-only collection glues them into one leg.
 *   - the portal double-encodes some descriptions; one HTML decode is not enough.
 */
function decodeDeep(text: string): string {
  let current = text;
  for (let pass = 0; pass < 5; pass++) {
    const next = decodeEntities(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

function cellText(raw: string): string {
  return decodeDeep(raw)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionText(raw: string): string {
  return decodeDeep(raw)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .split("\u0000")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "" && line.toLowerCase() !== "top")
    .join("\n");
}

function descCodeOf(description: string): string | null {
  const code = /G(\d{6,})/.exec(description) ?? /#(\d{5,})/.exec(description);
  return code?.[1] ?? null;
}

function parseDescription(description: string) {
  const body = description.replace(/^G\d{6,}\s*/, "");
  if (body === "") return [];
  return parseShortDesc(body).legs.map((leg, index) =>
    normalizeLeg(leg, index + 1),
  );
}

async function parseWithRewriter(html: string): Promise<HtmlBetTicket[]> {
  const tickets: HtmlBetTicket[] = [];
  let current: {
    wagerNumber: string;
    vip: boolean;
    cells: string[];
    cellIdx: number;
  } | null = null;

  const append = (text: string): void => {
    if (current === null || current.cellIdx < 0) return;
    const index = current.cellIdx;
    current.cells[index] = (current.cells[index] ?? "") + text;
  };

  const rewriter = new HTMLRewriter()
    .on("tr[data-wager-number]", {
      element(element) {
        current = {
          wagerNumber: element.getAttribute("data-wager-number") ?? "",
          vip: element.getAttribute("data-vip") === "true",
          cells: [],
          cellIdx: -1,
        };
        element.onEndTag(() => {
          if (current === null) return;
          const row = current;
          current = null;
          const description = descriptionText(row.cells[3] ?? "");
          if ((row.cells[3] ?? "").trim() === "") return;
          const typeLabel = cellText(row.cells[1] ?? "");
          const ticketStructure = typeLabel === "" ? "Other" : typeLabel;
          tickets.push({
            wagerNumber: row.wagerNumber,
            source: cellText(row.cells[6] ?? ""),
            ticketStructure,
            wagerTypeLabel: ticketStructure,
            timeOnly: cellText(row.cells[7] ?? "") || null,
            descCode: descCodeOf(description),
            stake: null,
            amountSource: "html-display",
            legs: parseDescription(description),
            vip: row.vip,
            live: /\bLIVE\b|\(live\)/i.test(description),
          });
        });
      },
    })
    .on("tr[data-wager-number] td", {
      element() {
        if (current !== null) current.cellIdx++;
      },
      text(text) {
        append(text.text);
      },
    })
    .on("tr[data-wager-number] td *", {
      element(element) {
        // The regex parser replaces each tag with a space; mirror that word boundary.
        if (element.tagName.toLowerCase() === "br") return;
        append(" ");
        element.onEndTag(() => append(" "));
      },
    })
    .on("tr[data-wager-number] td br", {
      element() {
        append("\u0000");
      },
    });

  // Handlers fire while the transform is consumed, so drain the body.
  await rewriter.transform(new Response(html)).arrayBuffer();
  return tickets;
}

describe("HTMLRewriter capture parser prototype", () => {
  const fixture = join(import.meta.dir, "fixtures/bet-ticker.html");

  test("matches the production parser on the 100-row capture", async () => {
    const html = await Bun.file(fixture).text();
    const expected = parseBetTickerHtml(html);
    const actual = await parseWithRewriter(html);

    expect(expected).toHaveLength(100);
    expect(actual).toHaveLength(expected.length);
    expect(actual).toEqual(expected);
  });

  test("keeps <br> as a leg boundary", async () => {
    const html = await Bun.file(fixture).text();
    const parlay = (await parseWithRewriter(html)).find(
      (ticket) => ticket.wagerNumber === "767469630",
    );
    expect(parlay?.legs).toHaveLength(2);
  });

  test("decodes the double-encoded event name", async () => {
    const html = await Bun.file(fixture).text();
    const row = (await parseWithRewriter(html)).find(
      (ticket) => ticket.wagerNumber === "767469622",
    );
    expect(row?.legs[0]?.eventName).toContain("Culiacán");
  });
});
