import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(ROOT, "tests", "audit-glob-fixture.ts");

describe("audit: glob.scan non-boolean options", () => {
  test("flags scan({ dot: 1 }) and ignores scan({ dot: true })", () => {
    mkdirSync(join(ROOT, "tests"), { recursive: true });
    writeFileSync(
      FIXTURE,
      [
        'const bad = new Bun.Glob("**/*.ts");',
        "bad.scan({ dot: 1 });",
        'const good = new Bun.Glob("**/*.ts");',
        "good.scan({ dot: true });",
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
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      const report = JSON.parse(proc.stdout.toString()) as {
        findings: Array<{ ruleId: string; file: string; line: number }>;
      };
      const hits = report.findings.filter(
        (finding) =>
          finding.ruleId === "BUN-GLOB-NONBOOL-OPTION" &&
          finding.file === "tests/audit-glob-fixture.ts",
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]?.line).toBe(2);
    } finally {
      rmSync(FIXTURE, { force: true });
    }
  });
});

test("audit findings carry the TypeError/RangeError taxonomy", () => {
  const taxonomyFixture = join(ROOT, "tests", "audit-taxonomy-fixture.ts");
  writeFileSync(
    taxonomyFixture,
    [
      "Bun.hash(null);",
      'Bun.dns.prefetch("example.com", Number.NaN);',
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
      findings: Array<{
        ruleId: string;
        file: string;
        errorClass: string | null;
      }>;
    };
    const classes = new Map(
      report.findings
        .filter((finding) => finding.file === "tests/audit-taxonomy-fixture.ts")
        .map((finding) => [finding.ruleId, finding.errorClass]),
    );
    expect(classes.get("BUN-HASH-NULLABLE-ARG")).toBe("TypeError");
    expect(classes.get("BUN-DNS-PREFETCH-NAN-RISK")).toBe("RangeError");
  } finally {
    rmSync(taxonomyFixture, { force: true });
  }
});
