import { expect, test } from "bun:test";
import { captureGradedWagers } from "../scripts/capture_graded_wagers.ts";

const capturedAt = Date.parse("2026-11-20T02:30:00Z");
const snapshot = {
  capturedAt: new Date(capturedAt).toISOString(),
  dataSource: "live:test",
  games: [{ customerID: " ACCT " }, { customerID: "acct" }],
};
const wire = {
  CustomerID: "ACCT",
  TicketNumber: 123,
  WagerNumber: 2,
  WagerStatus: "W",
  AcceptedDateTime: "2026-11-19 20:01:00.000",
  AmountWagered: 1000,
  AmountWon: 900,
  AmountLost: 0,
  AmountRefunded: 0,
  FreePlayFlag: "N",
  Password: "must-be-stripped",
};

test("captures one report per account and retains only projected observations", async () => {
  const options = {
    snapshot,
    capturedAt,
    agentId: "AGENT",
    fetchReport: async (body: string) => {
      expect(JSON.parse(body)).toMatchObject({
        customerID: "ACCT",
        date: "2026-11-19",
        figureDate: "2026-11-13",
        graded: 1,
      });
      return Response.json({ LIST: { INFO: [wire, wire] } });
    },
  };
  const first = await captureGradedWagers({ ...options, previous: [] });
  expect(first.coverage).toMatchObject({
    addedObservations: 1,
    requestedAccounts: 1,
    wholeBookComplete: false,
  });
  expect(first.retained[0]).toMatchObject({
    TicketNumber: "123",
    WagerNumber: "2",
    AmountWon: 900,
  });
  expect(first.retained[0]).not.toHaveProperty("Password");
  const second = await captureGradedWagers({
    ...options,
    previous: first.retained,
  });
  expect(second.coverage.addedObservations).toBe(0);
});

test("rejects stale selections, malformed reports and wrong-account rows", async () => {
  const options = { snapshot, capturedAt, agentId: "AGENT", previous: [] };
  const fetchReport = async () => Response.json({ LIST: null });
  await expect(
    captureGradedWagers({ ...options, fetchReport }),
  ).rejects.toThrow();
  await expect(
    captureGradedWagers({
      ...options,
      capturedAt: capturedAt + 3_600_001,
      fetchReport,
    }),
  ).rejects.toThrow("recent live pending snapshot");
  await expect(
    captureGradedWagers({
      ...options,
      fetchReport: async () =>
        Response.json({ LIST: { INFO: [{ ...wire, CustomerID: "OTHER" }] } }),
    }),
  ).rejects.toThrow("different account");
});
