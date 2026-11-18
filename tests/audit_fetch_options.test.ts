import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "tests", "audit-fetch-fixture.ts");

describe("audit: non-W3C fetch options", () => {
  test("flags timeout and inline S3 credentials", () => {
    writeFileSync(
      FIXTURE,
      [
        'const keyId = "placeholder-id";',
        'const secret = "placeholder-secret";',
        'fetch("https://example.test", { timeout: 1_000 });',
        'fetch("s3://bucket/key", {',
        "  s3: { accessKeyId: keyId, secretAccessKey: secret },",
        "});",
        'new Request("https://example.test", { timeout: 5 });',
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
      expect(proc.exitCode, proc.stderr.toString()).toBe(65);
      const report = JSON.parse(proc.stdout.toString()) as {
        findings: Array<{ ruleId: string; file: string }>;
      };
      const ids = report.findings
        .filter((finding) => finding.file === "tests/audit-fetch-fixture.ts")
        .map((finding) => finding.ruleId);
      expect(ids.filter((id) => id === "BUN-FETCH-TIMEOUT-IDLE")).toHaveLength(
        2,
      );
      expect(ids).toContain("BUN-FETCH-S3-INLINE-CREDENTIALS");
    } finally {
      rmSync(FIXTURE, { force: true });
    }
  }, 30_000);
});
