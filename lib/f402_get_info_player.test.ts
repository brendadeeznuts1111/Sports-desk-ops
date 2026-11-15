import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  auditPlayerRiskPosture,
  formatPlayerRiskPostureReport,
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
        mappedProxyWallet: "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
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

  test("audits XB142 wire payload with accounting identity and security posture flags", () => {
    const raw = {
      INFO: {
        data: {
          Login: "XB142",
          AgentID: "XBEER",
          AgentLogin: "XBEER",
          Active: "Y",
          CreditLimit: 1000000,
          CurrentBalance: -46651,
          PendingWagerBalance: 33500,
          PendingWagerCount: 2,
          CarryOverAmount: -124651,
          SettleFigure: 1000,
          WagerLimit: 250000,
          ParlayTeamMaxWager: 500000,
          ConfirmationDelay: 5,
          WiseLineMovementWeight: 1,
          InetTarget: "4playbets.com",
          AllowEZLive: "N",
          AllowNewLiveBetting: "N",
          AllowUltraLive: "Y",
          HalfPointInetBasketballFlag: "N",
          HalfPointInetFootballFlag: "N",
          ActivateBettingAlerts: "N",
          BasketballFlatPrice: 0,
          FootballFlatPrice: 0,
          SuspectedBot: "N",
          SuspectedBotType: 0,
          EncryptPassword: "N",
          Password: "mask",
          ParlayName: "8 Team Max - 300         ",
        },
        balance: {
          AvailableBalance: 919849,
        },
        added: {
          CustomerID: "XB142     ",
          NotifyTelegram: "N",
        },
        thisWeek: {
          PreviousBalance: -1246.51,
        },
      },
    };

    const envelope = parseGetInfoPlayerEnvelope(raw);
    const summary = summarizeGetInfoPlayer(envelope);
    expect(summary.customerId).toBe("XB142");
    expect(summary.agentId).toBe("XBEER");
    expect(summary.creditLimit).toBe(1000000);
    expect(summary.currentBalance).toBe(-46651);
    expect(summary.pendingWagerBalance).toBe(33500);
    expect(summary.availableBalance).toBe(919849);
    expect(summary.carryOverAmount).toBe(-124651);
    expect(summary.previousBalanceUsd).toBe(-1246.51);
    expect(summary.suspectedBot).toBe("N");
    expect(summary.suspectedBotType).toBe(0);
    expect(summary.basketballFlatPrice).toBe(0);
    expect(summary.footballFlatPrice).toBe(0);
    expect(summary.encryptPassword).toBe("N");
    expect(summary.plaintextPasswordExposed).toBe(true);
    expect(summary.mappedProxyWallet).toBeNull();

    const audit = auditPlayerRiskPosture(envelope);
    expect(audit.creditEquationBalanced).toBe(true);
    expect(audit.expectedAvailableBalanceCents).toBe(919849);
    expect(audit.creditEquationDeltaCents).toBe(0);
    expect(audit.carryOverParityMatched).toBe(true);
    expect(audit.carryOverParityDeltaCents).toBe(0);
    expect(audit.lineMoverWeightTier).toBe("DEFAULT_BASELINE_1");
    expect(audit.effectiveLiveBettingStatus).toBe(
      "ULTRA_LIVE_ENABLED_EZLIVE_OFF",
    );
    expect(audit.effectivePointBuyingStatus).toBe("DOW_SCHEDULE_OFF");
    expect(audit.riskFlags).toContain("PLAINTEXT_CREDENTIAL_EXPOSURE");
    expect(audit.riskFlags).toContain("LINE_MOVER_WEIGHT_ACTIVE");
    expect(audit.riskFlags).not.toContain("ELEVATED_LINE_MOVER_WEIGHT");
    expect(audit.riskFlags).toContain("BETTING_ALERTS_DISABLED");
    expect(audit.riskFlags).toContain("LIVE_INPLAY_RESTRICTED");
    expect(audit.riskFlags).toContain("HALF_POINT_BUY_RESTRICTED");
    expect(audit.riskFlags).toContain("HAS_PENDING_WAGERS");
    expect(audit.riskFlags).not.toContain("MAPPED_POLY_SYNDICATE_WALLET");
    expect(audit.riskFlags).not.toContain("CONTRACTUAL_FLAT_PRICE_ACTIVE");
    expect(audit.riskFlags).not.toContain("SUSPECTED_BOT_FLAGGED");
    expect(audit.riskFlags).not.toContain("HIGH_CONFIRMATION_DELAY_CLAMP");
  });

  test("flags cross-venue Polymarket proxy wallet attribution (BGD101)", () => {
    const raw = {
      INFO: {
        data: {
          Login: "BGD101",
          AgentID: "BIGDAD",
          Active: "Y",
          CreditLimit: 5000000,
          CurrentBalance: 0,
          PendingWagerBalance: 0,
          CarryOverAmount: 0,
          EncryptPassword: "Y",
        },
        balance: { AvailableBalance: 5000000 },
        added: { CustomerID: "BGD101" },
        thisWeek: { PreviousBalance: 0 },
      },
    };
    const envelope = parseGetInfoPlayerEnvelope(raw);
    const summary = summarizeGetInfoPlayer(envelope);
    expect(summary.mappedProxyWallet).toBe(
      "0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    );
    const audit = auditPlayerRiskPosture(envelope);
    expect(audit.riskFlags).toContain("MAPPED_POLY_SYNDICATE_WALLET");
  });

  test("flags bot, flat pricing contract, and confirmation delay clamp", () => {
    const raw = {
      INFO: {
        data: {
          Login: "BOT99",
          AgentID: "XBEER",
          Active: "Y",
          CreditLimit: 500000,
          CurrentBalance: 0,
          PendingWagerBalance: 0,
          CarryOverAmount: 0,
          ConfirmationDelay: 8,
          WiseLineMovementWeight: 0,
          ActivateBettingAlerts: "Y",
          BasketballFlatPrice: -105,
          FootballFlatPrice: 0,
          SuspectedBot: "Y",
          SuspectedBotType: 1,
          EncryptPassword: "Y",
        },
        balance: { AvailableBalance: 500000 },
        added: { CustomerID: "BOT99", NotifyTelegram: "Y" },
        thisWeek: { PreviousBalance: 0 },
      },
    };

    const envelope = parseGetInfoPlayerEnvelope(raw);
    const summary = summarizeGetInfoPlayer(envelope);
    expect(summary.suspectedBot).toBe("Y");
    expect(summary.suspectedBotType).toBe(1);
    expect(summary.basketballFlatPrice).toBe(-105);
    expect(summary.confirmationDelaySec).toBe(8);
    expect(summary.plaintextPasswordExposed).toBe(false);

    const audit = auditPlayerRiskPosture(envelope);
    expect(audit.riskFlags).toContain("SUSPECTED_BOT_FLAGGED");
    expect(audit.riskFlags).toContain("CONTRACTUAL_FLAT_PRICE_ACTIVE");
    expect(audit.riskFlags).toContain("HIGH_CONFIRMATION_DELAY_CLAMP");
    expect(audit.riskFlags).not.toContain("PLAINTEXT_CREDENTIAL_EXPOSURE");
  });

  test("formatPlayerRiskPostureReport renders comprehensive terminal report with decision overlay", () => {
    const raw = {
      INFO: {
        data: {
          Login: "XB142",
          AgentID: "XBEER",
          Active: "Y",
          CreditLimit: 1000000,
          CurrentBalance: -46651,
          PendingWagerBalance: 33500,
          PendingWagerCount: 2,
          CarryOverAmount: -124651,
          SettleFigure: 1000,
          WagerLimit: 250000,
          ConfirmationDelay: 5,
          WiseLineMovementWeight: 1,
          InetTarget: "4playbets.com",
          AllowEZLive: "N",
          AllowNewLiveBetting: "N",
          AllowUltraLive: "Y",
          AllowBuyPointsExtraGames: "Y",
          HalfPointInetFootballFlag: "N",
          EncryptPassword: "N",
        },
        balance: { AvailableBalance: 919849 },
        thisWeek: { PreviousBalance: -1246.51 },
      },
    };
    const envelope = parseGetInfoPlayerEnvelope(raw);
    const summary = summarizeGetInfoPlayer(envelope);
    const audit = auditPlayerRiskPosture(envelope);
    const report = formatPlayerRiskPostureReport(audit, summary, {
      decisionTier: "TIER_6_RECREATIONAL_HOLD",
      recommendedAction: "RETAIN_RECREATIONAL_HOLD",
      rankOverallSharp: 476,
      rankSystematicSignature: 925,
      totalBetsN: 50,
      powerStatus: "POWERED",
      correctedUnionRateShrunkKappa20: 0.2925,
      unionClvBhQValueAllCustomers: 1,
      estimatedNetEvAfterVigPct: -4.2,
      realizedPlayerNetUsd: -15.53,
      limitHeuristicScore: 0.1184,
      costRatioThresholdTau: 0.6026,
      systematicSignatureClass: "NONE_OBSERVED",
      minDistinctTicketGapSeconds: 18.54,
    });

    expect(report).toContain("F402 / DGS PLAYER PROFILE AUDIT REPORT");
    expect(report).toContain("Customer ID       : XB142");
    expect(report).toContain("Credit Limit      : $10,000.00");
    expect(report).toContain("Current Balance   : -$466.51");
    expect(report).toContain("Pending Wagers    : $335.00");
    expect(report).toContain("Available Balance : $9,198.49");
    expect(report).toContain("Credit Identity: BALANCED [OK]");
    expect(report).toContain("Carryover Parity: MATCHED [OK]");
    expect(report).toContain("Surveillance Proxy Wallet: UNMAPPED");
    expect(report).toContain("PLAINTEXT_CREDENTIAL_EXPOSURE");
    expect(report).toContain("[DEFAULT_BASELINE_1]");
    expect(report).toContain("[ULTRA_LIVE_ENABLED_EZLIVE_OFF]");
    expect(report).toContain("[EXTRA_GAMES_BUY_ENABLED_DOW_SCHEDULE_OFF]");
    expect(report).toContain("4. EMPIRICAL DECISION-INSTRUMENT TELEMETRY");
    expect(report).toContain("TIER_6_RECREATIONAL_HOLD");
  });
});
