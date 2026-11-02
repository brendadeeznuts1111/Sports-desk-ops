import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditCitations,
  extractCitations,
  type Citation,
} from "../scripts/check_spec_citations.ts";

/**
 * Prose citations in docs/openapi.json rot silently.
 *
 * They are hand-written strings like `services/sportsdesk_webview_server.ts:114-131`, so moving
 * code does not update them and the docs gate cannot see them. Measured 2026-11-01: 18 of 110
 * no longer pointed at code — nine named a file that had moved under docs/runbooks/, and five
 * landed on a bare `}`, `);` or `},`.
 *
 * The audit cannot know what a sentence meant, so it only reports anchors that are objectively
 * gone: file missing, line out of range, blank, or nothing but closing punctuation.
 */

const ROOT = resolve(import.meta.dir, "..");

const citation = (file: string, start: number, end = start): Citation => ({
  file,
  start,
  end,
  context: "test",
});

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
});

describe("auditCitations", () => {
  test("a citation pointing at real code passes", () => {
    expect(
      auditCitations(
        [citation("services/sportsdesk_webview_server.ts", 1327)],
        ROOT,
      ),
    ).toEqual([]);
  });

  test("a bare module name that no longer exists is reported", () => {
    // The module moved under services/; the published citation still said otherwise.
    const problems = auditCitations(
      [citation("sportsdesk_webview_server.ts", 27)],
      ROOT,
    );
    expect(problems.map((p) => p.reason)).toEqual(["file-missing"]);
  });

  test("a moved file is reported, with no search-path rescue", () => {
    // docs/runbooks/operational_guardrails_runbook.md: the old root-level path is gone.
    const problems = auditCitations(
      [citation("operational_guardrails_runbook.md", 153)],
      ROOT,
    );
    expect(problems.map((p) => p.reason)).toEqual(["file-missing"]);
  });

  test("a line past the end of the file is out of range", () => {
    const problems = auditCitations(
      [citation("docs/EVIDENCE.md", 999999)],
      ROOT,
    );
    expect(problems.map((p) => p.reason)).toEqual(["out-of-range"]);
  });

  test("the punctuation anchor is the signal that code moved under the citation", () => {
    // Find a punctuation-only line at runtime rather than pinning one: a hardcoded line number in
    // the test rots exactly like the citations it is testing for.
    const file = "services/sportsdesk_webview_server.ts";
    const lines = readFileSync(resolve(ROOT, file), "utf8").split("\n");
    const punctuationLine = lines.findIndex(
      (line) => line.trim() !== "" && /^[\s)}\];,]*$/.test(line.trim()),
    );
    expect(punctuationLine).toBeGreaterThan(0);
    const problems = auditCitations(
      [citation(file, punctuationLine + 1)],
      ROOT,
    );
    expect(problems.map((p) => p.reason)).toEqual(["punctuation-anchor"]);
  });
});

describe("the committed spec", () => {
  test("every prose citation resolves to code", () => {
    const spec = readFileSync(resolve(ROOT, "docs/openapi.json"), "utf8");
    const citations = extractCitations(spec);
    expect(citations.length).toBeGreaterThan(50);
    expect(auditCitations(citations, ROOT)).toEqual([]);
  });
});
