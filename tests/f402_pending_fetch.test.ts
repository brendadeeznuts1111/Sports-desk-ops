/**
 * @file f402_pending_fetch.test.ts
 * @description The pending body must carry a non-empty `agentOwner`: the server answers an empty
 * `agentOwner` with HTTP 500 (empty text/html), while the ticker body already sets it to the agent
 * id. Guards the 2026-11-17 bridge3b 500 regression without touching the network.
 */

import { describe, expect, test } from "bun:test";

import { fetchF402Pending } from "../lib/f402_pending_fetch.ts";

interface Capture {
  body?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fakeFetch(
  capture: Capture,
): (input: string, init: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const parsed: unknown = JSON.parse(String(init.body ?? "{}"));
    capture.body = isRecord(parsed) ? parsed : {};
    return new Response(JSON.stringify({ LIST: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("fetchF402Pending body", () => {
  test("defaults agentOwner to the agent id (server 500s on empty)", async () => {
    const saved = Bun.env.F402_AGENT_OWNER;
    delete Bun.env.F402_AGENT_OWNER;
    try {
      const capture: Capture = {};
      await fetchF402Pending({
        token: "t".repeat(24),
        date: "2026-11-17",
        agentId: "AGENT1",
        fetchImpl: fakeFetch(capture),
      });
      expect(capture.body?.agentID).toBe("AGENT1");
      expect(capture.body?.agentOwner).toBe("AGENT1");
    } finally {
      if (saved !== undefined) Bun.env.F402_AGENT_OWNER = saved;
    }
  });

  test("an explicit agentOwner wins", async () => {
    const capture: Capture = {};
    await fetchF402Pending({
      token: "t".repeat(24),
      date: "2026-11-17",
      agentId: "AGENT1",
      agentOwner: "OWNER1",
      fetchImpl: fakeFetch(capture),
    });
    expect(capture.body?.agentOwner).toBe("OWNER1");
  });

  test("falls back to the keychain agent id when env and option are empty", async () => {
    // types/env.d.ts declares F402_AGENT_ID read-only; this test has to clear and restore it.
    const env = Bun.env as Record<string, string | undefined>;
    const savedAgentId = env.F402_AGENT_ID;
    const savedOwner = env.F402_AGENT_OWNER;
    delete env.F402_AGENT_ID;
    delete env.F402_AGENT_OWNER;
    try {
      const capture: Capture = {};
      await fetchF402Pending({
        token: "t".repeat(24),
        date: "2026-11-17",
        resolveAgentId: async () => "KEYCHAIN1",
        fetchImpl: fakeFetch(capture),
      });
      expect(capture.body?.agentID).toBe("KEYCHAIN1");
      expect(capture.body?.agentOwner).toBe("KEYCHAIN1");
    } finally {
      if (savedAgentId !== undefined) env.F402_AGENT_ID = savedAgentId;
      if (savedOwner !== undefined) env.F402_AGENT_OWNER = savedOwner;
    }
  });
});
