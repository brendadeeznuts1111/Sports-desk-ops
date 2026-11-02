/**
 * Are the spec's `file:line` citations still pointing at something?
 *
 * docs/openapi.json carries prose citations like `sportsdesk_webview_server.ts:114-131`. They are
 * hand-written strings, so nothing notices when the code moves: measured 2026-11-01, several of
 * these landed on a bare `}` or `);` — the citation had been true when written and had rotted
 * since. The generated schema citations were fixed to name symbols; this covers the prose.
 *
 * The check is deliberately narrow. It cannot know what a sentence *meant*, so it only reports
 * citations whose anchor is objectively gone: out of range, blank, or nothing but closing
 * punctuation. That is enough to catch drift without inventing failures.
 *
 *   bun run scripts/check_spec_citations.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

export type Citation = {
  readonly file: string;
  readonly start: number;
  readonly end: number;
  /** Where the citation appears, for the report. */
  readonly context: string;
};

export type CitationProblem = {
  readonly citation: Citation;
  readonly reason: "file-missing" | "out-of-range" | "blank-anchor" | "punctuation-anchor";
  readonly detail: string;
};

/** `path/file.ext:12` or `path/file.ext:12-34`. */
const CITATION_RE = /([A-Za-z0-9_./-]+\.(?:ts|tsx|md|json|sh|sql)):(\d+)(?:-(\d+))?/g;

/** A line that is only closing punctuation cannot be an anchor for a sentence. */
const PUNCTUATION_ONLY = /^[\s)}\];,]*$/;

export function extractCitations(text: string, context = "spec"): Citation[] {
  const out: Citation[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    out.push({
      file: match[1] ?? "",
      start: Number(match[2]),
      end: Number(match[3] ?? match[2]),
      context,
    });
  }
  return out;
}

/**
 * Resolve a cited path exactly. No search path: a published citation has to name a file the
 * reader can open, and a fallback would keep accepting the bare `sportsdesk_webview_server.ts`
 * that did not exist after the module moved under `services/`.
 */
export function resolveCitedFile(file: string, root: string): string | undefined {
  const full = join(root, file);
  return existsSync(full) ? full : undefined;
}

export function auditCitations(
  citations: readonly Citation[],
  root: string,
): CitationProblem[] {
  const problems: CitationProblem[] = [];
  const lineCache = new Map<string, string[]>();

  for (const citation of citations) {
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
    if (citation.end > lines.length || citation.start < 1) {
      problems.push({
        citation,
        reason: "out-of-range",
        detail: `lines ${citation.start}-${citation.end} but ${citation.file} has ${lines.length}`,
      });
      continue;
    }
    const anchor = (lines[citation.start - 1] ?? "").trim();
    if (anchor === "") {
      problems.push({ citation, reason: "blank-anchor", detail: "the cited line is blank" });
      continue;
    }
    if (PUNCTUATION_ONLY.test(anchor)) {
      problems.push({
        citation,
        reason: "punctuation-anchor",
        detail: `the cited line is only ${JSON.stringify(anchor)}`,
      });
    }
  }
  return problems;
}

if (import.meta.main) {
  const spec = readFileSync(join(ROOT, "docs/openapi.json"), "utf8");
  const citations = extractCitations(spec);
  const problems = auditCitations(citations, ROOT);

  if (problems.length === 0) {
    console.log(`check:spec-citations: ok — ${citations.length} citation(s) resolve`);
    process.exit(0);
  }
  console.error(
    `check:spec-citations: ${problems.length}/${citations.length} citation(s) no longer point at code`,
  );
  for (const problem of problems) {
    console.error(
      `  [${problem.reason}] ${problem.citation.file}:${problem.citation.start}` +
        `${problem.citation.end === problem.citation.start ? "" : `-${problem.citation.end}`} — ${problem.detail}`,
    );
  }
  process.exit(1);
}
