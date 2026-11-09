/**
 * @file tests/normalize_cli.test.ts
 * @description Tests for scripts/normalize.ts CLI arguments, execution, and provenance sidecar output.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  onTestFinished,
  spyOn,
} from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseCliArgs, runNormalizer } from "../scripts/normalize.ts";
import { registerPortalPeriodSqliteFunctions } from "../lib/portal_period_taxonomy.ts";

const TEST_TMP_DIR = join(import.meta.dir, "../scratch/test_normalize_tmp");

const FIXTURE_DATA = [
  // Native E Game
  JSON.stringify({
    WagerNumber: 10001,
    WagerType: "E",
    ShortDesc: "E.Football #101 Patriots - For Game",
    AmountWagered: 10000,
    Login: "CUST1",
    AgentLogin: "AG1",
    InsertDateTime: "2026-10-15 10:00:00.000",
    TicketWriter: "Internet",
  }),
  // Native E 1st Half
  JSON.stringify({
    WagerNumber: 10002,
    WagerType: "E",
    ShortDesc: "E.Football #101 Patriots - For 1st Half",
    AmountWagered: 5000,
    Login: "CUST2",
    AgentLogin: "AG1",
    InsertDateTime: "2026-10-16 11:00:00.000",
    TicketWriter: "Internet",
  }),
  // Native E 2nd Half
  JSON.stringify({
    WagerNumber: 10003,
    WagerType: "E",
    ShortDesc: "E.Basketball #501 Celtics - For 2nd Half",
    AmountWagered: 8000,
    Login: "CUST3",
    AgentLogin: "AG2",
    InsertDateTime: "2026-10-17 12:00:00.000",
    TicketWriter: "Internet",
  }),
  // Gansrow Live 1st Half
  JSON.stringify({
    WagerNumber: 10004,
    WagerType: "M",
    ShortDesc:
      "Soccer - France vs Italy / 1st Half / France derivative points Over 1.5",
    AmountWagered: 4000,
    Login: "CUST4",
    AgentLogin: "AG2",
    InsertDateTime: "2026-10-18 13:00:00.000",
    TicketWriter: "GSLIVE",
  }),
  // Out of portal: Set 1
  JSON.stringify({
    WagerNumber: 10005,
    WagerType: "E",
    ShortDesc: "Tennis - Player A - For Set 1",
    Period: "set1",
    AmountWagered: 2000,
    Login: "CUST5",
    AgentLogin: "AG3",
    InsertDateTime: "2026-10-19 14:00:00.000",
    TicketWriter: "Internet",
  }),
].join("\n");

const FIXTURE_PATH = join(TEST_TMP_DIR, "sample_wagers.jsonl");

beforeAll(() => {
  mkdirSync(TEST_TMP_DIR, { recursive: true });
  writeFileSync(FIXTURE_PATH, FIXTURE_DATA, "utf8");
});

afterAll(() => {
  rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

describe("normalize CLI parseCliArgs", () => {
  it("parses CLI flags into structured options", () => {
    const opts = parseCliArgs([
      "--mode",
      "CPV",
      "--period",
      "1",
      "--engine",
      "native",
      "--range",
      "start=2026-10-01,end=2026-10-31",
      "--output",
      "scratch/test.json",
    ]);

    expect(opts.mode).toBe("CPV");
    expect(opts.period).toBe(1);
    expect(opts.engine).toBe("native");
    expect(opts.startDate).toBe("2026-10-01");
    expect(opts.endDate).toBe("2026-10-31");
    expect(opts.outputPath).toBe("scratch/test.json");
  });

  it("uses using spyOn (Symbol.dispose) and onTestFinished for scoped cleanup", () => {
    const captured: string[] = [];
    {
      using spy = spyOn(console, "log").mockImplementation((...args) => {
        captured.push(args.join(" "));
      });
      console.log("Parsing test CLI arguments");
      expect(spy).toHaveBeenCalledTimes(1);
    }
    expect(captured[0]).toBe("Parsing test CLI arguments");

    // onTestFinished hook registers per-test cleanup
    let finishedClean = false;
    onTestFinished(() => {
      finishedClean = true;
    });
    expect(finishedClean).toBe(false);
  });
});

describe("runNormalizer execution", () => {
  it("filters native 1st Half wagers correctly", async () => {
    const { records, provenance } = await runNormalizer({
      mode: "CPV",
      period: 1,
      engine: "native",
      market: "tt",
      startDate: null,
      endDate: null,
      inputPath: FIXTURE_PATH,
      outputPath: null,
      format: "table",
    });

    expect(records.length).toBe(1);
    const first = records[0]!;
    expect(first.wagerNumber).toBe(10002);
    expect(first.risk).toBe(50.0);
    expect(provenance.stats.totalRisk).toBe(50.0);
    expect(provenance.portalPeriodLabel).toBe("1st Half");
    expect(provenance.dateFamily).toBe("Customer Volume");
  });

  it("includes Gansrow when engine is full", async () => {
    const { records } = await runNormalizer({
      mode: "CPV",
      period: 1,
      engine: "full",
      market: "tt",
      startDate: null,
      endDate: null,
      inputPath: FIXTURE_PATH,
      outputPath: null,
      format: "table",
    });

    expect(records.length).toBe(2);
    const nums = records.map((r) => r.wagerNumber);
    expect(nums).toContain(10002);
    expect(nums).toContain(10004);
  });

  it("handles out-of-portal records with period -1 and tags them", async () => {
    const { records, provenance } = await runNormalizer({
      mode: "CPV",
      period: -1,
      engine: "full",
      market: "tt",
      startDate: null,
      endDate: null,
      inputPath: FIXTURE_PATH,
      outputPath: null,
      format: "table",
    });

    expect(records.length).toBe(5);
    const setRow = records.find((r) => r.wagerNumber === 10005);
    expect(setRow?.portalPeriod).toBeNull();
    expect(setRow?.half).toBe("OUT_OF_PORTAL");
    expect(
      provenance.stats.periodBreakdown["∅ Out-of-Portal (Set)"]?.count,
    ).toBe(1);
  });

  it("produces a valid PeriodTaxonomyInspection honoring Bun.inspect custom format", async () => {
    const parsed = parseCliArgs([
      "--mode",
      "CPV",
      "--period",
      "1",
      "--engine",
      "native",
      "--inspect",
      "--input",
      FIXTURE_PATH,
    ]);

    expect(parsed.inspect).toBe(true);
    expect(parsed.format).toBe("inspect");

    const {
      records,
      provenance: _provenance,
      inspection,
    } = await runNormalizer(parsed);
    expect(records.length).toBe(1);
    expect(inspection).toBeDefined();

    const inspectStr = Bun.inspect(inspection, { colors: false });
    expect(inspectStr).toContain(
      "=== Portal Period Taxonomy Inspection Report ===",
    );
    expect(inspectStr).toContain(
      "Report Mode       : CPV (Customer Volume Family)",
    );
    expect(inspectStr).toContain("Period Filter     : [1] 1st Half");
    expect(inspectStr).toContain("Sample Normalized Records (1):");
  });

  it("normalizes records directly from an in-memory web File instance", async () => {
    const memFile = new File([FIXTURE_DATA], "sample_wagers.jsonl", {
      type: "application/x-ndjson",
    });
    expect(memFile.name).toBe("sample_wagers.jsonl");
    expect(memFile.type).toBe("application/x-ndjson");
    expect(memFile.size).toBeGreaterThan(0);
    expect(await memFile.text()).toContain("CUST1");

    const { records, provenance } = await runNormalizer({
      mode: "CPV",
      period: 1,
      engine: "native",
      market: "tt",
      startDate: null,
      endDate: null,
      inputPath: memFile,
      outputPath: null,
      format: "table",
    });

    expect(records.length).toBe(1);
    expect(records[0]!.wagerNumber).toBe(10002);
    expect(records[0]!.portalPeriod).toBe(1);
    expect(provenance.stats.totalProcessed).toBe(4);
  });

  it("parses --sqlite CLI option and bulk ingests into SQLite database", async () => {
    const sqlitePath = join(TEST_TMP_DIR, "test_norm_wagers.sqlite");
    const parsed = parseCliArgs([
      "--mode",
      "CPV",
      "--period",
      "1",
      "--engine",
      "native",
      "--sqlite",
      sqlitePath,
      "--input",
      FIXTURE_PATH,
    ]);

    expect(parsed.sqlitePath).toBe(sqlitePath);

    const { records } = await runNormalizer(parsed);
    expect(records.length).toBe(1);

    const db = new Database(sqlitePath);
    registerPortalPeriodSqliteFunctions(db);
    const row = db
      .query(
        "SELECT wager_number, portal_period_label(portal_period) as period_label, sum_risk_cents(risk) as cents FROM normalized_wagers",
      )
      .get() as {
      wager_number: string;
      period_label: string;
      cents: number;
    } | null;

    expect(row?.wager_number).toBe("10002");
    expect(row?.period_label).toBe("1st Half");
    expect(row?.cents).toBe(5000);

    db.close();
    try {
      unlinkSync(sqlitePath);
    } catch {
      // ignore
    }
  });
});
