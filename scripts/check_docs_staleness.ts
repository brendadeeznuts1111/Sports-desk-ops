/**
 * check_docs_staleness.ts — anti-staleness gate for operator and governance Markdown docs.
 *
 * Why this exists: hardcoded inventory and snapshot counts in documentation
 * ("790 tracked TypeScript files", "200+ package.json scripts", "all 13 Per-Office",
 * "(9,435 accounts)", "(23 valid)", "Three removable DeepSeek Harness bundles")
 * rot silently whenever files, scripts, tests, or live snapshots change.
 *
 * This gate is intentionally separate from `verify:docs` (`scripts/verify_docs.ts`)
 * so that prose-staleness findings never mask or block OpenAPI 3.1 / evidence-tier
 * contract checks. Initial rollout runs under `verify:docs-staleness` (`--warn`
 * mode, exit 0) before flipping to strict enforcement (`verify:docs-staleness:strict`).
 *
 * Usage:
 *   bun run scripts/check_docs_staleness.ts                  # strict gate (exit 1 on findings)
 *   bun run scripts/check_docs_staleness.ts --warn           # rollout mode (prints findings, exits 0)
 *   bun run scripts/check_docs_staleness.ts --root <path>    # scan another checkout or fixture dir
 *   bun run scripts/check_docs_staleness.ts --target <path>  # override default target list (repeatable)
 *
 * Escape hatch (single-line only in v1):
 *   Append `<!-- staleness-ok: <reason> -->` on the exact line that intentionally
 *   states a fixed protocol or benchmark constant. Multi-line range markers
 *   (`<!-- staleness-ok:start -->`) are intentionally unsupported in v1.
 *
 * Missing target files:
 *   Governance or task docs (`cli/README.md`, `services/README.md`,
 *   `docs/REMAINING_TASKS.md`) may be renamed or retired over time. Missing
 *   targets are reported as `SKIP` with a note rather than failing the gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR =
  typeof import.meta.dir === "string"
    ? import.meta.dir
    : dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TARGETS = [
  "README.md",
  "AGENTS.md",
  "ROOT_LAYOUT.md",
  "docs/REMAINING_TASKS.md",
  "cli/README.md",
  "services/README.md",
] as const;

export const CODES = {
  TEST_FILE_INVENTORY: "E_DOC_TEST_FILE_INVENTORY",
  SCRIPT_BUNDLE_INVENTORY: "E_DOC_SCRIPT_BUNDLE_INVENTORY",
  SNAPSHOT_ENTITY_INVENTORY: "E_DOC_SNAPSHOT_ENTITY_INVENTORY",
  BUN_VERSION_DRIFT: "E_DOC_BUN_VERSION_DRIFT",
} as const;

export type StalenessCode = (typeof CODES)[keyof typeof CODES];

export interface DocStalenessIssue {
  readonly file: string;
  readonly line: number;
  readonly code: StalenessCode;
  readonly match: string;
  readonly message: string;
}

export type DocCheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DocCheckOutcome {
  readonly target: string;
  readonly status: DocCheckStatus;
  readonly issues: readonly DocStalenessIssue[];
  readonly notes: readonly string[];
}

export interface ScanOptions {
  readonly expectedBunVersion?: string;
}

export interface RunOptions {
  readonly root: string;
  readonly warn: boolean;
  readonly targets: readonly string[];
}

/**
 * Single-line escape hatch syntax: `<!-- staleness-ok: <reason> -->`.
 * Must appear on the same line as the exempted phrase.
 */
const SINGLE_LINE_ESCAPE_RE = /<!--\s*staleness-ok(?::[^>]*)?-->/i;

/**
 * Numbered step-header comments inside shell fences (`# 3. Audit all ...`) are
 * operator prose headers and are scanned; executable commands inside fences are skipped.
 */
const SHELL_FENCE_LANG_RE = /^(?:bash|sh|shell|zsh)$/i;
const NUMBERED_SHELL_HEADER_RE = /^\s*#\s*\d+\.\s+(.+)$/;

/**
 * Inline backtick nouns that form part of prose inventory phrases (`200+ \`package.json\` scripts`,
 * `237 \`*.test.ts\` suites`, `186 files under \`scripts/\``) are unwrapped so surrounding prose
 * patterns match cleanly, while code-literal spans (`\`type="B"\``, `\`customerID="0"\``) are blanked.
 */
const UNWRAPPABLE_INLINE_NOUN_RE =
  /^(?:package\.json|\*\.test\.ts|scripts\/|lib\/|tests\/|cli\/|services\/|dsh-plugin\*?|bun-types)$/i;

interface PatternRule {
  readonly code: StalenessCode;
  readonly pattern: RegExp;
  readonly guidance: string;
}

const PATTERN_RULES: readonly PatternRule[] = [
  {
    code: CODES.TEST_FILE_INVENTORY,
    // Pattern 1: Test, suite, assertion, and source-file inventory counts.
    // Includes a negative lookahead so status phrases ("0 test failures", "3 test flakes",
    // "1 test regression", "2 test errors") are never flagged as inventory counts.
    pattern:
      /\b\d[\d,]*\+?\s+(?:(?:passing|passed|skipped|colocated|tracked|unit|integration|typescript)\s+)*(?:tests?(?!\s+(?:failures?|flakes?|regressions?|errors?)\b)|test\s+files?|test\s+suites?|\*\.test\.ts\s+suites?|typescript\s+files?|files?\s+under\s+(?:scripts|lib|tests|cli|services)\/?|assertions?|expect(?:\(\))?\s+calls?)\b/gi,
    guidance:
      "derive test/file/assertion counts via `bun test` or `Bun.Glob` instead of hardcoding inventory totals in prose",
  },
  {
    code: CODES.SCRIPT_BUNDLE_INVENTORY,
    // Pattern 2: package.json scripts, Harness/plugin bundles, and surveillance report counts.
    // Covers both `dsh-plugin* bundles` / `plugin bundles` and `(DeepSeek) Harness bundles`.
    pattern:
      /\b(?:all\s+)?(?:\d[\d,]*\+?|(?:three|four|five|six|seven|eight|nine|ten))\s+(?:removable\s+)?(?:package\.json\s+scripts?|npm\s+scripts?|(?:deepseek\s+)?harness\s+bundles?|dsh-plugin\S*\s+bundles?|plugin\s+bundles?|auditable\s+surveillance\s+reports?)\b/gi,
    guidance:
      "state the discovery contract or entrypoint (`./bin/dx scripts`, `dsh-plugin*`, `reports/<timestamp>/MANIFEST.md`) instead of a static inventory count",
  },
  {
    code: CODES.SNAPSHOT_ENTITY_INVENTORY,
    // Pattern 3: Volatile per-office, customer account, and Polymarket wallet snapshot counts.
    // Covers both parenthetical forms (`(9,435 accounts)`, `(23 valid)`) and prose forms
    // (`23 valid Polymarket wallets`, `23 valid wallets`, `13 Per-Office`).
    pattern:
      /\b(?:all\s+)?\d[\d,]*\+?\s+(?:per-office\b|(?:customer|downline|active|total)\s+accounts?\b|valid\s+(?:polymarket\s+)?wallets?\b|configured\s+(?:polymarket\s+)?wallets?\b)|(?:full-customer|customer|downline|polymarket|wallets?)\s*\(\d[\d,]*\+?\s+(?:accounts?|valid|wallets?|customers?)\)|\(\d[\d,]*\+?\s+(?:valid|wallets?|customers?)\)/gi,
    guidance:
      "describe the wire filter or cohort rule (`type=\"B\"`, `valid 0x addresses`, `Full-Customer`) rather than a point-in-time entity count",
  },
];

/**
 * Normalize a single line for prose scanning while preserving exact line numbers
 * in the caller. Returns an empty string when the line is excluded (fenced code,
 * non-header shell comments, or single-line `<!-- staleness-ok -->`).
 */
export function normalizeProseLine(
  rawLine: string,
  inFence: boolean,
  fenceLang: string,
): string {
  if (SINGLE_LINE_ESCAPE_RE.test(rawLine)) {
    return "";
  }
  let line = rawLine;
  if (inFence) {
    if (!SHELL_FENCE_LANG_RE.test(fenceLang)) {
      return "";
    }
    const headerMatch = NUMBERED_SHELL_HEADER_RE.exec(rawLine);
    if (headerMatch === null || headerMatch[1] === undefined) {
      return "";
    }
    line = headerMatch[1];
  }
  // Strip Markdown link targets `[label](target)` -> `label`.
  line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  // Unwrap simple noun backticks (`package.json`, `*.test.ts`, `scripts/`, `bun-types`)
  // and blank out code-literal backtick spans (`type="B"`, `customerID="0"`).
  line = line.replace(/`([^`]+)`/g, (_full, inner: string) => {
    const trimmed = inner.trim();
    return UNWRAPPABLE_INLINE_NOUN_RE.test(trimmed) ? trimmed : " ";
  });
  return line;
}

/**
 * Scan an in-memory Markdown document and return all staleness issues in
 * line order. Pure function for deterministic unit and git-diff testing.
 */
export function scanMarkdownText(
  file: string,
  text: string,
  options: ScanOptions = {},
): DocStalenessIssue[] {
  const expectedBunVersion = options.expectedBunVersion ?? "1.4.4";
  const lines = text.split("\n");
  const issues: DocStalenessIssue[] = [];

  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;
  let fenceLang = "";

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNumber = index + 1;

    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(rawLine);
    if (fenceMatch !== null && fenceMatch[1] !== undefined) {
      const marker = fenceMatch[1];
      const char = marker[0] ?? "";
      if (!inFence) {
        inFence = true;
        fenceChar = char;
        fenceLen = marker.length;
        fenceLang = fenceMatch[2] ?? "";
        continue;
      }
      if (
        char === fenceChar &&
        marker.length >= fenceLen &&
        /^\s*(?:`{3,}|~{3,})\s*$/.test(rawLine)
      ) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        fenceLang = "";
        continue;
      }
    }

    const prose = normalizeProseLine(rawLine, inFence, fenceLang);
    if (prose.trim() === "") continue;

    for (const rule of PATTERN_RULES) {
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match: RegExpExecArray | null = regex.exec(prose);
      while (match !== null) {
        const matchedText = match[0];
        issues.push({
          file,
          line: lineNumber,
          code: rule.code,
          match: matchedText,
          message: `${file}:${lineNumber} contains hardcoded inventory/snapshot phrase ${JSON.stringify(matchedText)} — ${rule.guidance} (or append <!-- staleness-ok: <reason> --> if contractual)`,
        });
        match = regex.exec(prose);
      }
    }

    const bunTypesMatch =
      /\bRecord version:\s*bun-types\s+v(\d+\.\d+\.\d+)\b/i.exec(prose);
    if (
      bunTypesMatch !== null &&
      bunTypesMatch[1] !== undefined &&
      bunTypesMatch[1] !== expectedBunVersion
    ) {
      issues.push({
        file,
        line: lineNumber,
        code: CODES.BUN_VERSION_DRIFT,
        match: bunTypesMatch[0],
        message: `${file}:${lineNumber} pins ${JSON.stringify(bunTypesMatch[0])}, but package.json declares Bun/@types/bun ${expectedBunVersion}`,
      });
    }
  }

  return issues;
}

/** Read the expected Bun / `@types/bun` version from `package.json` at `root`. */
export function readExpectedBunVersion(root: string): string {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return "1.4.4";
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return "1.4.4";
    const record = parsed as Record<string, unknown>;
    const engines = record.engines;
    if (
      typeof engines === "object" &&
      engines !== null &&
      typeof (engines as Record<string, unknown>).bun === "string"
    ) {
      const ver = (engines as Record<string, string>).bun?.replace(/^[^\d]*/, "");
      if (ver) return ver;
    }
    const devDeps = record.devDependencies;
    if (
      typeof devDeps === "object" &&
      devDeps !== null &&
      typeof (devDeps as Record<string, unknown>)["@types/bun"] === "string"
    ) {
      const ver = (devDeps as Record<string, string>)["@types/bun"]?.replace(
        /^[^\d]*/,
        "",
      );
      if (ver) return ver;
    }
  } catch {
    return "1.4.4";
  }
  return "1.4.4";
}

/** Run the anti-staleness check across all configured target files under `options.root`. */
export function runStalenessChecks(options: RunOptions): DocCheckOutcome[] {
  const expectedBunVersion = readExpectedBunVersion(options.root);
  const outcomes: DocCheckOutcome[] = [];

  for (const target of options.targets) {
    const fullPath = join(options.root, target);
    if (!existsSync(fullPath)) {
      outcomes.push({
        target,
        status: "skip",
        issues: [],
        notes: [
          `${target} does not exist (skipped gracefully; governance/task docs may be renamed or retired)`,
        ],
      });
      continue;
    }

    const content = readFileSync(fullPath, "utf8");
    const issues = scanMarkdownText(target, content, { expectedBunVersion });
    if (issues.length === 0) {
      outcomes.push({
        target,
        status: "pass",
        issues: [],
        notes: [],
      });
    } else {
      outcomes.push({
        target,
        status: options.warn ? "warn" : "fail",
        issues,
        notes: [],
      });
    }
  }

  return outcomes;
}

/** Render outcomes to stdout and return the process exit code (`0` in `--warn` mode). */
export function reportStalenessOutcomes(
  outcomes: readonly DocCheckOutcome[],
  options: { readonly warn: boolean },
): number {
  let failedFiles = 0;
  let warnedFiles = 0;
  let skippedFiles = 0;
  let totalIssues = 0;

  for (const outcome of outcomes) {
    if (outcome.status === "fail") failedFiles += 1;
    if (outcome.status === "warn") warnedFiles += 1;
    if (outcome.status === "skip") skippedFiles += 1;
    totalIssues += outcome.issues.length;

    console.log(`${outcome.status.toUpperCase().padEnd(4)} ${outcome.target}`);
    for (const note of outcome.notes) {
      console.log(`     note: ${note}`);
    }
    for (const issue of outcome.issues) {
      console.log(`     - [${issue.code}] ${issue.message}`);
    }
  }

  const passedFiles =
    outcomes.length - failedFiles - warnedFiles - skippedFiles;
  console.log(
    `\ndocs staleness gate (${options.warn ? "warn-only" : "strict"}): ${outcomes.length} targets, ${passedFiles} pass, ${warnedFiles} warn, ${failedFiles} fail, ${skippedFiles} skip (${totalIssues} finding(s))`,
  );
  if (failedFiles > 0) {
    console.log("RESULT: FAIL");
    return 1;
  }
  console.log(warnedFiles > 0 ? "RESULT: WARN (exit 0)" : "RESULT: PASS");
  return 0;
}

const USAGE =
  "usage: bun run scripts/check_docs_staleness.ts [--warn] [--root <path>] [--target <relpath>...]";

export function parseCliArgs(argv: readonly string[]): RunOptions | string {
  let root = resolve(MODULE_DIR, "..");
  let warn = false;
  const customTargets: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--warn") {
      warn = true;
    } else if (arg === "--root") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return `--root requires a directory path\n${USAGE}`;
      }
      root = resolve(next);
      index += 1;
    } else if (arg === "--target") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        return `--target requires a relative file path\n${USAGE}`;
      }
      customTargets.push(next);
      index += 1;
    } else {
      return `unknown argument: ${String(arg)}\n${USAGE}`;
    }
  }

  return {
    root,
    warn,
    targets: customTargets.length > 0 ? customTargets : DEFAULT_TARGETS,
  };
}

function main(argv: readonly string[]): number {
  const options = parseCliArgs(argv);
  if (typeof options === "string") {
    console.error(options);
    return 2;
  }
  const outcomes = runStalenessChecks(options);
  return reportStalenessOutcomes(outcomes, { warn: options.warn });
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
