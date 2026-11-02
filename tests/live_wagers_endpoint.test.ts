import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("GET /api/live-wagers", () => {
  // The committed paste, served from a temp dir: a developer's gitignored data/bet-ticker.json
  // would otherwise win the selection and change every answer here.
  let dir: string;
  let server: ReturnType<typeof startServer>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "live-wagers-paste-"));
    await Bun.write(
      join(dir, "live-wagers.json"),
      Bun.file(join(import.meta.dir, "../data/live-wagers.json")),
    );
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("serves every row of the paste", async () => {
    const res = await get("api/live-wagers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { count: number };
      wagers: unknown[];
    };
    expect(body.wagers.length).toBe(body.summary.count);
    expect(body.summary.count).toBeGreaterThan(0);
  });

  test("reports the whole list alongside any filtered view", async () => {
    const body = (await (await get("api/live-wagers?writer=alert")).json()) as {
      all: { count: number };
      summary: { count: number };
    };
    expect(body.all.count).toBeGreaterThan(body.summary.count);
  });

  test("filters by writer and type without inventing values", async () => {
    const base = (await (await get("api/live-wagers")).json()) as {
      wagers: Array<{ writer: string; wagerType: string }>;
    };
    const writer = base.wagers[0]?.writer;
    expect(writer).toBeDefined();
    const filtered = (await (
      await get(`api/live-wagers?writer=${writer}`)
    ).json()) as {
      wagers: Array<{ writer: string }>;
      summary: { count: number };
    };
    expect(filtered.wagers.every((w) => w.writer === writer)).toBe(true);
    expect(filtered.summary.count).toBe(filtered.wagers.length);

    const none = (await (await get("api/live-wagers?type=NOPE")).json()) as {
      summary: { count: number };
    };
    expect(none.summary.count).toBe(0);
  });

  test("states where the rows came from and whether the list is complete", async () => {
    const res = await get("api/live-wagers");
    const body = (await res.json()) as {
      provenance?: {
        source: string;
        observedAt: string | null;
        captureNote: string | null;
        partial: boolean;
      };
    };

    // Never absent: a count without provenance reads as "the ticker showed this many".
    expect(body.provenance).toBeDefined();
    expect(typeof body.provenance?.source).toBe("string");
    expect(body.provenance?.source.length).toBeGreaterThan(0);
    expect(typeof body.provenance?.partial).toBe("boolean");

    // The committed salvage says it is a subset, both in the flag and in its own note.
    expect(body.provenance?.partial).toBe(true);
    expect(body.provenance?.captureNote ?? "").toContain("subset");
    expect(body.provenance?.observedAt).toBeNull();
  });
});

describe("GET /api/live-wagers source selection", () => {
  const row = (wagerNumber: number) => ({
    WagerNumber: wagerNumber,
    TicketWriter: "GSLIVE",
    WagerType: "S",
  });
  const list = (observedAt: string | null, ...numbers: number[]) => ({
    source: "test",
    observedAt,
    LIST: numbers.map(row),
  });

  type Body = {
    error?: string;
    wagers?: Array<{ wagerNumber: number }>;
    provenance?: { observedAt: string | null };
    freshness?: {
      asOf: string;
      asOfFrom: string;
      ageSeconds?: number;
      stale: boolean;
    };
    skipped?: Array<{ path: string; reason: string }>;
  };

  let dir: string;
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "live-wagers-"));
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
      wagerListDir: dir,
    });
  });

  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  const reset = () => {
    rmSync(join(dir, "bet-ticker.json"), { force: true });
    rmSync(join(dir, "live-wagers.json"), { force: true });
  };
  const write = (name: string, body: unknown) =>
    Bun.write(
      join(dir, name),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  const get = async (path = "api/live-wagers") => {
    const res = await fetch(`${server.url}${path}`);
    return { status: res.status, body: (await res.json()) as Body };
  };

  test("both absent answers 404 with nothing skipped", async () => {
    reset();
    const { status, body } = await get();
    expect(status).toBe(404);
    expect(body.skipped).toEqual([]);
  });

  test("a newer paste beats an older capture", async () => {
    reset();
    await write("bet-ticker.json", list("2026-11-01T10:00:00Z", 1));
    await write("live-wagers.json", list("2026-11-01T12:00:00Z", 2));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([2]);
    expect(body.skipped).toEqual([
      {
        path: "data/bet-ticker.json",
        reason: "older than data/live-wagers.json",
      },
    ]);
  });

  test("equal observation times prefer the capture", async () => {
    reset();
    await write("bet-ticker.json", list("2026-11-01T12:00:00Z", 1));
    await write("live-wagers.json", list("2026-11-01T12:00:00Z", 2));
    const { body } = await get();
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([1]);
  });

  test("a capture without a LIST array falls back to the paste", async () => {
    reset();
    await write("bet-ticker.json", { source: "test", rows: [row(1)] });
    await write("live-wagers.json", list(null, 2));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([2]);
    expect(body.skipped).toEqual([
      { path: "data/bet-ticker.json", reason: "no LIST array" },
    ]);
  });

  test("invalid JSON falls back instead of answering 500", async () => {
    reset();
    await write("bet-ticker.json", "{ not json");
    await write("live-wagers.json", list(null, 2));
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([2]);
    expect(body.skipped).toEqual([
      { path: "data/bet-ticker.json", reason: "invalid JSON" },
    ]);

    // With nothing valid left, the 404 still says why.
    rmSync(join(dir, "live-wagers.json"));
    const missing = await get();
    expect(missing.status).toBe(404);
    expect(missing.body.skipped).toEqual([
      { path: "data/bet-ticker.json", reason: "invalid JSON" },
    ]);
  });

  test("an old file is stale, dated by its mtime when it records no time", async () => {
    reset();
    await write("live-wagers.json", list(null, 2));
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    utimesSync(join(dir, "live-wagers.json"), twoHoursAgo, twoHoursAgo);
    const { body } = await get();
    expect(body.freshness?.asOfFrom).toBe("file-mtime");
    expect(body.freshness?.stale).toBe(true);
    expect(Date.parse(body.freshness?.asOf ?? "")).toBeLessThanOrEqual(
      Date.now() - 7200 * 1000,
    );
  });

  test("a fresh capture is not stale, dated by its own observedAt", async () => {
    reset();
    const observedAt = new Date(Date.now() - 60 * 1000).toISOString();
    await write("bet-ticker.json", list(observedAt, 1));
    const { body } = await get();
    expect(body.freshness?.asOfFrom).toBe("artifact");
    expect(body.freshness?.asOf).toBe(observedAt);
    expect(body.freshness?.stale).toBe(false);
  });

  test("an undated paste with a fresh mtime does not shadow a dated capture", async () => {
    reset();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await write("bet-ticker.json", list(halfHourAgo, 1));
    // What a checkout does to the committed paste: no observedAt, mtime now.
    await write("live-wagers.json", list(null, 2));
    const { body } = await get();
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([1]);
    expect(body.skipped).toEqual([
      {
        path: "data/live-wagers.json",
        reason: "older than data/bet-ticker.json",
      },
    ]);
  });

  test("a future observedAt is not believed", async () => {
    reset();
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await write("bet-ticker.json", list(halfHourAgo, 1));
    await write("live-wagers.json", list("2099-01-01T00:00:00Z", 2));
    const { body } = await get();
    expect(body.wagers?.map((w) => w.wagerNumber)).toEqual([1]);

    rmSync(join(dir, "bet-ticker.json"));
    const alone = await get();
    expect(alone.body.wagers?.map((w) => w.wagerNumber)).toEqual([2]);
    expect(alone.body.freshness?.asOfFrom).toBe("file-mtime");
  });

  test("the cached body carries no per-second age", async () => {
    reset();
    await write("live-wagers.json", list(null, 2));
    const { body } = await get();
    expect(body.freshness?.ageSeconds).toBeUndefined();
    expect(typeof body.freshness?.asOf).toBe("string");
  });
});
