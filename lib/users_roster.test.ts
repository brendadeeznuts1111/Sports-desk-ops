import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertProjectedRoster,
  loadProjectedUsersRoster,
  projectUsersRoster,
} from "./users_roster.ts";

describe("users roster projection", () => {
  test("keeps only structural fields and drops passwords/names", () => {
    const projected = projectUsersRoster({
      GENERAL: [
        {
          AgentID: "A1 ",
          Login: "A1",
          Level: 2,
          AgentType: "M",
          SeqNumber: 9,
        },
      ],
      PLAYERS: [
        {
          customerID: "C1 ",
          Login: "C1",
          Agent: "A1",
          Password: "secret",
          NameFirst: "Fake",
        },
      ],
    });
    expect(projected.players[0]).toEqual({
      customerId: "C1",
      login: "C1",
      agent: "A1",
    });
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("Fake");
    expect(projected.agents[0]?.level).toBe(2);
  });

  test("the loader refuses a raw report with a sensitive key", () => {
    expect(() =>
      assertProjectedRoster({
        schemaVersion: 1,
        agents: [],
        players: [{ customerId: "C1", Login: "C1", Password: "x" }],
      }),
    ).toThrow("sensitive key");
  });

  test("matches a customer id or login to its agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-"));
    const path = join(dir, "projected.json");
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        agents: [
          { agentId: "A1", login: "A1", level: 2, type: "M", seqNumber: 9 },
        ],
        players: [{ customerId: "CC107_1", login: "CC107", agent: "A1" }],
      }),
    );
    const index = await loadProjectedUsersRoster(path);
    expect(index.playerToAgent.get("CC107_1")).toBe("A1");
    expect(index.playerToAgent.get("CC107")).toBe("A1");
    expect(index.byAgent.get("A1")?.level).toBe(2);
  });
});
