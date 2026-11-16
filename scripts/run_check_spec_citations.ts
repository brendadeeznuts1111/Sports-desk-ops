/**
 * CLI entry for the spec-citations gate. Kept separate from `check_spec_citations.ts` so
 * dashboard metrics can import the citation helpers without bundling workspace package gates.
 */
import { resolve } from "node:path";
import {
  ANCHORS_KEY,
  CITING_DOCS,
  applyAnchorSync,
  auditCitations,
  citationKey,
  collectDocCitations,
  label,
  planAnchorSync,
  unusedAnchors,
} from "./check_spec_citations.ts";

const ROOT = resolve(import.meta.dir, "..");

const { runGateBunDocBlobSha } = (await import(
  resolve(ROOT, "packages/sportsdesk-ops/src/lib/gate_bun_doc_blob_sha.ts")
)) as typeof import("../packages/sportsdesk-ops/src/lib/gate_bun_doc_blob_sha.ts");

const blobGate = await runGateBunDocBlobSha({
  repoRoot: ROOT,
  moduleDir: resolve(ROOT, "packages/sportsdesk-ops/src/lib"),
});
if (!blobGate.ok) {
  process.stderr.write(`${JSON.stringify(blobGate)}\n`);
  process.exit(65);
}
console.log(
  `${blobGate.gate}: pass — ${blobGate.validated_citations} pinned citation(s), ${blobGate.ast_symbol_locations_verified} AST symbol location(s) at ${blobGate.audited_bun_commit.slice(0, 10)}`,
);

let { citations, anchors } = collectDocCitations(ROOT);
let problems = auditCitations(citations, ROOT, anchors);

if (process.argv.includes("--sync-anchors")) {
  const moves = planAnchorSync(citations, ROOT, anchors);
  if (moves.length > 0) {
    const changed = applyAnchorSync(moves, ROOT);
    console.error(
      `check:spec-citations: --sync-anchors moved ${moves.length} citation(s) across ${changed.length} doc(s)`,
    );
    for (const move of moves) {
      console.error(`  ${move.from} -> ${move.to}`);
    }
    ({ citations, anchors } = collectDocCitations(ROOT));
    problems = auditCitations(citations, ROOT, anchors);
  }
}

const unused = unusedAnchors(citations, anchors);
const external = new Set(citations.filter((c) => c.external).map(citationKey));
const checked = citations.length - citations.filter((c) => c.external).length;

if (problems.length === 0 && unused.length === 0) {
  console.log(
    `check:spec-citations: ok — ${checked} citation(s) across ${CITING_DOCS.length} docs resolve and hold their anchor (${anchors.size} anchors); ${external.size} distinct zip: citation(s) name the external GS extract and are not checked`,
  );
  process.exit(0);
}
if (problems.length > 0) {
  console.error(
    `check:spec-citations: ${problems.length}/${checked} citation(s) no longer point at the code they describe`,
  );
  const seen = new Set<string>();
  for (const problem of problems) {
    const line = `  [${problem.reason}] ${label(problem.citation)} — ${problem.detail}`;
    if (seen.has(line)) continue;
    seen.add(line);
    console.error(line);
  }
}
if (unused.length > 0) {
  console.error(
    `check:spec-citations: ${unused.length} ${ANCHORS_KEY} entr${unused.length === 1 ? "y is" : "ies are"} cited nowhere; delete or re-point them`,
  );
  for (const key of unused) console.error(`  [unused-anchor] ${key}`);
}
process.exit(1);
