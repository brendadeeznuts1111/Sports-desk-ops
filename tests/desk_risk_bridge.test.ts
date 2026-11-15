import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAuditEntries } from "../lib/audit_log.ts";
import {
  getLatestDeskRiskTelemetry,
  parseAsEpochMs,
  resetDeskRiskTelemetryForTests,
} from "../lib/desk-parser.ts";
import {
  buildArtifact,
  evaluatePendingExposureRisk,
  parseAsCents,
  type PendingRow,
} from "../lib/live_bets.ts";
import {
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

function makeLiveBetsArtifactJson(): string {
  const artifact = buildArtifact(
    [
      {
        TicketNumber: "998877",
        WagerNumber: "1",
        customerID: "CUST_RAW_77",
        WagerStatus: "P",
        Outcome: "P",
        WagerType: "S",
        AmountWagered: 50000,
        ToWinAmount: 45455,
        FinalMoney: -110,
        totalPicks: 1,
        Team1ID: "Arsenal",
        Team2ID: "Chelsea",
        ChosenTeamID: "Arsenal",
        Team1RotNum: 2001,
        Team2RotNum: 2002,
        AdjSpread: -0.5,
        Description: "Arsenal -0.5 from 203.0.113.42",
        SportType: "Soccer",
        SportSubType: "ENG PREM",
        GameDateTime: "2026-11-14 15:00:00.000",
        AcceptedDateTime: "2026-11-14 10:00:00.000",
      },
    ],
    {
      operation: "/cloud/api/Report/Pending",
      capturedAt: "2026-11-14T12:00:00.000Z",
      sourceKind: "capture",
    },
  );
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

afterEach(() => {
  stopBridgeHub();
  resetDeskRiskTelemetryForTests();
  setEnv("SPORTSDESK_AUDIT_DIR", prevEnv.SPORTSDESK_AUDIT_DIR);
  setEnv("SPORTSDESK_ADMIN_TOKEN", prevEnv.SPORTSDESK_ADMIN_TOKEN);
  setEnv("SPORTSDESK_TRUST_PROXY", prevEnv.SPORTSDESK_TRUST_PROXY);
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("desk risk bridge end-to-end signal honesty & peer sanitization", () => {
  test("evaluatePendingExposureRisk emits telemetry, provenance, and an audit_log entry", async () => {
    const dir = makeTempDir("desk-risk-e2e-");
    const auditDir = join(dir, "audit");
    const liveBetsPath = join(dir, "live-bets.json");
    writeFileSync(liveBetsPath, makeLiveBetsArtifactJson());

    setEnv("SPORTSDESK_AUDIT_DIR", auditDir);
    setEnv("SPORTSDESK_ADMIN_TOKEN", "test-admin-token");
    setEnv("SPORTSDESK_TRUST_PROXY", undefined);

    const rows: PendingRow[] = [
      {
        TicketNumber: "88001",
        WagerNumber: "1",
        customerID: "CUST_MAX_1",
        WagerStatus: "P",
        Outcome: "P",
        WagerType: "S",
        AmountWagered: 50000,
        ToWinAmount: 45455,
        FinalMoney: -110,
        totalPicks: 1,
        Team1ID: "Arsenal",
        Team2ID: "Chelsea",
        ChosenTeamID: "Arsenal",
        Team1RotNum: 2001,
        Team2RotNum: 2002,
        AdjSpread: -0.5,
      },
      {
        TicketNumber: "88002",
        WagerNumber: "1",
        customerID: "CUST_BAD_2",
        WagerStatus: "P",
        Outcome: "P",
        WagerType: "S",
        AmountWagered: 100.5,
        ToWinAmount: 10000,
        FinalMoney: -110,
        totalPicks: 1,
        Team1ID: "Lakers",
        Team2ID: "Celtics",
        ChosenTeamID: "Lakers",
        Team1RotNum: 501,
        Team2RotNum: 502,
        AdjSpread: -2.0,
      },
    ];

    const provenance = {
      sourceKind: "live" as const,
      dataWindowMaxEpochMs: parseAsEpochMs(1_763_120_000_000),
      r2PublishedAtEpochMs: parseAsEpochMs(1_763_120_005_000),
    };

    const bridged = evaluatePendingExposureRisk(
      rows,
      { maxStakeCents: parseAsCents(50000) },
      provenance,
    );

    expect(bridged.evaluation.pendingAtMax.length).toBe(1);
    expect(bridged.evaluation.degradedPending.length).toBe(1);
    expect(bridged.evaluation.requiresArsenalAlert).toBe(true);
    expect(bridged.telemetry.pendingAtMaxCount).toBe(1);
    expect(bridged.telemetry.degradedPendingCount).toBe(1);
    expect(bridged.telemetry.provenance).toEqual(provenance);
    expect(getLatestDeskRiskTelemetry()).toEqual(bridged.telemetry);

    const auditEntries = readAuditEntries({ category: "wager" });
    expect(auditEntries.length).toBe(1);
    expect(auditEntries[0]?.action).toBe("desk_risk_evaluated");
    expect(auditEntries[0]?.details).toEqual({
      pendingAtMaxCount: 1,
      degradedPendingCount: 1,
      requiresArsenalAlert: true,
      unresolvedGapCentsTotal: "0",
      sourceKind: "live",
      dataWindowMaxEpochMs: 1_763_120_000_000,
      r2PublishedAtEpochMs: 1_763_120_005_000,
    });
  });

  test("sanitizes /api/v1/live-bets and /api/v2/live-bets for untrusted proxied peers and preserves raw fields on trusted peers", async () => {
    const dir = makeTempDir("desk-risk-peer-");
    const liveBetsPath = join(dir, "live-bets.json");
    writeFileSync(liveBetsPath, makeLiveBetsArtifactJson());

    setEnv("SPORTSDESK_AUDIT_DIR", join(dir, "audit"));
    setEnv("SPORTSDESK_ADMIN_TOKEN", "test-admin-token");
    setEnv("SPORTSDESK_TRUST_PROXY", undefined);

    const untrustedServer = startServer({
      unix: join(dir, "untrusted.sock"),
      wagerListDir: dir,
      liveBetsPath,
      executionLedgerRoot: dir,
      liveRefresh: { enabled: false },
    });

    try {
      const authHeaders = { authorization: "Bearer test-admin-token" };
      const v1Res = await untrustedServer.fetch(
        new Request("http://localhost/api/v1/live-bets?source=file", {
          headers: authHeaders,
        }),
      );
      expect(v1Res.status).toBe(200);
      const v1Body = (await v1Res.json()) as {
        games: Array<{
          customerID: string;
          ticketNumber: string;
          ticketKey: string;
          description: string;
        }>;
      };
      expect(v1Body.games.length).toBe(1);
      const v1Game = v1Body.games[0]!;
      expect(v1Game.customerID).toMatch(/^cust_[0-9a-f]{12}$/);
      expect(v1Game.ticketNumber).toMatch(/^tkt_[0-9a-f]{12}$/);
      expect(v1Game.ticketKey).toMatch(/^tkt_[0-9a-f]{12}$/);
      expect(v1Game.description).toContain("[REDACTED_IP]");
      expect(v1Game.description).not.toContain("203.0.113.42");

      const v2Res = await untrustedServer.fetch(
        new Request("http://localhost/api/v2/live-bets?source=file", {
          headers: authHeaders,
        }),
      );
      expect(v2Res.status).toBe(200);
      expect(v2Res.headers.get("etag")).toMatch(/-0"$/);
      const v2Body = (await v2Res.json()) as {
        games: Array<{
          customerID: string;
          ticketNumber: string;
          ticketKey: string;
          description: string;
        }>;
      };
      expect(v2Body.games.length).toBe(1);
      const v2Game = v2Body.games[0]!;
      expect(v2Game.customerID).toMatch(/^cust_[0-9a-f]{12}$/);
      expect(v2Game.ticketNumber).toMatch(/^tkt_[0-9a-f]{12}$/);
      expect(v2Game.ticketKey).toMatch(/^tkt_[0-9a-f]{12}$/);
      expect(v2Game.description).toContain("[REDACTED_IP]");
      expect(v2Game.description).not.toContain("203.0.113.42");
    } finally {
      untrustedServer.stop(true);
    }

    setEnv("SPORTSDESK_TRUST_PROXY", "1");
    const trustedServer = startServer({
      unix: join(dir, "trusted.sock"),
      wagerListDir: dir,
      liveBetsPath,
      executionLedgerRoot: dir,
      liveRefresh: { enabled: false },
    });

    try {
      const v1Res = await trustedServer.fetch(
        new Request("http://localhost/api/v1/live-bets?source=file"),
      );
      expect(v1Res.status).toBe(200);
      const v1Body = (await v1Res.json()) as {
        games: Array<{
          customerID: string;
          ticketNumber: string;
          ticketKey: string;
          description: string;
        }>;
      };
      expect(v1Body.games.length).toBe(1);
      const v1Game = v1Body.games[0]!;
      expect(v1Game.customerID).toBe("CUST_RAW_77");
      expect(v1Game.ticketNumber).toBe("998877");
      expect(v1Game.ticketKey).toBe("998877-1");
      expect(v1Game.description).toContain("203.0.113.42");

      const v2Res = await trustedServer.fetch(
        new Request("http://localhost/api/v2/live-bets?source=file"),
      );
      expect(v2Res.status).toBe(200);
      expect(v2Res.headers.get("etag")).toMatch(/-1"$/);
      const v2Body = (await v2Res.json()) as {
        games: Array<{
          customerID: string;
          ticketNumber: string;
          ticketKey: string;
          description: string;
        }>;
      };
      expect(v2Body.games.length).toBe(1);
      const v2Game = v2Body.games[0]!;
      expect(v2Game.customerID).toBe("CUST_RAW_77");
      expect(v2Game.ticketNumber).toBe("998877");
      expect(v2Game.ticketKey).toBe("998877-1");
      expect(v2Game.description).toContain("203.0.113.42");
    } finally {
      trustedServer.stop(true);
    }
  });
});
