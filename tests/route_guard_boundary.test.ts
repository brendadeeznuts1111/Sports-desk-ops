import { describe, expect, test } from "bun:test";
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
