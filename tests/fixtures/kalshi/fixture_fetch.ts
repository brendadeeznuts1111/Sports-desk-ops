/**
 * Offline Kalshi transport for tests.
 *
 * Every fixture in this directory was captured from the live public API on 2026-11-04 with plain
 * `curl` (see each file's `source`/`capturedAtIso`), then trimmed: arrays shortened, real field
 * names and values kept. Tests never hit the network — this fetch answers from those files.
 */
// Sync fixture reader: callers are sync test helpers; Bun.file is async.
// ast-grep-ignore: node-fs-read-write-file
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

/** Series ticker → captured `/events` response body. */
const SERIES_FILES: Readonly<Record<string, string>> = {
  KXNBAGAME: "kxnbagame-events.json",
  KXNBATOTAL: "kxnbatotal-events.json",
  KXNBASPREAD: "kxnbaspread-events.json",
  KXNBATEAMTOTAL: "kxnbateamtotal-events.json",
  KXNBA1Q: "kxnba1q-events.json",
  KXNBA1QTOTAL: "kxnba1qtotalevents.json",
  KXNBA4QSPREAD: "kxnba4qspread-events.json",
};

/** Market ticker → captured orderbook body. */
const ORDERBOOK_FILES: Readonly<Record<string, string>> = {
  "KXNBAGAME-26NOV04ATLWAS-ATL": "orderbook-kxnbagame-atl.json",
  "KXNBATOTAL-26NOV04ATLWAS-207": "orderbook-kxnbatotal-207.json",
  "KXNBA4QSPREAD-26NOV04MILBOS-MIL2": "orderbook-kxnba4qspread-mil2.json",
};

export function readKalshiFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as unknown;
}

export interface FixtureFetch {
  readonly fetch: typeof fetch;
  readonly calls: string[];
}

export interface FixtureFetchOptions {
  /** Serve an empty book for every orderbook URL (liquidity-empty tests). */
  readonly emptyOrderbooks?: boolean;
  /** Force network-style failures for one scope. */
  readonly failOn?: "events" | "orderbook" | "all";
}

/** A `fetch` over the captured fixtures that also records the URLs it was asked for. */
export function kalshiFixtureFetch(
  options: FixtureFetchOptions = {},
): FixtureFetch {
  const calls: string[] = [];
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
    calls.push(url.toString());
    if (options.failOn === "all") throw new Error("fixture network failure");
    const ticker = url.searchParams.get("series_ticker");
    if (url.pathname.endsWith("/orderbook")) {
      if (options.failOn === "orderbook")
        throw new Error("fixture orderbook failure");
      const market = url.pathname.split("/").at(-2) ?? "";
      const file = ORDERBOOK_FILES[market];
      if (file === undefined || options.emptyOrderbooks === true) {
        return Response.json({
          orderbook_fp: { yes_dollars: [], no_dollars: [] },
        });
      }
      return Response.json(readKalshiFixture(file));
    }
    if (options.failOn === "events") throw new Error("fixture events failure");
    const file = ticker === null ? undefined : SERIES_FILES[ticker];
    if (file === undefined) return Response.json({ events: [] });
    return Response.json(readKalshiFixture(file));
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}
