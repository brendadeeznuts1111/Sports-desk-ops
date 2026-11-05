import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseGetInfoPlayerEnvelope,
  parseGetInfoPlayerProbe,
  redactGetInfoPlayer,
  summarizeGetInfoPlayer,
  trimPaddedId,
} from "./f402_get_info_player.ts";

const fixture = join(
  import.meta.dir,
  "../tests/fixtures/f402-get-info-player-minimal.json",
);

describe("getInfoPlayer envelope", () => {
  test("parses INFO.data / balance / parlaySpecs", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const env = parseGetInfoPlayerEnvelope(raw);
    expect(env.INFO.data.AgentType).toBe("M");
    expect(env.INFO.parlaySpecs).toHaveLength(2);
  });

  test("summarize trims padded Login and CustomerID", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const summary = summarizeGetInfoPlayer(parseGetInfoPlayerEnvelope(raw));
    expect(trimPaddedId("BILLY666  ")).toBe("BILLY666");
    expect(summary.customerId).toBe("BILLY666");
    expect(summary.login).toBe("BILLY666");
    expect(summary.assignedParlayName).toBe("8 Team Max");
    expect(summary.parlaySpecCount).toBe(2);
    expect(summary.agentType).toBe("M");
  });

  test("redactGetInfoPlayer removes password fields", () => {
    const raw = JSON.parse(readFileSync(fixture, "utf8"));
    const env = parseGetInfoPlayerEnvelope(raw);
    const redacted = redactGetInfoPlayer(env);
    expect(redacted.INFO.data.Password).toBe("<redacted>");
    expect(redacted.INFO.data.Passwordt).toBe("<redacted>");
  });

  test("rejects missing INFO.data", () => {
    expect(() => parseGetInfoPlayerEnvelope({ INFO: {} })).toThrow("INFO.data");
  });

  test("the probe treats INFO:null as player-not-found", () => {
    expect(parseGetInfoPlayerProbe({ INFO: null })).toEqual({ found: false });
    expect(() => parseGetInfoPlayerProbe({ INFO: true })).toThrow("INFO");
  });

  test("the probe summary carries the identity fields", () => {
    const probe = parseGetInfoPlayerProbe({
      INFO: {
        data: {
          Login: "BGD101   ",
          AgentID: "BIGDAD   ",
          AgentLogin: "BIGDAD",
          Status: "Active",
        },
        added: { CustomerID: "BGD101    " },
      },
    });
    expect(probe).toMatchObject({
      found: true,
      summary: {
        customerId: "BGD101",
        login: "BGD101",
        agentId: "BIGDAD",
        agentLogin: "BIGDAD",
        status: "Active",
      },
    });
  });
});
