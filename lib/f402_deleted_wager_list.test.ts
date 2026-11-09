import { describe, expect, test } from "bun:test";

import {
  dedupeDeletedWagerTargets,
  redactDeletedWagerEnvelope,
} from "./f402_deleted_wager_list.ts";

describe("f402_deleted_wager_list", () => {
  test("dedupes parlay legs to one ticket target", () => {
    const targets = dedupeDeletedWagerTargets([
      {
        TicketNumber: "1072976954",
        customerID: "BJ302     ",
        Login: "BJ302",
        DeleteDateTime: "2026-11-01 00:08:16.527",
        AmountWagered: "200.0",
        WagerType: "P",
        WagerCount: "6",
        totalPicks: "6",
        LoginID: "BUYOUT-BJ302",
        NameFirst: "Daymond Johnson",
        Password: "bonds",
      },
      {
        TicketNumber: "1072976954",
        customerID: "BJ302     ",
        Login: "BJ302",
        DeleteDateTime: "2026-11-01 00:08:16.527",
        AmountWagered: "200.0",
        WagerType: "P",
        WagerCount: "6",
        totalPicks: "6",
        LoginID: "BUYOUT-BJ302",
        NameFirst: "Daymond Johnson",
        Password: "bonds",
      },
    ] as never[]);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.legCount).toBe(2);
    expect(targets[0]?.customerId).toBe("BJ302");
  });

  test("redact strips Password and PCI cardholder data", () => {
    const redacted = redactDeletedWagerEnvelope({
      INFO: {
        LIST: [
          {
            TicketNumber: "1",
            Password: "secret",
            CCNumber: "4111222233334444",
            CCExpires: "12/28",
            CCApproval: "APP123",
          } as never,
        ],
      },
    });
    const row = redacted.INFO.LIST[0] as unknown as Record<string, unknown>;
    expect(row["Password"]).toBeUndefined();
    expect(row["CCNumber"]).toBeUndefined();
    expect(row["CCExpires"]).toBeUndefined();
    expect(row["CCApproval"]).toBeUndefined();
    expect(row["TicketNumber"]).toBe("1");
  });

  test("americanOddsToDecimal converts moneyline odds to multiplier", async () => {
    const { americanOddsToDecimal } =
      await import("./f402_deleted_wager_list.ts");
    expect(americanOddsToDecimal(150)).toBeCloseTo(2.5, 4);
    expect(americanOddsToDecimal(-110)).toBeCloseTo(1.9091, 4);
    expect(americanOddsToDecimal(-900)).toBeCloseTo(1.1111, 4);
    expect(americanOddsToDecimal(0)).toBeNull();
  });

  test("auditDeletedWagerEnvelope classifies buyouts and detects anomalies", async () => {
    const { auditDeletedWagerEnvelope } =
      await import("./f402_deleted_wager_list.ts");
    const envelope = {
      INFO: {
        LIST: [
          {
            TicketNumber: "1001",
            customerID: "GP301",
            Login: "GP301",
            WagerType: "P",
            totalPicks: "3",
            WagerCount: "3",
            AmountWagered: "100.0",
            ToWinAmount: "600.0",
            LoginID: "BUYOUT-GP301",
            Outcome: "W",
            FinalMoney: "-110",
            AcceptedDateTime: "2026-11-01 10:00:00",
            DeleteDateTime: "2026-11-01 18:00:00",
            GameDateTime: "2026-11-01 12:00:00",
            Odds: "-110",
          },
          {
            TicketNumber: "1001",
            customerID: "GP301",
            Login: "GP301",
            WagerType: "P",
            totalPicks: "3",
            WagerCount: "3",
            AmountWagered: "100.0",
            ToWinAmount: "600.0",
            LoginID: "BUYOUT-GP301",
            Outcome: "W",
            FinalMoney: "120",
            AcceptedDateTime: "2026-11-01 10:00:00",
            DeleteDateTime: "2026-11-01 18:00:00",
            GameDateTime: "2026-11-01 14:00:00",
            Odds: "120",
          },
          {
            TicketNumber: "1001",
            customerID: "GP301",
            Login: "GP301",
            WagerType: "P",
            totalPicks: "3",
            WagerCount: "3",
            AmountWagered: "100.0",
            ToWinAmount: "600.0",
            LoginID: "BUYOUT-GP301",
            Outcome: "P",
            AcceptedDateTime: "2026-11-01 10:00:00",
            DeleteDateTime: "2026-11-01 18:00:00",
            GameDateTime: "2026-11-01 20:00:00",
            Odds: "-110",
          },
        ],
      },
    };

    const audit = auditDeletedWagerEnvelope(envelope as never);
    expect(audit.uniqueTickets).toBe(1);
    expect(audit.buyoutTickets).toBe(1);
    expect(audit.deletedTickets).toBe(0);
    expect(audit.tickets[0]?.ticketNumber).toBe("1001");
    expect(audit.tickets[0]?.kind).toBe("BUYOUT");
    expect(audit.tickets[0]?.legBreakdown.won).toBe(2);
    expect(audit.tickets[0]?.legBreakdown.pendingAtDelete).toBe(1);
  });
});
