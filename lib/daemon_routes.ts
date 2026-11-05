/**
 * The daemon's routes, as data, with the property that matters encoded in the type.
 *
 * A route either has a guard — `admin`, `pii`, `telegram-secret` — or it is public, and a
 * public route may not carry customer-identifying data. That pairing is the whole point: the
 * earlier sketch of this table proposed labelling `/live-bets`, `/status` and `/miniapp` as
 * `proxy-auth`, which would have recorded protection the process does not have (each answers
 * 200 to a wrong bearer; nothing in this repo implements proxy auth).
 *
 * `dataClass` is what forces the question. It is not cosmetic: `/health` and `/api/status`
 * return uptime, memory, pid, bind address and NODE_ENV, so "public" there is a deliberate
 * operational choice rather than "static"; `/` and `/dashboard` show book totals (from
 * `/api/kpis`), so they are `aggregate`, not `static`; `/api/live-bets` and `/api/agent-tree` carry logins
 * and are `customer-identifying`, which is why they must be `pii`.
 *
 * tests/daemon_routes.test.ts keeps the table honest in both directions against the handler, and
 * asserts the runtime shadow of the type rule — a public route whose response carries customer
 * identifiers — because types are erased.
 */
export type Guard = "none" | "admin" | "pii" | "telegram-secret";

/** Alias kept for imports that read better as "which guard does this route have". */
export type RouteGuard = Guard;

export type DataClass =
  /** markup or assets whose data arrives from a guarded API */
  | "static"
  /** derived totals with no identifiers */
  | "aggregate"
  /** process telemetry: uptime, memory, pid, bind address, env */
  | "operational"
  /** logins, customer ids, wagers */
  | "customer-identifying";

export type RouteBase = {
  readonly path: string;
  readonly method: "ANY" | "GET" | "POST";
  /** The ledger surface that owns this path, or null where none declares it yet. */
  readonly surface: string | null;
  readonly dataClass: DataClass;
};

export type GuardedRoute = RouteBase & {
  readonly guard: Exclude<Guard, "none">;
};

/** A public route may be static, aggregate or operational — never customer-identifying. */
export type PublicRoute = RouteBase & {
  readonly guard: "none";
  readonly dataClass: Exclude<DataClass, "customer-identifying">;
};

export type DaemonRoute = GuardedRoute | PublicRoute;

/** Identity at runtime; the value is the checking. `const` keeps the literals rather than widening. */
export function defineRoute<const R extends DaemonRoute>(route: R): R {
  return route;
}

export const DAEMON_ROUTES: readonly DaemonRoute[] = [
  defineRoute({
    path: "/",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/agent-graph.webp",
    method: "ANY",
    // A rendering of the graph `/graph` serves: the node labels are logins.
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/agent-tree",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-agent-tree",
  }),
  defineRoute({
    path: "/api/agents/search",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-agent-search",
  }),
  defineRoute({
    path: "/api/analysis",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-analysis",
  }),
  defineRoute({
    path: "/api/analysis/filters",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-analysis",
  }),
  defineRoute({
    path: "/api/analysis/reports",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-analysis",
  }),
  defineRoute({
    path: "/api/contests",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-contests",
  }),
  defineRoute({
    path: "/combo-uniqueness.json",
    method: "ANY",
    guard: "admin",
    dataClass: "aggregate",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/cross-domain-bridge.json",
    method: "ANY",
    guard: "admin",
    dataClass: "aggregate",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/execution/mode",
    method: "POST",
    guard: "pii",
    // Changes the paper/live state of the execution engine and audits it.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/execution/plan",
    method: "GET",
    guard: "pii",
    // Decisions carry watchlist logins/risk and venue books; same plane as the signals route.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/execution/run",
    method: "POST",
    guard: "pii",
    // Mutates paper state (and could place live orders behind the gate); pii like the plan.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/f402/get-pending",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: "surface.daemon-live-bets",
  }),
  defineRoute({
    path: "/api/game-admin",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-game-admin",
  }),
  defineRoute({
    path: "/api/game-admin/board",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-game-admin-board",
  }),
  defineRoute({
    path: "/api/graph-feed",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/graph/stream",
    method: "GET",
    guard: "pii",
    // Server-sent frames carry the summary, whose catalog names agent-graph surfaces and whose
    // bridge values come from captures; the guard is the page's own, on the same plane.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/graph/summary",
    method: "GET",
    guard: "pii",
    // The envelope carries route surfaces and capture provenance, and `/graph` itself is
    // customer-identifying; keeping one guard for the whole graph plane avoids a second policy.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/gslive/weblogs",
    method: "GET",
    guard: "pii",
    // Account logins, archetypes and audit flags from the GSLive WebLog artifact.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/gslive/session-health",
    method: "GET",
    guard: "pii",
    // Credential provenance and cookie-only probe status; no cookie value leaves the daemon.
    dataClass: "operational",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/kpis",
    method: "ANY",
    guard: "none",
    // Counts and sums from lib/desk_kpis.ts; no login, customer id or agent key.
    dataClass: "aggregate",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/live-bets",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-live-bets",
  }),
  defineRoute({
    path: "/api/live-bets/summary",
    method: "ANY",
    guard: "pii",
    // Not `aggregate`: `summary.byAgent` is keyed by agent login, so the totals carry an
    // identifier even though the numbers themselves are sums.
    dataClass: "customer-identifying",
    surface: "surface.daemon-live-bets",
  }),
  defineRoute({
    path: "/api/live-wagers",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-live-wagers",
  }),
  defineRoute({
    path: "/api/parse-formdata",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-xml",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-customer-profile",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-customer-performance",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-transactions",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-ajax-xml",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-fantasy402-ajax",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-toml",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/parse-bet-ticker",
    method: "POST",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/scoreboard",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-scoreboard",
  }),
  defineRoute({
    path: "/api/signals/kalshi",
    method: "GET",
    guard: "pii",
    // Watchlist account logins, agent owners and their risk sit in each signal; the market
    // prices are public but the flow that produced the signal is not.
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/sports",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-sports-taxonomy",
  }),
  defineRoute({
    path: "/api/sports/catalog",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-sport-catalog",
  }),
  defineRoute({
    path: "/api/status",
    method: "GET",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/api/telegram/activity",
    method: "GET",
    guard: "admin",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/telegram/alert",
    method: "POST",
    guard: "admin",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/telegram/report",
    method: "POST",
    guard: "admin",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/telegram/status",
    method: "GET",
    guard: "admin",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/telegram/webhook",
    method: "POST",
    guard: "admin",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/test/error",
    method: "ANY",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/api/watchlist",
    method: "ANY",
    guard: "admin",
    dataClass: "customer-identifying",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  defineRoute({
    path: "/dashboard",
    method: "ANY",
    guard: "none",
    dataClass: "aggregate",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/graph",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: null,
  }),
  defineRoute({
    path: "/graph-live-feed.json",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/graph.html",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: null,
  }),
  defineRoute({
    path: "/graph.js",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: null,
  }),
  defineRoute({
    path: "/graph/",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: null,
  }),
  defineRoute({
    path: "/health",
    method: "ANY",
    guard: "none",
    dataClass: "operational",
    surface: null,
  }),
  defineRoute({
    path: "/live-bets",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: null,
  }),
  defineRoute({
    path: "/live-bets/summary",
    method: "ANY",
    guard: "pii",
    // Same body as `/api/live-bets/summary`, reached by the older path.
    dataClass: "customer-identifying",
    surface: null,
  }),
  defineRoute({
    path: "/miniapp",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: "surface.daemon-miniapp",
  }),
  defineRoute({
    path: "/miniapp/",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: "surface.daemon-miniapp",
  }),
  defineRoute({
    path: "/status",
    method: "ANY",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/status.json",
    method: "GET",
    guard: "none",
    dataClass: "operational",
    surface: "surface.daemon-dashboard",
  }),
  defineRoute({
    path: "/status/",
    method: "ANY",
    guard: "none",
    dataClass: "operational",
    surface: null,
  }),
  defineRoute({
    path: "/surveillance-graph",
    method: "ANY",
    guard: "pii",
    dataClass: "customer-identifying",
    surface: null,
  }),
  defineRoute({
    path: "/telegram/webhook",
    method: "POST",
    guard: "telegram-secret",
    dataClass: "operational",
    surface: "surface.daemon-telegram-admin-routes",
  }),
  // The ops tracker (tasks, PRs, secret inventory). `pii`, not `admin`: it is a page a browser
  // navigates to, so it cannot carry a bearer header; loopback reads it and any other peer needs the
  // token. Secret *names* and sources only, never values. Not available on the VPS (no gh/git there).
  defineRoute({
    path: "/tracker",
    method: "GET",
    guard: "pii",
    dataClass: "operational",
    surface: null,
  }),
];

/** Paths only, for the surface comparison. */
export const DAEMON_PATHS: readonly string[] = DAEMON_ROUTES.map(
  (route) => route.path,
);

/**
 * Surfaces answered by `pathname.startsWith`, which the literal-chain extractor cannot see.
 *
 * They are rows in the same sense — same guard, same data class — but they are kept apart so a
 * test can compare the exact-path table against the chain without pretending a prefix is a path.
 * `/assets/` is the graph page's asset directory; `/api/logo/` proxies team logos from the CDN.
 * Both are static by construction: the asset handler refuses anything outside `docs/assets`, and
 * the logo handler only ever returns image bytes.
 */
export const DAEMON_PREFIX_ROUTES: readonly DaemonRoute[] = [
  defineRoute({
    path: "/assets/*",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: "surface.daemon-graph-data-plane",
  }),
  defineRoute({
    path: "/api/logo/*",
    method: "ANY",
    guard: "none",
    dataClass: "static",
    surface: "surface.daemon-logo-proxy",
  }),
];

export const DAEMON_PREFIX_PATHS: readonly string[] = DAEMON_PREFIX_ROUTES.map(
  (route) => route.path,
);
