/**
 * @file lib/http_auth.ts
 * @description HTTP authentication handlers, session cookie management, and requireSession middleware.
 * Shared by the dev dashboard (:4022) and core API daemon (:4020).
 */

import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionRotate,
  sessionVerify,
  sessionRevoke,
} from "./session.ts";

export {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  sessionRotate,
  sessionVerify,
  sessionRevoke,
};
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  issueCsrf,
  verifyCsrf,
} from "./csrf.ts";

export { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, issueCsrf, verifyCsrf };
import {
  getOperatorByUsername,
  recordFailedAttempt,
  touchLogin,
  updatePasswordHash,
} from "./db.ts";
import {
  attemptLogin,
  hashPassword,
  needsRehash,
  verifyPassword,
  type LoginResult,
} from "./auth.ts";
import { auditAuth } from "./audit_log.ts";

const isLocal = (host: string): boolean =>
  host === "localhost" || host === "127.0.0.1" || host === "::1";

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
};

export const clientIp = (
  req: Request,
  server?: { requestIP?: (req: Request) => { address: string } | null },
): string => {
  if (Bun.env.TRUST_PROXY === "1") {
    return (
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown"
    );
  }
  const directIp = server?.requestIP?.(req)?.address;
  if (directIp) return directIp;
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "127.0.0.1"
  );
};

export const sessionCookie = (token: string, secure: boolean): string =>
  [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");

export const clearCookie = (): string =>
  `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;

export const json = (
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

// ── POST /api/auth/login ────────────────────────────────────────────────────
export const handleLogin = async (
  req: Request,
  server?: { requestIP?: (req: Request) => { address: string } | null },
): Promise<Response> => {
  const ip = clientIp(req, server);
  let body: { username?: unknown; password?: unknown };
  try {
    body = (await req.json()) as { username?: unknown; password?: unknown };
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  if (!username || !password)
    return json(400, { error: "missing_credentials" });

  const outcome: LoginResult = await attemptLogin(ip, username, password, {
    getOperatorByUsername,
    hashPassword,
    touchLogin,
    verifyPassword,
    needsRehash,
    recordFailedAttempt,
  });

  if (outcome.kind === "rate_limited") {
    auditAuth({
      action: "login_failed",
      success: false,
      username,
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      reason: "rate_limited",
    });
    return json(
      429,
      { error: "rate_limited" },
      {
        "retry-after": String(Math.ceil(outcome.retryAfterMs / 1000)),
      },
    );
  }
  if (outcome.kind !== "ok") {
    auditAuth({
      action: "login_failed",
      success: false,
      username,
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      reason: outcome.kind,
    });
    return json(401, { error: outcome.kind });
  }

  // Rehash-on-login: persist upgraded PHC if attemptLogin flagged it
  const op = await getOperatorByUsername(username);
  if (!op) {
    auditAuth({
      action: "login_failed",
      success: false,
      username,
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      reason: "invalid_credentials",
    });
    return json(401, { error: "invalid_credentials" });
  }

  if (outcome.rehash) {
    await updatePasswordHash(op.id, outcome.newHash);
  }

  const { token, expiresAt } = await sessionRotate(
    null,
    op.id,
    ip,
    req.headers.get("user-agent") ?? undefined,
  );

  auditAuth({
    action: "login_success",
    success: true,
    username,
    operatorId: op.id,
    ip,
    userAgent: req.headers.get("user-agent") ?? undefined,
    details: { rehash: outcome.rehash, role: op.role },
  });

  const csrf = issueCsrf();
  const secure = !isLocal(new URL(req.url).hostname);
  const res = json(
    200,
    { expiresAt, rehash: outcome.rehash, csrfToken: csrf },
    { "set-cookie": sessionCookie(token, secure) },
  );

  // Second Set-Cookie for CSRF (Not HttpOnly so SPA can read it from document.cookie)
  res.headers.append(
    "set-cookie",
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`,
  );
  return res;
};

// ── POST /api/auth/logout ───────────────────────────────────────────────────
export const handleLogout = async (
  req: Request,
  revokeSession = sessionRevoke,
): Promise<Response> => {
  const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE_NAME];
  if (token) await revokeSession(token);
  auditAuth({
    action: "logout",
    success: true,
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
  });
  const res = new Response(null, {
    status: 204,
    headers: { "set-cookie": clearCookie() },
  });
  res.headers.append(
    "set-cookie",
    `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0`,
  );
  return res;
};

// ── GET /api/auth/me ────────────────────────────────────────────────────────
export const handleSessionMe = async (
  req: Request,
  verifySession = sessionVerify,
): Promise<Response> => {
  return requireSession(
    req,
    async ({ operator, session }) => {
      return json(200, { operator, session });
    },
    verifySession,
  );
};

// ── Middleware: require an active session ───────────────────────────────────
export interface AuthedContext {
  operator: NonNullable<Awaited<ReturnType<typeof sessionVerify>>>["operator"];
  session: NonNullable<Awaited<ReturnType<typeof sessionVerify>>>["session"];
}

export const requireSession = async (
  req: Request,
  next: (ctx: AuthedContext) => Promise<Response>,
  verifySession = sessionVerify,
): Promise<Response> => {
  const token = parseCookies(req.headers.get("cookie"))[SESSION_COOKIE_NAME];
  if (!token) return json(401, { error: "unauthenticated" });
  const verified = await verifySession(token);
  if (!verified) {
    return new Response(JSON.stringify({ error: "unauthenticated" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "set-cookie": clearCookie(),
      },
    });
  }
  return next(verified);
};

// ── Middleware: require double-submit CSRF protection on mutating requests ──
export const requireCsrf = async (
  req: Request,
  next: () => Promise<Response>,
  verifyCsrfFn = verifyCsrf,
): Promise<Response> => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const cookies = parseCookies(req.headers.get("cookie"));
    const cookieToken = cookies[CSRF_COOKIE_NAME];
    const headerToken = req.headers.get(CSRF_HEADER_NAME);
    if (
      !cookieToken ||
      !headerToken ||
      cookieToken !== headerToken ||
      !verifyCsrfFn(headerToken)
    ) {
      return json(403, { error: "csrf_failed" });
    }
  }
  return next();
};
