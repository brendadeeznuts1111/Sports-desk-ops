import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BOOLEAN_ARRAY =
  /\b(?:readonly\s+)?boolean\s*\[\s*\]|Array<\s*boolean\s*>/;

/**
 * Dense flags are bitsets. The fraud feature model is the one known exception (its matrix is
 * offline and already marked for replacement in `scratch/data_handling_audit_focus.md`); every
 * other runtime module must not introduce `boolean[]`.
 */
describe("runtime data-handling contract", () => {
  test("boolean[] is confined to the fraud-model exception", async () => {
    const offenders: string[] = [];
    const glob = new Bun.Glob("**/*.ts");
    for await (const path of glob.scan({
      cwd: join(ROOT, "lib"),
      onlyFiles: true,
    })) {
      if (path.includes(".test.")) continue;
      const text = await Bun.file(join(ROOT, "lib", path)).text();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("*") ||
          trimmed.startsWith("//") ||
          trimmed.startsWith("/*")
        ) {
          continue;
        }
        if (BOOLEAN_ARRAY.test(line)) {
          offenders.push(`lib/${path}`);
          break;
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual(["lib/fraud_model.ts"]);
  });
});
