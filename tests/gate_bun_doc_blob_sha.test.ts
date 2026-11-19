import { describe, expect, test } from "bun:test";
import { scanMarkdownTextForViolations } from "../packages/sportsdesk-ops/src/lib/gate_bun_doc_blob_sha.ts";

/**
 * The gate validates citations; it does not police which host they point at. A markdown file may
 * cite bun.sh, bun.com, `blob/main` or a `#:~:text=` fragment. What still fails:
 *
 * - a pinned blob URL whose sha is not the audited commit (`E_DOC_BUN_VERSION_DRIFT`);
 * - a line anchor outside the cited file, on a leaf that is missing from the `@types/bun` closure
 *   (`ERR_CAT_UNPINNED_BUN_URL`).
 *
 * The ban on unpinned Bun URLs was removed deliberately: it rejected the canonical docs page
 * (bun.sh/docs/…) that a contributing guide should cite.
 */
describe("GATE-BUN-DOC-BLOB-SHA-01 scan", () => {
  const leafMax = new Map([["packages/bun-types/bun.d.ts", 12_000]]);
  const commit = Bun.revision;

  test("accepts a bun.sh docs citation", () => {
    const text =
      "See https://bun.sh/docs/project/contributing#download-release-build-from-pull-requests";
    const { violations, validatedCitations } = scanMarkdownTextForViolations(
      "CONTRIBUTING.md",
      text,
      commit,
      leafMax,
    );
    expect(violations).toEqual([]);
    expect(validatedCitations).toBe(0);
  });

  test("accepts bun.com, blob/main and #:~:text= citations", () => {
    const text = [
      "See https://bun.com/reference/bun/file for the function.",
      "See https://github.com/oven-sh/bun/blob/main/packages/bun-types/bun.d.ts.",
      "See https://bun.com/#:~:text=FORMATS for the grouped index.",
    ].join("\n");
    const { violations } = scanMarkdownTextForViolations(
      "docs/example.md",
      text,
      commit,
      leafMax,
    );
    expect(violations).toEqual([]);
  });

  test("accepts pinned blob at the audited commit", () => {
    const url = `https://github.com/oven-sh/bun/blob/${commit}/packages/bun-types/bun.d.ts#L820`;
    const { violations, validatedCitations } = scanMarkdownTextForViolations(
      "docs/bun-upstream-reference.md",
      `| which | [ref](${url}) |`,
      commit,
      leafMax,
    );
    expect(validatedCitations).toBe(1);
    expect(violations).toEqual([]);
  });

  test("E_DOC_BUN_VERSION_DRIFT on a wrong sha", () => {
    const url =
      "https://github.com/oven-sh/bun/blob/0000000000000000000000000000000000000000/packages/bun-types/bun.d.ts#L1";
    const { violations } = scanMarkdownTextForViolations(
      "x.md",
      url,
      commit,
      leafMax,
    );
    expect(violations.map((v) => v.code)).toContain("E_DOC_BUN_VERSION_DRIFT");
  });

  test("ERR_CAT_UNPINNED_BUN_URL when a line anchor exceeds the file", () => {
    const url = `https://github.com/oven-sh/bun/blob/${commit}/packages/bun-types/bun.d.ts#L99999`;
    const { violations } = scanMarkdownTextForViolations(
      "x.md",
      url,
      commit,
      leafMax,
    );
    expect(violations.map((v) => v.code)).toContain("ERR_CAT_UNPINNED_BUN_URL");
  });

  test("ERR_CAT_UNPINNED_BUN_URL when the leaf is not in the closure", () => {
    const url = `https://github.com/oven-sh/bun/blob/${commit}/packages/bun-types/not-there.d.ts#L1`;
    const { violations } = scanMarkdownTextForViolations(
      "x.md",
      url,
      commit,
      leafMax,
    );
    expect(violations.map((v) => v.code)).toContain("ERR_CAT_UNPINNED_BUN_URL");
  });
});
