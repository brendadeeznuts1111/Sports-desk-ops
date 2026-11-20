/**
 * Which upstream answers a preview `/api/*` request.
 *
 * The daemon (:4020) owns the operational routes (`/api/alerts`, `/api/dns/*`, `/api/terminal/*`,
 * `/api/build-matrix`, …) but predates the React feed routes; those live in `packages/api`, served
 * by `bun run dev:api` (:4021). A preview can therefore point just the four feed reads at the
 * fixture API while everything else stays on the daemon — no CORS, because the browser only ever
 * talks to the preview origin.
 */
const FEED_PATHS: ReadonlySet<string> = new Set([
  "/api/agency/conduits",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/automations",
  "/api/bet-ticker",
  "/api/build-matrix",
  "/api/config/tiers",
  "/api/customers",
  "/api/daemon/status",
  "/api/dashboard",
  "/api/dns",
  "/api/gslive/verify-tickets",
  "/api/r2/image-provenance",
  "/api/r2/pipeline",
  "/api/r2/pipeline/history",
  "/api/shadow-pricing",
  "/api/shift/summary",
  "/api/taxonomy-catalog",
  "/api/terminal/exec",
  "/api/wagers",
  "/api/ws/status",
]);

/** Routes owned strictly by the daemon even when sharing a prefix with `FEED_PREFIXES`. */
const DAEMON_ONLY_PATHS: ReadonlySet<string> = new Set(["/api/agents/search"]);

/** Path families the React app calls under a parameter (`/api/alerts/:id/ack`). */
const FEED_PREFIXES: readonly string[] = [
  "/api/agent/",
  "/api/agents/",
  "/api/alerts",
  "/api/customer/",
  "/api/dns/",
  "/api/live-wagers",
  "/api/rankings/",
];

export type PreviewProxyTargets = {
  /** The daemon that answers most `/api/*` routes. */
  readonly api: string;
  /** Optional host serving the React feed routes; empty/undefined keeps everything on `api`. */
  readonly feedsApi?: string | undefined;
};

/** Choose the upstream for one request path. */
export function pickApiTarget(
  pathname: string,
  targets: PreviewProxyTargets,
): string {
  if (DAEMON_ONLY_PATHS.has(pathname)) {
    return targets.api;
  }
  if (targets.feedsApi) {
    if (FEED_PATHS.has(pathname)) return targets.feedsApi;
    if (FEED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
      return targets.feedsApi;
    }
  }
  return targets.api;
}
