import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUN_KNOWN_REFERENCE_SYMBOLS,
  BUN_ROOT_REFERENCE_SYMBOLS,
  resolveBunSymbolReferenceUrl,
} from "../lib/bun_urls.ts";

interface SourceSymbols {
  readonly url: string;
  readonly symbols: readonly string[];
}

interface ReferenceSymbols {
  readonly schemaVersion: number;
  readonly observedAt: string;
  readonly runtime: string;
  readonly note: string;
  readonly sources: {
    readonly root: SourceSymbols;
    readonly archive: SourceSymbols;
    readonly shell: SourceSymbols;
    readonly nodeCrypto: SourceSymbols;
  };
}

const ROOT = join(import.meta.dir, "..");
const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "fixtures", "bun-reference-symbols.json"),
    "utf8",
  ),
) as ReferenceSymbols;

const SKIP_DIRS = [
  "node_modules/",
  ".agents/",
  ".worktrees/",
  "Scratch/",
  "dist/",
  "coverage/",
  "reports/",
];

/**
 * Every `.ts` path this checkout holds, read defensively.
 *
 * `tests/audit_filehandle_read_stream.test.ts` writes a fixture **inside `tests/`** for the
 * duration of one test. Bun's runner has several test files in flight, so a repo-wide glob can
 * list that path a moment before the fixture's `finally` removes it; the file is a transient
 * artifact, not a source file, and skipping it is correct rather than a workaround. Observed as
 * `ENOENT … tests/audit-filehandle-fixture.ts` on main 2026-11-19.
 */
function repoTypeScriptFiles(): string[] {
  const files: string[] = [];
  for (const rel of new Bun.Glob("**/*.ts").scanSync({
    cwd: ROOT,
    onlyFiles: true,
    dot: false,
  })) {
    if (SKIP_DIRS.some((dir) => rel.startsWith(dir))) continue;
    files.push(rel);
  }
  return files;
}

/** `null` when the path vanished between the glob and the read. */
function readRepoFile(rel: string): string | null {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function nodeCryptoNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(
    /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']node:crypto["']/g,
  )) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name && name !== "type") names.push(name);
    }
  }
  return names;
}

function shellMembers(text: string): string[] {
  return [...text.matchAll(/Bun\.\$\.([A-Za-z_$][\w$]*)/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("Bun reference symbol baseline", () => {
  test("fixture is a sorted, unique symbol inventory", () => {
    expect(reference.schemaVersion).toBe(1);
    expect(reference.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(reference.runtime).toBe("Bun 1.4.4");
    for (const source of Object.values(reference.sources)) {
      expect(source.url.startsWith("https://bun.com/reference/")).toBe(true);
      expect(source.symbols.length).toBeGreaterThan(0);
      expect(new Set(source.symbols).size).toBe(source.symbols.length);
      expect([...source.symbols].sort()).toEqual([...source.symbols]);
    }
    expect(reference.sources.root.symbols).toContain("hash");
    expect(reference.sources.root.symbols).toContain("Image");
    expect(reference.sources.root.symbols).toContain("JSONL");
    expect(reference.sources.root.symbols).toContain("RedisClient");
    expect(reference.sources.root.symbols).toContain("WebView");
    expect(reference.sources.root.symbols).toContain("BuildConfig");
    expect(reference.sources.root.symbols).toContain("CronController");
    expect(reference.sources.root.symbols).toContain("FetchSessionInit");
    expect(reference.sources.root.symbols).toContain("MatchedRoute");
    expect(reference.sources.root.symbols).toContain("ServerWebSocket");
    expect(reference.sources.root.symbols).toContain("TerminalOptions");
    expect(reference.sources.archive.symbols).toContain("blob");
    expect(reference.sources.archive.symbols).toContain("extract");
    expect(reference.sources.archive.symbols).toContain("ArchiveInput");
    expect(reference.sources.shell.symbols).toContain("escape");
    expect(reference.sources.nodeCrypto.symbols).toContain("createHash");
  });

  test("every named node:crypto import is documented", () => {
    const documented = new Set(reference.sources.nodeCrypto.symbols);
    const missing = new Map<string, string[]>();
    for (const rel of repoTypeScriptFiles()) {
      const names = nodeCryptoNames(readFileSync(join(ROOT, rel), "utf8"));
      for (const name of names) {
        if (documented.has(name)) continue;
        const list = missing.get(name) ?? [];
        list.push(rel);
        missing.set(name, list);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  test("every Bun.$ member access is documented", () => {
    const documented = new Set(reference.sources.shell.symbols);
    const missing = new Map<string, string[]>();
    for (const rel of repoTypeScriptFiles()) {
      for (const name of shellMembers(readFileSync(join(ROOT, rel), "utf8"))) {
        if (documented.has(name)) continue;
        const list = missing.get(name) ?? [];
        list.push(rel);
        missing.set(name, list);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  test("every Bun.Archive member access is documented", () => {
    const documented = new Set(reference.sources.archive.symbols);
    const missing = new Map<string, string[]>();
    for (const rel of repoTypeScriptFiles()) {
      const text = readRepoFile(rel);
      if (text === null) continue;
      for (const match of text.matchAll(
        /\bBun\.Archive\.([A-Za-z_$][\w$]*)/g,
      )) {
        const name = match[1] ?? "";
        if (documented.has(name)) continue;
        const list = missing.get(name) ?? [];
        list.push(rel);
        missing.set(name, list);
      }
    }
    expect(Object.fromEntries(missing)).toEqual({});
  });

  test("BUN_ROOT_REFERENCE_SYMBOLS matches sources.root.symbols and resolves to canonical URLs", () => {
    expect<readonly string[]>(BUN_ROOT_REFERENCE_SYMBOLS).toEqual(
      reference.sources.root.symbols,
    );
    for (const sym of reference.sources.root.symbols) {
      expect(BUN_KNOWN_REFERENCE_SYMBOLS[`Bun.${sym}`]).toBe(`bun/${sym}`);
      expect(resolveBunSymbolReferenceUrl(`Bun.${sym}`)).toBe(
        `https://bun.com/reference/bun/${sym}`,
      );
    }
  });
});
