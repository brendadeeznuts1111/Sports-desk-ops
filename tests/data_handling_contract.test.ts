import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const BOOLEAN_ARRAY =
  /\b(?:readonly\s+)?boolean\s*\[\s*\]|\b(?:Readonly)?Array<\s*boolean\s*>/;

// Zero-exception contract: every entry is line-anchored AND stale-checked.
const RATCHET: ReadonlyArray<{ file: string; line: number }> = [];

const SCAN_ROOTS = [
  "lib",
  "src",
  "types",
  "cli",
  "services",
  "scripts",
  "bin",
] as const;

describe("runtime data-handling contract", () => {
  test("boolean[] is confined to the pinned ratchet", async () => {
    const ratchetSet = new Set(RATCHET.map((r) => `${r.file}:${r.line}`));
    const offenders: string[] = [];

    for (const root of SCAN_ROOTS) {
      const dir = join(ROOT, root);
      const glob = new Bun.Glob("**/*.ts");
      for await (const path of glob.scan({ cwd: dir, onlyFiles: true })) {
        if (path.includes(".test.")) continue;
        const rel = `${root}/${path}`;
        const text = await Bun.file(join(dir, path)).text();
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const raw = lines[i]!;
          const trimmed = raw.trim();
          if (
            trimmed.startsWith("*") ||
            trimmed.startsWith("//") ||
            trimmed.startsWith("/*")
          ) {
            continue;
          }
          if (!BOOLEAN_ARRAY.test(raw)) continue;
          const key = `${rel}:${i + 1}`;
          if (!ratchetSet.has(key)) offenders.push(key);
        }
      }
    }

    const stale: string[] = [];
    for (const entry of RATCHET) {
      const line =
        (await Bun.file(join(ROOT, entry.file)).text()).split("\n")[
          entry.line - 1
        ] ?? "";
      if (!BOOLEAN_ARRAY.test(line)) stale.push(`${entry.file}:${entry.line}`);
    }

    expect(stale).toEqual([]);
    expect(offenders).toEqual([]);
  });
});
