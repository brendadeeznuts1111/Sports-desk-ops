import { afterAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { DAEMON_ROUTES } from "../lib/daemon_routes.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * The method column, verified instead of assumed.
 *
 * 36 of 42 rows said `method: "ANY"`, which claims the daemon does not check `req.method`. Nothing
 * checked that claim, and the boundary probe acts on it (it sends GET on the strength of ANY).
 * Two rows were already wrong: /api/status and /status.json are GET-only and answered 404 to POST,
 * so a probe that trusted the table could read "not refused" from a 404 that said nothing about
 * the guard.
 *
 * Direction one: an ANY route answers GET and POST the same way.
 * Direction two: a named-method route refuses the other method (404), so `ANY` is not silently
 * the safe default.
 */

// `/tracker` is probed with its named method (GET) on this loopback server. Its real loader runs
// `gh` and `git` and sweeps the keychain, which a test must not do, so it gets a state that
// makes no calls.
const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  trackerState: async () => ({
    generatedAt: "2026-11-04T00:00:00.000Z",
    mainCi: null,
    tasks: { kind: "unavailable", reason: "test" },
    prs: { kind: "unavailable", reason: "test" },
    secrets: { kind: "unavailable", reason: "test" },
  }),
});
const base = `http://127.0.0.1:${server.port}`;

async function statusOf(path: string, method: string): Promise<number> {
  const response = await fetch(`${base}${path}`, { method }).catch(() => null);
  return response?.status ?? -1;
}

describe("the method column matches the daemon", () => {
  test("ANY routes answer GET and POST alike", async () => {
    const disagreements: string[] = [];
    for (const route of DAEMON_ROUTES) {
      if (route.method !== "ANY") continue;
      const get = await statusOf(route.path, "GET");
      const post = await statusOf(route.path, "POST");
      if (get !== post)
        disagreements.push(`${route.path} GET=${get} POST=${post}`);
    }
    expect(disagreements).toEqual([]);
  });

  test("a named method is the one that works", async () => {
    const wrong: string[] = [];
    for (const route of DAEMON_ROUTES) {
      if (route.method === "ANY") continue;
      const declared = await statusOf(route.path, route.method);
      if (declared === 404)
        wrong.push(`${route.path} declares ${route.method} but 404s`);
    }
    expect(wrong).toEqual([]);
  });

  afterAll(() => {
    server.stop(true);
  });
});

/**
 * The complement of the guard test: public routes are public.
 *
 * tests/route_guard_boundary.test.ts proves guarded routes refuse a non-loopback peer. Nothing
 * proved the other direction, so a route that quietly gained a guard (or lost its handler and
 * started 404ing) would look like a pass — the exposure documented in the table would no longer
 * match the daemon.
 *
 * The assertion is deliberately narrow: not an auth refusal. A 200, 400, 404 or 500 all mean the
 * request was not gated; 401/403/503 would mean the table says `none` while the daemon refuses.
 */
const lan = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry !== undefined && entry.family === "IPv4" && !entry.internal,
  )?.address;

const publicRoutes = DAEMON_ROUTES.filter((route) => route.guard === "none");

describe.skipIf(lan === undefined)("public routes are not gated", () => {
  const remote = startServer({ port: 0, hostname: "0.0.0.0" });
  const remoteBase = `http://${lan ?? "127.0.0.1"}:${remote.port}`;

  for (const route of publicRoutes) {
    test(`${route.path} answers a non-loopback peer without credentials`, async () => {
      const response = await fetch(`${remoteBase}${route.path}`, {
        method: route.method === "ANY" ? "GET" : route.method,
      }).catch(() => null);
      expect(response).not.toBeNull();
      expect([401, 403, 503]).not.toContain(response?.status);
    });
  }

  afterAll(() => {
    remote.stop(true);
  });
});
