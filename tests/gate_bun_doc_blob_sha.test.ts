import { describe, expect, test } from "bun:test";
import {
  BANNED_BUN_URL_RE,
  scanMarkdownTextForViolations,
} from "../packages/sportsdesk-ops/src/lib/gate_bun_doc_blob_sha.ts";

describe("GATE-BUN-DOC-BLOB-SHA-01 scan", () => {
  const leafMax = new Map([["packages/bun-types/bun.d.ts", 12_000]]);
  const commit = Bun.revision;

  test("flags bun.com reference URLs", () => {
    const text = "See https://bun.com/reference/bun/file for details.";
    const { violations } = scanMarkdownTextForViolations(
      "docs/example.md",
      text,
      commit,
      leafMax,
    );
    expect(violations.some((v) => v.code === "ERR_SPEC_UNPINNED_BUN_URL")).toBe(
      true,
    );
  });

  test("accepts pinned blob at audited commit", () => {
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

  test("E_DOC_BUN_VERSION_DRIFT on wrong SHA", () => {
    const url =
      "https://github.com/oven-sh/bun/blob/0000000000000000000000000000000000000000/packages/bun-types/bun.d.ts#L1";
    const { violations } = scanMarkdownTextForViolations(
      "x.md",
      url,
      commit,
      leafMax,
    );
    expect(violations.some((v) => v.code === "E_DOC_BUN_VERSION_DRIFT")).toBe(
      true,
    );
  });

  test("ERR_CAT_UNPINNED_BUN_URL when line anchor exceeds file", () => {
    const url = `https://github.com/oven-sh/bun/blob/${commit}/packages/bun-types/bun.d.ts#L99999`;
    const { violations } = scanMarkdownTextForViolations(
      "x.md",
      url,
      commit,
      leafMax,
    );
    expect(violations.some((v) => v.code === "ERR_CAT_UNPINNED_BUN_URL")).toBe(
      true,
    );
  });
});

describe("BANNED_BUN_URL_RE", () => {
  test("matches #:~:text fragments", () => {
    BANNED_BUN_URL_RE.lastIndex = 0;
    const m = BANNED_BUN_URL_RE.exec(
      "https://github.com/oven-sh/bun#:~:text=foo",
    );
    expect(m?.[0]).toContain("#:~:text=");
  });
});
