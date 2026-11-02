import { describe, expect, test } from "bun:test";

import {
  applyProductionGeneralPlaceholders,
  generalRowsDifferOnlyInAgentLabels,
  replacePaddedWireLabel,
} from "./f402_production_general_placeholders.ts";
import { PRODUCTION_AGENT_PLACEHOLDER } from "./f402_production_fixture_redaction.ts";
import { trimPaddedField } from "./f402_list_agents_by_agent.ts";

describe("applyProductionGeneralPlaceholders", () => {
  test("assigns AGENT_L{level}_N{index} per level", () => {
    const out = applyProductionGeneralPlaceholders([
      { AgentID: "REAL1 ", Login: "REAL1", Level: 1, AgentType: "M" },
      { AgentID: "REAL2 ", Login: "REAL2", Level: 1, AgentType: "A" },
      { AgentID: "SUB1 ", Login: "SUB1", Level: 2, AgentType: "M" },
    ]);
    expect(trimPaddedField(out[0]?.Login)).toBe("AGENT_L1_N0");
    expect(trimPaddedField(out[1]?.Login)).toBe("AGENT_L1_N1");
    expect(trimPaddedField(out[2]?.Login)).toBe("AGENT_L2_N0");
    for (const row of out) {
      expect(
        PRODUCTION_AGENT_PLACEHOLDER.test(trimPaddedField(row.Login)),
      ).toBe(true);
    }
  });

  test("preserves trailing spaces on Login and AgentID (wire width)", () => {
    const original = [
      {
        AgentID: "USER667  ",
        Login: "USER667  ",
        Level: 1,
        AgentType: "M",
        SeqNumber: 1,
      },
    ];
    const out = applyProductionGeneralPlaceholders(original);
    const trailing = 2;
    expect(out[0]?.Login).toEndWith(" ".repeat(trailing));
    expect(out[0]?.Login).toHaveLength("AGENT_L1_N0".length + trailing);
    expect(trimPaddedField(out[0]?.Login)).toBe("AGENT_L1_N0");
  });

  test("generalRowsDifferOnlyInAgentLabels", () => {
    const original = [
      { AgentID: "X ", Login: "X", Level: 1, AgentType: "M", SeqNumber: 1 },
    ];
    const placeholder = applyProductionGeneralPlaceholders(original);
    expect(generalRowsDifferOnlyInAgentLabels(original, placeholder)).toBe(
      true,
    );
  });
});

describe("replacePaddedWireLabel", () => {
  test("keeps trailing space count", () => {
    expect(replacePaddedWireLabel("AGENT_L1_N0", "USER667  ")).toBe(
      "AGENT_L1_N0  ",
    );
  });
});
