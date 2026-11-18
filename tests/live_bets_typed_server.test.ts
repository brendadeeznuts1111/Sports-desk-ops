/**
 * @file tests/live_bets_typed_server.test.ts
 * @description Contract for the typed live-bets route slice: session-cookie auth,
 * branded route params, sanitized audit output, binary POST ingest and errors.
 */
import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";
import type { Serve } from "bun";
import {
  buildWagerPath,
  LIVE_BETS_ROUTE,
  startLiveBetsServer,
} from "../services/live_bets_typed_server.ts";

const TOKEN = "typed-live-bets-session-token";
const server = startLiveBetsServer(TOKEN, 0);
const base = server.url.origin;

afterAll(() => {
  server.stop(true);
});

const authHeaders = (token = TOKEN): Record<string, string> => ({
  cookie: `sd_session=${token}`,
});

describe("typed live-bets server", () => {
  test("ExtractRouteParams mirrors the route literal", () => {
    type LiveBetsParams =
      Serve.ExtractRouteParams<"/api/v2/live-bets/:bridge/:wagerNumber">;
    // ExtractRouteParams composes multi-param routes as an intersection.
    expectTypeOf<LiveBetsParams>().toEqualTypeOf<
      { bridge: string } & { wagerNumber: string }
    >();
    // Widened `string`, static routes and tail wildcards extract to the documented fallbacks.
    expectTypeOf<Serve.ExtractRouteParams<string>>().toEqualTypeOf<
      Record<string, string>
    >();
    expectTypeOf<Serve.ExtractRouteParams<"/health">>().toEqualTypeOf<{}>();
    expectTypeOf<
      Serve.ExtractRouteParams<"/snapshots/*">
    >().toEqualTypeOf<{}>();
  });

  test("buildWagerPath fills and encodes typed route params", () => {
    expect(
      buildWagerPath(LIVE_BETS_ROUTE, {
        bridge: "FANTASY_402",
        wagerNumber: "769158444",
      }),
    ).toBe("/api/v2/live-bets/FANTASY_402/769158444");
    expect(buildWagerPath("/files/:name", { name: "a b/c" })).toBe(
      "/files/a%20b%2Fc",
    );
    // The type infers keys up to "/", including hyphens; the builder matches.
    expect(buildWagerPath("/x/:a-b", { "a-b": "v" })).toBe("/x/v");
  });

  test("/health is a zero-JS static route", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("an unknown route falls through to the JSON 404", async () => {
    const response = await fetch(`${base}/not-a-route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "ERR_ROUTE_NOT_FOUND" });
  });

  test("rejects a missing or wrong session cookie and clears it", async () => {
    for (const headers of [undefined, { cookie: "sd_session=wrong" }]) {
      const response = await fetch(
        `${base}/api/v2/live-bets/FANTASY_402/769158444`,
        { headers },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "ERR_AUTH_REJECTED" });
      expect(response.headers.get("set-cookie")).toContain("sd_session=;");
    }
  });

  test("authenticated GET returns typed params, cookie state and a sanitized audit", async () => {
    const response = await fetch(
      `${base}/api/v2/live-bets/FANTASY_402/769158444`,
      {
        headers: {
          ...authHeaders(),
          authorization: "Bearer must-not-appear",
        },
      },
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      bridge: string;
      wagerNumber64: string;
      audit: {
        method: string;
        pathname: string;
        params: Record<string, string>;
        hasSessionCookie: boolean;
        sensitiveHeadersPresent: readonly string[];
        clientIp: string;
      };
    };
    expect(body.bridge).toBe("FANTASY_402");
    expect(body.wagerNumber64).toBe("769158444");
    expect(body.audit).toEqual({
      method: "GET",
      pathname: "/api/v2/live-bets/FANTASY_402/769158444",
      params: { bridge: "FANTASY_402", wagerNumber: "769158444" },
      hasSessionCookie: true,
      sensitiveHeadersPresent: ["authorization", "cookie"],
      clientIp: "[REDACTED_IP]",
    });
    expect(JSON.stringify(body)).not.toContain("must-not-appear");
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // The rolling cookie is refreshed with hardened attributes.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`sd_session=${TOKEN}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=3600");
  });

  test("rejects an unknown bridge or a non-numeric wager number", async () => {
    for (const path of [
      "/api/v2/live-bets/FANTASY_402/not-a-number",
      "/api/v2/live-bets/PARTNER_119/123",
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: authHeaders(),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "ERR_INVALID_ROUTE_PARAMS",
      });
    }
  });

  test("authenticated POST consumes the frame bytes zero-copy", async () => {
    const response = await fetch(`${base}/api/v2/live-bets/PARTNER_118/42`, {
      method: "POST",
      headers: authHeaders(),
      body: "frame-bytes",
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ingestedBytes: 11 });
  });

  test("POST rejects an empty frame and requires auth", async () => {
    const empty = await fetch(`${base}/api/v2/live-bets/PARTNER_118/42`, {
      method: "POST",
      headers: authHeaders(),
    });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "ERR_EMPTY_FRAME" });

    const anonymous = await fetch(`${base}/api/v2/live-bets/PARTNER_118/42`, {
      method: "POST",
      body: "frame-bytes",
    });
    expect(anonymous.status).toBe(401);
  });
});
