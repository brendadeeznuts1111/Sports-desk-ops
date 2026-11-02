import { afterAll, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { DAEMON_ROUTES, type Guard } from "../lib/daemon_routes.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * The guard, tested at the network boundary rather than through the code that implements it.
 *
 * Every existing server test connects over loopback, where `piiRejection` deliberately allows the
 * request — so a route that lost its guard call would pass the whole suite. That is not
 * hypothetical: /graph and /api/analysis both served customer identifiers unguarded while the
 * table claimed otherwise, and no test could see it.
 *
 * This binds 0.0.0.0, connects from a non-loopback address, and asserts the routes the table
 * marks `pii` refuse the request. An unguarded route is the control: if it also refused, the
 * failure would be the network, not the guard.
 *
 * Skips cleanly when the machine has no non-loopback IPv4, rather than passing vacuously and
 * reporting coverage it does not have.
 */

/**
 * Why this binds 0.0.0.0 instead of using `server.fetch()` for an in-process call.
 *
 * Measured: `server.requestIP(req)` returns `null` for a request passed straight to
 * `server.fetch()`, and `isLoopbackAddress(null)` is true ("unix socket = local"), so a pii route
 * answers 200 in-process. An in-process call therefore cannot distinguish a guarded route from an
 * unguarded one — the guard's whole input is the peer address, and in-process there isn't one.
 *
 * In-process dispatch is only ~1.3x faster anyway (70.6 µs vs 93.1 µs, handler work dominating),
 * so the socket cost is not the reason to reach for it.
 *
 * Correction to an earlier claim (commit 8498288 said "Bun does not cut an in-flight handler at the
 * 10s default"): it does cut, just later than the docs say. A handler that writes nothing until it
 * returns was measured against explicit idleTimeout values:
 *
 *   idle=1  handler 3s   200 at 3.0s        survived
 *   idle=1  handler 5s   ECONNRESET 4.0s
 *   idle=2  handler 5s   ECONNRESET 4.0s
 *   idle=3  handler 10s  ECONNRESET 4.0s
 *   idle=10 handler 11s  200 at 11.0s       survived by 1s
 *   idle=10 handler 25s  ECONNRESET 12.0s
 *
 * The fit is ~max(4s, idleTimeout + 2s) rather than the documented `idleTimeout`, so the default 10
 * behaves as ~12s. The original probe finished one second before the cut and was read as "never
 * cut". Consequence for this repo: an outbound call must abort well inside that budget, which is
 * why the Telegram client's default dropped from 10s to 8s.
 */

const lan = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry !== undefined && entry.family === "IPv4" && !entry.internal,
  )?.address;

/**
 * What each guard must do to a non-loopback peer without a credential.
 *
 * `Record<Guard, …>` rather than a filter on `guard === "pii"`: a new guard variant would silently
 * fall out of the test's coverage, and the compiler says nothing about coverage. Here adding a
 * variant fails compilation until its expectation is written.
 */
const CREDENTIAL_ABSENT: Record<Guard, readonly number[] | null> = {
  pii: [401, 403, 503],
  admin: [401, 403, 503],
  "telegram-secret": [401, 503],
  none: null, // public: nothing to refuse
};

const guardedRoutes = DAEMON_ROUTES.filter(
  (route) => CREDENTIAL_ABSENT[route.guard] !== null,
).map((route) => ({
  path: route.path,
  expected: CREDENTIAL_ABSENT[route.guard],
  // The table's method column is load-bearing: a POST-only arm falls through to 404 for a GET,
  // which looks like "not refused" while saying nothing about the guard.
  method: route.method === "ANY" ? "GET" : route.method,
}));
const publicControl = DAEMON_ROUTES.find(
  (route) => route.guard === "none" && route.path === "/api/sports",
);

describe.skipIf(lan === undefined)(
  "pii routes refuse a non-loopback peer",
  () => {
    const server = startServer({ port: 0, hostname: "0.0.0.0" });
    const base = `http://${lan ?? "127.0.0.1"}:${server.port}`;

    test("the table marks something as guarded (the loop below is not empty)", () => {
      expect(guardedRoutes.length).toBeGreaterThan(3);
    });

    test("an unguarded route still answers — so a refusal below means the guard, not the network", async () => {
      const route = publicControl;
      expect(route).toBeDefined();
      const response = await fetch(`${base}${route?.path ?? "/api/sports"}`);
      expect([200, 400, 404, 410]).toContain(response.status);
    });

    for (const route of guardedRoutes) {
      test(`${route.path} -> refused without a credential`, async () => {
        const response = await fetch(`${base}${route.path}`, {
          method: route.method,
        });
        // 400 or 200 here would mean the arm parsed or answered before guarding.
        expect(route.expected).toContain(response.status);
      });
    }

    test("a wrong bearer is refused too, not just an absent one", async () => {
      const response = await fetch(`${base}/api/live-bets`, {
        headers: { Authorization: "Bearer not-the-token" },
      });
      expect([401, 403, 503]).toContain(response.status);
    });

    // Stop listening once the file's tests have run.
    test("cleanup", () => {
      server.stop(true);
      expect(true).toBe(true);
    });
  },
);

/**
 * The guard is only worth anything if a cache cannot answer around it.
 *
 * `/api/live-bets/summary` was sent as `Cache-Control: public, max-age=30,
 * stale-while-revalidate=60` with no `Vary: Authorization`. Its body depends on this peer having
 * passed `piiRejection`, so `public` authorizes an intermediary to store and replay an answer the
 * guard never produced — and the unix-socket deployment is exactly the shape where such a cache
 * sits in front of the daemon. Measured on the allowed (loopback) path, because the refused path
 * carries no cache headers to inspect.
 */
describe("a guarded response is not cacheable by a shared cache", () => {
  const server = startServer({ port: 0, hostname: "127.0.0.1" });
  const base = `http://127.0.0.1:${server.port}`;

  afterAll(() => {
    server.stop(true);
  });

  test("/api/live-bets/summary is private and varies on Authorization", async () => {
    const response = await fetch(`${base}/api/live-bets/summary`);
    const cacheControl = response.headers.get("cache-control") ?? "";
    expect(cacheControl).toContain("private");
    expect(cacheControl).not.toContain("public");
    expect(cacheControl).not.toContain("stale-while-revalidate");
    expect(response.headers.get("vary") ?? "").toContain("Authorization");
  });

  test("the no-Origin variant still carries Vary, so a cache cannot replay it", async () => {
    // The grant-less response is the variant a cache stores first; without `Vary` it would be
    // replayed to a listed origin that should have been granted.
    const response = await fetch(`${base}/api/live-bets`);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("vary") ?? "").toContain("Origin");
  });
});
