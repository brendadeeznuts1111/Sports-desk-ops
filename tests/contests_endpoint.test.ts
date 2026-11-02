import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("GET /api/contests", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("answers 404 with the extract hint when no list exists", async () => {
    // data/contests.json is produced from operator-saved markup, so a fresh clone has none.
    const res = await get("api/contests");
    expect([200, 404]).toContain(res.status);
    const body = (await res.json()) as {
      hint?: string;
      entries?: unknown[];
      summary?: { total: number };
    };
    if (res.status === 404) {
      expect(body.hint).toContain("contests:extract");
    } else {
      expect(body.entries?.length).toBe(body.summary?.total);
    }
  });

  test("filters by group and query when a list is present", async () => {
    const base = (await (await get("api/contests")).json()) as {
      entries?: Array<{ group: string; description: string }>;
      summary?: { byGroup: Record<string, number> };
    };
    if (base.entries === undefined) return; // no list extracted in this checkout

    const group = Object.keys(base.summary?.byGroup ?? {})[0];
    if (group === undefined) return;

    const filtered = (await (
      await get(`api/contests?group=${encodeURIComponent(group)}`)
    ).json()) as { entries: Array<{ group: string }>; count: number };
    expect(filtered.entries.every((entry) => entry.group === group)).toBe(true);
    expect(filtered.count).toBe(filtered.entries.length);

    const none = (await (
      await get("api/contests?q=zzzz-not-a-contest")
    ).json()) as { entries: unknown[]; count: number };
    expect(none.count).toBe(0);
  });
});
