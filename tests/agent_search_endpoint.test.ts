import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { startServer } from "../services/sportsdesk_webview_server.ts";

describe("agent lookup for the Analysis form", () => {
  let server: ReturnType<typeof startServer>;

  beforeAll(() => {
    server = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  const get = (path: string) => fetch(`${server.url}${path}`);

  test("returns matching agents with their level", async () => {
    const res = await get("api/agents/search?q=HRGROUP");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as {
      query: string;
      count: number;
      agents: Array<{
        key: string;
        level: number | null;
        agentType: string | null;
      }>;
    };
    expect(body.count).toBe(1);
    expect(body.agents[0]?.key).toBe("HRGROUP");
    expect(body.agents[0]?.level).toBe(6);
    expect(body.agents[0]?.agentType).toBe("A");
  });

  test("is case-insensitive and prefers prefix hits", async () => {
    const lower = (await (await get("api/agents/search?q=hr")).json()) as {
      agents: Array<{ key: string }>;
    };
    const upper = (await (await get("api/agents/search?q=HR")).json()) as {
      agents: Array<{ key: string }>;
    };
    expect(lower.agents.map((a) => a.key)).toEqual(
      upper.agents.map((a) => a.key),
    );
    expect(lower.agents[0]?.key).toBe("HRGROUP");
  });

  test("caps the result set and clamps the limit", async () => {
    const few = (await (
      await get("api/agents/search?q=zz&limit=5")
    ).json()) as {
      agents: unknown[];
    };
    expect(few.agents.length).toBe(5);

    // A huge limit is clamped rather than honoured.
    const many = (await (
      await get("api/agents/search?q=zz&limit=1000")
    ).json()) as {
      agents: unknown[];
    };
    expect(many.agents.length).toBeLessThanOrEqual(100);
  });

  test("rejects a query shorter than two characters", async () => {
    const res = await get("api/agents/search?q=h");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; minLength: number };
    expect(body.error).toContain("at least 2 characters");
    expect(body.minLength).toBe(2);
  });

  test("analysis echoes whether the typed agent is in the hierarchy", async () => {
    const known = (await (
      await get("api/analysis?report=CP&agent=HRGROUP")
    ).json()) as { agentKnown: boolean; agentLevel: number | null };
    expect(known.agentKnown).toBe(true);
    expect(known.agentLevel).toBe(6);

    const unknown = (await (
      await get("api/analysis?report=CP&agent=NOSUCHAGENT")
    ).json()) as { agentKnown: boolean; agentLevel: number | null };
    expect(unknown.agentKnown).toBe(false);
    expect(unknown.agentLevel).toBeNull();
  });

  test("omitting the agent leaves the resolution empty, not false", async () => {
    const body = (await (await get("api/analysis?report=CP")).json()) as {
      agentKnown: boolean | null;
      agentLevel: number | null;
    };
    expect(body.agentKnown).toBeNull();
    expect(body.agentLevel).toBeNull();
  });
});
