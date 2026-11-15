// ============================================================================
// identifier_grammar.ts — the casing grammar as executable validators.
//
// This is the CONTRACT LAYER, not the naming document: each exported function
// answers one question about one identifier kind, so a write boundary can reject
// a non-conforming value instead of storing it and discovering the drift later.
//
// The grammar encoded here was derived from the artifacts, and where an artifact
// contradicts it the contradiction is reported by the test suite rather than
// smoothed over here:
//
//   venue            lower_snake, and never a reserved sentinel word
//   origin           UPPER_ with an ORIGIN_ prefix
//   lane             lower_snake
//   row flag         UPPER_SNAKE
//   provenance label UPPER_SNAKE
//   channel (API)    camelCase
//
// A "suffix" rule for VenueId/OriginId was proposed but does not hold on the
// artifacts: only two of six origins end in a location-like tail
// (_PARTNER118, _CTF) and three venue ids have no suffix at all, so no suffix
// pattern is enforced here. See docs/naming-refactor-migration.md.
// ============================================================================
import { DodGateFailureError } from "./bridge_and_channel_router.ts";

export type IdentifierKind =
  | "venue"
  | "origin"
  | "lane"
  | "rowFlag"
  | "provenanceLabel"
  | "channel"
  | "sentinel"
  | "channelSlug";

interface GrammarRule {
  readonly pattern: RegExp;
  readonly rule: string;
  readonly example: string;
}

export const IDENTIFIER_GRAMMAR: Readonly<Record<IdentifierKind, GrammarRule>> =
  {
    venue: {
      pattern: /^[a-z][a-z0-9_]*$/,
      rule: "lower_snake",
      example: "gslive_partner118",
    },
    origin: {
      pattern: /^ORIGIN_[A-Z0-9]+(?:_[A-Z0-9]+)*$/,
      rule: "UPPER_ with ORIGIN_ prefix",
      example: "ORIGIN_SPORTSBOOK_FANTASY402",
    },
    lane: {
      pattern: /^[a-z][a-z0-9_]*$/,
      rule: "lower_snake",
      example: "cslevel2",
    },
    rowFlag: {
      pattern: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
      rule: "UPPER_SNAKE",
      example: "NON_SPORTS_DROP",
    },
    provenanceLabel: {
      pattern: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
      rule: "UPPER_SNAKE",
      example: "GSLIVE",
    },
    channel: {
      pattern: /^[a-z][A-Za-z0-9]*$/,
      rule: "camelCase",
      example: "inetMirror",
    },
    sentinel: {
      pattern: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
      rule: "UPPER_SNAKE",
      example: "NON_SPORTS_DROP",
    },
    // NOT camelCase: the published `/api/v1/live-bets` channel is a kebab-case
    // slug (`^[a-z0-9-]{1,32}$`). Recorded as an exception, not smoothed over.
    channelSlug: {
      pattern: /^[a-z0-9-]{1,32}$/,
      rule: "kebab-case, 1..32 chars",
      example: "inet-mirror",
    },
  };

/**
 * Words that name a state rather than a feed. After the refactor none of them
 * may be a venue id or a lane id, because a filter on them silently selects a
 * sentinel instead of a market.
 */
export const RESERVED_SENTINEL_WORDS: readonly string[] = [
  "internal",
  "unknown",
  "unresolved",
  "blocked",
];

export function matchesGrammar(
  kind: IdentifierKind,
  value: unknown,
): value is string {
  return (
    typeof value === "string" && IDENTIFIER_GRAMMAR[kind].pattern.test(value)
  );
}

/** Parse at an I/O boundary: null means "not an identifier of this kind". */
export function parseIdentifier(
  kind: IdentifierKind,
  value: unknown,
): string | null {
  return matchesGrammar(kind, value) ? value : null;
}

/** Assert at a write boundary: a structured failure naming the violated rule. */
export function assertIdentifier(
  kind: IdentifierKind,
  value: unknown,
  section: string,
): string {
  if (!matchesGrammar(kind, value)) {
    throw new DodGateFailureError({
      gate: 4,
      section,
      expected: `${kind} must match ${IDENTIFIER_GRAMMAR[kind].rule} (e.g. ${IDENTIFIER_GRAMMAR[kind].example})`,
      actual: String(value),
    });
  }
  return value;
}

/** A reserved sentinel word presented as a feed id is a boundary error. */
export function assertNotSentinel(
  kind: "venue" | "lane",
  value: string,
  section: string,
): string {
  if (RESERVED_SENTINEL_WORDS.includes(value)) {
    throw new DodGateFailureError({
      gate: 4,
      section,
      expected: `${kind} must name a feed, not a state (reserved: ${RESERVED_SENTINEL_WORDS.join(", ")})`,
      actual: value,
    });
  }
  return value;
}
