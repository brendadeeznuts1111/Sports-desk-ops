/**
 * Offline transport for the execution tests.
 *
 * Kalshi URLs are answered from the v3 captured fixtures (tests/fixtures/kalshi), Polymarket from
 * the captures in this directory. The helper records every URL so a test can prove that no order
 * endpoint (Kalshi `/portfolio/orders`, Polymarket order paths) was ever requested.
 */
// Sync fixture reader: callers are sync test helpers; Bun.file is async.
// ast-grep-ignore: node-fs-read-write-file
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kalshiFixtureFetch } from "../kalshi/fixture_fetch.ts";

const DIR = import.meta.dir;

export function readExecutionFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as unknown;
}

export interface ExecutionFixtureFetch {
  readonly fetch: typeof fetch;
  readonly calls: string[];
  /** Any URL that looks like an order/portfolio mutation endpoint. */
  readonly orderCalls: string[];
}

export interface ExecutionFixtureOptions {
  /** Gamma markets are captured closed/historical; flip the flag only to exercise the open path. */
  readonly forceOpenGammaMarket?: boolean;
  readonly emptyOrderbooks?: boolean;
}

function isOrderUrl(url: string): boolean {
  return (
    /\/portfolio\/orders/i.test(url) ||
    /\/orders?\?/i.test(url) ||
    /\/order\/place/i.test(url)
  );
}

/** Fetch over Kalshi + Polymarket fixtures; order endpoints are recorded and never answered. */
export function executionFixtureFetch(
  options: ExecutionFixtureOptions = {},
): ExecutionFixtureFetch {
  const kalshi = kalshiFixtureFetch(
    options.emptyOrderbooks === true ? { emptyOrderbooks: true } : {},
  );
  const gamma = readExecutionFixture("polymarket-gamma-search.json");
  const clob = readExecutionFixture("polymarket-clob-book.json") as {
    bids?: unknown;
    asks?: unknown;
  };
  // Trimmed CLOB capture: the last ~12 bid levels keep the fixture small but deep enough.
  const bids = Array.isArray(clob.bids) ? clob.bids.slice(-12) : [];
  const asks = Array.isArray(clob.asks) ? clob.asks : [];
  const calls: string[] = [];
  const orderCalls: string[] = [];

  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const href = url.toString();
    calls.push(href);
    if (isOrderUrl(href)) {
      orderCalls.push(href);
      return new Response(
        JSON.stringify({ error: "offline fixture: order refused" }),
        {
          status: 500,
        },
      );
    }
    if (url.hostname.includes("kalshi")) return kalshi.fetch(input);
    if (url.hostname.startsWith("gamma-api")) {
      const body =
        options.forceOpenGammaMarket === true ? forceOpen(gamma) : gamma;
      return Response.json(body);
    }
    if (url.hostname.startsWith("clob.")) {
      return Response.json({
        bids,
        asks,
      });
    }
    return new Response(JSON.stringify({ error: "unmapped fixture host" }), {
      status: 500,
    });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, calls, orderCalls };
}

/** Mark one captured gamma market open so the quote path can be exercised without a live market. */
function forceOpen(gamma: unknown): unknown {
  if (typeof gamma !== "object" || gamma === null) return gamma;
  const copy = structuredClone(gamma) as {
    events?: Array<{ markets?: Array<Record<string, unknown>> }>;
  };
  for (const event of copy.events ?? []) {
    for (const market of event.markets ?? []) {
      market["closed"] = false;
      market["active"] = true;
    }
  }
  return copy;
}
