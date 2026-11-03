import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  alertThresholdsFromConfig,
  DEFAULT_CAPTURE_CRON,
  DEFAULT_KEEP_RUNS,
  DEFAULT_LOOKBACK_DAYS,
  DEFAULT_TIMEOUT_MS,
  loadWagersCaptureConfig,
} from "./wagers_capture_config.ts";
import {
  DEFAULT_CADENCE_MINUTES,
  DEFAULT_CHURN_MIN,
  DEFAULT_CHURN_PCT,
  DEFAULT_KEEP_HISTORY,
  DEFAULT_PENDING_WARN_HOURS,
  DEFAULT_SPIKE_MIN,
  DEFAULT_SPIKE_PCT,
  WAGERS_ARTIFACT_PATH,
  WAGERS_STATUS_PATH,
} from "../scripts/gslive_wagers_by_state.ts";
import { buildWagersOsSchedulePlan } from "../scripts/wagers_by_state_capture.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wagers-config-"));
  dirs.push(dir);
  return dir;
}

describe("TOML capture config", () => {
  test("missing default config means built-in defaults, not an error", async () => {
    const loaded = await loadWagersCaptureConfig(
      join(await tempDir(), "absent.toml"),
    );
    expect(loaded.source).toBeNull();
    expect(loaded.config.capture).toEqual({
      retries: 2,
      retryBackoffMs: 250,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      dateFilterBy: "calcTime",
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
      cron: DEFAULT_CAPTURE_CRON,
      keepRuns: DEFAULT_KEEP_RUNS,
      keepHistory: DEFAULT_KEEP_HISTORY,
    });
    expect(loaded.config.paths.artifact).toBe(WAGERS_ARTIFACT_PATH);
    expect(loaded.config.paths.status).toBe(WAGERS_STATUS_PATH);
    expect(loaded.config.alerts).toEqual({
      pendingWarnHours: DEFAULT_PENDING_WARN_HOURS,
      spikePct: DEFAULT_SPIKE_PCT,
      spikeMin: DEFAULT_SPIKE_MIN,
      churnPct: DEFAULT_CHURN_PCT,
      churnMin: DEFAULT_CHURN_MIN,
      cadenceMinutes: DEFAULT_CADENCE_MINUTES,
    });
    expect(loaded.config.session.webviewProfile).toBe("");
  });

  test("a tracked-style file overrides only the keys it names", async () => {
    const dir = await tempDir();
    const path = join(dir, "wagers-capture.toml");
    await Bun.write(
      path,
      [
        "[capture]",
        "retries = 5",
        "keepHistory = 42",
        'dateFilterBy = "logTime"',
        'cron = "30 2 * * *"',
        "[paths]",
        'archive = "Scratch/bundle.tar"',
        "[alerts]",
        "spikePct = 40",
        "[session]",
        'webviewProfile = "/tmp/profile"',
        "",
      ].join("\n"),
    );
    const loaded = await loadWagersCaptureConfig(path);
    expect(loaded.source).toBe(path);
    expect(loaded.config.capture.retries).toBe(5);
    expect(loaded.config.capture.keepHistory).toBe(42);
    expect(loaded.config.capture.dateFilterBy).toBe("logTime");
    expect(loaded.config.capture.cron).toBe("30 2 * * *");
    expect(loaded.config.capture.retryBackoffMs).toBe(250);
    expect(loaded.config.paths.archive).toBe("Scratch/bundle.tar");
    expect(loaded.config.alerts.spikePct).toBe(40);
    expect(loaded.config.alerts.spikeMin).toBe(DEFAULT_SPIKE_MIN);
    expect(loaded.config.session.webviewProfile).toBe("/tmp/profile");
  });

  test("malformed TOML and schema violations fail at the boundary", async () => {
    const dir = await tempDir();
    const broken = join(dir, "broken.toml");
    await Bun.write(broken, "[capture\nretries = 2");
    await expect(loadWagersCaptureConfig(broken)).rejects.toThrow(
      /not valid TOML/,
    );

    const badValue = join(dir, "bad-value.toml");
    await Bun.write(badValue, "[capture]\nretries = 99\n");
    await expect(loadWagersCaptureConfig(badValue)).rejects.toThrow(
      /does not match the wagers capture config/,
    );

    const unknownSection = join(dir, "unknown.toml");
    await Bun.write(unknownSection, "[nope]\nx = 1\n");
    await expect(loadWagersCaptureConfig(unknownSection)).rejects.toThrow(
      /does not match/,
    );
  });

  test("an explicitly named but missing file is an error", async () => {
    await expect(
      loadWagersCaptureConfig(join(await tempDir(), "missing.toml"), {
        required: true,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  test("maps the parsed config to the producer's threshold type", async () => {
    const loaded = await loadWagersCaptureConfig(
      join(await tempDir(), "absent.toml"),
    );
    expect(alertThresholdsFromConfig(loaded.config)).toEqual({
      pendingWarnHours: DEFAULT_PENDING_WARN_HOURS,
      spikePct: DEFAULT_SPIKE_PCT,
      spikeMin: DEFAULT_SPIKE_MIN,
      cadenceMinutes: DEFAULT_CADENCE_MINUTES,
      churnPct: DEFAULT_CHURN_PCT,
      churnMin: DEFAULT_CHURN_MIN,
    });
  });

  test("OS scheduling refuses a standalone executable", () => {
    expect(() =>
      buildWagersOsSchedulePlan(DEFAULT_CAPTURE_CRON, import.meta.url, true),
    ).toThrow(/standalone/);
    expect(() =>
      buildWagersOsSchedulePlan(DEFAULT_CAPTURE_CRON, import.meta.url, false),
    ).not.toThrow();
  });
});

describe("CLI precedence: flag > TOML > built-in", () => {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const script = join(repoRoot, "scripts", "wagers_by_state_capture.ts");

  function dryRun(
    configPath: string | null,
    extra: string[] = [],
    cwd: string = repoRoot,
  ) {
    const result = Bun.spawnSync(
      [
        "bun",
        script,
        "--dry-run",
        ...(configPath === null ? [] : ["--config", configPath]),
        ...extra,
      ],
      { cwd, stdout: "pipe", stderr: "pipe" },
    );
    const stderr = result.stderr.toString();
    const start = stderr.indexOf("{");
    if (start === -1) throw new Error(`no dry-run JSON in stderr: ${stderr}`);
    return JSON.parse(stderr.slice(start)) as {
      config: string;
      retries: number;
      keepHistory: number;
      archivePath?: string;
      session: string;
    };
  }

  test("TOML values apply, and a flag overrides them", async () => {
    const dir = await tempDir();
    const path = join(dir, "wagers-capture.toml");
    await Bun.write(
      path,
      '[capture]\nretries = 5\nkeepHistory = 42\n[paths]\narchive = "Scratch/bundle.tar"\n',
    );
    const configOnly = dryRun(path);
    expect(configOnly.config).toBe(path);
    expect(configOnly.retries).toBe(5);
    expect(configOnly.keepHistory).toBe(42);
    expect(configOnly.archivePath).toBe("Scratch/bundle.tar");

    const overridden = dryRun(path, ["--retries", "1"]);
    expect(overridden.retries).toBe(1);
    expect(overridden.keepHistory).toBe(42);
  });

  test("built-in defaults apply when the default config path is absent", async () => {
    const dir = await tempDir();
    const result = dryRun(null, [], dir);
    expect(result.config).toBe("(built-in defaults)");
    expect(result.retries).toBe(2);
    expect(result.keepHistory).toBe(DEFAULT_KEEP_HISTORY);
  });

  test("attach mode is described without a profile directory", async () => {
    const dir = await tempDir();
    const result = dryRun(null, ["--attach-chrome"], dir);
    expect(result.session).toBe("running Chrome (attach)");
  });

  test("an explicitly named missing config fails instead of falling back", async () => {
    const dir = await tempDir();
    expect(() => dryRun(join(dir, "absent.toml"))).toThrow(/does not exist/);
  });
});
