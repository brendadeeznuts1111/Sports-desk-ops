import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyAnchorSync,
  auditCitations,
  citationKey,
  collectDocCitations,
  extractCitations,
  parseCitationAnchors,
  planAnchorSync,
  rewriteCitationKey,
  rewriteFileCitations,
  unusedAnchors,
  type Citation,
} from "../scripts/check_spec_citations.ts";

/**
 * Prose citations in the evidence docs rot silently.
 *
 * They are hand-written strings like `services/sportsdesk_webview_server.ts:1007-1026`, so moving
 * code does not update them. Measured 2026-11-01: 18 of 110 in docs/openapi.json no longer
 * pointed at code. Measured 2026-11-02: about 40 citations into the webview server landed on
 * unrelated, non-blank code and passed a check that only rejected blank or punctuation lines.
 *
 * So each citation carries a content anchor that must sit on its first cited line; a shifted
 * range fails and names the line the anchor moved to.
 */

const ROOT = resolve(import.meta.dir, "..");

const citation = (file: string, start: number, end = start): Citation => ({
  file,
  start,
  end,
  context: "test",
  external: false,
});

const NO_ANCHORS = new Map<string, string>();

/** A throwaway repo whose one file has known line numbers, so drift tests pin nothing in the tree. */
const FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "spec-citations-"));
const FIXTURE = "handler.ts";
await Bun.write(
  join(FIXTURE_ROOT, FIXTURE),
  [
    'import { serve } from "bun";', // 1
    "", // 2
    'if (pathname === "/health") {', // 3
    "  return Response.json({ ok: true });", // 4
    "}", // 5
    'if (pathname === "/api/status") {', // 6
    "  return Response.json({ up: 1 });", // 7
    "}", // 8
  ].join("\n"),
);
afterAll(() => rmSync(FIXTURE_ROOT, { recursive: true, force: true }));

const HEALTH = new Map([[`${FIXTURE}:3-5`, 'pathname === "/health"']]);

describe("extractCitations", () => {
  test("finds single lines and ranges", () => {
    const text = "see `services/x.ts:12` and `lib/y.md:3-9`";
    expect(
      extractCitations(text).map((c) => `${c.file}:${c.start}-${c.end}`),
    ).toEqual(["services/x.ts:12-12", "lib/y.md:3-9"]);
  });

  test("ignores text that is not a file:line citation", () => {
    expect(extractCitations("version 1.4.4 and 12:30")).toEqual([]);
  });

  test("a comma list is one citation per range", () => {
    expect(
      extractCitations("design/types.ts:9,136-154").map(citationKey),
    ).toEqual(["design/types.ts:9", "design/types.ts:136-154"]);
  });

  test("ledger prefixes are stripped; only zip: is external", () => {
    const found = extractCitations(
      "main:lib/a.ts:1 fixture:tests/b.json:2-3 zip:customer/report.ts:4",
    );
    expect(found.map((c) => [citationKey(c), c.external])).toEqual([
      ["lib/a.ts:1", false],
      ["tests/b.json:2-3", false],
      ["customer/report.ts:4", true],
    ]);
  });
});

describe("auditCitations: the content anchor", () => {
  test("a citation whose anchor heads the range passes", () => {
    expect(
      auditCitations([citation(FIXTURE, 3, 5)], FIXTURE_ROOT, HEALTH),
    ).toEqual([]);
  });

  test("a range shifted down fails and names the corrected range", () => {
    // The pre-anchor check passed this: line 6 is real, non-blank code — the wrong handler.
    const shifted = citation(FIXTURE, 6, 8);
    const problems = auditCitations(
      [shifted],
      FIXTURE_ROOT,
      new Map([[citationKey(shifted), 'pathname === "/health"']]),
    );
    expect(problems.map((p) => p.reason)).toEqual(["anchor-drift"]);
    expect(problems[0]?.detail).toContain("it is at line 3");
    expect(problems[0]?.detail).toContain(`cite ${FIXTURE}:3-5`);
  });

  test("a range shifted up fails even though it still contains the anchor", () => {
    // Code inserted above a cited block leaves the stale range starting early: lines 1-3 still
    // hold the anchor, which is why it must be on the first line rather than anywhere in range.
    const early = citation(FIXTURE, 1, 3);
    const problems = auditCitations(
      [early],
      FIXTURE_ROOT,
      new Map([[citationKey(early), 'pathname === "/health"']]),
    );
    expect(problems.map((p) => p.reason)).toEqual(["anchor-drift"]);
    expect(problems[0]?.detail).toContain(`cite ${FIXTURE}:3-5`);
  });

  test("an anchor that is gone from the file says the claim needs re-verifying", () => {
    const gone = citation(FIXTURE, 3, 5);
    const problems = auditCitations(
      [gone],
      FIXTURE_ROOT,
      new Map([[citationKey(gone), 'pathname === "/healthz"']]),
    );
    expect(problems.map((p) => p.reason)).toEqual(["anchor-drift"]);
    expect(problems[0]?.detail).toContain("not anywhere in");
  });

  test("an anchor on several lines is reported without guessing a range", () => {
    const ambiguous = citation(FIXTURE, 1);
    const problems = auditCitations(
      [ambiguous],
      FIXTURE_ROOT,
      new Map([[citationKey(ambiguous), "return Response.json"]]),
    );
    expect(problems[0]?.detail).toContain("it is at line 4, 7");
    expect(problems[0]?.detail).not.toContain("cite ");
  });

  test("a citation with no anchor fails closed", () => {
    const problems = auditCitations(
      [citation(FIXTURE, 3, 5)],
      FIXTURE_ROOT,
      NO_ANCHORS,
    );
    expect(problems.map((p) => p.reason)).toEqual(["no-anchor"]);
  });

  test("an anchor no citation uses is reported", () => {
    expect(
      unusedAnchors(
        [citation(FIXTURE, 3, 5)],
        new Map([...HEALTH, [`${FIXTURE}:6-8`, "/api/status"]]),
      ),
    ).toEqual([`${FIXTURE}:6-8`]);
  });

  test("zip: citations are skipped, not resolved", () => {
    const external: Citation = {
      ...citation("customer/report/report.ts", 1),
      external: true,
    };
    expect(auditCitations([external], FIXTURE_ROOT, NO_ANCHORS)).toEqual([]);
  });

  test("a registry with no object, or an empty or punctuation anchor, is refused", () => {
    expect(() => parseCitationAnchors({})).toThrow("citationAnchors");
    expect(() =>
      parseCitationAnchors({ citationAnchors: { "a.ts:1": "" } }),
    ).toThrow("more than punctuation");
    expect(() =>
      parseCitationAnchors({ citationAnchors: { "a.ts:1": "});" } }),
    ).toThrow("more than punctuation");
  });
});

describe("auditCitations: objective checks", () => {
  test("a bare module name that no longer exists is reported", () => {
    // The module moved under services/; the published citation still said otherwise.
    const problems = auditCitations(
      [citation("sportsdesk_webview_server.ts", 27)],
      ROOT,
      NO_ANCHORS,
    );
    expect(problems.map((p) => p.reason)).toEqual(["file-missing"]);
  });

  test("a moved file is reported, with no search-path rescue", () => {
    // docs/runbooks/operational_guardrails_runbook.md: the old root-level path is gone.
    const problems = auditCitations(
      [citation("operational_guardrails_runbook.md", 153)],
      ROOT,
      NO_ANCHORS,
    );
    expect(problems.map((p) => p.reason)).toEqual(["file-missing"]);
  });

  test("a line past the end of the file is out of range", () => {
    const problems = auditCitations(
      [citation("docs/EVIDENCE.md", 999999)],
      ROOT,
      NO_ANCHORS,
    );
    expect(problems.map((p) => p.reason)).toEqual(["out-of-range"]);
  });

  test("a blank first line is reported, with where the anchor went", () => {
    const blank = citation(FIXTURE, 2, 4);
    const problems = auditCitations(
      [blank],
      FIXTURE_ROOT,
      new Map([[citationKey(blank), 'pathname === "/health"']]),
    );
    expect(problems.map((p) => p.reason)).toEqual(["blank-anchor"]);
    expect(problems[0]?.detail).toContain(`cite ${FIXTURE}:3-5`);
  });

  test("the punctuation anchor is the signal that code moved under the citation", async () => {
    // Found at runtime rather than pinned: a hardcoded line number rots like the citations do.
    const file = "services/sportsdesk_webview_server.ts";
    const lines = (await Bun.file(resolve(ROOT, file)).text()).split("\n");
    const punctuationLine = lines.findIndex(
      (line) => line.trim() !== "" && /^[\s)}\];,]*$/.test(line.trim()),
    );
    expect(punctuationLine).toBeGreaterThan(0);
    const problems = auditCitations(
      [citation(file, punctuationLine + 1)],
      ROOT,
      NO_ANCHORS,
    );
    expect(problems.map((p) => p.reason)).toEqual(["punctuation-anchor"]);
  });
});

describe("the committed docs", () => {
  const { citations, anchors } = collectDocCitations(ROOT);

  test("every citation resolves and holds its anchor", () => {
    expect(citations.length).toBeGreaterThan(300);
    expect(auditCitations(citations, ROOT, anchors)).toEqual([]);
  });

  test("every anchor is cited somewhere", () => {
    expect(unusedAnchors(citations, anchors)).toEqual([]);
  });

  test("shifting any webview-server citation by three lines fails", () => {
    const webview = citations.filter(
      (c) => c.file === "services/sportsdesk_webview_server.ts",
    );
    expect(webview.length).toBeGreaterThan(30);
    for (const delta of [-3, 3]) {
      for (const original of webview) {
        const shifted = {
          ...original,
          start: original.start + delta,
          end: original.end + delta,
        };
        const moved = new Map([
          [citationKey(shifted), anchors.get(citationKey(original)) ?? ""],
        ]);
        expect(auditCitations([shifted], ROOT, moved)).not.toEqual([]);
      }
    }
  });
});

describe("--sync-anchors", () => {
  const MOVED_KEY = `${FIXTURE}:6-8`;

  test("a unique anchor yields one move with the span preserved", () => {
    const anchors = new Map([[MOVED_KEY, 'pathname === "/health"']]);
    expect(
      planAnchorSync([citation(FIXTURE, 6, 8)], FIXTURE_ROOT, anchors),
    ).toEqual([
      { file: FIXTURE, from: MOVED_KEY, to: `${FIXTURE}:3-5`, line: 3 },
    ]);
  });

  test("an ambiguous anchor is left for a human", async () => {
    const ambiguous = "ambiguous.ts";
    await Bun.write(
      join(FIXTURE_ROOT, ambiguous),
      [
        'const first = "shared-literal";', // 1
        "// filler", // 2
        "// filler", // 3
        "// filler", // 4
        'const second = "shared-literal";', // 5
      ].join("\n"),
    );
    const anchors = new Map([[`${ambiguous}:3`, "shared-literal"]]);
    expect(
      planAnchorSync([citation(ambiguous, 3)], FIXTURE_ROOT, anchors),
    ).toEqual([]);
  });

  test("a vanished anchor yields no move", () => {
    const anchors = new Map([[MOVED_KEY, "literal that is gone"]]);
    expect(
      planAnchorSync([citation(FIXTURE, 6, 8)], FIXTURE_ROOT, anchors),
    ).toEqual([]);
  });

  test("a comma-list member is rewritten without its own file prefix", () => {
    expect(
      rewriteFileCitations(
        "sources: `handler.ts:1141-1143,1131-1135`",
        FIXTURE,
        new Map([["1131-1135", "1134-1138"]]),
      ),
    ).toBe("sources: `handler.ts:1141-1143,1134-1138`");
  });

  test("the single-key rewrite is boundary-guarded", () => {
    expect(
      rewriteCitationKey("x.ts:18 and x.ts:180", "x.ts:18", "x.ts:9"),
    ).toBe("x.ts:9 and x.ts:180");
    expect(
      rewriteCitationKey("a/lib/x.ts:18", "lib/x.ts:18", "lib/x.ts:9"),
    ).toBe("a/lib/x.ts:18");
  });

  test("applyAnchorSync rewrites the citing doc and reports it", async () => {
    const doc = "doc.md";
    await Bun.write(
      join(FIXTURE_ROOT, doc),
      "see `handler.ts:6-8` for details\n",
    );
    const changed = applyAnchorSync(
      [{ file: FIXTURE, from: MOVED_KEY, to: `${FIXTURE}:3-5`, line: 3 }],
      FIXTURE_ROOT,
      [doc],
    );
    expect(changed).toEqual([doc]);
    expect(await Bun.file(join(FIXTURE_ROOT, doc)).text()).toBe(
      "see `handler.ts:3-5` for details\n",
    );
  });
});
