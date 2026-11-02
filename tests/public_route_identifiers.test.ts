import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DAEMON_ROUTES } from "../lib/daemon_routes.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * A public route must not serve an artifact that contains identifiers.
 *
 * `dataClass` is a judgement, so a wrong judgement passes the type: the guarded/unguarded union
 * only rejects declaring `customer-identifying` data as public, not declaring it `aggregate` when
 * it is not. That is exactly what happened — five graph routes were classified `aggregate` and
 * served `docs/graph.html`, whose 640 KB payload carries BILLY666, RF2003, BGD101, CUB22HR and
 * MM800. A probe for the word "login" in the markup returned false, because the page has no such
 * label.
 *
 * So this checks values, not schema: it reads the artifact each file-serving arm points at and
 * fails if a public route serves one that contains a known identifier.
 *
 * Scope: arms that call `Bun.file(resolve(repoRoot, …))` directly. Pages loaded once at startup
 * into a const (the dashboard, the mini app) are not visible to this scan, which is why the table
 * must still be right about them.
 */

const ROOT = resolve(import.meta.dir, "..");
const SOURCE = readFileSync(
  resolve(ROOT, "services/sportsdesk_webview_server.ts"),
  "utf8",
);

/** Identifiers known to appear in this repo's captured artifacts. */
import { suspiciousIdentifiers } from "../lib/identifier_scan.ts";

/**
 * Arm → the repo-relative file it serves, read from the source.
 *
 * An arm is a `pathname === "…"` comparison; the file is the nearest `docs/…` path inside it.
 * Ranges are found by brace matching from the arm, so multi-line conditions are handled.
 */
function fileServingArms(source: string): Map<string, string> {
  const lines = source.split("\n");
  const map = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    if (!/^ {6}if \(/.test(lines[i] ?? "")) continue;

    // Walk the condition to its closing paren, then to the opening brace, so an `if (` whose
    // paths and file both sit on continuation lines is handled like a one-liner.
    let depth = 0;
    let opened = false;
    let j = i;
    const head: string[] = [];
    for (; j < lines.length; j++) {
      const text = lines[j] ?? "";
      head.push(text);
      for (const ch of text) {
        if (ch === "(") depth += 1;
        else if (ch === ")") depth -= 1;
        else if (ch === "{" && depth === 0) {
          opened = true;
          break;
        }
      }
      if (opened) break;
    }
    if (!opened) continue;

    const paths = [...head.join("\n").matchAll(/pathname === "([^"]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    if (paths.length === 0) continue;

    let bodyDepth = 1;
    const body: string[] = [];
    for (let k = j + 1; k < lines.length && bodyDepth > 0; k++) {
      const text = lines[k] ?? "";
      body.push(text);
      bodyDepth +=
        (text.match(/\{/g) ?? []).length - (text.match(/\}/g) ?? []).length;
    }
    const bodyText = body.join("\n");

    // "Serves" means the arm returns the file, either inline (`new Response(Bun.file(…))`) or
    // through the cached, compressing helper (`fileResponse(req, resolve(repoRoot, …))`). An arm
    // that opens an artifact to answer a question about it — /api/analysis reads
    // data/agent-tree.json to say whether a name is known — is not serving it, and counting it
    // produced a false positive.
    if (!/new Response\(|fileResponse\(/.test(bodyText)) continue;
    const file =
      /Bun\.file\(\s*resolve\(repoRoot,\s*"([^"]+)"\s*\)/.exec(bodyText)?.[1] ??
      /fileResponse\(\s*req,\s*resolve\(repoRoot,\s*"([^"]+)"\s*\)/s.exec(
        bodyText,
      )?.[1];
    if (file === undefined) continue;
    for (const path of paths) map.set(path, file);
  }
  return map;
}

describe("public routes do not serve identifiers", () => {
  const arms = fileServingArms(SOURCE);
  const byPath = new Map(DAEMON_ROUTES.map((route) => [route.path, route]));

  test("the scan finds the file-serving arms it is meant to cover", () => {
    // Fail on absent rather than coercing to zero: an empty map would make every assertion below
    // vacuously true, which is how a checker quietly stops checking.
    expect(arms.size).toBeGreaterThanOrEqual(4);
    expect([...arms.keys()]).toContain("/graph");
    expect([...arms.keys()]).toContain("/graph-live-feed.json");
  });

  test("no guard-free route serves an artifact containing a known identifier", () => {
    expect(misclassified(arms, byPath)).toEqual([]);
  });

  test("the comparison detects a public route serving identifiers", () => {
    // Fixture for the failure this test exists for: same arms, one row flipped to public.
    const published = new Map(byPath);
    published.set("/graph", {
      path: "/graph",
      method: "ANY",
      guard: "none",
      dataClass: "static",
      surface: null,
    });
    expect(misclassified(arms, published).length).toBeGreaterThan(0);
  });

  test("the graph artifacts are recorded as customer-identifying", () => {
    // Pins the classification that the check above depends on: if someone changes it back to
    // aggregate, this fails even though the guard would still be present.
    for (const path of [
      "/graph",
      "/graph.html",
      "/graph-live-feed.json",
      "/api/graph-feed",
    ]) {
      const route = byPath.get(path);
      expect(route?.dataClass).toBe("customer-identifying");
      expect(route?.guard).not.toBe("none");
    }
  });
});

/**
 * The table against the world.
 *
 * The union above only proves the table is internally consistent: a route declared `aggregate`
 * passes even when its response carries logins. `dataClass` is a declaration, so it needs a
 * co-validating measurement — otherwise the check is two labels agreeing about a label, the same
 * shape as `evidenceIsConcrete()` accepting any non-empty string.
 *
 * This calls the route with the selection its own artifact records and looks for the logins in
 * the response. If it finds them, the route must be classified customer-identifying and guarded.
 */
describe("a route's declared dataClass matches its response", () => {
  /** `data/analysis-*.json` records the selection it was captured for, in `context`. */
  function analysisSelection(): string | undefined {
    const dir = resolve(ROOT, "data");
    const files = readdirSync(dir).filter(
      (name) => name.startsWith("analysis-") && name.endsWith(".json"),
    );
    const file = files[0];
    if (file === undefined) return undefined;
    const artifact = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as {
      report?: string;
      context?: Record<string, string>;
    };
    const context = artifact.context ?? {};
    const params = new URLSearchParams({
      report: artifact.report ?? "CP",
      agent: context["agent"] ?? "",
      sport: context["sport"] ?? "all",
      week: context["week"] ?? "-1",
      activity: context["activity"] ?? "0",
    });
    return params.toString();
  }

  test("/api/analysis returns the artifact's rows only from an identifying, guarded route", async () => {
    const query = analysisSelection();
    expect(query).toBeDefined();

    const server = startServer({ port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/analysis?${query ?? ""}`,
      );
      const body = await response.text();
      const rowLogins = readAnalysisRowLogins();
      expect(rowLogins.length).toBeGreaterThan(0);
      const leaked = rowLogins.filter((login) => body.includes(login));

      if (leaked.length > 0) {
        const route = DAEMON_ROUTES.find((r) => r.path === "/api/analysis");
        expect(route?.dataClass).toBe("customer-identifying");
        expect(route?.guard).not.toBe("none");
      }
    } finally {
      server.stop(true);
    }
  });

  /**
   * The index the previous test does not cover.
   *
   * `/api/analysis/reports` was declared `aggregate` and unguarded while its body carried
   * `context.agent` — a portal login — so the co-validating check has to look at this arm too,
   * not just the one whose rows are obviously customer ids. Measured before the fix: a
   * non-loopback peer without a token got 200 with `BILLY666`.
   */
  test("/api/analysis/reports returns the artifact's context login only from a guarded route", async () => {
    const contextLogin = readAnalysisContextAgent();
    expect(contextLogin).toBeDefined();

    const server = startServer({ port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/analysis/reports`,
      );
      const body = await response.text();
      expect(body.includes(contextLogin as string)).toBe(true);

      const route = DAEMON_ROUTES.find(
        (r) => r.path === "/api/analysis/reports",
      );
      expect(route?.dataClass).toBe("customer-identifying");
      expect(route?.guard).not.toBe("none");
    } finally {
      server.stop(true);
    }
  });

  /**
   * `summary.byAgent` is keyed by `agent.key` (`lib/live_bets.ts:752`), so the aggregate bucket map
   * is a login list with sums attached. The check is structural rather than vocabulary-based:
   * every key that is not the `unassigned` sentinel must come from a route declared identifying.
   */
  test("/api/live-bets/summary's byAgent keys only from an identifying, guarded route", async () => {
    const server = startServer({ port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/live-bets/summary`,
        { headers: { "cache-control": "no-cache" } },
      );
      const body = (await response.json()) as {
        summary?: { byAgent?: Record<string, unknown> };
      };
      const keys = Object.keys(body.summary?.byAgent ?? {}).filter(
        (key) => key !== "unassigned",
      );
      if (keys.length === 0) return; // a capture with no assigned agent proves nothing

      for (const path of ["/api/live-bets/summary", "/live-bets/summary"]) {
        const route = DAEMON_ROUTES.find((r) => r.path === path);
        expect(route?.dataClass).toBe("customer-identifying");
        expect(route?.guard).not.toBe("none");
      }
    } finally {
      server.stop(true);
    }
  });
});

/** The agent login the stored analysis artifact was captured for. */
function readAnalysisContextAgent(): string | undefined {
  const dir = resolve(ROOT, "data");
  const file = readdirSync(dir).find(
    (name) => name.startsWith("analysis-") && name.endsWith(".json"),
  );
  if (file === undefined) return undefined;
  const artifact = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as {
    context?: { agent?: string };
  };
  const agent = artifact.context?.agent;
  return typeof agent === "string" && agent !== "" ? agent : undefined;
}

/** Customer logins from the stored analysis artifact's rows. */
function readAnalysisRowLogins(): string[] {
  const dir = resolve(ROOT, "data");
  const file = readdirSync(dir).find(
    (name) => name.startsWith("analysis-") && name.endsWith(".json"),
  );
  if (file === undefined) return [];
  const artifact = JSON.parse(readFileSync(resolve(dir, file), "utf8")) as {
    rows?: { customer?: string }[];
  };
  return (artifact.rows ?? [])
    .map((row) => row.customer)
    .filter(
      (login): login is string => typeof login === "string" && login.length > 0,
    );
}

/** Routes whose artifact contains identifiers while the table calls them public. */
function misclassified(
  arms: Map<string, string>,
  byPath: Map<string, { guard: string }>,
): string[] {
  const offenders: string[] = [];
  for (const [path, file] of arms) {
    const route = byPath.get(path);
    if (route === undefined || route.guard !== "none") continue;
    let text: string;
    try {
      text = readFileSync(resolve(ROOT, file), "utf8");
    } catch {
      continue; // artifact not present in this checkout
    }
    const found = suspiciousIdentifiers(text);
    if (found.length > 0) {
      offenders.push(
        `${path} serves ${file} with ${found.length} identifier(s)`,
      );
    }
  }
  return offenders;
}

/**
 * The extractor's own failure modes, as fixtures. Each one broke this test once; adding one is how
 * the next discovery gets closed rather than remembered.
 */
describe("the arm extractor's failure modes", () => {
  test("a multi-line `if (` condition is parsed, not skipped", () => {
    const source = [
      "      if (",
      '        pathname === "/api/x" ||',
      '        pathname === "/api/y"',
      "      ) {",
      '        return new Response(Bun.file(resolve(repoRoot, "docs/a.json")));',
      "      }",
    ].join("\n");
    const arms = fileServingArms(source);
    expect([...arms.keys()].sort()).toEqual(["/api/x", "/api/y"]);
  });

  test("an arm that reads a file without serving it is not counted", () => {
    // /api/analysis reads data/agent-tree.json to answer `agentKnown`; the response is a boolean.
    const source = [
      '      if (pathname === "/api/z") {',
      '        const tree = Bun.file(resolve(repoRoot, "data/agent-tree.json"));',
      "        return Response.json({ known: await tree.exists() });",
      "      }",
    ].join("\n");
    expect(fileServingArms(source).size).toBe(0);
  });

  test("an empty source yields no arms — which the real test treats as a failure, not a pass", () => {
    expect(fileServingArms("").size).toBe(0);
    // the committed-tree test asserts the scan finds at least four, so this cannot go unnoticed
  });
});

/**
 * The detector, calibrated against artifacts whose contents are known.
 *
 * Without this, the shape regex is an unverified belief: a pattern that matches everything would
 * make the route checks fire on every page, and one that matches nothing would pass forever.
 */
describe("the identifier detector separates the two classes", () => {
  const cases: { path: string; identifying: boolean }[] = [
    { path: "docs/graph.html", identifying: true },
    { path: "docs/graph-live-feed.json", identifying: true },
    { path: "data/analysis-cp-baseball-2026-11-01.json", identifying: true },
    { path: "data/live-wagers.json", identifying: true },
    { path: "docs/index.html", identifying: false },
    { path: "data/scoreboard.json", identifying: false },
    { path: "data/sports-catalog.json", identifying: false },
    { path: "data/contests.json", identifying: false },
  ];

  for (const item of cases) {
    test(`${item.path} is ${item.identifying ? "identifying" : "benign"}`, () => {
      let text: string;
      try {
        text = readFileSync(resolve(ROOT, item.path), "utf8");
      } catch {
        return; // artifact absent from this checkout
      }
      const found = suspiciousIdentifiers(text);
      if (item.identifying) expect(found.length).toBeGreaterThan(0);
      else expect(found).toEqual([]);
    });
  }
});
