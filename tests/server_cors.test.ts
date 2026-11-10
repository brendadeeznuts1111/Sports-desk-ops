import { afterAll, describe, expect, test } from "bun:test";
import {
  DEV_DEFAULT_CORS_ORIGINS,
  resolveAllowedOrigins,
  startServer,
} from "../services/sportsdesk_webview_server.ts";

/**
 * `Access-Control-Allow-Origin: *` was on every response, including the PII ones.
 *
 * Measured before the fix: `GET /api/live-bets` with `Origin: https://evil.example` returned
 * 200, `ACAO: *`, 3,250 bytes. The browser equivalent is worse than the curl one: the guard
 * treats loopback as the operator, so a page on any site could read the operator's own wager
 * capture from the machine it runs on.
 *
 * Same-origin fetches (the dashboard, the Mini App) need no header, so the default is to send
 * none, and `SPORTSDESK_ALLOWED_ORIGINS` is the explicit grant.
 */

const ALLOWED = "https://desk.example";
/** `Bun.env`/`process.env` properties are typed readonly; mutate through Reflect. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, key);
  else Reflect.set(Bun.env, key, value);
}

const savedOrigins = Bun.env["SPORTSDESK_ALLOWED_ORIGINS"];
const savedToken = Bun.env["SPORTSDESK_ADMIN_TOKEN"];
setEnv("SPORTSDESK_ALLOWED_ORIGINS", ALLOWED);
setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  setEnv("SPORTSDESK_ALLOWED_ORIGINS", savedOrigins);
  setEnv("SPORTSDESK_ADMIN_TOKEN", savedToken);
});

describe("resolveAllowedOrigins", () => {
  test("production: empty env stays fail-closed", () => {
    expect(resolveAllowedOrigins(false, "")).toEqual([]);
    expect(resolveAllowedOrigins(false, undefined)).toEqual([]);
  });

  test("development: empty env includes DSH desktop and local dev hosts", () => {
    const origins = resolveAllowedOrigins(true, "");
    for (const origin of DEV_DEFAULT_CORS_ORIGINS) {
      expect(origins).toContain(origin);
    }
  });

  test("development: an explicit env list is not augmented", () => {
    expect(resolveAllowedOrigins(true, "https://desk.example")).toEqual([
      "https://desk.example",
    ]);
  });
});

describe("cross-origin reads are opt-in", () => {
  /** Stable 200 JSON route: `/health` and `/api/live-bets` legitimately answer 503 without upstream auth. */
  const probePath = "/api/status";

  test("a request with no Origin gets no grant", async () => {
    const response = await fetch(`${base}${probePath}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a foreign Origin gets no grant, even though the body is still served", async () => {
    const response = await fetch(`${base}${probePath}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(0);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    // The refusal is origin-dependent too, so a cache must not reuse it across origins.
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("a listed Origin is echoed back with Vary", async () => {
    const response = await fetch(`${base}${probePath}`, {
      headers: { origin: ALLOWED },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(response.headers.get("vary")).toBe("Origin");
  });

  test("preflight answers 204 and grants only listed origins", async () => {
    const allowed = await fetch(`${base}/api/live-bets`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED);

    const foreign = await fetch(`${base}/api/live-bets`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(204);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the security headers are unconditional", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
  });
});

describe("development CORS defaults on the wire", () => {
  const savedOrigins = Bun.env.SPORTSDESK_ALLOWED_ORIGINS;
  setEnv("SPORTSDESK_ALLOWED_ORIGINS", undefined);

  const devServer = startServer({
    port: 0,
    hostname: "127.0.0.1",
    development: true,
  });
  const devBase = `http://127.0.0.1:${devServer.port}`;

  afterAll(() => {
    devServer.stop(true);
    setEnv("SPORTSDESK_ALLOWED_ORIGINS", savedOrigins);
  });

  test("dsh-app://app is echoed when origins env is unset", async () => {
    const response = await fetch(`${devBase}/health`, {
      headers: { origin: "dsh-app://app" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "dsh-app://app",
    );
  });
});
