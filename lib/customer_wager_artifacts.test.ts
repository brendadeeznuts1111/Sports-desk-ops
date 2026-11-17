import { describe, expect, test } from "bun:test";
import { tickerWagerRows } from "./customer_wager_artifacts.ts";

describe("ticker writer policy", () => {
  test("alert and blocked ticker rows are not returned as wagers", () => {
    const rows = tickerWagerRows({
      LIST: [
        {
          CustomerID: "C1",
          TicketWriter: "Internet",
          AmountWagered: 10000,
          ToWinAmount: 20000,
          WagerNumber: 1,
        },
        {
          CustomerID: "C1",
          TicketWriter: "ALERT     ",
          AmountWagered: 10000,
          ToWinAmount: 20000,
          WagerNumber: 2,
        },
        {
          CustomerID: "C1",
          TicketWriter: "blocked",
          AmountWagered: 10000,
          ToWinAmount: 20000,
          WagerNumber: 3,
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.writer).toBe("Internet");
  });
});
