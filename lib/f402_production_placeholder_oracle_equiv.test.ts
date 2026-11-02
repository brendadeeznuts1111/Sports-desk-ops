import { describe, expect, test } from "bun:test";

import { applyProductionGeneralPlaceholders } from "./f402_production_general_placeholders.ts";
import { assertOracleEquivalentAfterGeneralPlaceholder } from "./f402_oracle_label_agnostic.ts";
import type { PortalGeneralRow } from "./f402_portal_hierarchy_oracle.ts";

function row(
  level: number,
  agentId: string,
  agentType: "A" | "M" = "M",
): PortalGeneralRow {
  return {
    AgentID: `${agentId} `.padEnd(agentId.length + 4, " "),
    Login: agentId,
    Level: level,
    AgentType: agentType,
    SeqNumber: level + 1000,
  };
}

describe("placeholder oracle equivalence", () => {
  test("Levels 1–8 chain: nested snapshot matches under label normalization", async () => {
    const original: PortalGeneralRow[] = [row(1, "ROOT", "M")];
    for (let level = 2; level <= 8; level++) {
      original.push(row(level, `NODE${level}`, level === 8 ? "A" : "M"));
    }
    const placeholder = applyProductionGeneralPlaceholders(original);
    await assertOracleEquivalentAfterGeneralPlaceholder(original, placeholder);
  });

  test("preserves trailing padding on AgentID for wide wire fields", () => {
    const original = [
      {
        AgentID: "LIVEUSER    ",
        Login: "LIVEUSER    ",
        Level: 1,
        AgentType: "M",
        SeqNumber: 1,
      },
    ];
    const out = applyProductionGeneralPlaceholders(original);
    expect(out[0]?.AgentID).toEndWith("    ");
    expect(out[0]?.AgentID).toHaveLength("AGENT_L1_N0".length + 4);
  });
});
