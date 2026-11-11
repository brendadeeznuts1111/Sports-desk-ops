#!/usr/bin/env bun
/**
 * Native Bun Lint Rule: no-unsafe-innerhtml
 * Enforces that `.innerHTML` is never assigned a non-literal expression or unescaped concatenation.
 *
 * Disallowed:
 *   element.innerHTML = variable
 *   element.innerHTML = `template ${variable}`
 *   element.innerHTML = a + b
 *
 * Also enforces external-asset integrity in HTML: every absolute http(s) `<script src>` /
 * `<link rel="stylesheet">` must be pinned in `pinned/cdn-manifest.json` and carry the pinned
 * `integrity=` + `crossorigin="anonymous"`. `rel="stylesheet/less"` tags are pin-coverage only:
 * less.js fetches them over XHR, where browsers never consult SRI.
 *
 * Also enforces that every `Bun.markdown.html(...)` / `Bun.markdown.render(...)` call is annotated:
 * the native renderer passes raw HTML and attributes through unsanitized, so its output is a sink
 * wherever it is placed. A call is only accepted with `// trusted-markdown: <reason>` on the same
 * line or the line above, which keeps each raw-HTML decision reviewable.
 *
 * Allowed:
 *   element.innerHTML = "" (literal clearing)
 *   element.innerHTML = "constant static string"
 *   element.innerHTML = expr; // sanitized: <ticket-or-path> — <reason>
 *   Bun.markdown.html(src, opts); // trusted-markdown: <reason>
 */

import path from "node:path";
import { parseArgs } from "node:util";
import { listSourceFiles } from "../lib/source_files.ts";
import { loadCdnManifest } from "../lib/f402_cdn_pin.ts";
import type { CdnManifest } from "../lib/f402_cdn_pin.ts";
import { findSriIssues } from "../lib/f402_sri.ts";

const { values, positionals } = parseArgs({
  options: { verbose: { type: "boolean", default: false } },
  allowPositionals: true,
});
const ROOT = path.resolve(positionals[0] ?? path.join(import.meta.dir, ".."));
const isVerbose = values.verbose;

const INNER_HTML_ASSIGN_RE = /\.innerHTML\s*=\s*(.+?);?$/;
const EXTERNAL_ASSET_TAG_RE =
  /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']https?:\/\//i;
// A backslash run escapes the next character: client JS emitted from a TS template literal
// carries its quotes double-escaped (`\\"`). Any bare quote in the middle still fails the match.
const SAFE_STATIC_LITERAL_RE = /^(['"])(?:\\+.|(?!\1)[^\\])*\1$/;
const MARKDOWN_SINK_RE =
  /\b(?:(?:globalThis\.)?Bun\.markdown)\.(?:html|render)\s*\(/;
const BUN_NAMED_IMPORT_RE = /\bimport\s+\{([^}]+)\}\s+from\s+["']bun["']/g;
const BUN_NS_IMPORT_RE =
  /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s+from\s+["']bun["']/g;
const BUN_MARKDOWN_DESTRUCTURE_RE =
  /\bconst\s+\{([^}]+)\}\s*=\s*(?:globalThis\.)?Bun\b/g;

function escapeRegexIdent(ident: string): string {
  return ident.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMarkdownSinkRegexes(content: string): readonly RegExp[] {
  const regexes: RegExp[] = [MARKDOWN_SINK_RE];
  const markdownAliases = new Set<string>();
  const bunNsAliases = new Set<string>();

  for (const m of content.matchAll(BUN_NAMED_IMPORT_RE)) {
    for (const raw of m[1]?.split(",") ?? []) {
      const cleaned = raw.trim().replace(/^type\s+/, "");
      const asMatch = /^markdown(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(cleaned);
      if (asMatch !== null) {
        markdownAliases.add(asMatch[1] ?? "markdown");
      }
    }
  }
  for (const m of content.matchAll(BUN_MARKDOWN_DESTRUCTURE_RE)) {
    for (const raw of m[1]?.split(",") ?? []) {
      const colonMatch = /^markdown(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(
        raw.trim(),
      );
      if (colonMatch !== null) {
        markdownAliases.add(colonMatch[1] ?? "markdown");
      }
    }
  }
  for (const m of content.matchAll(BUN_NS_IMPORT_RE)) {
    if (m[1] !== undefined) bunNsAliases.add(m[1]);
  }

  for (const alias of markdownAliases) {
    const esc = escapeRegexIdent(alias);
    regexes.push(new RegExp(`(?<!\\.)\\b${esc}\\.(?:html|render)\\s*\\(`));
  }
  for (const ns of bunNsAliases) {
    const esc = escapeRegexIdent(ns);
    regexes.push(
      new RegExp(`(?<!\\.)\\b${esc}\\.markdown\\.(?:html|render)\\s*\\(`),
    );
  }
  return regexes;
}

/**
 * Help text can name the renderer (`--html   Bun.markdown.html() + options`), and only a call is a
 * sink. A call starts the statement, or follows `=`, `(`, `:` or `,`, or a `return`.
 */
function isMarkdownSinkCall(
  line: string,
  sinkRegexes: readonly RegExp[],
): boolean {
  for (const re of sinkRegexes) {
    const match = re.exec(line);
    if (match === null) continue;
    const before = line.slice(0, match.index).trimEnd();
    if (before === "") return true;
    const last = before.at(-1);
    if (last === "=" || last === "(" || last === ":" || last === ",") {
      return true;
    }
    if (/\breturn$/.test(before)) return true;
  }
  return false;
}

function isTestFile(relPath: string): boolean {
  const norm = `/${relPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  return (
    norm.endsWith(".test.ts") ||
    norm.endsWith(".test.js") ||
    norm.includes("/tests/") ||
    norm.includes("/test/") ||
    norm.includes("/fixtures/") ||
    norm.includes("/examples/")
  );
}

function auditFile(content: string, relPath: string): string[] {
  if (isTestFile(relPath)) {
    return [];
  }

  const violations: string[] = [];
  const lines = content.split("\n");
  const sinkRegexes = buildMarkdownSinkRegexes(content);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const stripped = line.trim();

    if (stripped.startsWith("//") || stripped.startsWith("*")) {
      continue;
    }
    if (
      stripped.includes("// sanitized:") ||
      stripped.includes("/* sanitized:")
    ) {
      continue;
    }

    if (
      isMarkdownSinkCall(stripped, sinkRegexes) &&
      !stripped.includes("// trusted-markdown:") &&
      !(lines[idx - 1] ?? "").includes("// trusted-markdown:")
    ) {
      violations.push(
        `Line ${idx + 1}: Unsafe Bun.markdown render sink '${stripped.slice(0, 60)}'. The native renderer passes raw HTML through; annotate with "// trusted-markdown: <reason>" or sanitize the output.`,
      );
    }

    const match = stripped.match(INNER_HTML_ASSIGN_RE);
    if (match) {
      const rhs = match[1]!.trim().replace(/;$/, "");
      if (SAFE_STATIC_LITERAL_RE.test(rhs)) {
        continue;
      }
      violations.push(
        `Line ${idx + 1}: Unsafe innerHTML assignment with dynamic expression '${rhs}'. Use textContent or DOM creation.`,
      );
    }
  }

  return violations;
}

async function main(): Promise<void> {
  let scannedCount = 0;
  let totalViolations = 0;
  let cdnManifest: CdnManifest | null = null;
  try {
    cdnManifest = await loadCdnManifest();
  } catch (error) {
    console.error(`check-innerhtml: ${(error as Error).message}`);
  }

  for (const file of await listSourceFiles(ROOT, [
    "ts",
    "tsx",
    "mts",
    "js",
    "mjs",
    "html",
  ])) {
    if (file.includes("/verification/manager-boot-oracle/pinned/")) continue;
    scannedCount++;
    const fullPath = path.join(ROOT, file);
    const content = await Bun.file(fullPath).text();
    const violations = auditFile(content, file);

    if (file.endsWith(".html") && !isTestFile(file)) {
      if (cdnManifest === null) {
        if (EXTERNAL_ASSET_TAG_RE.test(content)) {
          violations.push(
            "Line 1: external asset tag present but pinned/cdn-manifest.json is missing",
          );
        }
      } else {
        for (const issue of findSriIssues(content, cdnManifest)) {
          violations.push(
            `Line ${issue.line}: ${issue.message} (${issue.url})`,
          );
        }
      }
    }

    if (violations.length > 0) {
      console.log(`FAIL: ${file}`);
      for (const err of violations) {
        console.log(`  - ${err}`);
      }
      totalViolations += violations.length;
    } else if (isVerbose) {
      console.log(`PASS: ${file}`);
    }
  }

  if (totalViolations === 0) {
    console.log(
      `PASS: ${scannedCount} files scanned across ${ROOT}. Zero unsafe innerHTML assignments.`,
    );
    process.exit(0);
  } else {
    console.error(
      `FAILED: ${totalViolations} unsafe innerHTML violation(s) found across codebase.`,
    );
    process.exit(1);
  }
}

await main();
