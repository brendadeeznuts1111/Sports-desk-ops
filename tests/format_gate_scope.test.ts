/**
 * Pins the coupling fix: the format gate must check the INDEX (what will be committed), not
 * whatever scratch files happen to sit in a contributor's working tree. Before this, a single
 * untracked file made `bun run format:check` red for everyone.
 */
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";

import { trackedFiles } from "../bin/check-format.ts";

const PROBE = "__format_gate_probe__.md";

describe("format gate scope", () => {
  test("the gate lists tracked files, never untracked scratch files", () => {
    writeFileSync(PROBE, "#   probe\n\n\n\n* item\n");
    try {
      const files = trackedFiles();
      // A known tracked file is present; the untracked probe is not.
      expect(files).toContain("package.json");
      expect(files).not.toContain(PROBE);
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(
        false,
      );
    } finally {
      rmSync(PROBE, { force: true });
    }
  });
});
