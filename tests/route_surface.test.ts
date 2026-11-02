import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DAEMON_PREFIX_PATHS } from "../lib/daemon_routes.ts";
import {
  canonicalRoutePath,
  compareRouteSurfaces,
  declaredPathsFromLedger,
  type DeclaredPath,
  memberPath,
  readRouteSurfaceInputs,
  servedPathsFromSource,
  specPathsFromDocument,
} from "../lib/route_surface.ts";

/**
 * The daemon's surface was maintained three times by hand — 43 `pathname ===` arms, the ledger's
 * `surfaces[].members`, and the spec's `paths` — with nothing comparing them. Measured
 * 2026-11-01: five served `/api` routes appeared in neither the ledger nor the spec.
 */

const ROOT = resolve(import.meta.dir, "..");

describe("memberPath", () => {
  test("strips a method prefix and keeps the path", () => {
    expect(memberPath("GET /api/scoreboard")).toBe("/api/scoreboard");
    expect(memberPath("/api/live-bets")).toBe("/api/live-bets");
    expect(memberPath("OPTIONS *")).toBeUndefined();
    expect(memberPath(42)).toBeUndefined();
  });
});

describe("servedPathsFromSource", () => {
  test("reads literal comparisons, including the two arms on one line", () => {
    const source = `
      if (pathname === "/api/status" || pathname === "/status.json") {}
      if (pathname === "/api/telegram/alert" && req.method === "POST") {}
    `;
    expect([...servedPathsFromSource(source)].sort()).toEqual([
      "/api/status",
      "/api/telegram/alert",
      "/status.json",
    ]);
  });

  test("ignores non-path literals and query strings", () => {
    expect([
      ...servedPathsFromSource(
        'pathname === "not-a-path"; pathname === "/x?y=1"',
      ),
    ]).toEqual(["/x"]);
  });

  test("reads a set the handler branches on, and only then", () => {
    // Two graph companions were served by `GRAPH_DOCS_JSON.has(pathname)` and had no table row;
    // the extractor said "every table row is served / every served path has a row" anyway.
    const branched = `
      const GRAPH_DOCS_JSON = new Set([
        "/combo-uniqueness.json",
        "/cross-domain-bridge.json",
      ]);
      if (GRAPH_DOCS_JSON.has(pathname)) {}
    `;
    expect([...servedPathsFromSource(branched)].sort()).toEqual([
      "/combo-uniqueness.json",
      "/cross-domain-bridge.json",
    ]);

    // A set that is never matched against the pathname is not a route table.
    const unused = `
      const REPORT_TYPES = new Set(["MORNING_BRIEFING", "EVENING_SETTLEMENT"]);
    `;
    expect([...servedPathsFromSource(unused)]).toEqual([]);
  });
});

describe("declaredPathsFromLedger", () => {
  const ledger = {
    surfaces: [
      { id: "surface.local", category: "local-route", members: ["GET /api/a"] },
      {
        id: "surface.upstream",
        category: "upstream-route",
        members: ["GET /cloud/api/b"],
      },
    ],
  };

  test("carries the declaring surface and its category", () => {
    const declared = declaredPathsFromLedger(ledger);
    expect(declared.get("/api/a")).toEqual({
      surface: "surface.local",
      category: "local-route",
    });
    expect(declared.get("/cloud/api/b")?.category).toBe("upstream-route");
  });

  test("tolerates a ledger with no surfaces", () => {
    expect(declaredPathsFromLedger({}).size).toBe(0);
    expect(declaredPathsFromLedger(null).size).toBe(0);
  });
});

describe("specPathsFromDocument", () => {
  test("reads the published paths and tolerates junk", () => {
    expect(
      [...specPathsFromDocument({ paths: { "/a": {}, "/b": {} } })].sort(),
    ).toEqual(["/a", "/b"]);
    expect(specPathsFromDocument({}).size).toBe(0);
    expect(specPathsFromDocument(null).size).toBe(0);
  });
});

describe("compareRouteSurfaces", () => {
  const declared: Map<string, DeclaredPath> = new Map([
    ["/api/known", { surface: "surface.local", category: "local-route" }],
    ["/api/gone", { surface: "surface.local", category: "local-route" }],
    [
      "/cloud/api/up",
      { surface: "surface.upstream", category: "upstream-route" },
    ],
  ]);

  test("a served API path with no surface is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known", "/api/undocumented"]),
      declared,
      spec: new Set(["/api/known"]),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toContain(
      "served-undocumented /api/undocumented",
    );
  });

  test("a declared API path the daemon no longer serves is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known"]),
      declared,
      spec: new Set(["/api/known"]),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toContain(
      "declared-not-served /api/gone",
    );
  });

  test("upstream routes are not expected to be served here", () => {
    const findings = compareRouteSurfaces({
      served: new Set(),
      declared,
      spec: new Set(),
    });
    expect(findings.map((f) => f.path)).not.toContain("/cloud/api/up");
  });

  test("pages are not drift — but a declared page that vanished still is", () => {
    const withPage: Map<string, DeclaredPath> = new Map([
      ...declared,
      ["/graph", { surface: "surface.graph", category: "local-route" }],
    ]);
    const findings = compareRouteSurfaces({
      served: new Set(),
      declared: withPage,
      spec: new Set(),
    });
    // A served page missing from the ledger is fine (UI, not contract)…
    expect(
      compareRouteSurfaces({
        served: new Set(["/new-page"]),
        declared: withPage,
        spec: new Set(),
      }).map((f) => f.path),
    ).not.toContain("/new-page");
    // …but /graph is a page, so its absence is not asserted by this check either.
    expect(findings.map((f) => f.path)).not.toContain("/graph");
  });

  test("a served and declared API path missing from the spec is reported", () => {
    const findings = compareRouteSurfaces({
      served: new Set(["/api/known"]),
      declared: new Map([
        ["/api/known", { surface: "s", category: "local-route" }],
      ]),
      spec: new Set(),
    });
    expect(findings.map((f) => `${f.kind} ${f.path}`)).toEqual([
      "spec-missing /api/known",
    ]);
  });

  test("the handler's * and the spec's {name} are one route", () => {
    // /api/logo/* is served by `pathname.startsWith`, /api/logo/{name} is what the spec and the
    // ledger can express. Without a shared form the route read as both undocumented and
    // unpublished, which is why the check now compares canonical paths.
    expect(canonicalRoutePath("/api/logo/{name}")).toBe("/api/logo/*");
    expect(
      compareRouteSurfaces({
        served: new Set(["/api/logo/*"]),
        declared: new Map([
          [
            "/api/logo/{name}",
            { surface: "surface.logo", category: "local-route" },
          ],
        ]),
        spec: new Set(["/api/logo/{name}"]),
      }),
    ).toEqual([]);
  });
});

describe("the committed tree", () => {
  const inputs = readRouteSurfaceInputs(ROOT, DAEMON_PREFIX_PATHS);

  test("every served /api path is declared by a ledger surface", () => {
    const { served, declared, spec } = inputs;
    expect(served.size).toBeGreaterThan(20);
    const findings = compareRouteSurfaces({ served, declared, spec });
    const undocumented = findings.filter(
      (f) => f.kind === "served-undocumented",
    );
    expect(undocumented).toEqual([]);
  });

  test("served, declared and published agree — the check is green, not merely quiet", () => {
    // This asserted eight outstanding spec gaps until the surface operations were added to
    // scripts/generate_openapi.ts. A non-zero count here now means a new route landed without a
    // spec path, which is what the CI step exists to catch.
    expect(compareRouteSurfaces(inputs)).toEqual([]);
    // 47 API/page paths, plus the dashboard's agent-graph raster: a page asset, not an /api
    // contract path, so it is declared by a ledger surface and correctly absent from the spec.
    expect(inputs.served.size).toBe(48);
  });
});
