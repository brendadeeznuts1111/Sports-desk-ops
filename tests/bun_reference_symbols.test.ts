import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(reference.sources.root.symbols).toContain("JSONL");
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
});
