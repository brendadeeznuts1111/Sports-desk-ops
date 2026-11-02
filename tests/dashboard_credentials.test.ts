import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The dashboard reads `pii` routes, and the daemon guards them by peer.
 *
 * Measured before this: every data panel called `fetch()` bare, so over Nginx — where the peer is
 * the proxy and `requestIP()` is null — each panel answered 401/503 and rendered "TOKEN REQUIRED"
 * with no way to supply one. The token field existed, but only the Telegram controls used it.
 */

const ROOT = resolve(import.meta.dir, "..");
const dashboard = readFileSync(
  resolve(ROOT, "static/customer-churn-simulation-dashboard.html"),
  "utf8",
);

const inline = [...dashboard.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1] ?? "")
  .filter((body) => body.trim().length > 0)
  .join("\n");

describe("dashboard credentials", () => {
  test("the fixture parsed", () => {
    expect(inline.length).toBeGreaterThan(1000);
  });

  test("no /api/ read bypasses a credential-bearing helper", () => {
    // `fetch(` is allowed only inside api() and authed(); a bare `/api/` fetch is the bug.
    const bare = [...inline.matchAll(/fetch\(\s*[`"]\/api\//g)].map(
      (match) => match[0],
    );
    expect(bare).toEqual([]);
  });

  test("both helpers send the token the operator pasted", () => {
    const header = "Authorization: `Bearer ${tokenInput.value}`";
    const occurrences = inline.split(header).length - 1;
    expect(occurrences).toBe(2); // api() and authed()
  });

  test("the token survives a reload within the tab", () => {
    expect(inline).toContain('const TOKEN_KEY = "sportsdesk-admin-token"');
    expect(inline).toContain("sessionStorage.getItem(TOKEN_KEY)");
    expect(inline).toContain(
      "sessionStorage.setItem(TOKEN_KEY, tokenInput.value)",
    );
  });

  test("401 and 503 are explained differently", () => {
    // 503 means the daemon has no token configured at all; 401 means this peer sent nothing or
    // the wrong thing. Telling the operator to edit .env for a 401 sends them to the wrong place.
    expect(inline).toContain("function tokenHint(status)");
    expect(inline).toContain("Set it in .env and restart");
    expect(inline).toContain("Paste the daemon's admin token");
  });
});

describe("the VPS deployment keeps the guard on", () => {
  const deploy = readFileSync(
    resolve(ROOT, "scripts/deploy/deploy_to_vps.sh"),
    "utf8",
  );

  test("the unit does not opt into proxy trust", () => {
    // SPORTSDESK_TRUST_PROXY=1 makes every proxied client local; the dashboard now carries a
    // credential instead, so the deployment must not set it.
    expect(deploy).not.toContain('Environment="SPORTSDESK_TRUST_PROXY=1"');
  });

  test("a token is generated when the environment does not carry one", () => {
    expect(deploy).toContain("SPORTSDESK_ADMIN_TOKEN=.+");
    expect(deploy).toContain("head -c 32 /dev/urandom");
    expect(deploy).toContain("SPORTSDESK_ADMIN_TOKEN=${ADMIN_TOKEN}");
    expect(deploy).toContain("chmod 600");
  });
});
