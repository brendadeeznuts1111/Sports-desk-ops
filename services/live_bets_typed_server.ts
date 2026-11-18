/**
 * @file live_bets_typed_server.ts
 * @description Typed `BunRequest` route slice for the v2 live-bets bridge:
 * branded bridge/wager identity, timing-safe session-cookie auth, a redacted
 * request audit view, and zero-copy binary POST ingest.
 *
 * The session token is passed in by the caller so this module never reads a
 * secret from the environment; the route table is a library for the service
 * and its tests, not a mounted daemon route.
 */

import { timingSafeEqual } from "node:crypto";
import type { BunRequest, Serve, Server } from "bun";
import type { Brand } from "../lib/brand.ts";

/** Wager number carried as a BigInt (Fantasy402/Partner118 wager identity). */
export type WagerNumber64 = Brand<bigint, "WagerNumber64">;
export type BridgeSourceId = "FANTASY_402" | "PARTNER_118";

/** Header names an audit view may report as present, but never their values. */
export const SENSITIVE_HEADER_NAMES = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "cf-access-jwt-assertion",
] as const;

type LiveBetsParams =
  Serve.ExtractRouteParams<"/api/v2/live-bets/:bridge/:wagerNumber">;

type TypedRouteHandler<T extends string, WS = undefined> = (
  req: BunRequest<T>,
  server: Server<WS>,
) => Response | Promise<Response>;

/** `BunRequest.url` is a string; slice pathname without a URL allocation. */
function pathnameOf(rawUrl: string): string {
  const scheme = rawUrl.indexOf("://");
  const pathStart = scheme === -1 ? 0 : rawUrl.indexOf("/", scheme + 3);
  if (pathStart === -1) return "/";
  const queryStart = rawUrl.indexOf("?", pathStart);
  return queryStart === -1
    ? rawUrl.slice(pathStart)
    : rawUrl.slice(pathStart, queryStart);
}

export class SanitizedRequestAuditView<T extends string> {
  readonly method: string;
  readonly pathname: string;
  readonly params: Serve.ExtractRouteParams<T>;
  readonly hasSessionCookie: boolean;
  readonly sensitiveHeadersPresent: readonly string[];
  readonly clientIpRedacted: "[REDACTED_IP]" | "UNAVAILABLE";

  constructor(req: BunRequest<T>, server: Server<unknown>) {
    this.method = req.method;
    this.pathname = pathnameOf(req.url);
    this.params = req.params as Serve.ExtractRouteParams<T>;
    this.hasSessionCookie = req.cookies.has("sd_session");
    this.sensitiveHeadersPresent = SENSITIVE_HEADER_NAMES.filter((name) =>
      req.headers.has(name),
    );
    this.clientIpRedacted = server.requestIP(req)
      ? "[REDACTED_IP]"
      : "UNAVAILABLE";
  }

  toJSON(): {
    readonly method: string;
    readonly pathname: string;
    readonly params: Serve.ExtractRouteParams<T>;
    readonly hasSessionCookie: boolean;
    readonly sensitiveHeadersPresent: readonly string[];
    readonly clientIp: "[REDACTED_IP]" | "UNAVAILABLE";
  } {
    // Header names only — never a value, never a raw address.
    return {
      method: this.method,
      pathname: this.pathname,
      params: this.params,
      hasSessionCookie: this.hasSessionCookie,
      sensitiveHeadersPresent: this.sensitiveHeadersPresent,
      clientIp: this.clientIpRedacted,
    };
  }

  [Bun.inspect.custom](
    depth: number,
    options: { colors?: boolean } = {},
  ): string {
    if (depth < 0) {
      return `[SanitizedBunRequest ${this.method} ${this.pathname}]`;
    }
    return `SanitizedBunRequest ${Bun.inspect(this.toJSON(), options)}`;
  }
}

function verifySessionDigest(
  candidate: string | null,
  expectedSecret: string,
): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expectedSecret, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function parseBridgeAndWager(
  params: LiveBetsParams,
): { bridge: BridgeSourceId; wagerNumber64: WagerNumber64 } | null {
  if (params.bridge !== "FANTASY_402" && params.bridge !== "PARTNER_118") {
    return null;
  }
  if (!/^\d{1,19}$/.test(params.wagerNumber)) return null;
  return {
    bridge: params.bridge,
    wagerNumber64: BigInt(params.wagerNumber) as WagerNumber64,
  };
}

/** Wrap a handler with the session-cookie guard while preserving route params. */
export function withAuthenticatedRoute<T extends string, WS = undefined>(
  expectedSessionToken: string,
  handler: TypedRouteHandler<T, WS>,
): TypedRouteHandler<T, WS> {
  return async (req, server) => {
    const cookieToken = req.cookies.get("sd_session") ?? null;
    if (!verifySessionDigest(cookieToken, expectedSessionToken)) {
      req.cookies.delete("sd_session", { path: "/" });
      return Response.json({ error: "ERR_AUTH_REJECTED" }, { status: 401 });
    }
    return handler(req, server);
  };
}

export const LIVE_BETS_ROUTE =
  "/api/v2/live-bets/:bridge/:wagerNumber" as const;

/**
 * Typed path builder for `Bun.serve({ routes })` literals. Each `:param` is
 * filled from the matching `Serve.ExtractRouteParams<R>` key and percent-encoded;
 * static routes or tail wildcards (which extract to `{}`) pass through.
 */
export function buildWagerPath<R extends string>(
  route: R,
  params: Serve.ExtractRouteParams<R>,
): string {
  // ExtractRouteParams infers any text up to the next "/" as the key.
  return route.replace(/:([^/]+)/g, (_match, key: string) =>
    encodeURIComponent(
      (params as Record<string, string | undefined>)[key] ?? "",
    ),
  );
}

export function startLiveBetsServer(
  expectedSessionToken: string,
  port = 0,
): Server<undefined> {
  return Bun.serve<undefined>({
    port,
    routes: {
      "/health": Response.json({ status: "ok" }),

      [LIVE_BETS_ROUTE]: {
        GET: withAuthenticatedRoute(
          expectedSessionToken,
          async (req: BunRequest<typeof LIVE_BETS_ROUTE>, server) => {
            const parsed = parseBridgeAndWager(req.params);
            if (!parsed) {
              return Response.json(
                { error: "ERR_INVALID_ROUTE_PARAMS" },
                { status: 400 },
              );
            }

            req.cookies.set("sd_session", expectedSessionToken, {
              httpOnly: true,
              secure: true,
              sameSite: "strict",
              path: "/",
              maxAge: 3600,
            });

            return Response.json({
              bridge: parsed.bridge,
              wagerNumber64: parsed.wagerNumber64.toString(),
              audit: new SanitizedRequestAuditView(req, server),
            });
          },
        ),

        POST: withAuthenticatedRoute(
          expectedSessionToken,
          async (req: BunRequest<typeof LIVE_BETS_ROUTE>) => {
            const payloadBytes = await req.bytes();
            if (payloadBytes.byteLength === 0) {
              return Response.json(
                { error: "ERR_EMPTY_FRAME" },
                { status: 400 },
              );
            }
            return Response.json(
              { ingestedBytes: payloadBytes.byteLength },
              { status: 202 },
            );
          },
        ),
      },
    },
    fetch() {
      return Response.json({ error: "ERR_ROUTE_NOT_FOUND" }, { status: 404 });
    },
    error(err) {
      console.error("[Bun.serve] Unhandled route fault:", err.message);
      return Response.json({ error: "ERR_INTERNAL" }, { status: 500 });
    },
  });
}
