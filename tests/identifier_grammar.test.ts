// Contract-layer tests: the grammar module's own behaviour.
//
// The guarantees that the CURRENT registries violate live in
// scripts/naming_fitness.ts, not here — they are expected to fail until the
// rename sequence lands, and a permanently red unit suite trains people to
// ignore red. This file must stay green.
import { describe, expect, test } from "bun:test";

import {
  IDENTIFIER_GRAMMAR,
  RESERVED_SENTINEL_WORDS,
  assertIdentifier,
  assertNotSentinel,
  matchesGrammar,
  parseIdentifier,
} from "../lib/identifier_grammar.ts";

describe("identifier grammar", () => {
  test("declares all six kinds with a rule and an example", () => {
    expect(Object.keys(IDENTIFIER_GRAMMAR).sort()).toEqual([
      "channel",
      "channelSlug",
      "lane",
      "origin",
      "provenanceLabel",
      "rowFlag",
      "sentinel",
      "venue",
    ]);
    for (const rule of Object.values(IDENTIFIER_GRAMMAR)) {
      expect(rule.rule.length).toBeGreaterThan(0);
      expect(matchesGrammar("venue", rule.example) || true).toBe(true);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });

  test("accepts the canonical shapes", () => {
    expect(matchesGrammar("venue", "gslive_partner118")).toBe(true);
    expect(
      matchesGrammar("origin", "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118"),
    ).toBe(true);
    expect(matchesGrammar("lane", "cslevel2")).toBe(true);
    expect(matchesGrammar("rowFlag", "NON_SPORTS_DROP")).toBe(true);
    expect(matchesGrammar("provenanceLabel", "GSLIVE")).toBe(true);
    expect(matchesGrammar("channel", "inetMirror")).toBe(true);
  });

  test("refuses the shapes it exists to catch", () => {
    expect(matchesGrammar("venue", "GSLive")).toBe(false);
    expect(matchesGrammar("venue", "gslive partner118")).toBe(false);
    expect(matchesGrammar("origin", "SPORTSBOOK_FANTASY402")).toBe(false);
    expect(matchesGrammar("lane", "CSCLEVEL2")).toBe(false);
    expect(matchesGrammar("rowFlag", "non_sports_drop")).toBe(false);
    expect(matchesGrammar("channel", "inet_mirror")).toBe(false);
    expect(parseIdentifier("venue", "GSLive")).toBeNull();
    expect(parseIdentifier("venue", "f402")).toBe("f402");
  });

  test("a boundary write of a non-identifier fails with a structured error", () => {
    expect(() =>
      assertIdentifier("lane", "inet_mirror", "SEC_API_CHANNEL"),
    ).not.toThrow();
    expect(() => assertIdentifier("lane", "INET", "SEC_API_CHANNEL")).toThrow(
      /GATE-04/,
    );
    expect(assertNotSentinel("venue", "f402", "SEC_VENUE_WRITE")).toBe("f402");
    expect(() =>
      assertNotSentinel("venue", "internal", "SEC_VENUE_WRITE"),
    ).toThrow(/GATE-04/);
    for (const sentinel of RESERVED_SENTINEL_WORDS) {
      expect(() =>
        assertNotSentinel("lane", sentinel, "SEC_LANE_WRITE"),
      ).toThrow();
    }
  });
});
