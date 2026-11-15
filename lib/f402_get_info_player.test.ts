import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditPlayerRiskPosture,
  parseGetInfoPlayerEnvelope,
  parseGetInfoPlayerProbe,
  redactGetInfoPlayer,
  summarizeGetInfoPlayer,
  trimPaddedId,
} from "./f402_get_info_player.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-get-info-player-minimal.json",
);

describe("getInfoPlayer envelope", () => {
  test("parses INFO.data / balance / parlaySpecs", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const env = parseGetInfoPlayerEnvelope(raw);
    expect(env.INFO.data.AgentType).toBe("M");
    expect(env.INFO.parlaySpecs).toHaveLength(2);
  });

  test("summarize trims padded Login and CustomerID", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const summary = summarizeGetInfoPlayer(parseGetInfoPlayerEnvelope(raw));
    expect(trimPaddedId("BILLY666  ")).toBe("BILLY666");
    expect(summary.customerId).toBe("BILLY666");
    expect(summary.login).toBe("BILLY666");
    expect(summary.assignedParlayName).toBe("8 Team Max");
    expect(summary.parlaySpecCount).toBe(2);
    expect(summary.agentType).toBe("M");
  });

  test("redactGetInfoPlayer removes password and PII fields", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    raw.INFO.data.NameFirst = "Fixture Name";
    raw.INFO.data.HomePhone = "555-0100";
    raw.INFO.data.email = "fixture@example.test";
    raw.INFO.data.address = "1 Fixture Way";
    raw.INFO.data.PlayerNotes = "fixture note";
    raw.INFO.added.TelegramID = "fixture-telegram";
    const env = parseGetInfoPlayerEnvelope(raw);
    const redacted = redactGetInfoPlayer(env);
    expect(redacted.INFO.data.Password).toBe("<redacted>");
    expect(redacted.INFO.data.Passwordt).toBe("<redacted>");
    expect(redacted.INFO.data.NameFirst).toBe("<redacted>");
    expect(redacted.INFO.data.HomePhone).toBe("<redacted>");
    expect(redacted.INFO.data.email).toBe("<redacted>");
    expect(redacted.INFO.data.address).toBe("<redacted>");
    expect(redacted.INFO.data.PlayerNotes).toBe("<redacted>");
    expect(redacted.INFO.added?.TelegramID).toBe("<redacted>");
    expect(redacted.INFO.added?.CustomerID).toBe("BILLY666  ");
  });

  test("rejects missing INFO.data", () => {
    expect(() => parseGetInfoPlayerEnvelope({ INFO: {} })).toThrow("INFO.data");
  });

  test("the probe treats INFO:null as player-not-found", () => {
    expect(parseGetInfoPlayerProbe({ INFO: null })).toEqual({ found: false });
    expect(() => parseGetInfoPlayerProbe({ INFO: true })).toThrow("INFO");
  });

  test("the probe summary carries the identity fields", () => {
    const probe = parseGetInfoPlayerProbe({
      INFO: {
        data: {
          Login: "BGD101   ",
          AgentID: "BIGDAD   ",
          AgentLogin: "BIGDAD",
          Status: "Active",
        },
        added: { CustomerID: "BGD101    " },
      },
    });
    expect(probe).toMatchObject({
      found: true,
      summary: {
        customerId: "BGD101",
        login: "BGD101",
        agentId: "BIGDAD",
        agentLogin: "BIGDAD",
        status: "Active",
      },
    });
  });

  test("summarizes player-level credit/balance identity, carryover USD/cents parity, and risk flags (BRT106 shape, redacted)", () => {
    const probe = parseGetInfoPlayerProbe({
      INFO: {
        data: {
          Login: "BRT106",
          AgentID: "BGMASTER",
          AgentLogin: "BGMASTER",
          AgentType: null,
          Active: "Y",
          CreditLimit: 7500000,
          CurrentBalance: -205000,
          PendingWagerBalance: 2560000,
          PendingWagerCount: 4,
          CarryOverAmount: 7932500,
          SettleFigure: 25000,
          WagerLimit: 1000000,
          ConfirmationDelay: 3,
          WiseLineMovementWeight: 1,
          InetTarget: "DeltaDuke.com",
          AllowEZLive: "N",
          AllowNewLiveBetting: "N",
          HalfPointInetBasketballFlag: "N",
          HalfPointInetFootballFlag: "N",
          ActivateBettingAlerts: "N",
          ParlayName: "8 Team Max - 300         ",
        },
        balance: {
          AvailableBalance: 4735000,
        },
        added: {
          CustomerID: "BRT106    ",
          NotifyTelegram: "N",
        },
        thisWeek: {
          PreviousBalance: 79325,
        },
        parlaySpecs: [],
      },
    });

    expect(probe.found).toBe(true);
    if (!probe.found) return;
    const s = probe.summary;
    expect(s.customerId).toBe("BRT106");
    expect(s.agentId).toBe("BGMASTER");
    expect(s.creditLimit).toBe(7500000);
    expect(s.currentBalance).toBe(-205000);
    expect(s.pendingWagerBalance).toBe(2560000);
    expect(s.availableBalance).toBe(4735000);
    // Exact credit-line accounting identity: CreditLimit + CurrentBalance - PendingWagerBalance === AvailableBalance
    expect(s.creditLimit! + s.currentBalance! - s.pendingWagerBalance!).toBe(
      s.availableBalance!,
    );
    // CarryOverAmount is in cents (7932500) while thisWeek.PreviousBalance is in whole USD (79325)
    expect(s.carryOverAmount).toBe(7932500);
    expect(s.previousBalanceUsd).toBe(79325);
    expect(s.carryOverAmount! / 100).toBe(s.previousBalanceUsd!);
    expect(s.settleFigureUsd).toBe(25000);
    expect(s.wagerLimit).toBe(1000000);
    expect(s.pendingWagerCount).toBe(4);
    expect(s.confirmationDelaySec).toBe(3);
    expect(s.wiseLineMovementWeight).toBe(1);
    expect(s.inetTarget).toBe("DeltaDuke.com");
    expect(s.allowEzLive).toBe("N");
    expect(s.activateBettingAlerts).toBe("N");
    expect(s.notifyTelegram).toBe("N");
    expect(s.assignedParlayName).toBe("8 Team Max - 300");

    const audit = auditPlayerRiskPosture(probe.envelope);
    expect(audit.creditEquationBalanced).toBe(true);
    expect(audit.expectedAvailableBalanceCents).toBe(4735000);
    expect(audit.creditEquationDeltaCents).toBe(0);
    expect(audit.carryOverParityMatched).toBe(true);
    expect(audit.carryOverParityDeltaCents).toBe(0);
    expect(audit.riskFlags).toEqual([
      "LINE_MOVER_WEIGHT_ACTIVE",
      "BETTING_ALERTS_DISABLED",
      "LIVE_INPLAY_RESTRICTED",
      "HALF_POINT_BUY_RESTRICTED",
      "HAS_PENDING_WAGERS",
    ]);

    // Verify formatted string PreviousBalance ("79,325.00") coerces cleanly and mismatch flags anomaly
    const formattedPrev = parseGetInfoPlayerEnvelope({
      INFO: {
        data: { Login: "BRT106", CarryOverAmount: 7932500 },
        thisWeek: { PreviousBalance: "79,325.00" },
      },
    });
    expect(summarizeGetInfoPlayer(formattedPrev).previousBalanceUsd).toBe(
      79325,
    );
    expect(auditPlayerRiskPosture(formattedPrev).carryOverParityMatched).toBe(
      true,
    );

    const mismatchedPrev = parseGetInfoPlayerEnvelope({
      INFO: {
        data: { Login: "BRT106", CarryOverAmount: 7932500 },
        thisWeek: { PreviousBalance: 79000 },
      },
    });
    const mismatchAudit = auditPlayerRiskPosture(mismatchedPrev);
    expect(mismatchAudit.carryOverParityMatched).toBe(false);
    expect(mismatchAudit.carryOverParityDeltaCents).toBe(32500);
    expect(mismatchAudit.riskFlags).toContain(
      "CARRYOVER_PREVIOUS_BALANCE_MISMATCH",
    );
  });
});
