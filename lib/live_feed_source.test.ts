import { describe, expect, test } from "bun:test";
import { fetchLiveFeedObject } from "./live_feed_source.ts";

describe("fetchLiveFeedObject", () => {
  test("reads the key, URL, observedAt and byte count", async () => {
    const object = await fetchLiveFeedObject("live-wagers/latest.json", {
      baseUrl: "https://example.test/",
      fetchImpl: async (input) => {
        expect(String(input)).toBe(
          "https://example.test/live-wagers/latest.json",
        );
        return new Response(
          JSON.stringify({
            observedAt: "2026-11-16T22:50:00.000Z",
            LIST: [],
          }),
          { status: 200 },
        );
      },
    });
    expect(object.key).toBe("live-wagers/latest.json");
    expect(object.observedAtIso).toBe("2026-11-16T22:50:00.000Z");
    expect(object.bytes).toBeGreaterThan(0);
  });

  test("a non-2xx response throws with the key, not an empty payload", async () => {
    await expect(
      fetchLiveFeedObject("live-bets/latest.json", {
        fetchImpl: async () => new Response("down", { status: 503 }),
      }),
    ).rejects.toThrow("live-bets/latest.json returned HTTP 503");
  });

  test("a non-JSON body throws instead of returning undefined", async () => {
    await expect(
      fetchLiveFeedObject("live-bets/latest.json", {
        fetchImpl: async () => new Response("<html>", { status: 200 }),
      }),
    ).rejects.toThrow("did not return JSON");
  });
});
