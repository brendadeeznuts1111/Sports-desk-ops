import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildWebLogBody,
  buildWebLogFormBody,
  F402WebLogFetchError,
  fetchAndPersistWebLog,
  fetchWebLog,
  formatWebLogDate,
  explainWebLogListParseFailure,
  OBSERVED_WEBLOG_WIRE_ORDER,
  parseWebLogFormBody,
  parseWebLogListPayload,
  resolveF402BearerToken,
} from "../lib/f402_weblog_fetch.ts";

const json = (payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const modeRequest = (mode: "A" | "B" | "C" | "I") => ({
  mode,
  date: "2026-11-02",
  customerId: mode === "B" ? "0" : "BB7884",
  ...(mode === "I" ? { ip: "203.0.113.7" } : {}),
});

describe("f402 weblog fetch", () => {
  test("formats A/B dates as MM/DD/YYYY and C as YYYY-MM-DD", () => {
    expect(formatWebLogDate("A", "2026-11-02")).toBe("11/02/2026");
    expect(formatWebLogDate("B", "2026-11-02")).toBe("11/02/2026");
    expect(formatWebLogDate("C", "2026-11-02")).toBe("2026-11-02");
    expect(() => formatWebLogDate("C", "11/02/2026")).toThrow(
      F402WebLogFetchError,
    );
  });

  test("parseWebLogListPayload accepts array, LIST array, and LIST JSON string", () => {
    expect(parseWebLogListPayload([{ LoginID: "x" }])).toHaveLength(1);
    expect(parseWebLogListPayload({ LIST: [{ LoginID: "y" }] })).toHaveLength(
      1,
    );
    expect(parseWebLogListPayload({ LIST: "", INFO: "" })).toEqual([]);
    expect(
      parseWebLogListPayload({
        LIST: JSON.stringify([{ LoginID: "z" }]),
        INFO: "",
      }),
    ).toHaveLength(1);
    expect(parseWebLogListPayload({ LIST: "not-json", INFO: "x" })).toBeNull();
    expect(explainWebLogListParseFailure({ rows: [] })).toMatch(/missing LIST/);
    expect(explainWebLogListParseFailure({ LIST: "not-json" })).toMatch(
      /LIST string/,
    );
  });

  test("builds all four wire bodies", () => {
    for (const mode of ["A", "B", "C", "I"] as const) {
      const body = buildWebLogBody({
        ...modeRequest(mode),
        agentId: "AG",
        agentOwner: "OWNER",
      });
      expect(body.type).toBe(mode);
      expect(body.operation).toBe("getWebLog");
      expect(body.RRO).toBe("1");
      expect(body.actions).toBe("ALL");
      expect(body.agentID).toBe("AG");
      expect(body.agentOwner).toBe("OWNER");
      if (mode === "I") {
        expect(body.customerID).toBe("0");
        expect(body.ip).toBe("203.0.113.7");
        expect(body.start).toBe("2026-11-02");
        expect(body.end).toBe("2026-11-02");
      } else if (mode === "C") {
        expect(body.start).toBe("2026-11-02");
        expect(body.end).toBe("2026-11-02");
      } else {
        expect(body.start).toBe("11/02/2026");
        expect(body.end).toBe("11/02/2026");
      }
    }
  });

  test("posts the mode body and rejects 200 HTML traps without clobbering the capture", async () => {
    for (const mode of ["A", "B", "C", "I"] as const) {
      let seen: { url?: string; init?: RequestInit } = {};
      const result = await fetchWebLog({
        token: "t".repeat(32),
        request: modeRequest(mode),
        baseUrl: "https://mock.test",
        fetchImpl: async (url, init) => {
          seen = { url, init };
          return json([{ LoginID: "x" }]);
        },
      });
      expect(seen.url).toBe("https://mock.test/cloud/api/Manager/getWebLog");
      expect(
        (seen.init?.headers as Record<string, string> | undefined)
          ?.authorization,
      ).toBe(`Bearer ${"t".repeat(32)}`);
      const form = new URLSearchParams(String(seen.init?.body));
      expect(form.get("type")).toBe(mode);
      expect(
        (seen.init?.headers as Record<string, string> | undefined)?.[
          "content-type"
        ],
      ).toContain("application/x-www-form-urlencoded");
      expect(seen.init?.redirect).toBe("manual");
      expect(result.rows).toHaveLength(1);
    }

    await expect(
      fetchWebLog({
        token: "t".repeat(32),
        request: modeRequest("B"),
        baseUrl: "https://mock.test",
        fetchImpl: async () =>
          new Response("", {
            status: 302,
            headers: { location: "https://mock.test/login" },
          }),
      }),
    ).rejects.toThrow(/redirect HTTP 302/);

    await expect(
      fetchWebLog({
        token: "t".repeat(32),
        request: modeRequest("B"),
        baseUrl: "https://mock.test",
        fetchImpl: async () => json({ rows: [{ LoginID: "x" }] }),
      }),
    ).rejects.toThrow(/missing LIST/);

    const dir = mkdtempSync(join(tmpdir(), "weblog-fetch-"));
    try {
      const path = join(dir, "capture-A-2026-11-02.jsonl");
      writeFileSync(path, '{"sentinel":true}\n');
      await expect(
        fetchAndPersistWebLog({
          token: "t".repeat(32),
          request: modeRequest("A"),
          capturePath: path,
          fetchImpl: async () =>
            new Response("<!DOCTYPE html>login", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
        }),
      ).rejects.toThrow(/HTML\/XML login trap/);
      expect(readFileSync(path, "utf8")).toBe('{"sentinel":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects short/zero tokens", () => {
    for (const token of ["", "0", "short"]) {
      expect(() =>
        resolveF402BearerToken({
          cliToken: token,
          environment: {},
          readSession: () => null,
        }),
      ).toThrow();
    }
  });

  test("emits observed 10-field wire order, multi-day Mode C range, lowercase ip echo, and distinct agentOwner", () => {
    const modeBBody = buildWebLogFormBody({
      mode: "B",
      date: "2026-10-28",
      agentId: "MASTER01",
      agentOwner: "MASTER01",
    });
    expect(modeBBody).toBe(
      "agentID=MASTER01&customerID=0&start=10%2F28%2F2026&end=10%2F28%2F2026&type=B&actions=ALL&ip=&operation=getWebLog&RRO=1&agentOwner=MASTER01",
    );

    const fixturePath = resolve(
      import.meta.dir,
      "fixtures/f402-weblog-mode-c-observed-2026-11-20.json",
    );
    const observedFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      wireOrder: readonly string[];
      fields: Record<string, string>;
    };
    const expectedFixtureBody = new URLSearchParams(
      Object.entries(observedFixture.fields),
    ).toString();
    const builtFromPlaceholders = buildWebLogFormBody({
      mode: "C",
      date: observedFixture.fields.start!,
      endDate: observedFixture.fields.end!,
      agentId: observedFixture.fields.agentID!,
      agentOwner: observedFixture.fields.agentOwner!,
      customerId: observedFixture.fields.customerID!,
      ip: observedFixture.fields.ip!,
    });
    expect(builtFromPlaceholders).toBe(expectedFixtureBody);

    const modeCBody = buildWebLogFormBody({
      mode: "C",
      date: "2026-11-06",
      endDate: "2026-11-20",
      customerId: "CUST99",
      agentId: "MASTER01",
      agentOwner: "MASTER01v",
    });
    expect(modeCBody).toBe(
      "agentID=MASTER01&customerID=CUST99&start=2026-11-06&end=2026-11-20&type=C&actions=ALL&ip=cust99&operation=getWebLog&RRO=1&agentOwner=MASTER01v",
    );

    const parsedC = parseWebLogFormBody(modeCBody);
    expect(parsedC.wireFieldOrder).toEqual([...OBSERVED_WEBLOG_WIRE_ORDER]);
    expect(parsedC.wireFieldOrder).toEqual([...observedFixture.wireOrder]);
    expect(parsedC.matchesObservedWireOrder).toBe(true);
    expect(parsedC.hasDistinctAgentOwner).toBe(true);
    expect(parsedC.agentOwner).toBe("MASTER01v");
    expect(parsedC.isDateRange).toBe(true);
    expect(parsedC.modeCIpMatchesCustomer).toBe(true);
    expect(parsedC.isActivityStream).toBe(false);

    const parsedA = parseWebLogFormBody(
      buildWebLogFormBody({
        mode: "A",
        date: "2026-11-20",
        customerId: "CUST99",
        agentId: "MASTER01",
        agentOwner: "MASTER01",
      }),
    );
    expect(parsedA.isActivityStream).toBe(true);
    expect(parsedA.modeCIpMatchesCustomer).toBeNull();
    expect(parsedA.hasDistinctAgentOwner).toBe(false);

    expect(() =>
      buildWebLogFormBody({
        mode: "C",
        date: "2026-11-20",
        endDate: "2026-11-06",
        customerId: "CUST99",
      }),
    ).toThrow(/cannot precede/);

    expect(() => parseWebLogFormBody("operation=other&type=C")).toThrow(
      /Invalid getWebLog form operation/,
    );
    expect(() => parseWebLogFormBody("operation=getWebLog&type=Z")).toThrow(
      /Invalid getWebLog mode type/,
    );
  });
});
