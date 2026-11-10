import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readBunRunCliSurface } from "../lib/bun_cli_flags.ts";
import {
  buildDxRunPlan,
  checkVerboseFetchSecretSafety,
  collectMonitorSnapshot,
  parsePsBunProcesses,
  splitShellTokens,
} from "../scripts/dx_run_control.ts";

const ROOT = path.join(import.meta.dir, "..");
const DX = path.join(ROOT, "bin/dx");
const CLI = path.join(ROOT, "cli/sportsdesk_cli.ts");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "dx-run-control-"));
const RUN_SURFACE = readBunRunCliSurface();

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

async function fixtureDotfiles(dir: string): Promise<string> {
  const files: Record<string, string> = {
    "git/gitconfig": "[user]\n\tname = fixture\n",
    "git/config/ignore": "*.swp\n",
    "git/config/credential-gh-owner": "#!/bin/sh\n",
    "git/config/profiles/.keep": "",
    "shell/config/.keep": "",
    "shell/.zshenv": "# fixture zshenv\n",
    "shell/.zshrc": "# fixture zshrc\n",
    "shell/.bash_profile": "# fixture bash_profile\n",
    "bun/bunfig.toml": "",
  };
  for (const [rel, body] of Object.entries(files)) {
    await Bun.write(path.join(dir, rel), body);
  }
  return dir;
}

async function runCmd(
  cmd: readonly string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(path.join(SCRATCH, "home-"));
  const dotfiles = await fixtureDotfiles(
    mkdtempSync(path.join(SCRATCH, "dotfiles-")),
  );
  const child = Bun.spawn([...cmd], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      HOME: home,
      DX_DOTFILES_DIR: dotfiles,
      DX_STATUS_OFFLINE: "1",
      CLOUDFLARE_API_TOKEN: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      GSLIVE_SESSION_ID: "",
      BUN_CONFIG_VERBOSE_FETCH: "",
      ...extraEnv,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("connected `bun run --help` across ./bin/dx and cli/sportsdesk_cli.ts", () => {
  test("./bin/dx --help and ./bin/dx help --bun expose live `bun run --help` flags", async () => {
    const baseHelp = await runCmd([DX, "--help"]);
    expect(baseHelp.code).toBe(0);
    expect(baseHelp.stdout).toContain("Bun Runtime Control & Monitoring");
    expect(baseHelp.stdout).toContain("--no-orphans");
    expect(baseHelp.stdout).toContain("--cpu-prof-md");
    expect(baseHelp.stdout).toContain("./bin/dx run");
    expect(baseHelp.stdout).toContain("./bin/dx monitor");
    expect(baseHelp.stdout).toContain("./bin/dx live-bets");

    const fullBunHelp = await runCmd([
      DX,
      "help",
      "--bun",
      "--category=control",
    ]);
    expect(fullBunHelp.code).toBe(0);
    expect(fullBunHelp.stdout).toContain("Connected Bun Runtime CLI");
    expect(fullBunHelp.stdout).toContain("[CONTROL —");
    expect(fullBunHelp.stdout).toContain("--unhandled-rejections");
    expect(fullBunHelp.stdout).not.toContain("[NETWORK —");
  });

  test("cli/sportsdesk_cli.ts --help and --bun-help connect the live `bun run --help` surface", async () => {
    const cliHelp = await runCmd([process.execPath, CLI, "--help"]);
    expect(cliHelp.code).toBe(0);
    expect(cliHelp.stdout).toContain(
      "RUNTIME CONTROL, MONITORING & LIVE BUN RUN SURFACE",
    );
    expect(cliHelp.stdout).toContain("Bun Runtime Control & Monitoring");
    expect(cliHelp.stdout).toContain("--no-orphans");

    const cliBunHelp = await runCmd([
      process.execPath,
      CLI,
      "--bun-help",
      "--category=monitor",
    ]);
    expect(cliBunHelp.code).toBe(0);
    expect(cliBunHelp.stdout).toContain("[MONITOR —");
    expect(cliBunHelp.stdout).toContain("--heap-prof-md");
  });
});

describe("dx run control, presets, validation, and secret safety", () => {
  test("buildDxRunPlan injects containment, env isolation, low-mem, and markdown profiles", () => {
    const plan = buildDxRunPlan(
      [
        "--profile",
        "--low-mem",
        "--isolated-env",
        "--dry-run",
        "--json",
        "scripts/shadow_price.ts",
        "--min-volume=10",
      ],
      RUN_SURFACE,
      {
        bunPath: "/usr/local/bin/bun",
        stamp: "fixed123",
        envFlags: "--console-depth=4",
      },
    );

    expect(plan.target).toBe("scripts/shadow_price.ts");
    expect(plan.targetArgs).toEqual(["--min-volume=10"]);
    expect(plan.dryRun).toBe(true);
    expect(plan.json).toBe(true);
    expect(plan.cpuProfilePath).toBe(
      "scratch/profiles/dx_shadow_price_ts_fixed123.cpuprofile.md",
    );
    expect(plan.heapProfilePath).toBe(
      "scratch/profiles/dx_shadow_price_ts_fixed123.heapprofile.md",
    );
    expect(plan.bunFlags).toContain("--no-orphans");
    expect(plan.bunFlags).toContain("--unhandled-rejections=strict");
    expect(plan.bunFlags).toContain("--title=dx:shadow_price.ts");
    expect(plan.bunFlags).toContain("--no-env-file");
    expect(plan.bunFlags).toContain("--smol");
    expect(plan.bunFlags).toContain("--cpu-prof-md");
    expect(plan.bunFlags).toContain("--heap-prof-md");
    expect(plan.bunFlags).toContain("--console-depth=4");
    expect(plan.cmd).toEqual([
      "/usr/local/bin/bun",
      ...plan.bunFlags,
      "run",
      "scripts/shadow_price.ts",
      "--min-volume=10",
    ]);
  });

  test("splitShellTokens handles single and double quotes cleanly", () => {
    expect(
      splitShellTokens(`--smol --title="dx:my worker" '--define=A=1'`),
    ).toEqual(["--smol", "--title=dx:my worker", "--define=A=1"]);
  });

  test("dx run rejects unknown Bun flags with exit 2 and nearest-flag hint", async () => {
    const bad = await runCmd([
      DX,
      "run",
      "--no-orphan",
      "scripts/dx_scripts.ts",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown Bun run flag "--no-orphan"');
    expect(bad.stderr).toContain("--no-orphans");
  });

  test("checkVerboseFetchSecretSafety blocks BUN_CONFIG_VERBOSE_FETCH when secrets exist and never logs values", async () => {
    const secretVal = "super-secret-do-not-print-99182";
    const unit = checkVerboseFetchSecretSafety({
      BUN_CONFIG_VERBOSE_FETCH: "1",
      R2_SECRET_ACCESS_KEY: secretVal,
    });
    expect(unit.blocked).toBe(true);
    expect(unit.reason).toContain("R2_SECRET_ACCESS_KEY");
    expect(unit.reason).not.toContain(secretVal);

    const allowedWithoutSecrets = checkVerboseFetchSecretSafety({
      BUN_CONFIG_VERBOSE_FETCH: "1",
    });
    expect(allowedWithoutSecrets.blocked).toBe(false);

    const cliBlocked = await runCmd(
      [DX, "run", "scripts/dx_scripts.ts", "verify:docs"],
      {
        BUN_CONFIG_VERBOSE_FETCH: "curl",
        R2_SECRET_ACCESS_KEY: secretVal,
      },
    );
    expect(cliBlocked.code).toBe(2);
    expect(cliBlocked.stderr).toContain("BUN_CONFIG_VERBOSE_FETCH");
    expect(cliBlocked.stderr).toContain("R2_SECRET_ACCESS_KEY");
    expect(cliBlocked.stderr).not.toContain(secretVal);
  });

  test("DX_BUN_FLAGS forwards validated runtime flags through standard dx subcommands", async () => {
    const res = await runCmd([DX, "scripts", "verify:docs"], {
      DX_BUN_FLAGS: "--smol --no-env-file",
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("verify:docs");
  });
});

describe("dx monitor and dx live-bets control & telemetry", () => {
  test("parsePsBunProcesses isolates real Bun processes and detects --no-orphans / --title", () => {
    const samplePs = [
      "  101     1  62400   1.5 02:10:00 /Users/dev/.bun/bin/bun --no-orphans --title=dx:poller run scripts/graph_feed_poller_daemon.ts",
      "  102   101  12000   0.0 00:05:10 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/bun-profile",
      "  103     1   8400   0.2 00:01:00 zsh -c bun cli/sportsdesk_cli.ts --help",
      "  104     1  18200   0.4 00:12:00 dx:worker_a",
    ].join("\n");
    const parsed = parsePsBunProcesses(samplePs, 999);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      pid: 101,
      noOrphans: true,
      title: "dx:poller",
    });
    expect(parsed[1]).toMatchObject({
      pid: 104,
      noOrphans: false,
      title: "dx:worker_a",
    });
  });

  test("collectMonitorSnapshot and `./bin/dx monitor --offline --prune --json` inspect profiles without network", async () => {
    const profDir = mkdtempSync(path.join(SCRATCH, "profiles-"));
    writeFileSync(
      path.join(profDir, "dx_sample_1.cpuprofile.md"),
      [
        "# CPU Profile",
        "| Self % | Self | Total % | Total | Function | Location |",
        "| --- | --- | --- | --- | --- | --- |",
        "| 42.0% | 42ms | 50.0% | 50ms | `rollupHotPath` | `lib/gslive_tally_rollup.ts:80` |",
      ].join("\n"),
    );
    writeFileSync(
      path.join(profDir, "dx_sample_2.cpuprofile.md"),
      "# CPU Profile 2\n",
    );

    const directSnap = await collectMonitorSnapshot({
      daemonUrl: "http://127.0.0.1:4020",
      offline: true,
      profileDir: profDir,
      prune: true,
      maxFiles: 1,
    });
    expect(directSnap.daemon.probed).toBe(false);
    expect(directSnap.profiles.pruned?.pruned).toBe(1);
    expect(directSnap.profiles.count).toBe(1);

    const cliRes = await runCmd([
      DX,
      "monitor",
      "--offline",
      `--profile-dir=${profDir}`,
      "--json",
    ]);
    expect(cliRes.code).toBe(0);
    const parsed = JSON.parse(cliRes.stdout) as {
      daemon: { probed: boolean };
      profiles: { count: number };
    };
    expect(parsed.daemon.probed).toBe(false);
    expect(parsed.profiles.count).toBe(1);
  });

  test("dx live-bets controls source/fallback contract and rejects implicit auto", async () => {
    const fixtureRes = await runCmd([
      DX,
      "live-bets",
      "--source=fixture",
      "--fallback=sample",
      "--path=tests/f402-pending-wager-sample.json",
      "--json",
    ]);
    expect(fixtureRes.code).toBe(0);
    const body = JSON.parse(fixtureRes.stdout) as {
      apiVersion: string;
      dataSource: string;
      fallbackUsed: boolean;
      pendingCount: number;
    };
    expect(body.apiVersion).toBe("2");
    expect(body.dataSource).toBe("fixture");
    expect(body.fallbackUsed).toBe(false);
    expect(body.pendingCount).toBeGreaterThan(0);

    const strictMissing = await runCmd([
      process.execPath,
      CLI,
      "live-bets",
      "--source=file",
      "--fallback=strict",
      "--path=scratch/nonexistent-live-bets-test.json",
      "--json",
    ]);
    expect(strictMissing.code).toBe(0);
    const strictBody = JSON.parse(strictMissing.stdout) as {
      dataSource: string;
      fallbackUsed: boolean;
      pendingCount: number;
      warnings: string[];
    };
    expect(strictBody.dataSource).toBe("none");
    expect(strictBody.fallbackUsed).toBe(false);
    expect(strictBody.pendingCount).toBe(0);
    expect(strictBody.warnings.length).toBeGreaterThan(0);

    const autoRejected = await runCmd([DX, "live-bets", "--source=auto"]);
    expect(autoRejected.code).toBe(2);
    expect(autoRejected.stderr).toContain('invalid --source="auto"');
  });
});
