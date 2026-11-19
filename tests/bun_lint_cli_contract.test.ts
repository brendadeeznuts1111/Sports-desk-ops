/**
 * Contract for the repo's `bun lint` plumbing.
 *
 * Stable Bun 1.4.4 has no native `bun lint`: the command dispatches to the project's `lint` script
 * and forwards every flag verbatim. Native lint exists in canary builds, which is why CI runs
 * `lint:native` in a separate `bun-version: canary` job and `scripts/lint_native.ts` resolves a
 * canary binary locally. These tests pin that split down:
 *
 * - always: the pin's dispatch behavior, the resolver's precedence, and the repo wiring
 *   (package scripts, bunfig `[lint]`, oxlint configs, CI canary job);
 * - when a native-lint binary is available: the documented flag surface and semantics, so the
 *   canary job's behavior cannot silently drift from the docs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  candidateBunLintBins,
  hasNativeBunLint,
  resolveNativeBunLintBin,
} from "../scripts/lint_native.ts";

const ROOT = join(import.meta.dir, "..");
const nativeBin = resolveNativeBunLintBin();
const tempDirs: string[] = [];
const makeTemp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const run = (bin: string, args: readonly string[], cwd: string) =>
  Bun.spawnSync([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
const output = (result: ReturnType<typeof run>) =>
  `${result.stdout.toString()}${result.stderr.toString()}`;
const nativeTest = (name: string, fn: () => void | Promise<void>) => {
  if (nativeBin === null) test.skip(name, fn);
  else test(name, fn);
};

const probeDir = makeTemp("bun-lint-probe-");
const pinHasNativeLint = hasNativeBunLint(process.execPath, probeDir);

describe("pin channel: bun lint is a project-script alias", () => {
  test.skipIf(pinHasNativeLint)("stable Bun has no native lint command", () => {
    const dir = makeTemp("bun-lint-no-script-");
    const result = run(process.execPath, ["lint", "--help"], dir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('Script not found "lint"');
  });

  test.skipIf(pinHasNativeLint)(
    "documented flags are forwarded verbatim to the project lint script",
    () => {
      const dir = makeTemp("bun-lint-dispatch-");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "dispatch",
          scripts: { lint: "bun ./capture.ts" },
        }),
      );
      writeFileSync(
        join(dir, "capture.ts"),
        "console.log(JSON.stringify({ argv: Bun.argv.slice(2) }));\n",
      );
      const flags = [
        "--rules",
        "--no-script",
        "--changed=HEAD",
        "--max-warnings",
        "3",
      ];
      const result = run(process.execPath, ["lint", ...flags], dir);
      expect(result.exitCode).toBe(0);
      const forwarded = (
        JSON.parse(result.stdout.toString()) as { argv: string[] }
      ).argv;
      expect(forwarded).toEqual(flags);
      // The pin must not interpret them natively.
      expect(output(result)).not.toContain("Usage: bun lint");
    },
  );
});

describe("native-lint resolver", () => {
  test("explicit BUN_LINT_BIN wins, then the current binary", () => {
    const candidates = candidateBunLintBins({
      BUN_LINT_BIN: "/custom/bun-lint",
      PATH: "/nonexistent",
      HOME: "/nonexistent",
    });
    expect(candidates[0]).toBe("/custom/bun-lint");
    expect(candidates).toContain(process.execPath);
  });

  test("a pinned 1.4.4 binary is not native-lint capable", () => {
    // The pin under test in CI is stable 1.4.4; canary runtimes are gated by nativeBin.
    expect(hasNativeBunLint(process.execPath, probeDir)).toBe(false);
  });

  test("resolved binary (when present) is executable and reports a version", () => {
    if (nativeBin === null) return;
    const version = run(nativeBin, ["--version"], probeDir)
      .stdout.toString()
      .trim();
    expect(version.length).toBeGreaterThan(0);
  });
});

describe("repo lint wiring", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  test("native lint scripts use the documented flags", () => {
    expect(pkg.scripts["lint:native"]).toContain("bun lint --no-script");
    expect(pkg.scripts["lint:native"]).toContain("--deny-warnings");
    expect(pkg.scripts["lint:native:type-aware"]).toContain("--type-aware");
    expect(pkg.scripts["lint:native:type-aware"]).toContain(
      "-c .oxlintrc.type-aware.json",
    );
    expect(pkg.scripts["lint:check"]).toContain("lint_native.ts");
  });

  test("bunfig [lint] and oxlint configs are present", () => {
    const bunfig = readFileSync(join(ROOT, "bunfig.toml"), "utf8");
    expect(bunfig).toContain("[lint]");
    expect(bunfig).toContain("ignorePatterns");
    expect(existsSync(join(ROOT, ".oxlintrc.json"))).toBe(true);
    expect(existsSync(join(ROOT, ".oxlintrc.type-aware.json"))).toBe(true);
  });

  test("CI isolates native lint in a canary job", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const job =
      /lint-native:[\s\S]{0,2000}?(?=\n  [a-z-]+:\n)/.exec(ci)?.[0] ?? "";
    expect(job).toContain("bun-version: canary");
    expect(job).toContain("run: bun run lint:native");
    expect(job).toContain("run: bun run lint:native:type-aware");
  });
});

describe("native lint (canary only)", () => {
  const docsFlags = [
    "--rule",
    "--type-aware",
    "--rules",
    "--explain",
    "--init",
    "--fix",
    "--fix-suggestions",
    "--fix-dry-run",
    "--staged",
    "--changed",
    "--ignore-pattern",
    "--no-ignore",
    "--format",
    "--output-file",
    "--quiet",
    "--max-warnings",
    "--all",
    "--doctor",
    "--print-config",
    "--no-script",
  ];

  nativeTest("help exposes every documented flag", () => {
    const help = run(
      nativeBin!,
      ["lint", "--help", "--all"],
      probeDir,
    ).stdout.toString();
    for (const flag of docsFlags) expect(help).toContain(flag);
    expect(
      run(nativeBin!, ["lint", "--help"], probeDir).stdout.toString(),
    ).toContain("Usage: bun lint");
  });

  nativeTest("--rules -f json is machine-readable", () => {
    const dir = makeTemp("bun-lint-rules-");
    const result = run(nativeBin!, ["lint", "--rules", "-f", "json"], dir);
    expect(result.exitCode).toBe(0);
    const rules = JSON.parse(result.stdout.toString()) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(500);
    expect(rules[0]).toHaveProperty("fix");
    expect(rules[0]).toHaveProperty("type_aware");
  });

  nativeTest("--explain prints rule documentation", () => {
    const dir = makeTemp("bun-lint-explain-");
    const text = run(
      nativeBin!,
      ["lint", "--explain", "eqeqeq"],
      dir,
    ).stdout.toString();
    expect(text).toContain("Require === and !==");
  });

  nativeTest("--init writes a [lint] section", () => {
    const dir = makeTemp("bun-lint-init-");
    expect(run(nativeBin!, ["lint", "--init"], dir).exitCode).toBe(0);
    expect(readFileSync(join(dir, "bunfig.toml"), "utf8")).toContain("[lint]");
  });

  nativeTest("fixing: --fix, --fix-dry-run, --fix-suggestions", () => {
    const dir = makeTemp("bun-lint-fix-");
    writeFileSync(
      join(dir, "var.ts"),
      "export function f(): number {\n  var x = 1;\n  return x;\n}\n",
    );
    writeFileSync(
      join(dir, "dry.ts"),
      "export function g(): number {\n  var y = 2;\n  return y;\n}\n",
    );
    writeFileSync(
      join(dir, "suggest.ts"),
      "export function h(x: number): boolean {\n  return x == 1;\n}\n",
    );

    expect(
      run(
        nativeBin!,
        ["lint", "--rule", "no-var: error", "--fix", "var.ts"],
        dir,
      ).exitCode,
    ).toBe(0);
    expect(readFileSync(join(dir, "var.ts"), "utf8")).toContain("const x");

    const dry = run(
      nativeBin!,
      [
        "lint",
        "--rule",
        "no-var: error",
        "--fix-dry-run",
        "-f",
        "json",
        "dry.ts",
      ],
      dir,
    );
    expect(dry.exitCode).toBe(0);
    const record = (
      JSON.parse(dry.stdout.toString().split("\n")[0]!) as Array<{
        output?: string;
      }>
    )[0]!;
    expect(record.output).toContain("const y");
    expect(readFileSync(join(dir, "dry.ts"), "utf8")).toContain("var y");

    expect(
      run(
        nativeBin!,
        ["lint", "--rule", "eqeqeq: error", "--fix-suggestions", "suggest.ts"],
        dir,
      ).exitCode,
    ).toBe(0);
    expect(readFileSync(join(dir, "suggest.ts"), "utf8")).toContain("x === 1");

    const conflict = run(
      nativeBin!,
      ["lint", "--fix-suggestions", "--fix-dry-run", "suggest.ts"],
      dir,
    );
    expect(conflict.exitCode).toBe(2);
    expect(output(conflict)).toContain("cannot be used together");
  });

  nativeTest("warnings: --quiet, --max-warnings, --deny-warnings", () => {
    const dir = makeTemp("bun-lint-warn-");
    writeFileSync(join(dir, "warn.ts"), "console.log(1);\n");
    const base = ["lint", "--rule", "no-console: warn", "warn.ts"];
    expect(run(nativeBin!, base, dir).exitCode).toBe(0);
    const quiet = run(nativeBin!, [...base, "--quiet"], dir);
    expect(quiet.exitCode).toBe(0);
    expect(quiet.stdout.toString()).toBe("");
    expect(
      run(nativeBin!, [...base, "--max-warnings", "0"], dir).exitCode,
    ).toBe(1);
    expect(
      run(nativeBin!, [...base, "--max-warnings", "5"], dir).exitCode,
    ).toBe(0);
    expect(run(nativeBin!, [...base, "--deny-warnings"], dir).exitCode).toBe(1);
  });

  nativeTest("formats, output files, and --all grouping", () => {
    const dir = makeTemp("bun-lint-output-");
    writeFileSync(join(dir, "warn.ts"), "console.log(1);\n");
    writeFileSync(
      join(dir, "many.ts"),
      Array.from({ length: 60 }, (_, i) => `console.log(${i});`).join("\n") +
        "\n",
    );
    const formats = [
      "pretty",
      "stylish",
      "json",
      "unix",
      "github",
      "junit",
      "checkstyle",
      "gitlab",
      "sarif",
      "agent",
    ];
    for (const format of formats) {
      const result = run(
        nativeBin!,
        ["lint", "--rule", "no-console: warn", "-f", format, "warn.ts"],
        dir,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().length).toBeGreaterThan(0);
    }
    const reportPath = join(dir, "report.json");
    expect(
      run(
        nativeBin!,
        [
          "lint",
          "--rule",
          "no-console: warn",
          "-f",
          "json",
          "-o",
          reportPath,
          "warn.ts",
        ],
        dir,
      ).exitCode,
    ).toBe(0);
    expect(Array.isArray(JSON.parse(readFileSync(reportPath, "utf8")))).toBe(
      true,
    );

    const grouped = run(
      nativeBin!,
      ["lint", "--rule", "no-console: warn", "many.ts"],
      dir,
    )
      .stdout.toString()
      .split("\n").length;
    const ungrouped = run(
      nativeBin!,
      ["lint", "--rule", "no-console: warn", "--all", "many.ts"],
      dir,
    )
      .stdout.toString()
      .split("\n").length;
    expect(ungrouped).toBeGreaterThan(grouped * 5);
  });

  nativeTest("files: --staged and --changed", () => {
    if (Bun.which("git") === null) return;
    const dir = makeTemp("bun-lint-git-");
    const git = (script: string) =>
      Bun.spawnSync(["bash", "-c", script], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
    git("git init -q && git config user.email t@t && git config user.name t");
    writeFileSync(join(dir, "staged.ts"), "console.log(1);\n");
    writeFileSync(join(dir, "modified.ts"), "console.log(0);\n");
    git("git add staged.ts modified.ts && git commit -qm base");
    writeFileSync(join(dir, "staged.ts"), "console.log(2);\n");
    git("git add staged.ts");
    writeFileSync(join(dir, "modified.ts"), "console.log(3);\n");
    const staged = run(
      nativeBin!,
      ["lint", "--rule", "no-console: warn", "--staged", "-f", "unix"],
      dir,
    ).stdout.toString();
    expect(staged).toContain("staged.ts");
    expect(staged).not.toContain("modified.ts");
    const changed = run(
      nativeBin!,
      ["lint", "--rule", "no-console: warn", "--changed=HEAD", "-f", "unix"],
      dir,
    ).stdout.toString();
    expect(changed).toContain("staged.ts");
    expect(changed).toContain("modified.ts");
  });

  nativeTest(
    "ignore: bunfig ignorePatterns, --no-ignore, repeated --ignore-pattern",
    () => {
      const dir = makeTemp("bun-lint-ignore-");
      mkdirSync(join(dir, "ignored"), { recursive: true });
      writeFileSync(join(dir, "ignored/x.ts"), "console.log(1);\n");
      writeFileSync(
        join(dir, "bunfig.toml"),
        '[lint]\nignorePatterns = ["ignored/**"]\n',
      );
      const skipped = run(
        nativeBin!,
        ["lint", "--rule", "no-console: warn", "-f", "unix", "ignored/x.ts"],
        dir,
      ).stdout.toString();
      const forced = run(
        nativeBin!,
        [
          "lint",
          "--rule",
          "no-console: warn",
          "--no-ignore",
          "-f",
          "unix",
          "ignored/x.ts",
        ],
        dir,
      ).stdout.toString();
      expect(skipped).toMatch(/ignored because of a matching ignore pattern/i);
      expect(forced).toContain("no-console");
      rmSync(join(dir, "bunfig.toml"));
      writeFileSync(join(dir, "warn.ts"), "console.log(1);\n");
      const ignored = run(
        nativeBin!,
        [
          "lint",
          "--rule",
          "no-console: warn",
          "--ignore-pattern",
          "warn.ts",
          "warn.ts",
        ],
        dir,
      );
      expect(ignored.exitCode).toBe(0);
      expect(output(ignored)).toContain(
        "ignored because of a matching ignore pattern",
      );
    },
  );

  nativeTest(
    "tools: --doctor, --print-config, --no-script, --type-aware, -c",
    () => {
      const dir = makeTemp("bun-lint-tools-");
      writeFileSync(join(dir, "warn.ts"), "console.log(1);\n");
      const doctor = run(nativeBin!, ["lint", "--doctor"], dir);
      expect(doctor.exitCode).toBe(0);
      expect(output(doctor).toLowerCase()).toContain("rules");
      const printed = run(
        nativeBin!,
        ["lint", "--print-config", "warn.ts"],
        dir,
      );
      const config = JSON.parse(printed.stdout.toString()) as Record<
        string,
        unknown
      >;
      expect(config).toHaveProperty("rules");

      writeFileSync(join(dir, "x.ts"), "console.log(1);\n");
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "tools",
          scripts: {
            lint: `bun -e "require('node:fs').writeFileSync('${join(dir, "ran")}','1')"`,
          },
        }),
      );
      expect(
        run(
          nativeBin!,
          ["lint", "--no-script", "--rule", "no-console: warn", "x.ts"],
          dir,
        ).exitCode,
      ).toBe(0);
      expect(existsSync(join(dir, "ran"))).toBe(false);
      expect(
        run(nativeBin!, ["lint", "--rule", "no-console: warn", "x.ts"], dir)
          .exitCode,
      ).toBe(0);
      expect(existsSync(join(dir, "ran"))).toBe(true);

      const typeAware = run(
        nativeBin!,
        ["lint", "--type-aware", "-f", "unix", "warn.ts"],
        dir,
      );
      expect([0, 1]).toContain(typeAware.exitCode);
      expect(output(typeAware)).not.toMatch(/unknown|unrecognized/i);
      const cfg = run(
        nativeBin!,
        ["lint", "-c", join(ROOT, ".oxlintrc.json"), "-f", "unix", "warn.ts"],
        dir,
      );
      expect(output(cfg)).not.toMatch(/unknown|unrecognized/i);
    },
  );
});
