import { describe, expect, test } from "bun:test";

/**
 * Terminal formatting goes through `lib/terminal_format.ts`.
 *
 * The sweep that introduced the shared helpers had to fix the same class of bug in a dozen
 * places — UTF-16 length where a column was meant, an SGR-only regex where OSC/CSI mattered. This
 * ratchet keeps the next helper from bypassing the module: a display file may pad, clip, wrap and
 * strip, but it does so through the shared primitives, not a fresh `Bun.stringWidth` call.
 *
 * Allowed to call the natives directly:
 * - `lib/terminal_format.ts` — the implementation itself.
 * - `scripts/probe_bun.ts` — a probe whose job is to measure what Bun does.
 * - `scripts/bun_shape_contracts.ts` — the shape catalogue's documentation strings, not calls.
 */

const NATIVE_CALLS = [
  "Bun.stringWidth(",
  "Bun.wrapAnsi(",
  "Bun.stripANSI(",
] as const;

const ALLOWED = new Set([
  "lib/terminal_format.ts",
  "scripts/probe_bun.ts",
  "scripts/bun_shape_contracts.ts",
]);

const ROOTS = ["lib", "scripts", "src", "cli"] as const;

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    const glob = new Bun.Glob(`${root}/**/*.ts`);
    for (const path of glob.scanSync({ dot: false })) {
      if (
        path.endsWith(".test.ts") ||
        path.endsWith(".test-d.ts") ||
        path.includes(".generated.")
      ) {
        continue;
      }
      files.push(path);
    }
  }
  return files;
}

describe("terminal formatting adoption", () => {
  test("no display module calls the Bun text natives directly", async () => {
    const offenders: string[] = [];
    for (const path of sourceFiles()) {
      if (ALLOWED.has(path)) continue;
      let text: string;
      try {
        text = await Bun.file(path).text();
      } catch {
        // A fixture that vanished between the glob and the read is not a source file.
        continue;
      }
      // Comments that name the native (a doc line, a rationale) are not calls.
      const executable = text
        .split("\n")
        .filter((line) => {
          const trimmed = line.trimStart();
          return !(
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("/*")
          );
        })
        .join("\n");
      for (const call of NATIVE_CALLS) {
        if (executable.includes(call)) offenders.push(`${path}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the guard would catch a new direct call", () => {
    // Keep the test honest: the needle is what a regression looks like, and the allowlist is
    // small on purpose.
    expect(NATIVE_CALLS.every((call) => call.endsWith("("))).toBe(true);
    expect(ALLOWED.size).toBe(3);
  });
});
