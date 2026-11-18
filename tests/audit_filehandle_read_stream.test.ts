import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "tests", "audit-filehandle-fixture.ts");

describe("audit: FileHandle.createReadStream options", () => {
  test("flags invalid inclusive ranges and fd/close lifetime options", () => {
    writeFileSync(
      FIXTURE,
      [
        'import { open, type FileHandle } from "node:fs/promises";',
        'const fh: FileHandle = await open("x");',
        "fh.createReadStream({",
        "  start: -1,",
        "  end: 9007199254740992,",
        "  autoClose: false,",
        "  emitClose: false,",
        "  highWaterMark: -1,",
        "});",
        "fh.createReadStream({ start: 10, end: 5 });",
        "",
      ].join("\n"),
    );
    try {
      const proc = Bun.spawnSync({
        cmd: [
          process.execPath,
          "scripts/audit_bun_failclosed_edges.ts",
          "--json",
        ],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      // The fixture intentionally contains ERROR-level range violations.
      expect(proc.exitCode, proc.stderr.toString()).toBe(65);
      const report = JSON.parse(proc.stdout.toString()) as {
        findings: Array<{ ruleId: string; file: string; line: number }>;
      };
      const ids = report.findings
        .filter(
          (finding) => finding.file === "tests/audit-filehandle-fixture.ts",
        )
        .map((finding) => finding.ruleId)
        .sort();
      expect(ids).toEqual([
        "BUN-FILEHANDLE-READ-AUTOCLOSE",
        "BUN-FILEHANDLE-READ-EMITCLOSE",
        "BUN-FILEHANDLE-READ-HWM",
        "BUN-FILEHANDLE-READ-RANGE",
        "BUN-FILEHANDLE-READ-RANGE",
        "BUN-FILEHANDLE-READ-RANGE",
      ]);
    } finally {
      rmSync(FIXTURE, { force: true });
    }
  });
});
