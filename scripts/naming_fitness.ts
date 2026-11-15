#!/usr/bin/env bun
// ============================================================================
// naming_fitness.ts — the five guarantees from the migration plan, executable.
//
// Each check is named after the guarantee it enforces, prints its counterexample
// when it fails, and the process exits 1 if ANY guarantee is violated. The point
// is a gate that FAILS on the current state and passes after the renames; a green
// run today would mean the checks are wrong.
//
//   bun scripts/naming_fitness.ts          human output, exit 0/1
//   bun scripts/naming_fitness.ts --json   machine output
//
// CI wiring: run this in the release gate after the rename sequence lands. It is
// not part of `bun test` because it is expected to fail until then, and a
// permanently red unit suite trains people to ignore it.
// ============================================================================
import {
  ORIGIN_DOMAIN_REGISTRY,
  SENTINEL_CHANNEL_REGISTRY,
  VENUE_REGISTRY,
  WRITER_LANES_BY_ORIGIN,
  WRITER_LANE_REGISTRY,
  type OriginDomainId,
  type SentinelChannelId,
  type VenueId,
  type WriterLaneId,
} from "../lib/domain_venue_registry.ts";
import { SENTINEL_CHANNEL_WIRE_ID } from "../lib/domain-enums.ts";
import { F402_BET_TICKER_SENTINEL_CHANNELS } from "../lib/f402_bet_ticker_delta.ts";
import {
  IDENTIFIER_GRAMMAR,
  RESERVED_SENTINEL_WORDS,
  matchesGrammar,
} from "../lib/identifier_grammar.ts";

const venueIds = Object.keys(VENUE_REGISTRY) as VenueId[];
const originIds = Object.keys(ORIGIN_DOMAIN_REGISTRY) as OriginDomainId[];
const laneIds = Object.keys(WRITER_LANE_REGISTRY) as WriterLaneId[];
const sentinelIds = Object.keys(
  SENTINEL_CHANNEL_REGISTRY,
) as SentinelChannelId[];
const rowFlags = [
  ...F402_BET_TICKER_SENTINEL_CHANNELS,
  ...sentinelIds.map((id) => SENTINEL_CHANNEL_REGISTRY[id].provenanceLabel),
];

interface Check {
  readonly guarantee: string;
  readonly rule: string;
  run(): string[];
}

const checks: readonly Check[] = [
  {
    guarantee: "noLaneIdIsARowFlag",
    rule: "a lane id never spells a row flag, case-insensitively",
    run: () =>
      laneIds.filter((lane) =>
        rowFlags.some((flag) => flag.toLowerCase() === lane.toLowerCase()),
      ),
  },
  {
    guarantee: "everyVenueHasOneKindAndOneOrigin",
    rule: "each venue has exactly one kind and exactly one origin",
    run: () =>
      venueIds
        .filter((id) => VENUE_REGISTRY[id].originDomainIds.length !== 1)
        .map(
          (id) => `${id}: ${VENUE_REGISTRY[id].originDomainIds.length} origins`,
        ),
  },
  {
    guarantee: "laneIdMatchesProvenanceLabel",
    rule: "each lane's provenance label is its id in UPPER_SNAKE",
    run: () =>
      laneIds
        .filter(
          (lane) =>
            WRITER_LANE_REGISTRY[lane].provenanceLabel !== lane.toUpperCase(),
        )
        .map(
          (lane) =>
            `${lane} -> "${WRITER_LANE_REGISTRY[lane].provenanceLabel}"`,
        ),
  },
  {
    guarantee: "sentinelsAreNotWritableFeeds",
    rule: "no venue id or lane id is a reserved sentinel word",
    run: () => [
      ...venueIds
        .filter((id) => RESERVED_SENTINEL_WORDS.includes(id))
        .map((id) => `venue ${id}`),
      ...laneIds
        .filter((id) => RESERVED_SENTINEL_WORDS.includes(id))
        .map((id) => `lane ${id}`),
    ],
  },
  {
    guarantee: "everyOriginHasTokenMatchedLane",
    // Scoped to origins that CLAIM a writer lane: an exchange that trades over
    // its own API publishes no ticket writer, so having no lane is a fact to
    // state, not a violation to paper over.
    rule: "each origin with writer lanes wears its default token on one of them",
    run: () =>
      originIds
        .filter((origin) => WRITER_LANES_BY_ORIGIN[origin].length > 0)
        .filter((origin) => {
          const token = ORIGIN_DOMAIN_REGISTRY[origin].defaultTokenCode;
          return !WRITER_LANES_BY_ORIGIN[origin].some(
            (lane) => WRITER_LANE_REGISTRY[lane].tokenProvenanceCode === token,
          );
        }),
  },
  {
    guarantee: "everySentinelChannelHasAPinnedWireId",
    rule: "each sentinel class keeps its frozen byte (alert 1, blocked 7, non_sports_drop 8, unknown 0)",
    run: () => {
      const pinned: Record<SentinelChannelId, number> = {
        alert: 1,
        blocked: 7,
        non_sports_drop: 8,
        unknown: 0,
      };
      return sentinelIds
        .filter((id) => SENTINEL_CHANNEL_WIRE_ID[id] !== pinned[id])
        .map(
          (id) =>
            `${id}: wire ${SENTINEL_CHANNEL_WIRE_ID[id]} != ${pinned[id]}`,
        );
    },
  },
  {
    guarantee: "identifiersMatchTheirCasingRule",
    rule: "every declared id matches the grammar for its kind",
    run: () => {
      const violations: string[] = [];
      for (const id of venueIds)
        if (!matchesGrammar("venue", id)) violations.push(`venue ${id}`);
      for (const id of originIds)
        if (!matchesGrammar("origin", id)) violations.push(`origin ${id}`);
      for (const id of laneIds)
        if (!matchesGrammar("lane", id)) violations.push(`lane ${id}`);
      for (const flag of rowFlags)
        if (!matchesGrammar("rowFlag", flag))
          violations.push(`rowFlag ${flag}`);
      for (const lane of laneIds) {
        const label = WRITER_LANE_REGISTRY[lane].provenanceLabel;
        if (!matchesGrammar("provenanceLabel", label))
          violations.push(`provenanceLabel "${label}" (lane ${lane})`);
      }
      return violations;
    },
  },
];

const results = checks.map((check) => ({
  guarantee: check.guarantee,
  rule: check.rule,
  violations: check.run(),
}));
const failed = results.filter((r) => r.violations.length > 0);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
} else {
  for (const result of results) {
    const status = result.violations.length === 0 ? "PASS" : "FAIL";
    console.log(`${status}  ${result.guarantee}`);
    console.log(`      ${result.rule}`);
    for (const violation of result.violations)
      console.log(`      - ${violation}`);
  }
  console.log(
    failed.length === 0
      ? "\nall guarantees hold"
      : `\n${failed.length}/${results.length} guarantees violated — this is the pre-refactor state`,
  );
}
// Grammar reference is exported so the gate and the contract layer cannot drift.
const GRAMMAR_KINDS = 8;
if (Object.keys(IDENTIFIER_GRAMMAR).length !== GRAMMAR_KINDS) {
  console.error(
    `identifier grammar declares ${Object.keys(IDENTIFIER_GRAMMAR).length} kinds, expected ${GRAMMAR_KINDS}`,
  );
  process.exit(2);
}
process.exit(failed.length === 0 ? 0 : 1);
