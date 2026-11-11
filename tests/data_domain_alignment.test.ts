import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  agentIdentifier,
  centsToDollars,
  customerIdentifier,
  isIsoDateTimeUtc,
  isoDateTimeUtc,
  isSha256Hex,
  parseAsCents,
  parseAsEpochSec,
} from "../design/domain-branded-types.ts";
import {
  classifyArtifactBasis,
  extractArtifactProvenanceEnvelope,
  inspectArtifactFileProvenance,
  parseSourcesTxtArtifactPaths,
  SOURCES_ARTIFACT_CONTRACTS,
} from "../lib/artifact_domain_provenance.ts";
import { auditRunAt, auditRunId } from "../lib/audit_run_id.ts";
import { inspectBlobSource } from "../lib/blob_ingest.ts";
import {
  createMatchEvaluationStore,
  evaluateCandidateOverlay,
} from "../lib/candidate_match_evaluation.ts";
import {
  createCandidateTicketStore,
  enrich,
} from "../lib/candidate_ticket_enrich.ts";
import {
  createComboVenueStore,
  hashComboWire,
} from "../lib/combo_venue_store.ts";
import {
  createWagerSettlementStore,
  verifyWagerSettlementStoreSchema,
} from "../lib/fantasy402_settlement_ingest.ts";
import {
  assertSqliteStoreMatchesRegistry,
  CANDIDATE_TICKETS_SCHEMA,
  COMBO_LEGS_SCHEMA,
  INGESTION_TRADES_SCHEMA,
  MATCH_EVALUATIONS_SCHEMA,
  renderCreateTableDdl,
  SPORTSDESK_SQLITE_TABLES,
  WAGER_SETTLEMENT_SCHEMA,
} from "../lib/sqlite_schema_registry.ts";
import { openSportsdeskSqlite } from "../lib/sportsdesk_sqlite.ts";
import {
  normalizeDeskBasis,
  normalizeDeskEntityId,
  parseKalshiPayload,
  parseLiveBetsListPayload,
  parseLiveBetsSummaryPayload,
  toDeskBasisPoints,
  toDeskCents,
  usdToDeskCents,
} from "../packages/nsh-desk/desk_model.ts";
import { createIngestionReplayDatabase } from "../services/sportsdesk_ingestion_replay.ts";
import {
  liveBetsSourceToBasis,
  parseLiveBetsProvenance,
  toValidatedLiveBetGameExposure,
} from "../src/contracts/live_bets.v2.ts";
import { resolveLiveBets } from "../src/live_bets/resolve.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("cross-layer data-domain alignment", () => {
  test("all 5 SSOT SQLite stores match SPORTSDESK_SQLITE_TABLES DDL and branded domain invariants", () => {
    expect(SPORTSDESK_SQLITE_TABLES).toHaveLength(5);
    for (const def of SPORTSDESK_SQLITE_TABLES) {
      expect(typeof def.domain).toBe("string");
      expect(def.domain.length).toBeGreaterThan(0);
      const ddl = renderCreateTableDdl(def);
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${def.name}`);
    }

    const dbCombo = openSportsdeskSqlite(":memory:");
    const comboStore = createComboVenueStore(dbCombo);
    assertSqliteStoreMatchesRegistry(dbCombo, COMBO_LEGS_SCHEMA);
    const wireDigest = hashComboWire({ marker: "combo-domain" });
    expect(isSha256Hex(wireDigest)).toBe(true);
    comboStore.insertObservation({
      canonicalComboId: "combo-1",
      venue: "internal",
      venueRef: "T-100",
      validTime: "2026-11-11T18:00:00.000Z",
      legs: [],
      runId: auditRunId("domain-test"),
      runAt: auditRunAt("2026-11-11T18:00:01.000Z"),
    });
    expect(() =>
      comboStore.insertObservation({
        canonicalComboId: "combo-bad",
        venue: "internal",
        venueRef: "T-101",
        validTime: "not-an-iso-timestamp",
        legs: [],
        runId: auditRunId("domain-test"),
        runAt: auditRunAt("2026-11-11T18:00:01.000Z"),
      }),
    ).toThrow(/IsoTime/);
    dbCombo.close();

    const dbCand = openSportsdeskSqlite(":memory:");
    const candStore = createCandidateTicketStore(dbCand);
    assertSqliteStoreMatchesRegistry(dbCand, CANDIDATE_TICKETS_SCHEMA);
    const enriched = enrich(
      { matchKey: "NBA|501", timeDiff: 4 },
      { matchKey: "NBA|501", raw: { ShortName1: "BOS", ShortName2: "LAL" } },
    );
    expect(isSha256Hex(enriched.policySha256)).toBe(true);
    candStore.write(enriched);
    expect(candStore.query("SELECT * FROM candidate_tickets")).toHaveLength(1);
    dbCand.close();

    const dbEval = openSportsdeskSqlite(":memory:");
    const evalStore = createMatchEvaluationStore(dbEval);
    assertSqliteStoreMatchesRegistry(dbEval, MATCH_EVALUATIONS_SCHEMA);
    const evalRes = evaluateCandidateOverlay(
      {
        matchKey: "NBA|501",
        timeDifferenceMs: 5,
        payload: { SportType: "Basketball", SportSubType: "NBA" },
      },
      {
        matchKey: "NBA|501",
        payload: {
          SportType: "Basketball",
          SportSubType: "NBA",
          ShortName1: "BOS",
        },
      },
    );
    evalStore.insertEvaluation({
      result: evalRes,
      replayInput: {
        ticker: { matchKey: "NBA|501", timeDifferenceMs: 5, payload: {} },
        pending: { matchKey: "NBA|501", payload: {} },
        validTime: "2026-11-11T18:00:00.000Z",
      },
      runId: auditRunId("eval-domain"),
      runAt: auditRunAt("2026-11-11T18:00:01.000Z"),
    });
    expect(Number(evalStore.countByPolicy(evalRes.policySha256))).toBe(1);
    dbEval.close();

    const dbSettle = openSportsdeskSqlite(":memory:");
    createWagerSettlementStore(dbSettle);
    verifyWagerSettlementStoreSchema(dbSettle);
    assertSqliteStoreMatchesRegistry(dbSettle, WAGER_SETTLEMENT_SCHEMA);
    dbSettle.close();

    const dbReplay = createIngestionReplayDatabase();
    assertSqliteStoreMatchesRegistry(dbReplay, INGESTION_TRADES_SCHEMA);
    dbReplay.close();
  });

  test("assertSqliteStoreMatchesRegistry detects live column/type/nullability drift", () => {
    const db = openSportsdeskSqlite(":memory:");
    db.exec("CREATE TABLE candidate_tickets (match_key INTEGER);");
    expect(() =>
      assertSqliteStoreMatchesRegistry(db, CANDIDATE_TICKETS_SCHEMA),
    ).toThrow(/drifted from SPORTSDESK_SQLITE_TABLES/);
    db.close();
  });

  test("lib/blob_ingest.ts validates Sha256Hex via brand constructor without unvalidated casts", async () => {
    const srcText = await Bun.file(
      resolve(REPO_ROOT, "lib/blob_ingest.ts"),
    ).text();
    expect(srcText).not.toContain("as Sha256Hex");

    const inspected = await inspectBlobSource(
      '{"Pending":[]}',
      "application/json",
    );
    expect(isSha256Hex(inspected.sha256)).toBe(true);
  });

  test("live_bets.v2 and NSH Desk align provenance basis, integer Cents, and entity identifiers", async () => {
    expect(liveBetsSourceToBasis("db")).toBe("live");
    expect(liveBetsSourceToBasis("file")).toBe("capture");
    expect(liveBetsSourceToBasis("fixture")).toBe("fixture");
    expect(liveBetsSourceToBasis("none")).toBe("none");

    expect(normalizeDeskBasis("db")).toBe("live");
    expect(normalizeDeskBasis("file")).toBe("capture");
    expect(normalizeDeskBasis("fixture")).toBe("fixture");
    expect(normalizeDeskBasis("PARTIAL")).toBe("partial");

    const resolved = await resolveLiveBets(
      {
        source: "fixture",
        fallback: "strict",
        path: "tests/f402-pending-wager-sample.json",
      },
      {
        repoRoot: REPO_ROOT,
        now: () => new Date("2026-11-11T19:00:00.000Z"),
        scoreboard: null,
      },
    );

    expect(resolved.provenance.basis).toBe("fixture");
    expect(isSha256Hex(resolved.provenance.hash)).toBe(true);
    expect(isIsoDateTimeUtc(resolved.provenance.generatedAt)).toBe(true);

    const validatedProv = parseLiveBetsProvenance(
      {
        path: resolved.provenance.path,
        hash: resolved.provenance.hash,
        generatedAt: resolved.provenance.generatedAt,
      },
      resolved.dataSource,
    );
    expect(validatedProv.basis).toBe("fixture");

    expect(resolved.games.length).toBeGreaterThan(0);
    const firstGame = resolved.games[0]!;
    const domainGame = toValidatedLiveBetGameExposure(firstGame);
    expect(domainGame.wageredCents).toBe(parseAsCents(22_400_000, true));
    expect(domainGame.toWinCents).toBe(parseAsCents(20_000_000, true));
    expect(domainGame.agentId).toBe(agentIdentifier("HRGROUP"));

    // Verify NSH Desk parses /api/v2/live-bets integer Cents without 100x USD inflation
    const deskParsed = parseLiveBetsListPayload(resolved);
    expect(deskParsed.basis).toBe("fixture");
    expect(deskParsed.provenance.basis).toBe("fixture");
    expect(deskParsed.games[0]?.matchup).toBe(
      "Arizona Cardinals vs Dallas Cowboys",
    );
    expect(deskParsed.games[0]?.league).toBe("NFL");
    expect(deskParsed.games[0]?.riskCents).toBe(toDeskCents(22_400_000));
    expect(deskParsed.games[0]?.riskUsd).toBe(
      Number(centsToDollars(domainGame.wageredCents)),
    );
    expect(deskParsed.games[0]?.toWinCents).toBe(toDeskCents(20_000_000));
    expect(deskParsed.games[0]?.toWinUsd).toBe(200_000);

    // Verify NSH Desk /api/live-bets/summary handles integer totalWagered Cents
    const deskSummary = parseLiveBetsSummaryPayload({
      summary: resolved.summary,
    });
    expect(deskSummary.totalWagers).toBe(1);
    expect(deskSummary.totalRiskCents).toBe(22_400_000);
    expect(deskSummary.totalRiskUsd).toBe(224_000);

    // Verify NSH Desk normalizes lowercase identifiers & computes integer cents/bps
    expect(normalizeDeskEntityId("  dk121 ", "unknown")).toBe(
      customerIdentifier("dk121"),
    );
    expect(usdToDeskCents(19.99)).toBe(parseAsCents(19.99, false));
    expect(Number(toDeskBasisPoints(380.4))).toBe(380);

    const kalshi = parseKalshiPayload({
      generatedAt: "2026-11-11T19:00:00.000Z",
      provenance: { basis: "live", source: "kalshi" },
      kalshi: { ok: true, degraded: false },
      signals: [
        {
          id: "NBA-1",
          league: "NBA",
          riskUsd: 125.5,
          kalshi: { edgeBps: 215, verdict: "actionable" },
          accounts: [{ login: "mj102", agentId: "mj2026", riskUsd: 125.5 }],
        },
      ],
    });
    expect(kalshi.signals[0]?.riskCents).toBe(12_550);
    expect(kalshi.signals[0]?.accounts[0]?.login).toBe("MJ102");
    expect(kalshi.signals[0]?.accounts[0]?.agentId).toBe("MJ2026");
    expect(kalshi.signals[0]?.accounts[0]?.riskCents).toBe(12_550);
  });

  test("docs/Sources.txt and SOURCES_ARTIFACT_CONTRACTS achieve 1-to-1 artifact parity and normalize provenance", async () => {
    const sourcesTxt = await Bun.file(
      resolve(REPO_ROOT, "docs/Sources.txt"),
    ).text();
    const docPaths = parseSourcesTxtArtifactPaths(sourcesTxt).sort();
    const contractPaths = SOURCES_ARTIFACT_CONTRACTS.map(
      (c) => c.artifactPath,
    ).sort();
    expect(docPaths).toEqual(contractPaths);

    expect(classifyArtifactBasis("LIVE")).toBe("live");
    expect(classifyArtifactBasis("PARTIAL")).toBe("capture");
    expect(classifyArtifactBasis("fixture:sample.json")).toBe("fixture");

    // Missing files return basis="missing" and exists=false (never fake zero)
    const missingEnv = await inspectArtifactFileProvenance(
      REPO_ROOT,
      "data/does-not-exist-ever.json",
    );
    expect(missingEnv.exists).toBe(false);
    expect(missingEnv.basis).toBe("missing");
    expect(missingEnv.asOfUtc).toBeNull();
    expect(missingEnv.sha256).toBeNull();

    // Present artifacts normalize heterogeneous timestamp keys into IsoDateTimeUtc + Sha256Hex
    const bridgeEnv = await inspectArtifactFileProvenance(
      REPO_ROOT,
      "docs/cross-domain-bridge.json",
      { nowMs: Date.parse("2026-11-11T19:00:00.000Z") },
    );
    expect(bridgeEnv.exists).toBe(true);
    expect(bridgeEnv.domainId).toBe("cross-domain-bridge");
    expect(isSha256Hex(bridgeEnv.sha256)).toBe(true);
    if (bridgeEnv.asOfUtc !== null) {
      expect(isIsoDateTimeUtc(bridgeEnv.asOfUtc)).toBe(true);
      expect(bridgeEnv.ageSeconds).not.toBeNull();
    }

    const syntheticLiveWagers = extractArtifactProvenanceEnvelope(
      "data/live-wagers.json",
      {
        schemaVersion: 1,
        source: "Manager/getBetTicker",
        observedAt: "2026-11-11T18:45:00.000Z",
        partial: true,
        LIST: [],
      },
      { nowMs: Date.parse("2026-11-11T19:00:00.000Z") },
    );
    expect(syntheticLiveWagers.domainId).toBe("book-ticker");
    expect(syntheticLiveWagers.basis).toBe("capture");
    expect(syntheticLiveWagers.asOfUtc).toBe(
      isoDateTimeUtc("2026-11-11T18:45:00.000Z"),
    );
    expect(syntheticLiveWagers.ageSeconds).toBe(parseAsEpochSec(900));
    expect(syntheticLiveWagers.stale).toBe(false);
    expect(syntheticLiveWagers.partial).toBe(true);
  });
});
