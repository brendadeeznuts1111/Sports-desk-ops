import { describe, expect, test } from "bun:test";

import {
  USERS_REPORT_BASE_URL,
  UsersReportError,
  aggregateCorpusTickets,
  buildUsersReportUrl,
  captureUsersReport,
  compareUsersReportToCorpus,
  redactUsersReportRows,
  usersReportStringHash,
} from "../lib/gslive_users_report.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureOptions(
  overrides: Partial<Parameters<typeof captureUsersReport>[0]> = {},
): Parameters<typeof captureUsersReport>[0] {
  return {
    fromEpochSec: 1_793_163_600,
    toEpochSec: 1_793_771_999,
    cookieHeader: "GSID=test-session",
    sessionSource: "test",
    fetchImpl: () => Promise.resolve(jsonResponse([])),
    ...overrides,
  };
}

describe("users-report URL", () => {
  test("builds the exact report URL with the observed parameter order", () => {
    expect(
      buildUsersReportUrl({
        fromEpochSec: 1_792_386_000,
        toEpochSec: 1_793_771_999,
      }),
    ).toBe(
      `${USERS_REPORT_BASE_URL}?from=1792386000&to=1793771999&partnerId=118&kind=users-report`,
    );
  });

  test("rejects a reversed window and a non-positive partner id", () => {
    expect(() =>
      buildUsersReportUrl({ fromEpochSec: 10, toEpochSec: 5 }),
    ).toThrow(UsersReportError);
    expect(() =>
      buildUsersReportUrl({ fromEpochSec: 5, toEpochSec: 10, partnerId: 0 }),
    ).toThrow(UsersReportError);
  });
});

describe("users-report redaction", () => {
  test("keeps numeric/boolean cells and hashes every identity string", () => {
    const report = redactUsersReportRows([
      { userID: 123, login: "player_ABC", bot: true, stake: 55.5 },
      { userID: 456, login: "player_DEF", bot: false, stake: 10 },
    ]);
    expect(report.rowCount).toBe(2);
    expect(report.numericColumns).toEqual(["userID", "stake"]);
    expect(report.stringColumns).toEqual(["login"]);
    expect(report.rows[0]?.["userID"]).toBe(123);
    expect(report.rows[0]?.["stake"]).toBe(55.5);
    expect(report.rows[0]?.["bot"]).toBe(true);
    expect(report.rows[0]?.["login"]).toBe(
      `sha256:${usersReportStringHash("player_ABC")}`,
    );
    const serialized = JSON.stringify(report);
    expect(serialized.includes("player_ABC")).toBe(false);
    expect(serialized.includes("player_DEF")).toBe(false);
  });

  test("hashes nested values instead of leaking them", () => {
    const report = redactUsersReportRows([
      { userID: 1, profile: { name: "secret-name" } },
    ]);
    expect(String(report.rows[0]?.["profile"]).startsWith("sha256:")).toBe(
      true,
    );
    expect(JSON.stringify(report).includes("secret-name")).toBe(false);
  });
});

describe("users-report capture", () => {
  test("accepts an array body and records the raw digest, never the body", async () => {
    const capture = await captureUsersReport(
      captureOptions({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse([
              { userID: 1, login: "player_A", stake: 10 },
              { userID: 2, login: "player_B", stake: 20 },
            ]),
          ),
      }),
    );
    expect(capture.envelope).toBe("array");
    expect(capture.report.rowCount).toBe(2);
    expect(capture.rawSha256).toHaveLength(64);
    expect(JSON.stringify(capture).includes("player_A")).toBe(false);
  });

  test("accepts the object envelope {e:0,r:[...]}", async () => {
    const capture = await captureUsersReport(
      captureOptions({
        fetchImpl: () =>
          Promise.resolve(
            jsonResponse({ e: 0, r: [{ userID: 1, stake: 10 }], d: "" }),
          ),
      }),
    );
    expect(capture.envelope).toBe("object-r");
    expect(capture.report.rowCount).toBe(1);
  });

  test("a 401 is a session-expired failure, never an empty report", async () => {
    await expect(
      captureUsersReport(
        captureOptions({
          fetchImpl: () =>
            Promise.resolve(
              jsonResponse(
                { e: 1, r: [], d: "Please login to your account" },
                401,
              ),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "session_expired" });
  });

  test("an error envelope is a refusal, never an empty report", async () => {
    await expect(
      captureUsersReport(
        captureOptions({
          fetchImpl: () =>
            Promise.resolve(
              jsonResponse({ e: 1, r: [], d: "Please login to your account" }),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "report_error" });
  });

  test("a non-array body is invalid, not empty", async () => {
    await expect(
      captureUsersReport(
        captureOptions({
          fetchImpl: () => Promise.resolve(jsonResponse({ e: 0, d: "" })),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("an HTML body is invalid and carries the body digest", async () => {
    await expect(
      captureUsersReport(
        captureOptions({
          fetchImpl: () =>
            Promise.resolve(
              new Response("<html>login</html>", {
                status: 200,
                headers: { "content-type": "text/html" },
              }),
            ),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  test("an empty session fails closed before any fetch", async () => {
    let calls = 0;
    await expect(
      captureUsersReport(
        captureOptions({
          cookieHeader: "",
          fetchImpl: () => {
            calls += 1;
            return Promise.resolve(jsonResponse([]));
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "session_expired" });
    expect(calls).toBe(0);
  });
});

describe("users-report comparison", () => {
  const corpusBets = [
    {
      betGroupId: "g1",
      userID: "1",
      partnerUserID: "player_A",
      bet: "100",
      betGroupResult: "-50",
    },
    {
      betGroupId: "g1",
      userID: "1",
      partnerUserID: "player_A",
      bet: "100",
      betGroupResult: "-50",
    },
    {
      betGroupId: "g2",
      userID: "2",
      partnerUserID: "player_B",
      bet: "200",
      betGroupResult: "25",
    },
  ];

  test("dedupes ticket legs before aggregating", () => {
    const aggregates = aggregateCorpusTickets(corpusBets);
    const userOne = aggregates.byUserId.get("1");
    expect(userOne?.tickets).toBe(1);
    expect(userOne?.stakeCents).toBe(10_000);
    expect(userOne?.resultCents).toBe(-5_000);
    const partnerHash = `sha256:${usersReportStringHash("player_A")}`;
    expect(aggregates.byPartnerHash.get(partnerHash)?.tickets).toBe(1);
  });

  test("detects the numeric userID column and ranks numeric metrics", () => {
    const report = redactUsersReportRows([
      { userID: 1, stake: 100, net: -50, login: "player_A" },
      { userID: 2, stake: 200, net: 25, login: "player_B" },
    ]);
    const comparison = compareUsersReportToCorpus(
      report,
      aggregateCorpusTickets(corpusBets),
    );
    expect(comparison.idColumn).toBe("userID");
    expect(comparison.idKind).toBe("userId");
    expect(comparison.overlap).toBe(2);
    expect(comparison.reportRows).toBe(2);
    const columns = comparison.candidates.map((candidate) => candidate.column);
    expect(columns).toContain("stake");
    expect(columns).toContain("net");
  });

  test("falls back to the hashed partner login when no numeric id matches", () => {
    const report = redactUsersReportRows([
      { login: "player_A", stake: 100 },
      { login: "player_B", stake: 200 },
    ]);
    const comparison = compareUsersReportToCorpus(
      report,
      aggregateCorpusTickets(corpusBets),
    );
    expect(comparison.idColumn).toBe("login");
    expect(comparison.idKind).toBe("partnerHash");
    expect(comparison.overlap).toBe(2);
  });

  test("refuses when no column joins to the corpus", () => {
    const report = redactUsersReportRows([{ mystery: 7, token: "nobody" }]);
    expect(() =>
      compareUsersReportToCorpus(report, aggregateCorpusTickets(corpusBets)),
    ).toThrow(UsersReportError);
  });
});
