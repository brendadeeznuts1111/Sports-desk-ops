/**
 * Do the docs' `file:line` citations still point at the code they describe?
 *
 * The evidence docs carry prose citations like `services/sportsdesk_webview_server.ts:1007-1026`.
 * They are hand-written strings, so nothing notices when the code moves. Checking only that the
 * first cited line was non-blank let drift through: measured 2026-11-02, about 40 citations into
 * the webview server landed on unrelated code (`GET /api/test/error` cited the import block,
 * `OPTIONS *` a `.trim()` call) and every one passed.
 *
 * So every citation must carry a content anchor: `citationAnchors` in docs/evidence/ledger.json
 * maps each cited `file:start-end` to a literal that has to appear on the range's first line. The
 * first line, not anywhere in the range: code inserted above a cited block leaves the stale range
 * starting a few lines early, and a range-wide search would still find the anchor inside it. The
 * check fails closed — a citation with no anchor fails, an anchor no citation uses fails, and an
 * anchor that has left the first line fails with the line(s) it moved to, which is also the
 * corrected range when it occurs once. The older objective checks stay: file missing, out of
 * range, blank or punctuation-only first line.
 *
 * `zip:` citations name the GS extract under the git-ignored scratch/ tree, which a fresh checkout
 * does not have; they are counted and reported as unchecked, never passed silently.
 *
 * `--sync-anchors` applies the moves whose anchor occurs exactly once in the file (span
 * preserved) and rewrites the key in every citing doc. Ambiguous anchors — the literal appears
 * twice — and vanished ones still fail: neither identifies one site, so a rewrite would guess.
 *
 *   bun run scripts/check_spec_citations.ts
 *   bun run scripts/check_spec_citations.ts --sync-anchors
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** Every document whose citations are audited. The ledger's own anchor registry is excluded. */
export const CITING_DOCS = [
  "docs/evidence/ledger.json",
  "docs/openapi.json",
  "docs/api-reference.md",
  "docs/evidence/capture-requests.md",
  "docs/evidence/surfaces.md",
] as const;

const LEDGER_PATH = "docs/evidence/ledger.json";
const ANCHORS_KEY = "citationAnchors";

export type Citation = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  /** Where the citation appears, for the report. */
  readonly context: string;
  /** `zip:` — the GS extract outside the repo; reported, not resolved. */
  readonly external: boolean;
};

export type CitationProblem = {
  readonly citation: Citation;
  readonly reason:
    | "file-missing"
    | "out-of-range"
    | "blank-anchor"
    | "punctuation-anchor"
    | "no-anchor"
    | "anchor-drift";
  readonly detail: string;
};

/** Cited `file:line` → literal that must appear on the first cited line. */
export type CitationAnchors = ReadonlyMap<string, string>;

/**
 * `path/file.ext:12`, `path/file.ext:12-34` or `path/file.ext:9,140-158`, optionally behind a
 * ledger source prefix (`main:`, `fixture:` name this repo; `zip:` the external extract).
 */
const CITATION_RE =
  /(?:(zip|main|fixture):)?([A-Za-z0-9_./-]+\.(?:ts|tsx|md|json|sh|sql)):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)/g;

/** A line that is only closing punctuation cannot be an anchor for a sentence. */
const PUNCTUATION_ONLY = /^[\s)}\];,]*$/;

export function extractCitations(text: string, context = "spec"): Citation[] {
  const out: Citation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const file = match[2] ?? "";
    for (const part of (match[3] ?? "").split(",")) {
      const [start = "", end] = part.split("-");
      out.push({
        file,
        start: Number(start),
        end: Number(end ?? start),
        context,
        external: match[1] === "zip",
      });
    }
  }
  return out;
}

/** The registry key for a citation: `file:start` or `file:start-end`. */
export function citationKey(citation: Citation): string {
  return citation.start === citation.end
    ? `${citation.file}:${citation.start}`
    : `${citation.file}:${citation.start}-${citation.end}`;
}

/** The ledger's `citationAnchors`, refusing a registry an anchor could not be checked against. */
export function parseCitationAnchors(ledger: unknown): Map<string, string> {
  const raw =
    typeof ledger === "object" && ledger !== null
      ? (ledger as Record<string, unknown>)[ANCHORS_KEY]
      : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${LEDGER_PATH} has no "${ANCHORS_KEY}" object`);
  }
  const anchors = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    if (
      typeof value !== "string" ||
      value.includes("\n") ||
      PUNCTUATION_ONLY.test(value)
    ) {
      throw new Error(
        `${ANCHORS_KEY}[${JSON.stringify(key)}] must be a single-line string with more than punctuation in it`,
      );
    }
    anchors.set(key, value);
  }
  return anchors;
}

/**
 * Resolve a cited path exactly. No search path: a published citation has to name a file the
 * reader can open, and a fallback would keep accepting the bare `sportsdesk_webview_server.ts`
 * that did not exist after the module moved under `services/`.
 */
export function resolveCitedFile(
  file: string,
  root: string,
): string | undefined {
  const full = join(root, file);
  return existsSync(full) ? full : undefined;
}

/** Lines holding `anchor`. In the ledger, the registry's own copy of every anchor is not a hit. */
function linesContaining(
  lines: readonly string[],
  anchor: string,
  file: string,
): number[] {
  const registry =
    file === LEDGER_PATH
      ? lines.findIndex((line) => line.includes(`"${ANCHORS_KEY}": {`))
      : -1;
  const searched = registry === -1 ? lines : lines.slice(0, registry);
  const hits: number[] = [];
  searched.forEach((line, index) => {
    if (line.includes(anchor)) hits.push(index + 1);
  });
  return hits;
}

function describeDrift(
  citation: Citation,
  anchor: string,
  hits: readonly number[],
): string {
  const quoted = JSON.stringify(anchor);
  if (hits.length === 0) {
    return `anchor ${quoted} is not on line ${citation.start} and not anywhere in ${citation.file}: the cited code is gone or the claim needs re-verifying`;
  }
  const moved = `anchor ${quoted} is not on line ${citation.start}; it is at line ${hits.join(", ")}`;
  const [only] = hits;
  if (hits.length !== 1 || only === undefined) return moved;
  const span = citation.end - citation.start;
  const next = span === 0 ? `${only}` : `${only}-${only + span}`;
  return `${moved} — cite ${citation.file}:${next} (same span; re-check the end)`;
}

/** Every in-repo citation whose anchor is missing or no longer on its first cited line. */
export function auditCitations(
  citations: readonly Citation[],
  root: string,
  anchors: CitationAnchors,
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const lineCache = new Map<string, string[]>();

  for (const citation of citations) {
    if (citation.external) continue;
    const path = resolveCitedFile(citation.file, root);
    if (path === undefined) {
      problems.push({
        citation,
        reason: "file-missing",
        detail: `${citation.file} is not in the repo`,
      });
      continue;
    }
    let lines = lineCache.get(path);
    if (lines === undefined) {
      lines = readFileSync(path, "utf8").split("\n");
      lineCache.set(path, lines);
    }
    if (
      citation.end > lines.length ||
      citation.start < 1 ||
      citation.end < citation.start
    ) {
      problems.push({
        citation,
        reason: "out-of-range",
        detail: `lines ${citation.start}-${citation.end} but ${citation.file} has ${lines.length}`,
      });
      continue;
    }
    const anchor = anchors.get(citationKey(citation));
    const drift = (current: readonly string[]): string =>
      anchor === undefined
        ? ""
        : describeDrift(
            citation,
            anchor,
            linesContaining(current, anchor, citation.file),
          );
    const first = (lines[citation.start - 1] ?? "").trim();
    if (first === "" || PUNCTUATION_ONLY.test(first)) {
      const moved = anchor === undefined ? "" : `; ${drift(lines)}`;
      problems.push({
        citation,
        reason: first === "" ? "blank-anchor" : "punctuation-anchor",
        detail: `${first === "" ? "the cited line is blank" : `the cited line is only ${JSON.stringify(first)}`}${moved}`,
      });
      continue;
    }
    if (anchor === undefined) {
      problems.push({
        citation,
        reason: "no-anchor",
        detail: `add "${citationKey(citation)}" to ${LEDGER_PATH} ${ANCHORS_KEY} with a literal from the cited lines`,
      });
      continue;
    }
    if (!(lines[citation.start - 1] ?? "").includes(anchor)) {
      problems.push({
        citation,
        reason: "anchor-drift",
        detail: drift(lines),
      });
    }
  }
  return problems;
}

/** Registry entries no citation uses: a stale anchor would otherwise vouch for nothing. */
export function unusedAnchors(
  citations: readonly Citation[],
  anchors: CitationAnchors,
): string[] {
  const cited = new Set(citations.map(citationKey));
  return [...anchors.keys()].filter((key) => !cited.has(key)).sort();
}

/** One citation whose anchor occurs exactly once, so its new range is not a guess. */
export type AnchorMove = {
  /** The cited file, needed because a comma list writes the prefix only once. */
  readonly file: string;
  /** The key as written today, e.g. `lib/x.ts:841-851`. */
  readonly from: string;
  /** The key after the move, span preserved. */
  readonly to: string;
  /** New first cited line. */
  readonly line: number;
};

/** Reasons where a unique anchor identifies the new site even though the old line is not code. */
const RESOLVABLE: ReadonlySet<string> = new Set([
  "anchor-drift",
  "blank-anchor",
  "punctuation-anchor",
]);

/**
 * The moves `--sync-anchors` may apply. Only drift where the anchor occurs exactly once in the
 * file is eligible: two hits mean the literal does not identify one site, and no hit means the
 * code is gone. Both are left for a human — the check stays fail-closed for them.
 *
 * Inserting lines above a cited block usually lands the old range on the *previous* block's
 * closing brace, which reaches the audit as `punctuation-anchor` rather than `anchor-drift`; the
 * move is the same one either way, so both are resolvable.
 */
export function planAnchorSync(
  citations: readonly Citation[],
  root: string,
  anchors: CitationAnchors,
): AnchorMove[] {
  const moves: AnchorMove[] = [];
  const seen = new Set<string>();
  const lineCache = new Map<string, string[]>();
  for (const problem of auditCitations(citations, root, anchors)) {
    if (!RESOLVABLE.has(problem.reason)) continue;
    const { citation } = problem;
    const key = citationKey(citation);
    if (seen.has(key)) continue;
    const anchor = anchors.get(key);
    if (anchor === undefined) continue;
    const path = resolveCitedFile(citation.file, root);
    if (path === undefined) continue;
    let lines = lineCache.get(path);
    if (lines === undefined) {
      lines = readFileSync(path, "utf8").split("\n");
      lineCache.set(path, lines);
    }
    const hits = linesContaining(lines, anchor, citation.file);
    if (hits.length !== 1) continue;
    const line = hits[0]!;
    seen.add(key);
    moves.push({
      file: citation.file,
      from: key,
      to: citationKey({
        ...citation,
        start: line,
        end: line + (citation.end - citation.start),
      }),
      line,
    });
  }
  return moves.sort((a, b) => a.from.localeCompare(b.from));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The `start` or `start-end` part of a citation key. */
function rangeOf(key: string): string {
  const colon = key.lastIndexOf(":");
  return colon === -1 ? key : key.slice(colon + 1);
}

/**
 * Rewrite moved ranges for one file. The whole citation list is matched — `file:1141-1143,1131-1135`
 * writes the prefix once, so a bare range after a comma would never match a full-key replace.
 */
export function rewriteFileCitations(
  text: string,
  file: string,
  ranges: ReadonlyMap<string, string>,
): string {
  if (ranges.size === 0) return text;
  const pattern = new RegExp(
    `(?<![\\w./-])${escapeRegExp(file)}:(\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*)`,
    "g",
  );
  return text.replace(pattern, (whole, list: string) => {
    const parts = list.split(",").map((part) => ranges.get(part) ?? part);
    return parts.join(",") === list ? whole : `${file}:${parts.join(",")}`;
  });
}

/** Boundary-guarded single-key rewrite; a comma-list member needs `rewriteFileCitations`. */
export function rewriteCitationKey(
  text: string,
  from: string,
  to: string,
): string {
  const colon = from.lastIndexOf(":");
  if (colon === -1) return text;
  return rewriteFileCitations(
    text,
    from.slice(0, colon),
    new Map([[from.slice(colon + 1), rangeOf(to)]]),
  );
}

/** Applies the moves in place; returns the docs whose bytes changed. */
export function applyAnchorSync(
  moves: readonly AnchorMove[],
  root: string,
  docs: readonly string[] = CITING_DOCS,
): string[] {
  const byFile = new Map<string, Map<string, string>>();
  for (const move of moves) {
    const ranges = byFile.get(move.file) ?? new Map<string, string>();
    ranges.set(rangeOf(move.from), rangeOf(move.to));
    byFile.set(move.file, ranges);
  }
  const changed: string[] = [];
  for (const doc of docs) {
    const path = join(root, doc);
    const original = readFileSync(path, "utf8");
    let text = original;
    for (const [file, ranges] of byFile) {
      text = rewriteFileCitations(text, file, ranges);
    }
    if (text !== original) {
      writeFileSync(path, text);
      changed.push(doc);
    }
  }
  return changed;
}

/** The docs' citations, reading the ledger without its own anchor registry. */
export function collectDocCitations(root: string): {
  readonly citations: Citation[];
  readonly anchors: Map<string, string>;
} {
  const citations: Citation[] = [];
  let anchors = new Map<string, string>();
  for (const doc of CITING_DOCS) {
    const text = readFileSync(join(root, doc), "utf8");
    if (doc !== LEDGER_PATH) {
      citations.push(...extractCitations(text, doc));
      continue;
    }
    const ledger: unknown = JSON.parse(text);
    anchors = parseCitationAnchors(ledger);
    const { [ANCHORS_KEY]: _registry, ...rows } = ledger as Record<
      string,
      unknown
    >;
    citations.push(...extractCitations(JSON.stringify(rows), doc));
  }
  return { citations, anchors };
}

function label(citation: Citation): string {
  return `${citation.context}: ${citationKey(citation)}`;
}

if (import.meta.main) {
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
  const external = new Set(
    citations.filter((c) => c.external).map(citationKey),
  );
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
}
