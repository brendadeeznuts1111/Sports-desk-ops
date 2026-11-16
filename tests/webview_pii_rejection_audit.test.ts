import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveAuditFilePath, readAuditEntries } from "../lib/audit_log.ts";
import {
  bridgeUpgradeRejection,
  startServer,
  stopBridgeHub,
} from "../services/sportsdesk_webview_server.ts";

const tempDirs: string[] = [];
const prevEnv = {
  SPORTSDESK_AUDIT_DIR: Bun.env.SPORTSDESK_AUDIT_DIR,
  SPORTSDESK_ADMIN_TOKEN: Bun.env.SPORTSDESK_ADMIN_TOKEN,
  SPORTSDESK_TRUST_PROXY: Bun.env.SPORTSDESK_TRUST_PROXY,
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, name);
  else Reflect.set(Bun.env, name, value);
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  stopBridgeHub();
  setEnv("SPORTSDESK_AUDIT_DIR", prevEnv.SPORTSDESK_AUDIT_DIR);
  setEnv("SPORTSDESK_ADMIN_TOKEN", prevEnv.SPORTSDESK_ADMIN_TOKEN);
  setEnv("SPORTSDESK_TRUST_PROXY", prevEnv.SPORTSDESK_TRUST_PROXY);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("webview piiRejection audit logging", () => {
  test("logs 503 and 401 HTTP rejections on /api/live-bets and /api/gslive/weblogs without raw tokens or PII", async () => {
    const dir = makeTempDir("wv-pii-audit-http-");
    const auditDir = join(dir, "audit");
    const socketPath = join(dir, "srv.sock");
    writeFileSync(join(dir, "live-bets.json"), "{}");
    setEnv("SPORTSDESK_AUDIT_DIR", auditDir);
    setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    setEnv("SPORTSDESK_TRUST_PROXY", undefined);

    const server = startServer({
      unix: socketPath,
      wagerListDir: dir,
      liveBetsPath: join(dir, "live-bets.json"),
      executionLedgerRoot: dir,
      liveRefresh: { enabled: false },
    });

    try {
      // 1) 503 when SPORTSDESK_ADMIN_TOKEN is unset over proxied unix ingress
      const resLive503 = await server.fetch(
        new Request("http://localhost/api/live-bets"),
      );
      expect(resLive503.status).toBe(503);

      const resWeblog503 = await server.fetch(
        new Request("http://localhost/api/gslive/weblogs"),
      );
      expect(resWeblog503.status).toBe(503);

      // 2) 401 with bad bearer token, cookie, and query token
      const expectedToken = "expected-admin-secret-value-001";
      const sentBadBearer = "attacker-bearer-secret-999";
      const sentCookie = "sd_session=raw-cookie-secret-777";
      setEnv("SPORTSDESK_ADMIN_TOKEN", expectedToken);

      const resLive401 = await server.fetch(
        new Request("http://localhost/api/live-bets?token=query-secret-888", {
          headers: {
            authorization: `Bearer ${sentBadBearer}`,
            cookie: sentCookie,
          },
        }),
      );
      expect(resLive401.status).toBe(401);

      const resWeblog401 = await server.fetch(
        new Request("http://localhost/api/gslive/weblogs", {
          headers: {
            authorization: `Bearer ${sentBadBearer}`,
          },
        }),
      );
      expect(resWeblog401.status).toBe(401);

      const entries = readAuditEntries({ category: "auth" });
      expect(entries.length).toBe(4);
      expect(
        entries.map((e) => [e.target, e.details?.status, e.details?.surface]),
      ).toEqual([
        ["/api/live-bets", 503, "http"],
        ["/api/gslive/weblogs", 503, "http"],
        ["/api/live-bets", 401, "http"],
        ["/api/gslive/weblogs", 401, "http"],
      ]);
      for (const entry of entries) {
        expect(entry.success).toBe(false);
        expect(entry.action).toBe("pii_rejection");
        expect(entry.details?.proxied).toBe(true);
      }

      const activeFile = getActiveAuditFilePath();
      expect(existsSync(activeFile)).toBe(true);
      const rawAudit = readFileSync(activeFile, "utf8");
      expect(rawAudit).not.toContain(expectedToken);
      expect(rawAudit).not.toContain(sentBadBearer);
      expect(rawAudit).not.toContain("raw-cookie-secret-777");
      expect(rawAudit).not.toContain("query-secret-888");
      expect(rawAudit).not.toContain("127.0.0.1");
    } finally {
      server.stop(true);
    }
  });

  test("logs 503 and 401 WS upgrade piiRejection outcomes without raw Sec-WebSocket-Protocol token or peer IP", () => {
    const dir = makeTempDir("wv-pii-audit-ws-");
    setEnv("SPORTSDESK_AUDIT_DIR", join(dir, "audit"));
    setEnv("SPORTSDESK_ADMIN_TOKEN", undefined);
    setEnv("SPORTSDESK_TRUST_PROXY", undefined);

    const remoteIp = "203.0.113.55";
    const wsToken = "ws-raw-bearer-secret-4242";
    const wsReqNoAuth = new Request("http://desk.example/api/live-bets", {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    const rej503 = bridgeUpgradeRejection(wsReqNoAuth, remoteIp, {
      proxied: false,
      trustProxy: false,
    });
    expect(rej503?.status).toBe(503);

    setEnv("SPORTSDESK_ADMIN_TOKEN", "valid-admin-token-002");
    const wsReqBadProto = new Request(
      "http://desk.example/api/live-bets?secret=leak-me",
      {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": `sportsdesk-v1, bearer.${wsToken}`,
        },
      },
    );
    const rej401 = bridgeUpgradeRejection(wsReqBadProto, remoteIp, {
      proxied: false,
      trustProxy: false,
    });
    expect(rej401?.status).toBe(401);

    const entries = readAuditEntries({ category: "auth" });
    expect(entries.length).toBe(2);
    expect(
      entries.map((e) => [e.target, e.details?.status, e.details?.surface]),
    ).toEqual([
      ["/api/live-bets", 503, "ws_upgrade"],
      ["/api/live-bets", 401, "ws_upgrade"],
    ]);

    const rawAudit = readFileSync(getActiveAuditFilePath(), "utf8");
    expect(rawAudit).not.toContain(wsToken);
    expect(rawAudit).not.toContain("valid-admin-token-002");
    expect(rawAudit).not.toContain("leak-me");
    expect(rawAudit).not.toContain(remoteIp);
  });
});
