import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DAEMON_PATHS,
  DAEMON_PREFIX_PATHS,
  DAEMON_ROUTES,
} from "../lib/daemon_routes.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * A page the daemon serves may only reference paths the daemon answers.
 *
 * The dashboard's agent-tree dropdown asked for `src="agent-graph.webp"`, which resolves to
 * `GET /agent-graph.webp`. Measured 2026-11-01: that arm did not exist (404 JSON), the raster is
 * written to `scratch/` rather than `docs/assets` (so `/assets/agent-graph.webp` was 404 too), and
 * the "Open live view" button hard-coded `http://127.0.0.1:9876/` — a port the daemon does not
 * listen on and a host that does not exist from any other machine. Every piece of the panel was
 * dead while the page itself answered 200.
 *
 * Nothing compared page markup with the route table, so this does: it reads the same
 * `pathname === "…"` table the handler is pinned to (`tests/daemon_routes.test.ts`) and requires
 * every local `src`/`href` to be a declared path.
 */

const ROOT = resolve(import.meta.dir, "..");

/** The pages that fileResponse serves, and the route each one answers on. */
const SERVED_PAGES: readonly {
  readonly route: string;
  readonly file: string;
}[] = [
  {
    route: "/",
    file: "static/customer-churn-simulation-dashboard.html",
  },
  {
    route: "/dashboard",
    file: "static/customer-churn-simulation-dashboard.html",
  },
  {
    route: "/live-bets",
    file: "static/live-bets.html",
  },
  {
    route: "/miniapp",
    file: "static/telegram-miniapp-dashboard.html",
  },
  {
    route: "/status",
    file: "static/status.html",
  },
];

/** A scheme (https:, data:, mailto:, telegram:), a protocol-relative host, or a fragment. */
const EXTERNAL_REF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;

/**
 * Attribute refs (`src`, `href`) plus the string literals the page passes to `fetch`/`api`/
 * `authed`. Both are requests the browser makes to this origin; a page that names a path the
 * daemon does not answer is broken whether the request comes from markup or script.
 */
const SCRIPT_REF_RE = /\b(?:fetch|api|authed)\(\s*(["'`])([^"'`]+)\1/g;

function localRefs(html: string, pageRoute: string): string[] {
  const refs = new Set<string>();
  const add = (raw: string): void => {
    const value = raw.trim();
    if (value === "" || EXTERNAL_REF_RE.test(value)) return;
    // Resolve the way the browser does, so a relative ref is read against its own page.
    refs.add(new URL(value, `http://daemon${pageRoute}`).pathname);
  };

  for (const match of html.matchAll(/(?:src|href)="([^"]*)"/g)) {
    add(match[1] ?? "");
  }
  for (const match of html.matchAll(SCRIPT_REF_RE)) {
    add(match[2] ?? "");
  }
  return [...refs];
}

function daemonAnswers(pathname: string): boolean {
  if (DAEMON_PATHS.includes(pathname)) return true;
  return DAEMON_PREFIX_PATHS.some((prefix) => {
    const stem = prefix.endsWith("*") ? prefix.slice(0, -1) : prefix;
    return pathname.startsWith(stem);
  });
}

describe("served pages reference routes the daemon answers", () => {
  test("the parser finds the refs these pages actually carry", () => {
    // Guard the extractor itself: an empty list would make the gate vacuous.
    const dashboard = readFileSync(
      resolve(ROOT, "static/customer-churn-simulation-dashboard.html"),
      "utf8",
    );
    expect(localRefs(dashboard, "/")).toContain("/agent-graph.webp");
    expect(localRefs(dashboard, "/")).toContain("/graph");
  });

  for (const page of SERVED_PAGES) {
    test(`${page.route} → ${page.file}`, () => {
      const html = readFileSync(resolve(ROOT, page.file), "utf8");
      const unanswered = localRefs(html, page.route).filter(
        (pathname) => !daemonAnswers(pathname),
      );
      expect(unanswered).toEqual([]);
    });
  }

  test("no served page hard-codes a loopback origin", () => {
    // The listener port is the operator's choice (BUN_PORT/PORT, or a unix socket), so a page
    // that names one is wrong on every deployment except the author's.
    for (const page of SERVED_PAGES) {
      const html = readFileSync(resolve(ROOT, page.file), "utf8");
      expect(html).not.toMatch(
        /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)/,
      );
    }
  });
});

describe("the agent-tree raster is an integration, not a dangling file", () => {
  test("the dashboard loads it through the credential helper, not a bare <img src>", () => {
    const html = readFileSync(
      resolve(ROOT, "static/customer-churn-simulation-dashboard.html"),
      "utf8",
    );
    // The bytes need the token on a non-loopback peer, and an <img> cannot send one.
    expect(html).toContain('authed("/agent-graph.webp"');
    expect(html).not.toMatch(/<img[^>]*\ssrc="agent-graph\.webp"/);
    // The GOAP page is the guarded surface the raster belongs to.
    expect(html).toContain('href="/graph"');
  });

  test("the route is declared pii, like the page it is rendered from", () => {
    const route = DAEMON_ROUTES.find(
      (candidate) => candidate.path === "/agent-graph.webp",
    );
    expect(route).toBeDefined();
    expect(route?.guard).toBe("pii");
    expect(route?.dataClass).toBe("customer-identifying");
  });
});

describe("GET /agent-graph.webp", () => {
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

  test("answers with the raster, or names the command that builds it", async () => {
    const res = await fetch(`${server.url}agent-graph.webp`);
    // Loopback is trusted, so this must not be the 401/503 credential branch.
    expect([200, 404, 503]).toContain(res.status);

    if (res.status === 200) {
      expect(res.headers.get("content-type")).toBe("image/webp");
      // Guarded per peer: a proxy must not replay it to another one.
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      return;
    }

    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("bun run graph:agent:image");
  });
});
