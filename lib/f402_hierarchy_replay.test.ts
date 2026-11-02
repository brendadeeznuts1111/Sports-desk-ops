import { describe, expect, test } from "bun:test";

import {
  assertHierarchyFetchResponse,
  buildListAgentsReplayPlan,
  loadAccountInfoOwnerFixture,
} from "./f402_hierarchy_replay.ts";
import { assertListAgentsTopLevelKeys } from "./f402_list_agents_envelope_strict.ts";

describe("f402 hierarchy replay scaffolding", () => {
  test("dry plan matches portal getCompleteHeriarchy POST fields", () => {
    const account = loadAccountInfoOwnerFixture({
      agentID: "AGENT1",
      accountInfo: { AgentType: "M" },
    });
    const plan = buildListAgentsReplayPlan(account, {}, { rro: 1 });
    expect(plan.url).toEndWith("/cloud/api/Manager/getListAgenstByAgent");
    expect(plan.bodyRecord).toEqual({
      agentID: "AGENT1",
      agentType: "M",
      operation: "getListAgenstByAgent",
      RRO: "1",
    });
  });

  test("strict envelope keys reject login HTML wrapper", () => {
    expect(() =>
      assertListAgentsTopLevelKeys({
        GENERAL: [],
        PLAYERS: [],
        EXTRA: true,
        error: 1,
      }),
    ).toThrow(/exactly \{GENERAL, PLAYERS, EXTRA\}/);
  });

  test("assertHierarchyFetchResponse fails on 401", () => {
    const res = new Response("", { status: 401 });
    expect(() => assertHierarchyFetchResponse(res, "")).toThrow(/401/);
  });

  test("assertHierarchyFetchResponse reports 500 as an HTTP error, not a redirect", () => {
    const res = new Response("internal error", { status: 500 });
    expect(() => assertHierarchyFetchResponse(res, "internal error")).toThrow(
      /HTTP error 500 .*: internal error/,
    );
  });

  test("assertHierarchyFetchResponse reports 302 as a redirect", () => {
    const res = new Response("", {
      status: 302,
      headers: { location: "https://example.test/login" },
    });
    expect(() => assertHierarchyFetchResponse(res, "")).toThrow(
      /redirected \(HTTP 302\)/,
    );
  });
});
