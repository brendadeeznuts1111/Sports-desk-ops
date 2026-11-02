import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DAEMON_PATHS,
  DAEMON_ROUTES,
  type DaemonRoute,
} from "../lib/daemon_routes.ts";
import {
  declaredPathsFromLedger,
  servedPathsFromSource,
} from "../lib/route_surface.ts";

/**
 * The table is only worth having if it cannot drift from the daemon.
 *
 * `DAEMON_ROUTES` is hand-shaped data (the guard column especially), while the handler is a chain
 * of `pathname === "…"` comparisons. These tests read the chain and require an exact match in
 * both directions, so a route added to the handler without a table row fails, and a table row the
 * handler does not serve fails too.
 *
 * The guard column cannot be checked this way — it says where the gate lives, and a scan of arm
 * bodies gets that wrong (the telegram gate sits above its arms). What is assertable is the
 * behaviour, which is why the interesting guards are covered in tests/telegram_bot.test.ts.
 */

const ROOT = resolve(import.meta.dir, "..");

describe("DAEMON_ROUTES", () => {
  const served = servedPathsFromSource(
    readFileSync(
      resolve(ROOT, "services/sportsdesk_webview_server.ts"),
      "utf8",
    ),
  );
  const tablePaths = new Set(DAEMON_PATHS);

  test("every table row is actually served", () => {
    expect([...tablePaths].filter((path) => !served.has(path)).sort()).toEqual(
      [],
    );
  });

  test("every served path has a row", () => {
    expect([...served].filter((path) => !tablePaths.has(path)).sort()).toEqual(
      [],
    );
  });

  test("paths are unique", () => {
    expect(new Set(DAEMON_PATHS).size).toBe(DAEMON_PATHS.length);
  });

  test("a public route with customer data is a type error, not a review finding", () => {
    // The union makes it unrepresentable: `PublicRoute.dataClass` excludes the identifying class.
    // @ts-expect-error — a route with guard "none" may not declare customer-identifying data
    const illegal: DaemonRoute = {
      path: "/api/whoever",
      method: "ANY",
      guard: "none",
      dataClass: "customer-identifying",
      surface: null,
    };
    expect(illegal.path).toBe("/api/whoever");
  });

  test("the table contains no public route with customer data", () => {
    // Runtime shadow of the same rule: types are erased once the table is data, so read it back
    // as plain strings (the literal types make this comparison unreachable at compile time).
    const rows = JSON.parse(JSON.stringify(DAEMON_ROUTES)) as {
      path: string;
      guard: string;
      dataClass: string;
    }[];
    expect(
      rows.filter(
        (row) =>
          row.guard === "none" && row.dataClass === "customer-identifying",
      ),
    ).toEqual([]);
    expect(
      rows.filter((row) => row.dataClass === "customer-identifying").length,
    ).toBeGreaterThan(3);
  });

  test("every customer-identifying route is guarded, by admin or pii", () => {
    const identifying = DAEMON_ROUTES.filter(
      (route) => route.dataClass === "customer-identifying",
    );
    expect(identifying.length).toBeGreaterThan(3);
    expect(
      [...new Set(identifying.map((route) => route.guard))].sort(),
    ).toEqual(["admin", "pii"]);
  });

  test("the admin policy covers /api/watchlist and the /api/telegram/ prefix", () => {
    for (const path of DAEMON_PATHS) {
      if (path === "/api/watchlist" || path.startsWith("/api/telegram/")) {
        const route = DAEMON_ROUTES.find((r) => r.path === path);
        expect(route?.guard).toBe("admin");
      }
    }
  });

  test("every route's surface is either null or a surface the ledger declares", () => {
    const ledger = JSON.parse(
      readFileSync(resolve(ROOT, "docs/evidence/ledger.json"), "utf8"),
    );
    const surfaces = new Set(
      (ledger.surfaces as { id?: string }[]).map((surface) => surface.id ?? ""),
    );
    for (const route of DAEMON_ROUTES) {
      if (route.surface === null) continue;
      expect(surfaces.has(route.surface)).toBe(true);
    }
  });

  test("a route mapped to a surface is listed in that surface's members", () => {
    const ledger = JSON.parse(
      readFileSync(resolve(ROOT, "docs/evidence/ledger.json"), "utf8"),
    );
    const declared = declaredPathsFromLedger(ledger);
    for (const route of DAEMON_ROUTES) {
      if (route.surface === null) continue;
      expect(declared.get(route.path)?.surface).toBe(route.surface);
    }
  });
});
