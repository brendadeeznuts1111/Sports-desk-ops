import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Ingress,
  peerIsTrusted,
  startServer,
} from "../services/sportsdesk_webview_server.ts";

/**
 * A unix socket has no peer address, and `isLoopbackAddress(null)` reads that as "local".
 *
 * That shortcut is right for `server.fetch()` and wrong for the deployment: the systemd unit
 * points the daemon at `/run/sportsdesk/webview.sock` and Nginx proxies the whole domain to it,
 * so every remote client arrived with `requestIP() === null` and every `pii` route answered 200.
 * Measured before the fix: `/api/live-bets` 3,250 B, `/api/agent-tree` 94,091 B, `/graph`
 * 654,893 B — no token, over the socket.
 *
 * So the ingress decides: a proxied listener trusts nothing unless the deployment says
 * `SPORTSDESK_TRUST_PROXY=1`.
 */

const DIRECT: Ingress = { proxied: false, trustProxy: false };
const PROXIED: Ingress = { proxied: true, trustProxy: false };
const PROXIED_TRUSTING: Ingress = { proxied: true, trustProxy: true };

describe("peerIsTrusted", () => {
  test("a direct listener trusts loopback and only loopback", () => {
    expect(peerIsTrusted(null, DIRECT)).toBe(true);
    expect(peerIsTrusted("127.0.0.1", DIRECT)).toBe(true);
    expect(peerIsTrusted("::1", DIRECT)).toBe(true);
    expect(peerIsTrusted("192.168.1.92", DIRECT)).toBe(false);
    expect(peerIsTrusted("203.0.113.9", DIRECT)).toBe(false);
  });

  test("a proxied listener trusts nothing, even a loopback peer", () => {
    expect(peerIsTrusted(null, PROXIED)).toBe(false);
    expect(peerIsTrusted("127.0.0.1", PROXIED)).toBe(false);
  });

  test("SPORTSDESK_TRUST_PROXY=1 hands the decision to the proxy", () => {
    expect(peerIsTrusted(null, PROXIED_TRUSTING)).toBe(true);
    expect(peerIsTrusted("203.0.113.9", PROXIED_TRUSTING)).toBe(true);
  });
});

const PII = ["/api/live-bets", "/api/live-wagers", "/api/agent-tree", "/graph"];

/** `Bun.env`/`process.env` properties are typed readonly; mutate through Reflect. */
function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else Reflect.set(process.env, key, value);
}

function socketFor(name: string): string {
  return join(tmpdir(), `sportsdesk-${name}-${process.pid}-${Date.now()}.sock`);
}

/** A request straight down the socket, which is how Nginx reaches the daemon. */
function overSocket(socket: string, path: string): Promise<Response> {
  return fetch(`http://localhost${path}`, { unix: socket } as RequestInit);
}

describe("proxied ingress requires the token", () => {
  const socket = socketFor("guard");
  const savedToken = process.env["SPORTSDESK_ADMIN_TOKEN"];
  const savedTrust = process.env["SPORTSDESK_TRUST_PROXY"];

  const server = (() => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    setEnv("SPORTSDESK_TRUST_PROXY", undefined);
    return startServer({ unix: socket });
  })();

  afterAll(() => {
    server.stop(true);
    setEnv("SPORTSDESK_ADMIN_TOKEN", savedToken);
    setEnv("SPORTSDESK_TRUST_PROXY", savedTrust);
  });

  test("the daemon reports the rule it is applying", async () => {
    const response = await overSocket(socket, "/health");
    const body = (await response.json()) as { ingress?: Ingress };
    expect(body.ingress).toEqual({ proxied: true, trustProxy: false });
  });

  for (const path of PII) {
    test(`${path} refuses a socket peer with no credential`, async () => {
      const response = await overSocket(socket, path);
      expect([401, 403, 503]).toContain(response.status);
    });
  }

  test("a public route still answers, so the refusal is the guard", async () => {
    const response = await overSocket(socket, "/api/sports");
    expect(response.status).toBe(200);
  });

  test("a wrong bearer is refused, not just an absent one", async () => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", "the-real-token");
    try {
      const response = await fetch(`http://localhost/api/live-bets`, {
        unix: socket,
        headers: { authorization: "Bearer not-the-token" },
      } as RequestInit);
      expect([401, 403, 503]).toContain(response.status);

      const ok = await fetch(`http://localhost/api/live-bets`, {
        unix: socket,
        headers: { authorization: "Bearer the-real-token" },
      } as RequestInit);
      expect(ok.status).toBe(200);
    } finally {
      setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    }
  });

  /**
   * The dashboard's read set, over the socket, with the token it now sends. This is the deploy
   * posture: Nginx is the only client of the socket, the daemon cannot see the browser, and the
   * page carries the credential instead.
   */
  test("every route the dashboard reads answers with the token", async () => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", "dashboard-token");
    try {
      const paths = [
        "/api/live-bets",
        "/api/game-admin",
        "/api/sports",
        "/api/scoreboard",
        "/api/analysis/reports",
        "/api/analysis/filters",
        "/api/sports/catalog",
        "/api/contests",
        "/api/live-wagers",
        "/api/agents/search?q=BI",
        "/api/game-admin/board",
      ];
      const refused: string[] = [];
      for (const path of paths) {
        const response = await fetch(`http://localhost${path}`, {
          unix: socket,
          headers: { authorization: "Bearer dashboard-token" },
        } as RequestInit);
        if ([401, 403, 503].includes(response.status)) {
          refused.push(`${path} -> ${response.status}`);
        }
        await response.body?.cancel();
      }
      expect(refused).toEqual([]);
    } finally {
      setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    }
  });
});

describe("SPORTSDESK_TRUST_PROXY=1 keeps the deployment's proxy as the boundary", () => {
  const socket = socketFor("trust");
  const savedToken = process.env["SPORTSDESK_ADMIN_TOKEN"];
  const savedTrust = process.env["SPORTSDESK_TRUST_PROXY"];

  const server = (() => {
    setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    setEnv("SPORTSDESK_TRUST_PROXY", "1");
    return startServer({ unix: socket });
  })();

  afterAll(() => {
    server.stop(true);
    setEnv("SPORTSDESK_ADMIN_TOKEN", savedToken);
    setEnv("SPORTSDESK_TRUST_PROXY", savedTrust);
  });

  test("the opt-in is visible on /health", async () => {
    const response = await overSocket(socket, "/health");
    const body = (await response.json()) as { ingress?: Ingress };
    expect(body.ingress).toEqual({ proxied: true, trustProxy: true });
  });

  test("a pii route answers the proxy without a token", async () => {
    const response = await overSocket(socket, "/api/live-bets");
    expect(response.status).toBe(200);
  });
});
