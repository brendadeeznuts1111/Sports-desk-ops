import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `bun run ticket` reads a `getBetTicker` artifact. The fixture rows carry customer logins and
 * agent ids, so these tests also pin that neither view leaks them.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli/sportsdesk_ticket_cli.ts");
const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-list-sample.json");
const HTML_FIXTURE = join(import.meta.dir, "fixtures/bet-ticker.html");
const TMP = mkdtempSync(join(tmpdir(), "ticket-cli-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return { code, stdout, stderr };
}

describe("sportsdesk_ticket_cli", () => {
  test("prints one ticket with its legs from a capture artifact", async () => {
    const { code, stdout } = await run(["767125863", "--file", FIXTURE]);
    expect(code).toBe(0);
    expect(stdout).toContain("Ticket 767125863");
    expect(stdout).toContain("GSLIVE");
    expect(stdout).toContain("Parlay (P)");
    expect(stdout).toContain("Stake $1,000.00");
    expect(stdout).toContain("To win $1,395.00");
    expect(stdout).toContain(
      "Football · Los Angeles Rams vs Los Angeles Chargers · Game · Winner (2 way) · Los Angeles Rams -140",
    );
    expect(stdout).toContain("New England Patriots -252");
    expect(stdout).toContain("Source: unlabelled");
  });

  test("the portal b prefix resolves to the same wager", async () => {
    const plain = await run(["767125863", "--file", FIXTURE, "--json"]);
    const prefixed = await run(["b767125863", "--file", FIXTURE, "--json"]);
    expect(plain.code).toBe(0);
    expect(prefixed.code).toBe(0);
    expect(JSON.parse(prefixed.stdout)).toEqual(JSON.parse(plain.stdout));
  });

  test("--json emits a safe view without customer or agent identifiers", async () => {
    const { code, stdout } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--json",
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as {
      wager: Record<string, unknown>;
      provenance: Record<string, unknown>;
    };
    expect(payload.wager).toMatchObject({
      wagerNumber: 767125863,
      ticketWriter: "GSLIVE",
      writer: "gslive",
      wagerType: "P",
      wagerTypeLabel: "Parlay",
      live: false,
      vip: false,
      amountWagered: 1000,
      toWinAmount: 1395,
      volumeDiffers: false,
      descCode: "P.G319747616",
    });
    expect(payload.wager.legs).toHaveLength(2);
    expect(payload.provenance).toMatchObject({
      source: "unlabelled",
      observedAt: null,
      partial: false,
    });

    // Fixture identifiers: login, customer id and agent logins/ids.
    for (const identifier of ["WC9001", "ADAM", "MARWES50", "JP1833"]) {
      expect(stdout).not.toContain(identifier);
    }
  });

  test("--list prints every ticket with the parser's leg counts", async () => {
    const { code, stdout } = await run(["--list", "--file", FIXTURE]);
    expect(code).toBe(0);
    expect(stdout).toContain("ticket");
    expect(stdout).toContain("legs");
    expect(stdout).toContain("767125863");
    expect(stdout).toContain("767126230");
    expect(stdout).toContain("7 tickets · 12 legs · avg 1.71 legs/ticket");
    for (const identifier of ["WC9001", "ADAM", "MARWES50", "JP1833"]) {
      expect(stdout).not.toContain(identifier);
    }
  });

  test("--list --json keeps one row per ticket and exact leg counts", async () => {
    const { code, stdout } = await run(["--list", "--file", FIXTURE, "--json"]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as {
      tickets: Array<{ wagerNumber: number; legs: unknown[] }>;
      totals: { tickets: number; legs: number };
      provenance: { source: string };
    };
    expect(payload.totals).toEqual({ tickets: 7, legs: 12 });
    // Naive `ShortDesc` splitting counts the M.G/P.G code line and misses `\n`-only leg
    // separators; these are the parser's counts.
    expect(
      payload.tickets.map((ticket) => [ticket.wagerNumber, ticket.legs.length]),
    ).toEqual([
      [767125863, 2],
      [767126203, 1],
      [767126205, 3],
      [767126231, 1],
      [767126258, 1],
      [767126232, 1],
      [767126230, 3],
    ]);
    expect(payload.provenance.source).toBe("unlabelled");
    for (const identifier of ["WC9001", "ADAM", "MARWES50", "JP1833"]) {
      expect(stdout).not.toContain(identifier);
    }
  });

  test("--json --normalized emits the canonical public ticket", async () => {
    const { code, stdout } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--json",
      "--normalized",
    ]);
    expect(code).toBe(0);
    const ticket = JSON.parse(stdout) as {
      wagerNumber: string;
      legs: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    expect(ticket).toMatchObject({
      wagerNumber: "767125863",
      product: "GSLIVE",
      wagerType: "P",
      wagerTypeLabel: "Parlay",
      phase: "pregame",
      stake: 1000,
      toWin: 1395,
      volume: null,
      insertedAt: "2026-11-01T23:15:02.770Z",
      descCode: "P.G319747616",
      writer: null,
      ticketWriter: "GSLIVE",
      source: "GSLIVE",
      provenance: {
        file: FIXTURE,
        capturedAt: null,
        source: "unlabelled",
      },
    });
    expect(ticket.legs[0]).toEqual({
      index: 1,
      sport: "Football",
      eventName: "Los Angeles Rams vs Los Angeles Chargers",
      period: "Game",
      market: "Winner (2 way)",
      selection: "Los Angeles Rams",
      price: "-140",
      live: false,
      gameNumber: "319747616",
    });
    for (const identifier of ["WC9001", "ADAM", "MARWES50", "JP1833"]) {
      expect(stdout).not.toContain(identifier);
    }
  });

  test("--list --json --normalized keeps the same totals", async () => {
    const { code, stdout } = await run([
      "--list",
      "--file",
      FIXTURE,
      "--json",
      "--normalized",
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(stdout) as {
      tickets: Array<{ wagerNumber: string; legs: unknown[] }>;
      totals: { tickets: number; legs: number };
    };
    expect(payload.totals).toEqual({ tickets: 7, legs: 12 });
    expect(payload.tickets.map((ticket) => ticket.wagerNumber)).toEqual([
      "767125863",
      "767126203",
      "767126205",
      "767126231",
      "767126258",
      "767126232",
      "767126230",
    ]);
    expect(payload.tickets[2]?.legs).toHaveLength(3);
  });

  test("an unknown wager exits 1 and names the artifact", async () => {
    const { code, stderr } = await run(["1", "--file", FIXTURE]);
    expect(code).toBe(1);
    expect(stderr).toContain("wager 1 not found");
    expect(stderr).toContain(FIXTURE);
  });

  test("a missing artifact exits 1 with the capture hint", async () => {
    const missing = join(TMP, "absent.json");
    const { code, stderr } = await run(["767125863", "--file", missing]);
    expect(code).toBe(1);
    expect(stderr).toContain(`${missing} not found`);
    expect(stderr).toContain("capture:bet-ticker");
  });

  test("usage errors exit 2", async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("expected exactly one wager number");

    const invalid = await run(["not-a-number", "--file", FIXTURE]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("invalid wager number");

    const extra = await run(["1", "2", "--file", FIXTURE]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("expected exactly one wager number");

    const listWithNumber = await run(["--list", "1", "--file", FIXTURE]);
    expect(listWithNumber.code).toBe(2);
    expect(listWithNumber.stderr).toContain("--list takes no wager number");

    const normalizedWithoutJson = await run([
      "767125863",
      "--normalized",
      "--file",
      FIXTURE,
    ]);
    expect(normalizedWithoutJson.code).toBe(2);
    expect(normalizedWithoutJson.stderr).toContain(
      "--normalized requires --json",
    );
  });

  test("--lang resolves ui.json labels and warns for JAPANESE", async () => {
    const spanish = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=SPANISH",
    ]);
    expect(spanish.code).toBe(0);
    expect(spanish.stdout).toContain("Boleto");
    expect(spanish.stdout).toContain("Combinada");
    expect(spanish.stdout).toContain("A Ganar");
    expect(spanish.stdout).toContain("Fuente");

    const japanese = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=JAPANESE",
    ]);
    expect(japanese.code).toBe(0);
    expect(japanese.stderr).toContain("JAPANESE → ENGLISH");
    expect(japanese.stdout).toContain("Ticket 767125863");
    expect(japanese.stdout).toContain("Parlay");
  });

  test("--lang-coverage reports the shipped table and locale gaps", async () => {
    const { code, stdout } = await run(["--lang-coverage"]);
    expect(code).toBe(0);
    expect(stdout).toContain("JAPANESE");
    expect(stdout).toContain("VIETNAMES");
    expect(stdout).toContain("1,461");
  });

  test("--html-header-map reads data-language keys from a capture", async () => {
    const { code, stdout } = await run([
      "--html-header-map",
      "--from-html",
      HTML_FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("L-213  Customer");
    expect(stdout).toContain("L-1030  Time (ET)");
  });

  test("HTML captures work through --analyze and a single lookup", async () => {
    const keys = await run([
      "--analyze",
      "--file",
      HTML_FIXTURE,
      "--lang=keys",
    ]);
    expect(keys.code).toBe(0);
    expect(keys.stdout).toContain("100 tickets");
    expect(keys.stdout).toContain("125 legs");
    expect(keys.stdout).toContain("L-83 Straight");
    expect(keys.stdout).toContain("L-84 Parlay");

    const single = await run([
      "767465259",
      "--file",
      HTML_FIXTURE,
      "--lang=SPANISH",
    ]);
    expect(single.code).toBe(0);
    expect(single.stdout).toContain("Boleto 767465259");
    expect(single.stdout).toContain("Indiana Pacers");
    expect(single.stdout).toContain("Fuente: GSLIVE");
  });

  test("--currency-scale applies to JSON and rejects non-positive values", async () => {
    const scaled = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--json",
      "--normalized",
      "--currency-scale=0.01",
    ]);
    expect(scaled.code).toBe(0);
    const ticket = JSON.parse(scaled.stdout) as {
      stake: number;
      toWin: number;
    };
    expect(ticket.stake).toBe(10);
    expect(ticket.toWin).toBe(13.95);

    const invalid = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--currency-scale=0",
    ]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("positive");
  });

  test("--capture-info reports Pace and --require-confidence gates HTML", async () => {
    const htmlInfo = await run(["--capture-info", "--file", HTML_FIXTURE]);
    expect(htmlInfo.code).toBe(0);
    expect(htmlInfo.stdout).toContain("Confidence: low");
    expect(htmlInfo.stdout).toContain("ajaxComplete-restart");
    expect(htmlInfo.stdout).toContain("71× pace-running");
    expect(htmlInfo.stdout).toContain("Sort: client");
    expect(htmlInfo.stdout).toContain("client-sorted");

    const htmlGate = await run([
      "--analyze",
      "--require-confidence=medium",
      "--file",
      HTML_FIXTURE,
    ]);
    expect(htmlGate.code).toBe(1);
    expect(htmlGate.stderr).toContain("capture confidence low");
    expect(htmlGate.stderr).toContain("ajaxComplete restarts");

    const jsonInfo = await run(["--capture-info", "--file", FIXTURE]);
    expect(jsonInfo.code).toBe(0);
    expect(jsonInfo.stdout).toContain("Status: 1 (OK)");
    expect(jsonInfo.stdout).toContain("Amounts: present (cents)");
    expect(jsonInfo.stdout).toContain("Poll model: incremental");
    expect(jsonInfo.stdout).toContain("Wager ordering: in-order");
    expect(jsonInfo.stdout).toContain("stake/to-win are in cents");
    expect(jsonInfo.stdout).toContain("Confidence: high");

    const jsonGate = await run([
      "--analyze",
      "--require-confidence=medium",
      "--file",
      FIXTURE,
    ]);
    expect(jsonGate.code).toBe(0);

    const invalid = await run(["--require-confidence=bogus"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("one of none|low|medium|high");
  });

  test("--help prints usage and exits 0", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("bun run ticket <wagerNumber>");
    expect(stdout).toContain("bun run ticket --list");
    expect(stdout).toContain("--normalized");
    expect(stdout).toContain("--lang");
    expect(stdout).toContain("--lang-coverage");
    expect(stdout).toContain("b767125863");
  });
});
