import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPendingDate,
  F402PendingFetchError,
  fetchF402Pending,
  fetchAndPersistPending,
  resolveF402BearerToken,
} from "../lib/f402_pending_fetch.ts";

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("F402 getPending fetch", () => {
  test("rejects missing, zero, and short bearer tokens before I/O", () => {
    for (const token of [undefined, "", "0", "short-token"]) {
      expect(() =>
        resolveF402BearerToken({ cliToken: token, environment: {} }),
      ).toThrow(F402PendingFetchError);
    }
    expect(
      resolveF402BearerToken({
        cliToken: "Bearer " + "a".repeat(32),
        environment: {},
      }),
    ).toBe("a".repeat(32));
  });

  test("posts the 10-field body with the Authorization header", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const legs = [{ TicketNumber: 1, WagerNumber: 1, totalPicks: 1 }];
    const result = await fetchF402Pending({
      token: "t".repeat(32),
      date: "2026-10-28",
      agentId: "AG",
      agentOwner: "OWNER",
      baseUrl: "https://mock.test",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return jsonResponse(legs);
      },
    });
    expect(seen.url).toBe("https://mock.test/cloud/api/Manager/getPending");
    expect(
      (seen.init?.headers as Record<string, string> | undefined)?.authorization,
    ).toBe(`Bearer ${"t".repeat(32)}`);
    const body = JSON.parse(String(seen.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      agentID: "AG",
      path: "/qubic/api/Manager/getPending",
      RRO: 1,
      date: "2026-10-28",
      wagerType: "",
      sort: "1",
      typeSort: "2",
      week: 0,
      customerID: "0",
      agentOwner: "OWNER",
    });
    expect(result.legs).toHaveLength(1);
  });

  test("accepts { LIST: [...] } and rejects HTML traps without clobbering the capture", async () => {
    await expect(
      fetchF402Pending({
        token: "t".repeat(32),
        date: "2026-10-28",
        fetchImpl: async () => jsonResponse({ LIST: [{ TicketNumber: 2 }] }),
      }),
    ).resolves.toMatchObject({ legs: [{ TicketNumber: 2 }] });

    const dir = mkdtempSync(join(tmpdir(), "f402-pending-fetch-"));
    try {
      const path = join(dir, "capture.json");
      writeFileSync(path, '{"sentinel":true}\n');
      const html = new Response(
        "<!DOCTYPE html><html><form>login</form></html>",
        {
          status: 200,
          headers: { "content-type": "text/html" },
        },
      );
      await expect(
        fetchAndPersistPending({
          token: "t".repeat(32),
          date: "2026-10-28",
          capturePath: path,
          fetchImpl: async () => html,
        }),
      ).rejects.toThrow(/HTML\/XML login trap/);
      expect(readFileSync(path, "utf8")).toBe('{"sentinel":true}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default date is six days back on the desk calendar", () => {
    expect(defaultPendingDate(new Date("2026-11-03T12:00:00Z"))).toBe(
      "2026-10-28",
    );
    expect(
      defaultPendingDate(new Date("2026-11-03T12:00:00Z"), "2026-11-01"),
    ).toBe("2026-11-01");
  });
});
