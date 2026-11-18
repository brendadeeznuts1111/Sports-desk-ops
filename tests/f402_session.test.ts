import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  F402_DERIVED_EXPIRY_MARGIN_MS,
  describeF402Session,
  readF402Session,
  refreshF402Session,
  sessionFromAuth,
  writeF402Session,
  type F402Session,
} from "../lib/f402_session.ts";
import { probeF402BetTicker } from "../lib/f402_ingest.ts";

const SESSION: F402Session = {
  cookieHeader: "session=SECRET; csrftoken=SECRET2",
  cookieNames: ["session", "csrftoken"],
  obtainedAtIso: "2026-10-31T18:00:00.000Z",
  expiresAtIso: "2026-10-31T18:30:00.000Z",
};

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
let lastRequest: {
  body: string;
  cookie: string | null;
  authorization: string | null;
} | null = null;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "f402-session-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      lastRequest = {
        body: await request.text(),
        cookie: request.headers.get("cookie"),
        authorization: request.headers.get("authorization"),
      };
      if (url.pathname.startsWith("/slow")) {
        await Bun.sleep(120);
        return Response.json({ LIST: [] });
      }
      if (request.headers.get("cookie")?.includes("expired")) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ LIST: [{ Login: "AF12" }, { Login: "MJ102" }] });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("F402 session cache", () => {
  test("writes 0600 and reads back", () => {
    const path = join(dir, "session.json");
    writeF402Session(SESSION, { path });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const loaded = readF402Session({
      path,
      now: Date.parse("2026-10-31T18:10:00.000Z"),
    });
    expect(loaded?.cookieHeader).toBe(SESSION.cookieHeader);
    expect(loaded?.cookieNames).toEqual(["session", "csrftoken"]);
  });

  test("rejects group/world-readable, expired, and missing sessions", () => {
    const path = join(dir, "loose.json");
    writeF402Session(SESSION, { path });
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      expect(
        readF402Session({ path, now: Date.parse("2026-10-31T18:10:00.000Z") }),
      ).toBeNull();
    }

    const expired = join(dir, "expired.json");
    writeF402Session(SESSION, { path: expired });
    expect(
      readF402Session({
        path: expired,
        now: Date.parse("2026-10-31T19:00:00.000Z"),
      }),
    ).toBeNull();
    expect(readF402Session({ path: join(dir, "missing.json") })).toBeNull();
  });

  test("builds a TTL session and never logs the cookie value", () => {
    const session = sessionFromAuth(
      { cookieHeader: "session=SECRET", cookieNames: ["session"] },
      { now: Date.parse("2026-10-31T18:00:00.000Z"), ttlMinutes: 15 },
    );
    expect(session.expiresAtIso).toBe("2026-10-31T18:15:00.000Z");
    const described = describeF402Session(session);
    expect(described).toContain("session");
    expect(described).not.toContain("SECRET");
  });

  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwtAt = (nbf: number, exp: number): string =>
    `Bearer ${b64({ alg: "none" })}.${b64({ nbf, exp })}.sig`;

  test("derives a bearer session expiry from exp, not the fallback TTL", () => {
    const now = Date.parse("2026-11-17T16:00:00.000Z");
    const exp = Math.floor(now / 1000) + 21 * 60;
    const session = sessionFromAuth(
      {
        cookieHeader: "",
        cookieNames: [],
        authorizationHeader: jwtAt(exp - 21 * 60, exp),
      },
      { now },
    );
    expect(session.expiresAtIso).toBe(
      new Date((exp - 2 * 60) * 1000).toISOString(),
    );
  });

  test("derived expiry sits the pinned 2-minute margin before exp", () => {
    expect(F402_DERIVED_EXPIRY_MARGIN_MS).toBe(2 * 60 * 1000);
    const now = Date.parse("2026-11-17T16:00:00.000Z");
    const exp = Math.floor(now / 1000) + 21 * 60;
    const session = sessionFromAuth(
      {
        cookieHeader: "",
        cookieNames: [],
        authorizationHeader: jwtAt(exp - 21 * 60, exp),
      },
      { now },
    );
    expect(Date.parse(session.expiresAtIso)).toBe(
      exp * 1000 - F402_DERIVED_EXPIRY_MARGIN_MS,
    );
  });

  test("a shorter caller TTL still wins over the bearer exp", () => {
    const now = Date.parse("2026-11-17T16:00:00.000Z");
    const exp = Math.floor(now / 1000) + 21 * 60;
    const session = sessionFromAuth(
      {
        cookieHeader: "",
        cookieNames: [],
        authorizationHeader: jwtAt(exp - 21 * 60, exp),
      },
      { now, ttlMinutes: 5 },
    );
    expect(session.expiresAtIso).toBe(new Date(now + 5 * 60_000).toISOString());
  });

  test("an opaque bearer keeps the TTL fallback", () => {
    const now = Date.parse("2026-11-17T16:00:00.000Z");
    const session = sessionFromAuth(
      {
        cookieHeader: "",
        cookieNames: [],
        authorizationHeader: "Bearer opaque-token",
      },
      { now, ttlMinutes: 15 },
    );
    expect(session.expiresAtIso).toBe(
      new Date(now + 15 * 60_000).toISOString(),
    );
  });

  test("an already-expired bearer derives a past expiry", () => {
    const now = Date.parse("2026-11-17T16:00:00.000Z");
    const exp = Math.floor(now / 1000) - 60;
    const session = sessionFromAuth(
      {
        cookieHeader: "",
        cookieNames: [],
        authorizationHeader: jwtAt(exp - 21 * 60, exp),
      },
      { now },
    );
    expect(Date.parse(session.expiresAtIso)).toBeLessThan(now);
  });

  test("live login stays disabled without F402_LIVE_LOGIN=1", async () => {
    await expect(refreshF402Session({ env: {} })).rejects.toThrow(
      /F402_LIVE_LOGIN=1/,
    );
  });
});

describe("F402 getBetTicker probe", () => {
  test("posts the captured form shape and counts LIST rows", async () => {
    const probe = await probeF402BetTicker(SESSION, {
      baseUrl,
      agentId: "BILLY666",
    });
    expect(probe.endpoint).toBe(`${baseUrl}/cloud/api/Manager/getBetTicker`);
    expect(probe.httpStatus).toBe(200);
    expect(probe.rows).toBe(2);
    expect(probe.error).toBeNull();
    expect(probe.fields).toContain("Login");
    expect(probe.ticks.map((tick) => tick.login)).toEqual(["AF12", "MJ102"]);
    expect(lastRequest?.body).toContain("agentID=BILLY666");
    expect(lastRequest?.body).toContain("operation=getBetTicker");
    expect(lastRequest?.cookie).toBe(SESSION.cookieHeader);
  });

  test("forwards the bearer token when present", async () => {
    await probeF402BetTicker(
      { ...SESSION, authorizationHeader: "Bearer jwt-value" },
      { baseUrl, agentId: "BILLY666" },
    );
    expect(lastRequest?.authorization).toBe("Bearer jwt-value");
  });

  test("classifies 401 as unauthorized", async () => {
    const probe = await probeF402BetTicker(
      { ...SESSION, cookieHeader: "session=expired" },
      { baseUrl, agentId: "BILLY666" },
    );
    expect(probe.httpStatus).toBe(401);
    expect(probe.error).toBe("unauthorized");
  });

  test("classifies timeouts", async () => {
    const probe = await probeF402BetTicker(SESSION, {
      baseUrl: `${baseUrl}/slow`,
      agentId: "BILLY666",
      timeoutMs: 20,
    });
    expect(probe.error).toBe("timeout");
  });
});
