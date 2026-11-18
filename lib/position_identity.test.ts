import { describe, expect, test } from "bun:test";
import { positionIdentity } from "./position_identity.ts";

describe("position identity", () => {
  test("a pending ticket is the key", () => {
    expect(
      positionIdentity({
        ticketNumber: "T-8001",
        wagerNumber: "1",
        source: "live-bets",
      }),
    ).toEqual({ key: "T-8001", refusal: null });
  });

  test("a pending row without a ticket is refused, even with wagerNumber 1", () => {
    expect(
      positionIdentity({
        ticketNumber: null,
        wagerNumber: "1",
        source: "live-bets",
      }),
    ).toEqual({ key: null, refusal: "null_ticket" });
  });

  test("a ticker row keys on its wager number", () => {
    expect(
      positionIdentity({
        wagerNumber: "769188271",
        source: "live-wagers",
      }),
    ).toEqual({ key: "769188271", refusal: null });
  });

  test("no ticket and no wager is a refusal, not an empty key", () => {
    expect(positionIdentity({ source: "live-wagers" })).toEqual({
      key: null,
      refusal: "null_wager",
    });
  });

  test("snake_case rows from the profile layer follow the same rule", () => {
    expect(
      positionIdentity({
        ticket_number: "T-9",
        wager_number: "1",
        source: "live-bets",
      }).key,
    ).toBe("T-9");
    expect(
      positionIdentity({
        ticket_number: undefined,
        wager_number: "1",
        source: "live-bets",
      }).refusal,
    ).toBe("null_ticket");
  });
});
