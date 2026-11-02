import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditLedger,
  countByTag,
  countTiers,
  deriveMissingFromSpec,
  memberPath,
  resolveCitation,
} from "../lib/ledger_consistency.ts";
import { loadManifestIndex } from "../scripts/apply_captures.ts";

/**
 * The ledger is the SSOT the docs gate trusts, and nothing checked it against itself. Three
 * numbers inside it were wrong at once: the schemaDoc prose said "total = 48" for 55 rows, and
 * three `missingFromSpec` flags contradicted docs/openapi.json. A field description nobody
 * applied is not a contract.
 */

const ROOT = resolve(import.meta.dir, "..");
const ledger = JSON.parse(
  readFileSync(resolve(ROOT, "docs/evidence/ledger.json"), "utf8"),
);
const spec = JSON.parse(
  readFileSync(resolve(ROOT, "docs/openapi.json"), "utf8"),
);

function ledgerWith(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    schemaDoc: {
      counts: "Operation counts by tier. A+B+C+D+E = total = 2.",
      surfaceFields: { missingFromSpec: "documented" },
    },
    counts: { A: 1, B: 0, C: 1, D: 0, E: 0, total: 2 },
    countsByTag: {
      "Tag One": { A: 1, B: 0, C: 0, D: 0, E: 0, total: 1 },
      "Tag Two": { A: 0, B: 0, C: 1, D: 0, E: 0, total: 1 },
    },
    surfaceCounts: { D: 1, E: 0, total: 1 },
    operations: [
      { method: "get", path: "/a", tier: "A", tag: "Tag One" },
      { method: "get", path: "/b", tier: "C", tag: "Tag Two" },
    ],
    surfaces: [
      {
        id: "surface.x",
        tier: "D",
        missingFromSpec: true,
        members: ["GET /missing"],
      },
    ],
    ...overrides,
  };
}

describe("memberPath", () => {
  test("reduces a member to a spec path", () => {
    expect(memberPath("POST /cloud/api/Manager/getHistory")).toBe(
      "/cloud/api/Manager/getHistory",
    );
    expect(memberPath("GET /assets/*")).toBe("/assets");
    expect(memberPath("/api/live-bets")).toBe("/api/live-bets");
  });

  test("returns nothing for members that are not routes", () => {
    // A surface may list field names or CLI verbs; those cannot be spec paths.
    expect(memberPath("sports")).toBeUndefined();
    expect(memberPath("gslive <LOGIN>")).toBeUndefined();
    expect(memberPath(undefined)).toBeUndefined();
  });
});

describe("deriveMissingFromSpec", () => {
  const specPaths = new Set([
    "/dashboard",
    "/api/live-bets",
    "/api/live-bets/summary",
  ]);

  test("fully published is false", () => {
    const surface = { members: ["GET /dashboard"] };
    expect(deriveMissingFromSpec(surface, specPaths)).toBe(false);
  });

  test("partially published is true — the spec does not fully model it", () => {
    // This is the case the old prose could not decide, and daemon-live-bets was recorded as
    // false because of it: /api/f402/get-pending has no spec row.
    const surface = {
      members: [
        "GET /api/live-bets",
        "GET /api/live-bets/summary",
        "GET /api/f402/get-pending",
      ],
    };
    expect(deriveMissingFromSpec(surface, specPaths)).toBe(true);
  });

  test("no path members is true, not false-by-vacuity", () => {
    // A surface of field names or CLI verbs can never be in the spec.
    expect(
      deriveMissingFromSpec({ members: ["sports", "periods"] }, specPaths),
    ).toBe(true);
    expect(deriveMissingFromSpec({ members: [] }, specPaths)).toBe(true);
  });
});

describe("countTiers", () => {
  test("counts rows per tier and ignores rows without one", () => {
    expect(
      countTiers([{ tier: "A" }, { tier: "A" }, { tier: "C" }, { nope: true }]),
    ).toEqual({ A: 2, C: 1 });
  });
});

describe("countByTag", () => {
  test("buckets rows by tag and tier", () => {
    expect(
      countByTag([
        { tier: "A", tag: "X" },
        { tier: "C", tag: "X" },
        { tier: "C", tag: "Y" },
        { tier: "C" },
      ]),
    ).toEqual({ X: { A: 1, C: 1 }, Y: { C: 1 }, "(none)": { C: 1 } });
  });
});

describe("auditLedger", () => {
  test("a consistent ledger has no issues", () => {
    expect(
      auditLedger(ledgerWith({}), { paths: { "/a": {}, "/b": {} } }),
    ).toEqual([]);
  });

  test("counts that disagree with the rows are reported per tier", () => {
    const issues = auditLedger(
      ledgerWith({ counts: { A: 2, B: 0, C: 0, D: 0, E: 0, total: 2 } }),
      { paths: {} },
    );
    expect(issues.map((issue) => issue.code)).toContain("COUNTS_STALE");
    expect(
      issues.some((issue) => issue.message.includes("counts.A=2 but 1")),
    ).toBe(true);
  });

  test("a total that disagrees with the row count is reported", () => {
    const issues = auditLedger(
      ledgerWith({ counts: { A: 1, B: 0, C: 1, D: 0, E: 0, total: 99 } }),
      { paths: {} },
    );
    expect(
      issues.some((issue) => issue.message.includes("counts.total=99")),
    ).toBe(true);
  });

  test("prose that restates the total is compared against the rows", () => {
    const issues = auditLedger(
      ledgerWith({
        schemaDoc: {
          counts: "A+B+C+D+E = total = 48.",
          surfaceFields: { missingFromSpec: "x" },
        },
      }),
      { paths: {} },
    );
    expect(issues.map((issue) => issue.code)).toContain("PROSE_STALE");
  });

  test("an undocumented surface flag is reported even without a spec", () => {
    const issues = auditLedger(
      ledgerWith({ schemaDoc: { counts: "total = 2.", surfaceFields: {} } }),
    );
    expect(issues.map((issue) => issue.code)).toContain(
      "SURFACE_FLAG_UNDOCUMENTED",
    );
  });

  test("a surface flag contradicting the spec is reported by id", () => {
    const issues = auditLedger(
      ledgerWith({
        surfaces: [
          {
            id: "surface.x",
            tier: "D",
            missingFromSpec: false,
            members: ["GET /absent"],
          },
        ],
      }),
      { paths: {} },
    );
    const wrong = issues.find((issue) => issue.code === "SURFACE_FLAG_WRONG");
    expect(wrong?.message).toContain("surface.x");
    expect(wrong?.message).toContain(
      "missingFromSpec=false but the spec says true",
    );
  });

  test("without a spec the flag checks are skipped, not guessed", () => {
    const issues = auditLedger(ledgerWith({}));
    expect(issues.map((issue) => issue.code)).not.toContain(
      "SURFACE_FLAG_WRONG",
    );
  });

  test("per-tag counts that disagree with the rows are reported per tag and tier", () => {
    // The real instance: Manager/getAgentPerformance moved C -> B and this copy kept
    // "Downline Accounting: C 5 / B 0" because the per-tag total was still 5.
    const issues = auditLedger(
      ledgerWith({
        countsByTag: {
          "Tag One": { A: 0, B: 1, C: 0, D: 0, E: 0, total: 1 },
          "Tag Two": { A: 0, B: 0, C: 1, D: 0, E: 0, total: 1 },
        },
      }),
      { paths: {} },
    );
    const stale = issues.filter((issue) => issue.code === "TAG_COUNTS_STALE");
    expect(stale.map((issue) => issue.message)).toEqual([
      expect.stringContaining('"Tag One"].A=0 but 1'),
      expect.stringContaining('"Tag One"].B=1 but 0'),
    ]);
  });

  test("a tag in the rows but absent from countsByTag is reported", () => {
    const issues = auditLedger(
      ledgerWith({
        countsByTag: { "Tag One": { A: 1, B: 0, C: 0, D: 0, E: 0, total: 1 } },
      }),
      { paths: {} },
    );
    expect(issues.map((issue) => issue.message).join("\n")).toContain(
      '"Tag Two"].total=0 but 1',
    );
  });
});

describe("citation audit", () => {
  const captureFiles = new Set(["2026-10-31/getBetTicker.post.json"]);

  // The fixture's other bookkeeping (tag counts, prose total) does not describe this single row,
  // so these assertions look only at citation findings.
  const citationIssues = (
    source: string,
    options?: Parameters<typeof auditLedger>[2],
  ) =>
    auditLedger(
      ledgerWith({
        operations: [
          {
            method: "get",
            path: "/a",
            tier: "A",
            tag: "Tag One",
            evidence: [{ source }],
          },
        ],
      }),
      {},
      options,
    ).filter(
      (issue) =>
        issue.code.startsWith("CAPTURE") || issue.code.startsWith("CITATION"),
    );

  test("a capture citation must name a file in the store", () => {
    // The pre-fix ledger cited capture:<date>:<sha256> ids that matched nothing at all.
    const issues = citationIssues("capture:2026-10-31:deadbeef", {
      captureFiles,
    });
    expect(issues.map((issue) => issue.code)).toContain("CAPTURE_REF_DANGLING");
    expect(issues[0]?.message).toContain("expected capture:<date>/<file>");
  });

  test("the canonical capture form resolves", () => {
    expect(
      citationIssues("capture:2026-10-31/getBetTicker.post.json", {
        captureFiles,
      }),
    ).toEqual([]);
  });

  test("a cited file that is nowhere in the repo is reported", () => {
    const issues = citationIssues("lib/does_not_exist.ts:1", { root: ROOT });
    expect(issues.map((issue) => issue.code)).toContain("CITATION_DANGLING");
  });

  test("a citation that moved directories still resolves", () => {
    // This is the 34-row failure mode: operational_guardrails_runbook.md moved to docs/runbooks/.
    expect(
      resolveCitation("operational_guardrails_runbook.md", ROOT),
    ).toContain("docs/runbooks/operational_guardrails_runbook.md");
  });

  test("a line range past the end of the file is reported", () => {
    const issues = citationIssues("docs/EVIDENCE.md:99999", { root: ROOT });
    expect(issues.map((issue) => issue.code)).toContain("CITATION_LINE_RANGE");
  });

  test("a real citation with a line range is accepted", () => {
    expect(citationIssues("docs/EVIDENCE.md:1-2", { root: ROOT })).toEqual([]);
  });

  test("without a capture store or root the citation checks are skipped", () => {
    // Skipped, not guessed: a missing store must not turn every capture into a false finding.
    expect(citationIssues("capture:2026-10-31:deadbeef")).toEqual([]);
    expect(citationIssues("lib/does_not_exist.ts:1")).toEqual([]);
  });
});

describe("the committed ledger", () => {
  test("is internally consistent, agrees with the spec, and cites artifacts that exist", async () => {
    // The regression, at full strength: counts, tag counts, prose total, surface flags, capture
    // references and file citations. It fails on the ledger as it stood (12 issues: 4 numbers,
    // 8 capture ids that named no capture).
    const manifest = await loadManifestIndex(
      resolve(ROOT, "docs/evidence/captures"),
    );
    expect(
      auditLedger(ledger, spec, {
        root: ROOT,
        captureFiles: new Set(manifest.hashes.keys()),
      }),
    ).toEqual([]);
  });

  test("every surface id is unique", () => {
    const ids = (ledger.surfaces as { id: string }[]).map(
      (surface) => surface.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("tier decides whether a row may be published, and contradicted rows may go either way", () => {
    // 44 of the 55 rows are in the spec. That number is not asserted directly because it moves
    // with the ledger; the rule behind it is what should stay true:
    //   - a tier-E row is retired or unimplemented, so the spec must not publish it;
    //   - a non-E row with no contradiction must be published, or the row is a phantom;
    //   - a contradicted row may be absent (the path never existed) or present (the path exists
    //     and the recorded request/response detail is wrong) — Manager/getPending and
    //     Manager/getAgentPerformance are the second kind.
    const specPaths = new Set(
      Object.keys((spec as { paths: Record<string, unknown> }).paths),
    );
    const rows = ledger.operations as {
      path: string;
      tier: string;
      contradicted?: boolean;
    }[];

    expect(
      rows.filter((row) => row.tier === "E" && specPaths.has(row.path)),
    ).toEqual([]);
    expect(
      rows.filter(
        (row) =>
          row.tier !== "E" &&
          row.contradicted !== true &&
          !specPaths.has(row.path),
      ),
    ).toEqual([]);
    expect(
      rows.filter((row) => specPaths.has(row.path)).length,
    ).toBeGreaterThan(40);
  });
});
