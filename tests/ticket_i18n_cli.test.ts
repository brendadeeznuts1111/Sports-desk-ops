import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ticket CLI's i18n surface: labels come from the same ui.json the Manager app renders
 * (tests/fixtures/ui.json), `--lang=keys` reverses to L-keys, `--lang-coverage` exposes locale
 * gaps, `--html-header-map` maps data-language attributes, and JAPANESE warns instead of
 * replicating the upstream GREEK bug. Every assertion is offline.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "cli/sportsdesk_ticket_cli.ts");
const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-list-sample.json");
const HTML_FIXTURE = join(
  import.meta.dir,
  "fixtures/portal-agent-performance-filterbar-2026-11-01.html",
);
const TMP = mkdtempSync(join(tmpdir(), "ticket-i18n-"));
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

describe("ticket --lang", () => {
  test("SPANISH resolves labels from ui.json (not hardcoded English)", async () => {
    const { code, stdout } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=SPANISH",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Combinada (P)"); // L-84
    expect(stdout).toContain("A Ganar"); // L-245
    expect(stdout).toContain("Fuente:"); // L-1029
  });

  test("keys mode renders the raw L-keys", async () => {
    const { code, stdout } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=keys",
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("L-38 767125863"); // Ticket
    expect(stdout).toContain("L-84 (P)"); // Parlay
    expect(stdout).toContain("L-245 $1,395.00"); // To Win
    expect(stdout).toContain("L-1029: unlabelled"); // Source
  });

  test("JAPANESE warns and falls back to ENGLISH, never Greek", async () => {
    const { code, stdout, stderr } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=JAPANESE",
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain("JAPANESE → ENGLISH fallback");
    expect(stderr).toContain("does not replicate");
    expect(stdout).toContain("Ticket 767125863");
    expect(stdout).toContain("Parlay (P)");
    expect(/[\u0370-\u03ff]/.test(stdout)).toBe(false); // no Greek glyphs
  });

  test("an unknown language is a usage error (exit 2) listing the codes", async () => {
    const { code, stderr } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=KLINGON",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown --lang");
    expect(stderr).toContain("SPANISH");
    expect(stderr).toContain("keys");
  });

  test("--ui-table overrides the extracted table and falls back to literals", async () => {
    const tablePath = join(TMP, "ui.json");
    writeFileSync(
      tablePath,
      JSON.stringify({
        "L-84": { ENGLISH: "Parlay", SPANISH: "Combinada de prueba" },
        "L-245": { ENGLISH: "To Win", SPANISH: "A ganar prueba" },
      }),
    );
    const { code, stdout } = await run([
      "767125863",
      "--file",
      FIXTURE,
      "--lang=SPANISH",
      "--ui-table",
      tablePath,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Combinada de prueba (P)");
    expect(stdout).toContain("A ganar prueba");
    // The override table has no L-38; the label falls back to the English literal.
    expect(stdout).toContain("Ticket 767125863");
  });
});

describe("ticket analysis modes", () => {
  test("--analyze groups by ticket structure with English labels by default", async () => {
    const { code, stdout } = await run(["--analyze", "--file", FIXTURE]);
    expect(code).toBe(0);
    expect(stdout).toContain("Ticket structures · 7 tickets · 12 legs");
    expect(stdout).toContain("Straight");
    expect(stdout).toContain("Parlay");
    expect(stdout).toContain("Source:");
  });

  test("--analyze --lang=keys shows the L-key beside the English name", async () => {
    const { code, stdout } = await run([
      "--analyze",
      "--lang=keys",
      "--file",
      FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("L-83 Straight");
    expect(stdout).toContain("L-84 Parlay");
    expect(stdout).toContain("L-1029:");
  });

  test("--analyze --lang=SPANISH localizes the structure labels", async () => {
    const { code, stdout } = await run([
      "--analyze",
      "--lang=SPANISH",
      "--file",
      FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("Sencilla");
    expect(stdout).toContain("Combinada");
    expect(stdout).toContain("Fuente:");
  });

  test("--analyze takes no wager number", async () => {
    const { code, stderr } = await run(["--analyze", "767125863"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--analyze takes no wager number");
  });
});

describe("ui.json diagnostics", () => {
  test("--lang-coverage reports the measured per-language gaps", async () => {
    const { code, stdout } = await run(["--lang-coverage"]);
    expect(code).toBe(0);
    expect(stdout).toContain("UI language coverage");
    expect(stdout).toContain("1,461 keys");
    expect(stdout).toContain("JAPANESE");
    expect(stdout).toMatch(/JAPANESE.*\b0\b.*\b1461\b/);
    expect(stdout).toContain("VIETNAMES"); // the upstream typo is surfaced, not hidden
  });

  test("--html-header-map maps the capture header L-keys to English", async () => {
    const { code, stdout } = await run(["--html-header-map"]);
    expect(code).toBe(0);
    expect(stdout).toContain("L-213  Customer");
    expect(stdout).toContain("L-152  Type");
    expect(stdout).toContain("L-1029  Source");
    expect(stdout).toContain("L-1030  Time (ET)");
  });

  test("--html-header-map --from-html extracts the keys actually in a capture", async () => {
    const { code, stdout } = await run([
      "--html-header-map",
      "--from-html",
      HTML_FIXTURE,
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("L-998  All Action");
    expect(stdout).toContain("L-330  Customer Performance");
    expect(stdout.split("\n").length).toBeGreaterThan(5);
  });

  test("a non-capture --from-html is refused with a clear message", async () => {
    const path = join(TMP, "not-a-capture.html");
    writeFileSync(path, "<html><body>nothing here</body></html>");
    const { code, stderr } = await run([
      "--html-header-map",
      "--from-html",
      path,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('no data-language="L-..." attributes');
  });
});
