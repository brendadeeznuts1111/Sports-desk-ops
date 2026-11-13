import { describe, expect, test } from "bun:test";
import type { ListAgentsByAgentEnvelope } from "../lib/f402_list_agents_by_agent.ts";
import {
  redactListAgentsEnvelopeInMemory,
  redactListAgentsEnvelopeJsonText,
} from "../lib/f402_list_agents_envelope_redact.ts";
import { PRODUCTION_PASSWORD_SENTINEL } from "../lib/f402_production_fixture_redaction.ts";

const WIRE_TEXT = JSON.stringify({
  GENERAL: [{ Login: "agent-login", AgentID: 7 }],
  PLAYERS: [
    {
      Password: "s3cret",
      Login: "player1",
      NameFirst: "Ada",
      customerID: "c1",
      Balance: 12.5,
    },
    { Password: "", Login: "player2", Note: "keep" },
  ],
  EXTRA: false,
});

function envelope(): ListAgentsByAgentEnvelope {
  return {
    GENERAL: [{ Login: "agent-login", AgentID: 7 }],
    PLAYERS: [
      {
        Password: "s3cret",
        Login: "player1",
        NameFirst: "Ada",
        customerID: "c1",
        Balance: 12.5,
      },
      { Password: "", Login: "player2", Note: "keep" },
      { Password: 1234, Login: "player3", NameFirst: "Cy" },
    ],
    EXTRA: true,
  } as unknown as ListAgentsByAgentEnvelope;
}

describe("redactListAgentsEnvelopeInMemory", () => {
  test("replaces a non-empty password with the sentinel and the PII keys with a marker", () => {
    const redacted = redactListAgentsEnvelopeInMemory(envelope());
    const [first, second, third] = redacted.PLAYERS as unknown as Record<
      string,
      unknown
    >[];
    expect(first).toMatchObject({
      Password: PRODUCTION_PASSWORD_SENTINEL,
      Login: "[REDACTED]",
      NameFirst: "[REDACTED]",
      customerID: "[REDACTED]",
      Balance: 12.5,
    });
    expect(second).toMatchObject({
      Password: "[REDACTED]",
      Login: "[REDACTED]",
      Note: "keep",
    });
    expect(third).toMatchObject({
      Password: "[REDACTED]",
      Login: "[REDACTED]",
      NameFirst: "[REDACTED]",
    });
  });

  test("leaves GENERAL untouched (redaction is scoped to PLAYERS)", () => {
    const redacted = redactListAgentsEnvelopeInMemory(envelope());
    expect(redacted.GENERAL as unknown as Record<string, unknown>[]).toEqual([
      { Login: "agent-login", AgentID: 7 },
    ]);
  });

  test("copies each PLAYERS row instead of mutating the input", () => {
    const source = envelope();
    const redacted = redactListAgentsEnvelopeInMemory(source);
    expect(source.PLAYERS[0]).toMatchObject({
      Password: "s3cret",
      Login: "player1",
    });
    expect(redacted.PLAYERS[0]).not.toBe(source.PLAYERS[0]);
  });

  test("preserves EXTRA and its absence", () => {
    expect(redactListAgentsEnvelopeInMemory(envelope()).EXTRA).toBe(true);
    const withoutExtra = {
      ...envelope(),
      EXTRA: undefined,
    } as unknown as ListAgentsByAgentEnvelope;
    expect(
      redactListAgentsEnvelopeInMemory(withoutExtra).EXTRA,
    ).toBeUndefined();
  });
});

describe("redactListAgentsEnvelopeJsonText", () => {
  test("parses, redacts and re-serializes the envelope", () => {
    const text = redactListAgentsEnvelopeJsonText(WIRE_TEXT);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as {
      GENERAL: Record<string, unknown>[];
      PLAYERS: Record<string, unknown>[];
      EXTRA: boolean;
    };
    expect(parsed.GENERAL).toEqual([{ Login: "agent-login", AgentID: 7 }]);
    expect(parsed.PLAYERS[0]).toMatchObject({
      Password: PRODUCTION_PASSWORD_SENTINEL,
      Login: "[REDACTED]",
      NameFirst: "[REDACTED]",
      customerID: "[REDACTED]",
      Balance: 12.5,
    });
    expect(parsed.PLAYERS[1]).toMatchObject({
      Password: "[REDACTED]",
      Login: "[REDACTED]",
    });
    expect(parsed.EXTRA).toBe(false);
  });

  test("names the empty and truncated body failure modes", () => {
    expect(() => redactListAgentsEnvelopeJsonText("")).toThrow("empty body");
    expect(() => redactListAgentsEnvelopeJsonText("   ")).toThrow("empty body");
    expect(() => redactListAgentsEnvelopeJsonText("{")).toThrow(
      "truncated or incomplete JSON",
    );
    expect(() => redactListAgentsEnvelopeJsonText('{"GENERAL":}')).toThrow(
      "body is not JSON",
    );
  });

  test("requires exactly the three top-level keys", () => {
    expect(() =>
      redactListAgentsEnvelopeJsonText('{"GENERAL":[],"PLAYERS":[]}'),
    ).toThrow(
      "envelope top-level keys must be exactly {GENERAL, PLAYERS, EXTRA}",
    );
    expect(() =>
      redactListAgentsEnvelopeJsonText(
        '{"GENERAL":[],"PLAYERS":[],"EXTRA":false,"X":1}',
      ),
    ).toThrow(
      "envelope top-level keys must be exactly {GENERAL, PLAYERS, EXTRA}",
    );
  });
});
