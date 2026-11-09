/**
 * Canonical JSON bytes for match evaluation — golden pins and SQLite storage.
 */

import type { Sha256Hex } from "./brand.ts";
import { sha256HexOfBytes } from "../services/sportsdesk_ingestion_feed_provenance.ts";
import type { MatchEvaluationResult } from "./candidate_match_evaluation.ts";
import { canonicalJsonString } from "./canonical_json.ts";

export { canonicalJsonString } from "./canonical_json.ts";

export function serializeMatchEvaluationResult(
  result: MatchEvaluationResult,
): string {
  return canonicalJsonString(result);
}

export function hashEvaluationResult(result: MatchEvaluationResult): Sha256Hex {
  return sha256HexOfBytes(
    new TextEncoder().encode(serializeMatchEvaluationResult(result)),
  );
}

export function hashCanonicalJsonBytes(text: string): Sha256Hex {
  return sha256HexOfBytes(new TextEncoder().encode(text));
}
