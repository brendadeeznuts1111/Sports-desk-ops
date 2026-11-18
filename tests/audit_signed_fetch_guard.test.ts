import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const AUDIT = join(ROOT, "scripts", "audit_bun_failclosed_edges.ts");
const GUARD_RULES = new Set(["BUN-FETCH-VERBOSE", "BUN-FETCH-S3-URL"]);

interface AuditReport {
  readonly findings: ReadonlyArray<{ ruleId: string; file: string }>;
}

function runAudit(cwd: string): { exitCode: number; report: AuditReport } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, AUDIT, "--json"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.stdout.toString(), proc.stderr.toString()).not.toBe("");
  return {
    exitCode: proc.exitCode,
    report: JSON.parse(proc.stdout.toString()) as AuditReport,
  };
}

describe("audit: signed-fetch guard (verbose option, s3:// fetch)", () => {
  test("lib/, src/ and services/ have no verbose fetch option or s3:// fetch", () => {
    const { report } = runAudit(ROOT);
    expect(
      report.findings.filter((finding) => GUARD_RULES.has(finding.ruleId)),
    ).toEqual([]);
  }, 30_000);

  test("flags verbose (literal, shorthand, spread) and s3:// targets in guarded trees only", () => {
    const dir = mkdtempSync(join(tmpdir(), "signed-fetch-guard-"));
    try {
      for (const sub of ["lib", "src", "services", "tests"]) {
        mkdirSync(join(dir, sub));
      }
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ESNext", "DOM"],
            types: [],
            noEmit: true,
          },
          include: ["lib", "src", "services", "tests"],
        }),
      );
      const offending = [
        'const verbose = "curl" as const;',
        'void fetch("https://example.test", { verbose: true });',
        'void fetch("https://example.test", { method: "GET", ...(verbose ? { verbose } : {}) });',
        'void new Request("https://example.test", { "verbose": verbose });',
        'void fetch("s3://bucket/key");',
        "const key = 'k';",
        "void fetch(`s3://bucket/${key}`);",
        "",
      ].join("\n");
      writeFileSync(join(dir, "lib", "offender.ts"), offending);
      writeFileSync(
        join(dir, "services", "offender.ts"),
        'void new Request("S3://bucket/key");\n',
      );
      writeFileSync(
        join(dir, "src", "clean.ts"),
        'void fetch("https://example.test", { method: "HEAD" });\n',
      );
      writeFileSync(join(dir, "tests", "stub.ts"), offending);

      const { exitCode, report } = runAudit(dir);
      expect(exitCode).toBe(65);
      const guard = report.findings
        .filter((finding) => GUARD_RULES.has(finding.ruleId))
        .map((finding) => `${finding.file} ${finding.ruleId}`)
        .sort();
      expect(guard).toEqual([
        "lib/offender.ts BUN-FETCH-S3-URL",
        "lib/offender.ts BUN-FETCH-S3-URL",
        "lib/offender.ts BUN-FETCH-VERBOSE",
        "lib/offender.ts BUN-FETCH-VERBOSE",
        "lib/offender.ts BUN-FETCH-VERBOSE",
        "services/offender.ts BUN-FETCH-S3-URL",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
