#!/usr/bin/env bun
/**
 * Audit the documented Bun global surface against this repo's catalogs and usage.
 *
 * Sources (network is deliberate; this is a manual audit, not a CI gate):
 *  - https://bun.sh/reference/globals/bun — documented Bun functions/classes/variables/namespaces;
 *  - lib/bun_shapes.ts — the shape catalog the docs gates reference;
 *  - bin/bun_surface.ts — the pinned runtime presence checks;
 *  - the tracked source tree — `Bun.<name>` call sites.
 *
 * Usage: bun run scripts/audit_bun_surface.ts [--json] [--limit N]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const URL_REFERENCE = "https://bun.sh/reference/globals/bun";
const SECTIONS = [
  "functions",
  "classes",
  "interfaces",
  "types",
  "variables",
  "namespaces",
] as const;
const RUNTIME_SECTIONS = [
  "functions",
  "classes",
  "variables",
  "namespaces",
] as const;
const RUNTIME_ROOTS = ["lib", "scripts", "services", "bin", "cli"];
const TEST_ROOTS = ["tests"];
const CATALOG_FILES = new Set([
  "lib/bun_shapes.ts",
  "bin/bun_surface.ts",
  "scripts/probe_bun.ts",
  "scripts/audit_bun_surface.ts",
]);

interface DocumentedEntry {
  readonly section: (typeof RUNTIME_SECTIONS)[number];
  readonly name: string;
  readonly description: string;
}

interface AuditResult {
  readonly generatedAt: string;
  readonly counts: Readonly<Record<(typeof SECTIONS)[number], number>>;
  readonly documentedRuntime: number;
  readonly cataloged: readonly string[];
  readonly pinned: readonly string[];
  readonly used: readonly string[];
  readonly usedRuntime: readonly string[];
  readonly usedTests: readonly string[];
  readonly documentedNotCataloged: readonly DocumentedEntry[];
  readonly catalogedNotDocumented: readonly string[];
  readonly usedNotCataloged: readonly string[];
  readonly usedNotPinned: readonly string[];
  readonly pinnedNotDocumented: readonly string[];
}

/** Strip tags and decode the few entities the reference page emits inside labels. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** `Bun.allocUnsafe()` / `class Bun.Archive` / `const Bun.argv` / `namespace Bun.$` -> name. */
function entryName(section: string, label: string): string {
  const stripped = label
    .replace(/^(class|const|namespace|interface|type)\s+/, "")
    .replace(/^Bun\./, "")
    .replace(/\(\)$/, "");
  return stripped;
}

function sliceSection(
  html: string,
  section: (typeof SECTIONS)[number],
): string {
  const start = html.indexOf(`id="${section}"`);
  if (start < 0) return "";
  const index = SECTIONS.indexOf(section);
  const next = SECTIONS[index + 1];
  const end =
    next === undefined ? html.length : html.indexOf(`id="${next}"`, start + 10);
  return html.slice(start, end < 0 ? html.length : end);
}

async function fetchDocumented(): Promise<{
  counts: Record<string, number>;
  runtime: DocumentedEntry[];
  allNames: string[];
}> {
  const response = await fetch(URL_REFERENCE);
  if (!response.ok) {
    throw new Error(`reference fetch failed: HTTP ${response.status}`);
  }
  const html = await response.text();
  const counts: Record<string, number> = {};
  const runtime: DocumentedEntry[] = [];
  const allNames: string[] = [];
  for (const section of SECTIONS) {
    const body = sliceSection(html, section);
    const entries = [
      ...body.matchAll(
        /<li[^>]*>[\s\S]*?<a href="\/reference\/globals\/bun\/([^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)<\/li>/g,
      ),
    ].map(([, href, labelHtml, rest]) => ({
      href: decodeURIComponent(href ?? ""),
      label: plainText(labelHtml ?? ""),
      description: plainText(rest ?? "").slice(0, 160),
    }));
    counts[section] = entries.length;
    for (const entry of entries) {
      const name = entryName(section, entry.label) || entry.href;
      if (name === "") continue;
      allNames.push(name);
      if (!(RUNTIME_SECTIONS as readonly string[]).includes(section)) continue;
      runtime.push({
        section: section as DocumentedEntry["section"],
        name,
        description: entry.description,
      });
    }
  }
  return { counts, runtime, allNames: [...new Set(allNames)] };
}

function namesFromCatalog(relativePath: string): string[] {
  const text = readFileSync(join(ROOT, relativePath), "utf8");
  return [...text.matchAll(/\bname:\s*"([^"]+)"/g)].map(([, name]) =>
    String(name),
  );
}

function trackedSourceFiles(roots: readonly string[]): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files", ...roots],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .filter((path) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path))
    .filter((path) => !CATALOG_FILES.has(path));
}

/** Comments and string/template literals are not call sites (they caused `Bun.not`). */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function scanUsage(roots: readonly string[]): string[] {
  const used = new Set<string>();
  const pattern = /\bBun\.([A-Za-z_$][\w$]*)/g;
  for (const path of trackedSourceFiles(roots)) {
    const text = codeOnly(readFileSync(join(ROOT, path), "utf8"));
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && name !== "") used.add(name);
    }
  }
  return [...used].sort();
}

const args = new Set(Bun.argv.slice(2));
const limitIndex = Bun.argv.indexOf("--limit");
const limit =
  limitIndex >= 0 && Bun.argv[limitIndex + 1] !== undefined
    ? Number(Bun.argv[limitIndex + 1])
    : 30;

const documented = await fetchDocumented();
const documentedNames = new Set(documented.allNames);
const cataloged = [...new Set(namesFromCatalog("lib/bun_shapes.ts"))].sort();
const pinned = [...new Set(namesFromCatalog("bin/bun_surface.ts"))].sort();
const usedRuntime = scanUsage(RUNTIME_ROOTS);
const usedTests = scanUsage(TEST_ROOTS);
const used = [...new Set([...usedRuntime, ...usedTests])].sort();
const catalogedSet = new Set(cataloged);
const pinnedSet = new Set(pinned);
const pinnedRoots = new Set(pinned.map((name) => name.split(".")[0] ?? name));

const result: AuditResult = {
  generatedAt: new Date().toISOString(),
  counts: documented.counts as AuditResult["counts"],
  documentedRuntime: documented.runtime.length,
  cataloged,
  pinned,
  used,
  documentedNotCataloged: documented.runtime
    .filter((entry) => !catalogedSet.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name)),
  catalogedNotDocumented: cataloged.filter(
    (name) => !documentedNames.has(name),
  ),
  usedNotCataloged: used.filter((name) => !catalogedSet.has(name)),
  usedRuntime,
  usedTests,
  usedNotPinned: used.filter(
    (name) => !pinnedSet.has(name) && !pinnedRoots.has(name),
  ),
  pinnedNotDocumented: pinned.filter((name) => !documentedNames.has(name)),
};

if (args.has("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Bun reference: ${URL_REFERENCE}`);
  console.log(
    `documented: ${Object.entries(result.counts)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(" ")} -> ${result.documentedRuntime} runtime globals`,
  );
  console.log(
    `repo: catalog=${cataloged.length} pinned=${pinned.length} referenced=${used.length} (runtime=${usedRuntime.length} tests=${usedTests.length})`,
  );
  console.log(
    `\ndocumented but not cataloged (${result.documentedNotCataloged.length}):`,
  );
  for (const entry of result.documentedNotCataloged.slice(0, limit)) {
    console.log(
      `  ${entry.name.padEnd(28)} ${entry.section.padEnd(10)} ${entry.description}`,
    );
  }
  console.log(
    `\ncataloged but not documented / Bun extensions (${result.catalogedNotDocumented.length}): ${result.catalogedNotDocumented.join(", ")}`,
  );
  console.log(
    `\nreferenced but not cataloged (${result.usedNotCataloged.length}): ${result.usedNotCataloged.join(", ")}`,
  );
  console.log(
    `runtime-only, not cataloged: ${usedRuntime.filter((name) => !catalogedSet.has(name)).join(", ") || "(none)"}`,
  );
  console.log(
    `\nused in source but not pinned in bin/bun_surface.ts (${result.usedNotPinned.length}): ${result.usedNotPinned.join(", ")}`,
  );
}
