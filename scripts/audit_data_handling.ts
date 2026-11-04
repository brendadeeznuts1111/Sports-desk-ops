/**
 * Data-handling audit. Globs the repo with Bun.Glob, scores collection/IO patterns, and inventories
 * large or duplicated data artifacts. Read-only: no file is modified or deleted.
 *
 * Run: bun run scratch/data_handling_audit.ts
 */
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CODE_EXCLUDE = [
  "node_modules",
  ".git",
  ".agents",
  "scratch",
  "dist",
  "coverage",
  "profiles",
  "vendor",
  "tests",
  "dsh-plugin",
  "docs",
  "static",
];
const DATA_EXCLUDE = [
  "node_modules",
  ".git",
  ".agents",
  "scratch",
  "coverage",
  "profiles",
  "vendor",
];

interface Pattern {
  readonly id: string;
  readonly note: string;
  readonly re: RegExp;
}

const CODE_PATTERNS: readonly Pattern[] = [
  { id: "Map", note: "hash table", re: /\bnew\s+Map\s*[<(]/g },
  { id: "Set", note: "hash set", re: /\bnew\s+Set\s*[<(]/g },
  {
    id: "bool[]",
    note: "boolean array",
    re: /\bboolean\s*\[\s*\]|Array<\s*boolean\s*>/g,
  },
  { id: "readFileSync", note: "sync file read", re: /\breadFileSync\s*\(/g },
  { id: "JSON.parse", note: "full parse", re: /\bJSON\.parse\s*\(/g },
  {
    id: "filter+map",
    note: "intermediate array",
    re: /\.filter\s*\([^)]*\)\s*\.map\s*\(/g,
  },
  { id: "Array.from", note: "materialization", re: /\bArray\.from\s*\(/g },
  {
    id: "structuredClone",
    note: "deep clone",
    re: /\bstructuredClone\s*\(/g,
  },
  {
    id: "sync fs",
    note: "statSync/existsSync/readdirSync",
    re: /\b(?:statSync|existsSync|readdirSync)\s*\(/g,
  },
  {
    id: "sync spawn",
    note: "execSync/spawnSync",
    re: /\b(?:execSync|spawnSync)\s*\(/g,
  },
  { id: "new Array", note: "unclear length", re: /\bnew\s+Array\s*\(/g },
  {
    id: "map+sort",
    note: "re-sorts per metric",
    re: /\.map\s*\([^)]*\)\s*\.sort\s*\(/g,
  },
  {
    id: "push spread",
    note: "spread into push",
    re: /\.push\s*\(\s*\.\.\./g,
  },
  {
    id: "sort template",
    note: "sort allocates key strings",
    re: /\.sort\s*\(\s*\([^)]*\)\s*=>[^;]{0,160}?`/g,
  },
];

interface CodeFinding {
  readonly file: string;
  readonly pattern: string;
  readonly note: string;
  readonly count: number;
  readonly lines: readonly number[];
  readonly score: number;
}

function excluded(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function scoreCode(file: string, total: number): number {
  let score = total;
  if (file.startsWith("services/")) score += 8;
  if (file.startsWith("lib/")) score += 5;
  if (file.startsWith("bin/")) score += 3;
  if (file.startsWith("cli/")) score += 3;
  if (file.startsWith("scripts/")) score += 1;
  if (file.endsWith(".html")) score += 2;
  return score;
}

const codeFiles: string[] = [];
const codeGlob = new Bun.Glob("**/*.{ts,tsx,js,mjs,html}");
for await (const path of codeGlob.scan({
  cwd: ROOT,
  onlyFiles: true,
  dot: false,
})) {
  if (excluded(path, CODE_EXCLUDE)) continue;
  if (path.includes(".test.")) continue;
  codeFiles.push(path);
}

const findings: CodeFinding[] = [];
for (const file of codeFiles.sort()) {
  const text = await Bun.file(resolve(ROOT, file)).text();
  for (const pattern of CODE_PATTERNS) {
    const lines: number[] = [];
    let count = 0;
    for (const match of text.matchAll(pattern.re)) {
      count += 1;
      if (lines.length < 6) lines.push(lineOf(text, match.index ?? 0));
    }
    if (count === 0) continue;
    findings.push({
      file,
      pattern: pattern.id,
      note: pattern.note,
      count,
      lines,
      score: scoreCode(file, count),
    });
  }
}

findings.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

interface DataFile {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

const dataFiles: DataFile[] = [];
const dataGlob = new Bun.Glob("**/*.{json,jsonl,html,zip}");
for await (const path of dataGlob.scan({
  cwd: ROOT,
  onlyFiles: true,
  dot: false,
})) {
  if (excluded(path, DATA_EXCLUDE)) continue;
  if (!(
    path.startsWith("data/") ||
    path.startsWith("docs/") ||
    path.startsWith("static/") ||
    path.startsWith("tests/fixtures/") ||
    path.startsWith("dist/") ||
    !path.includes("/")
  )) {
    continue;
  }
  const file = Bun.file(resolve(ROOT, path));
  const bytes = file.size;
  if (bytes < 32 * 1024) continue;
  dataFiles.push({
    file: path,
    bytes,
    sha256: await sha256(resolve(ROOT, path)),
  });
}

dataFiles.sort((a, b) => b.bytes - a.bytes);

const byHash = new Map<string, string[]>();
for (const entry of dataFiles) {
  const list = byHash.get(entry.sha256) ?? [];
  list.push(entry.file);
  byHash.set(entry.sha256, list);
}
const duplicates = [...byHash.entries()]
  .filter(([, files]) => files.length > 1)
  .map(([hash, files]) => ({ hash, files }));

const piiPattern =
  /(live-(?:bets|wagers)|customer|enriched|agent-tree|graph-live)/i;
const largeData = dataFiles.filter((entry) => entry.bytes >= 512 * 1024);

console.log("# Data-handling audit\n");
console.log(`Code files scanned: ${codeFiles.length}`);
console.log(`Data files ≥32 KiB: ${dataFiles.length}\n`);

console.log("## Code findings (top 40 by score)\n");
console.log("| file | score | pattern | count | lines |");
console.log("| --- | ---: | --- | ---: | --- |");
for (const finding of findings.slice(0, 40)) {
  console.log(
    `| \`${finding.file}\` | ${finding.score} | ${finding.pattern} (${finding.note}) | ${finding.count} | ${finding.lines.join(", ")} |`,
  );
}

console.log("\n## Large data (≥512 KiB)\n");
console.log("| file | bytes | sha256 | note |");
console.log("| --- | ---: | --- | --- |");
for (const entry of largeData) {
  const note = piiPattern.test(entry.file)
    ? "PII / live artifact — do not commit"
    : entry.file.startsWith("dist/")
      ? "generated copy"
      : "review";
  console.log(
    `| \`${entry.file}\` | ${entry.bytes.toLocaleString()} | \`${entry.sha256.slice(0, 16)}…\` | ${note} |`,
  );
}

console.log("\n## Duplicate data (same SHA-256)\n");
if (duplicates.length === 0) {
  console.log("None above the 32 KiB floor.");
} else {
  for (const duplicate of duplicates) {
    console.log(
      `- \`${duplicate.hash.slice(0, 16)}…\`: ${duplicate.files.map((f) => `\`${f}\``).join(", ")}`,
    );
  }
}
