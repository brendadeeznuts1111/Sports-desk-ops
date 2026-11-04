import { describe, expect, test } from "bun:test";
import { DAEMON_PATHS } from "../lib/daemon_routes.ts";

const html = await Bun.file("static/telegram-miniapp-dashboard.html").text();

describe("Telegram Mini App", () => {
  test("reads live daemon routes and keeps no mock fixtures", () => {
    const paths = [...html.matchAll(/\bapi\(\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    expect(paths).toEqual([
      "/api/kpis",
      "/api/live-bets/summary",
      "/api/graph/summary",
      "/api/game-admin/board",
      "/api/gslive/session-health",
      "/api/watchlist",
    ]);
    expect(paths.filter((path) => !DAEMON_PATHS.includes(path))).toEqual([]);

    // The page used to ship invented numbers and alert() as its "actions".
    expect(html).not.toContain("$2.79M");
    expect(html).not.toContain("-$63,467");
    expect(html).not.toContain("Whale Surveillance");
    expect(html).not.toContain("alert(");
    expect(html).toContain("GSLive session");
    expect(html).toContain("cookie-only GET");
    expect(html).toContain("Legacy vs v4 surface map");
  });

  test("every element id the script looks up exists in the markup", () => {
    const ids = new Set(
      [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!),
    );
    const looked = new Set([
      ...[...html.matchAll(/getElementById\("([^"]+)"\)/g)].map(
        (match) => match[1]!,
      ),
      ...[...html.matchAll(/setText\("([^"]+)"/g)].map((match) => match[1]!),
    ]);
    expect([...looked].filter((id) => !ids.has(id))).toEqual([]);
  });

  test("the guarded watchlist never asks for or stores the admin token", () => {
    expect(html).toContain("SPORTSDESK_ADMIN_TOKEN");
    expect(html).toContain("This page never asks for the token");
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
  });
});
