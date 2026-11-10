import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import {
  BUN_RUN_FLAG_CATEGORIES,
  bunFlagsInScripts,
  classifyBunRunFlag,
  formatConnectedBunRunHelp,
  missingRequiredFlags,
  parseBunHelpFlags,
  parseBunRunHelpEntries,
  readBunCliSurface,
  readBunHelpFlags,
  readBunRunCliSurface,
  REQUIRED_BUN_CLI_FLAGS,
  suggestBunRunFlag,
  unsupportedScriptFlags,
} from "../lib/bun_cli_flags.ts";

const SURFACE = readBunCliSurface();
const RUN_SURFACE = readBunRunCliSurface();

describe("pinned Bun CLI surface (1.4.4)", () => {
  test("every flag our tooling depends on is declared by the runtime", () => {
    expect(missingRequiredFlags(SURFACE)).toEqual([]);
    for (const flag of REQUIRED_BUN_CLI_FLAGS) {
      expect(SURFACE.flags.has(flag)).toBe(true);
    }
  });

  test("package.json scripts only ask Bun to parse flags it declares", async () => {
    const pkg = z
      .object({
        engines: z.object({ bun: z.string() }).optional(),
        scripts: z.record(z.string(), z.string()).optional(),
      })
      .parse(
        await Bun.file(new URL("../package.json", import.meta.url)).json(),
      );
    const scripts = pkg.scripts ?? {};
    expect(unsupportedScriptFlags(scripts, SURFACE)).toEqual([]);
    // The watch daemon is the one long-running script: it must not outlive its parent.
    expect(scripts["wagers:watch"]).toContain("--no-orphans");
    // Bun.semver gates the pinned runtime against package.json engines.
    expect(pkg.engines?.bun).toBeDefined();
    expect(Bun.semver.satisfies(Bun.version, pkg.engines?.bun ?? "")).toBe(
      true,
    );
  });

  test("help parsing reads flag declarations, not prose or values", () => {
    const flags = parseBunHelpFlags(
      [
        "  -e, --eval=<val>                    Evaluate argument as a script",
        "      --port=<val>                    Set the default port for Bun.serve",
        "  -u, --update-snapshots              Update snapshot files",
        "  --do-not-treat-this-as-a-flag",
      ].join("\n"),
    );
    expect(flags.has("--eval")).toBe(true);
    expect(flags.has("--port")).toBe(true);
    expect(flags.has("--update-snapshots")).toBe(true);
    // An indented prose line without declaration columns is not a flag.
    expect(flags.has("--do-not-treat-this-as-a-flag")).toBe(false);
  });

  test("script flag extraction stops at the entrypoint/command", () => {
    const flags = bunFlagsInScripts({
      watch:
        "bun --no-orphans run scripts/x.ts --watch --cron '0,15,30,45 * * * *'",
      plain: "bun run scripts/x.ts --json",
    });
    expect([...(flags.get("watch") ?? [])]).toEqual(["--no-orphans"]);
    expect(flags.has("plain")).toBe(false);
  });

  test("records the known 1.4.4 gap instead of pretending --origin exists", () => {
    // Docs snippets sometimes show `--origin`/`-u`; this runtime does not declare --origin, and
    // -u is a *test* flag. If an upgrade adds --origin, this assertion is the reminder to revisit.
    expect(SURFACE.flags.has("--origin")).toBe(false);
    expect(readBunHelpFlags(["test", "--help"]).has("--update-snapshots")).toBe(
      true,
    );
  });

  test("bun run --parallel, --sequential, globbing, and hook grouping (v1.4.0)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-parallel-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "parallel-test",
          scripts: {
            "task:a": "echo 'Hello from A'",
            "task:b": "echo 'Hello from B'",
            "task:fail": "exit 1",
            "pretask:c": "echo 'Pre-hook'",
            "task:c": "echo 'Main task'",
            "posttask:c": "echo 'Post-hook'",
          },
        }),
      );

      // 1. Parallel execution with Foreman-style prefixed output
      const runParallel = Bun.spawnSync(
        [process.execPath, "run", "--parallel", "task:a", "task:b"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(runParallel.exitCode).toBe(0);
      const outParallel = runParallel.stdout.toString();
      expect(outParallel).toContain("task:a |");
      expect(outParallel).toContain("task:b |");
      expect(outParallel).toContain("Hello from A");
      expect(outParallel).toContain("Hello from B");

      // 2. Glob matching and --no-exit-on-error fault tolerance (flags precede script globs)
      const runGlob = Bun.spawnSync(
        [process.execPath, "run", "--parallel", "--no-exit-on-error", "task:*"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      const outGlob = runGlob.stdout.toString();
      expect(outGlob).toMatch(/task:a\s+\|/);
      expect(outGlob).toMatch(/task:b\s+\|/);
      expect(outGlob).toMatch(/task:c\s+\|/);
      // --no-exit-on-error runs through despite task:fail exiting with code 1
      expect(runGlob.exitCode).toBe(1);

      // 3. Lifecycle hook preservation: pretask/posttask grouped with main task
      const runHooks = Bun.spawnSync(
        [process.execPath, "run", "--parallel", "task:c"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(runHooks.exitCode).toBe(0);
      const outHooks = runHooks.stdout.toString();
      expect(outHooks).toContain("Pre-hook");
      expect(outHooks).toContain("Main task");
      expect(outHooks).toContain("Post-hook");

      // 4. Sequential execution mode preserves order
      const runSequential = Bun.spawnSync(
        [process.execPath, "run", "--sequential", "task:a", "task:b"],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expect(runSequential.exitCode).toBe(0);
      const outSequential = runSequential.stdout.toString();
      expect(outSequential).toContain("task:a |");
      expect(outSequential).toContain("task:b |");
      const idxA = outSequential.indexOf("Hello from A");
      const idxB = outSequential.indexOf("Hello from B");
      expect(idxA).toBeLessThan(idxB);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connected bun run --help surface parses entries, categories, suggestions, and formatted help", () => {
    expect(RUN_SURFACE.usage).toContain("Usage: bun run");
    expect(RUN_SURFACE.entries.length).toBeGreaterThan(0);

    // Sum of category buckets equals total parsed entries (derived, never hardcoded)
    const bucketSum = BUN_RUN_FLAG_CATEGORIES.reduce(
      (acc, cat) => acc + RUN_SURFACE.byCategory[cat].length,
      0,
    );
    expect(bucketSum).toBe(RUN_SURFACE.entries.length);

    // Every required Bun run flag is present in `bun run --help` as well
    for (const flag of REQUIRED_BUN_CLI_FLAGS) {
      expect(RUN_SURFACE.flags.has(flag)).toBe(true);
    }

    // Dotted flags like --tls-min-v1.0 and short-only flags like -i are parsed cleanly
    expect(RUN_SURFACE.flags.has("--tls-min-v1.0")).toBe(true);
    expect(RUN_SURFACE.entries.some((e) => e.name === "-i")).toBe(true);

    expect(classifyBunRunFlag("--no-orphans")).toBe("control");
    expect(classifyBunRunFlag("--cpu-prof-md")).toBe("monitor");
    expect(classifyBunRunFlag("--parallel")).toBe("workspace");
    expect(classifyBunRunFlag("--no-env-file")).toBe("environment");
    expect(classifyBunRunFlag("--fetch-preconnect")).toBe("network");
    expect(classifyBunRunFlag("--feature")).toBe("transpiler");

    expect(suggestBunRunFlag("--no-orphan", RUN_SURFACE)).toBe("--no-orphans");
    expect(suggestBunRunFlag("--cpu-prof-m", RUN_SURFACE)).toBe(
      "--cpu-prof-md",
    );
    expect(
      suggestBunRunFlag("--totally-unrelated-nonexistent-option", RUN_SURFACE),
    ).toBeNull();

    const parsedSample = parseBunRunHelpEntries(
      [
        "Usage: bun run [flags] <file or script>",
        "      --no-orphans                   Exit when the parent process dies",
        "  -F, --filter=<val>                 Run a script in matching workspace packages",
        "  -i                                 Auto-install dependencies during execution",
      ].join("\n"),
    );
    expect(parsedSample).toHaveLength(3);
    expect(parsedSample[1]?.short).toBe("-F");
    expect(parsedSample[1]?.valueHint).toBe("<val>");

    const summary = formatConnectedBunRunHelp(RUN_SURFACE);
    expect(summary).toContain("Bun Runtime Control & Monitoring");
    expect(summary).toContain("--no-orphans");
    expect(summary).toContain("--cpu-prof-md");

    const monitorOnly = formatConnectedBunRunHelp(RUN_SURFACE, {
      category: "monitor",
    });
    expect(monitorOnly).toContain("[MONITOR —");
    expect(monitorOnly).toContain("--heap-prof-md");
    expect(monitorOnly).not.toContain("[WORKSPACE —");

    const filtered = formatConnectedBunRunHelp(RUN_SURFACE, {
      filter: "orphans",
    });
    expect(filtered).toContain("--no-orphans");

    const raw = formatConnectedBunRunHelp(RUN_SURFACE, { raw: true });
    expect(raw).toContain(RUN_SURFACE.usage);
  });
});
