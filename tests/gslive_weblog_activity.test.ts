import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  // ast-grep-ignore: node-fs-read-write-file -- the loader under test is sync; fixtures must be too.
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  buildGsliveWeblogArtifact,
  GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
  GSLIVE_WEBLOG_ARTIFACT_RELATIVE_ALT,
  GSLIVE_WEBLOG_REFRESH_COMMAND,
  GSLIVE_WEBLOG_STALE_AFTER_SECONDS,
  gsliveWeblogFlagSeverity,
  loadGsliveWeblogActivity,
  type GsliveWeblogArtifact,
  type GsliveWeblogBetLogInput,
  type GsliveWeblogBuildInput,
  type GsliveWeblogReport,
  type GsliveWeblogWatchlistAccount,
} from "../lib/gslive_weblog_activity.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FIXTURE_PATH = resolve(
  import.meta.dir,
  "fixtures/gslive-weblogs/build-input.json",
);
const FIXED_NOW = new Date("2026-11-04T12:00:00.000Z");
const WINDOW = {
  fromIso: "2026-11-03T12:00:00.000Z",
  toIso: "2026-11-04T12:00:00.000Z",
} as const;

interface Fixture {
  readonly accounts: readonly GsliveWeblogWatchlistAccount[];
  readonly reports: readonly {
    readonly customerLogin: string;
    readonly rows: readonly Record<string, unknown>[];
  }[];
  readonly bets: readonly {
    readonly customerLogin: string;
    readonly betId: string;
    readonly betLog: unknown;
    readonly eventLog?: unknown;
    readonly eventState?: string;
  }[];
}

const fixture = (await Bun.file(FIXTURE_PATH).json()) as Fixture;

const accountByLogin = new Map(
  fixture.accounts.map((account) => [account.customerLogin, account]),
);

function fixtureAccount(customerLogin: string): GsliveWeblogWatchlistAccount {
  const account = accountByLogin.get(customerLogin);
  if (account === undefined) {
    throw new Error(`fixture account ${customerLogin} is missing`);
  }
  return account;
}

function fixtureReports(): GsliveWeblogReport[] {
  return fixture.reports.map((report) => ({
    account: fixtureAccount(report.customerLogin),
    rows: report.rows,
  }));
}

function fixtureBets(): GsliveWeblogBetLogInput[] {
  return fixture.bets.map((bet) => ({
    account: fixtureAccount(bet.customerLogin),
    betId: bet.betId,
    betLog: bet.betLog,
    ...(bet.eventLog === undefined ? {} : { eventLog: bet.eventLog }),
    ...(bet.eventState === undefined ? {} : { eventState: bet.eventState }),
  }));
}

function buildFixtureArtifact(
  overrides: Partial<GsliveWeblogBuildInput> = {},
): GsliveWeblogArtifact {
  return buildGsliveWeblogArtifact({
    reports: fixtureReports(),
    bets: fixtureBets(),
    window: WINDOW,
    session: { configured: true, source: "keychain" },
    now: FIXED_NOW,
    ...overrides,
  });
}

function withTempRoot(
  run: (root: string) => void,
  artifactRelative: string = GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
  artifact: GsliveWeblogArtifact | null = buildFixtureArtifact(),
): void {
  const root = mkdtempSync(join(tmpdir(), "gslive-weblog-test-"));
  try {
    if (artifact !== null) {
      const path = join(root, artifactRelative);
      mkdirSync(dirname(path), { recursive: true });
      // ast-grep-ignore: node-fs-read-write-file -- fixture mode 0600 for a sync loader.
      writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, {
        mode: 0o600,
      });
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const accountIn = (artifact: GsliveWeblogArtifact, customerLogin: string) => {
  const account = artifact.accounts.find(
    (candidate) => candidate.customerLogin === customerLogin,
  );
  expect(account).toBeDefined();
  return account as GsliveWeblogArtifact["accounts"][number];
};

describe("buildGsliveWeblogArtifact", () => {
  test("builds per-account activity from synthetic getBetLog/getEventLog payloads", () => {
    const artifact = buildFixtureArtifact();
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.kind).toBe("gslive-weblogs");
    expect(artifact.generatedAtIso).toBe(FIXED_NOW.toISOString());
    expect(artifact.window).toEqual(WINDOW);
    expect(artifact.session).toEqual({
      configured: true,
      source: "keychain",
    });

    const bgd = accountIn(artifact, "BGD101");
    expect(bgd.betCount).toBe(2);
    expect(bgd.agentId).toBe("BIGDAD");
    expect(bgd.placedAtIso).toBe(new Date(1793762000000).toISOString());
    expect(bgd.lastLogIso).toBe(new Date(1793762001000).toISOString());
    expect(bgd.flags).toEqual([
      { code: "SUB_15S_SCORE_SNIPE", severity: "CRITICAL", count: 1 },
      { code: "ODDS_IMPROVEMENT_DURING_DELAY", severity: "MEDIUM", count: 2 },
      { code: "ODDS_DRIFT", severity: "MEDIUM", count: 1 },
    ]);

    const mj = accountIn(artifact, "MJ102");
    expect(mj.betCount).toBe(2);
    expect(mj.flags.map((flag) => flag.code)).toEqual([
      "ADMIN_USER",
      "MANUAL_ADMIN_INTERVENTION",
      "MANUAL_LOG",
      "ODDS_IMPROVEMENT_DURING_DELAY",
    ]);
    expect(mj.flags.map((flag) => flag.severity)).toEqual([
      "HIGH",
      "HIGH",
      "MEDIUM",
      "MEDIUM",
    ]);

    const cb = accountIn(artifact, "CB112_1");
    expect(cb.betCount).toBe(1);
    expect(cb.flags).toEqual([]);
    expect(cb.placedAtIso).toBeNull();
    expect(cb.lastLogIso).toBe(new Date(1793762400000).toISOString());

    // Most severe finding first, then busiest, then login.
    expect(artifact.accounts.map((account) => account.customerLogin)).toEqual([
      "BGD101",
      "MJ102",
      "CB112_1",
    ]);
    expect(artifact.summary.accounts).toBe(3);
    expect(artifact.summary.bets).toBe(5);
    expect(artifact.parseErrors).toBe(1);
  });

  test("aggregates flagsByCode across accounts without double counting a bet", () => {
    const artifact = buildFixtureArtifact();
    expect(artifact.summary.flagsByCode).toEqual({
      ADMIN_USER: 1,
      MANUAL_ADMIN_INTERVENTION: 1,
      MANUAL_LOG: 1,
      ODDS_DRIFT: 1,
      ODDS_IMPROVEMENT_DURING_DELAY: 3,
      SUB_15S_SCORE_SNIPE: 1,
    });
    // The same bet supplied twice must not inflate flags or bet counts.
    const bgd = fixtureAccount("BGD101");
    const duplicated = buildFixtureArtifact({
      reports: [{ account: bgd, rows: fixture.reports[0]?.rows ?? [] }],
      bets: [
        {
          account: bgd,
          betId: "350826311",
          betLog: fixture.bets[0]?.betLog,
          eventLog: fixture.bets[0]?.eventLog,
        },
        {
          account: bgd,
          betId: "350826311",
          betLog: fixture.bets[0]?.betLog,
          eventLog: fixture.bets[0]?.eventLog,
        },
      ],
    });
    expect(duplicated.summary.bets).toBe(1);
    expect(duplicated.summary.flagsByCode).toEqual({
      ODDS_DRIFT: 1,
      ODDS_IMPROVEMENT_DURING_DELAY: 1,
      SUB_15S_SCORE_SNIPE: 1,
    });
  });

  test("counts an unparseable or failed bet log, never inventing flags", () => {
    const cb = fixtureAccount("CB112_1");
    const unparseable = buildFixtureArtifact({
      reports: [{ account: cb, rows: [] }],
      bets: [
        { account: cb, betId: "990003", betLog: fixture.bets[4]?.betLog },
        { account: cb, betId: "990004", betLog: null },
        { account: cb, betId: "990005", betLog: "not-json" },
      ],
    });
    expect(unparseable.summary.accounts).toBe(1);
    expect(unparseable.summary.bets).toBe(3);
    expect(unparseable.parseErrors).toBe(3);
    expect(unparseable.summary.flagsByCode).toEqual({});
    expect(unparseable.accounts[0]?.flags).toEqual([]);
  });

  test("a manual-override bet surfaces the existing auditor flags", () => {
    const artifact = buildFixtureArtifact();
    const mj = accountIn(artifact, "MJ102");
    expect(mj.flags).toContainEqual({
      code: "MANUAL_ADMIN_INTERVENTION",
      severity: "HIGH",
      count: 1,
    });
    expect(mj.flags).toContainEqual({
      code: "ADMIN_USER",
      severity: "HIGH",
      count: 1,
    });
    expect(mj.flags).toContainEqual({
      code: "MANUAL_LOG",
      severity: "MEDIUM",
      count: 1,
    });
  });

  test("maps audit codes to the documented severities", () => {
    expect(gsliveWeblogFlagSeverity("SUB_15S_SCORE_SNIPE")).toBe("CRITICAL");
    expect(gsliveWeblogFlagSeverity("WAGER_STATE_MISMATCH")).toBe("CRITICAL");
    expect(gsliveWeblogFlagSeverity("ADMIN_USER")).toBe("HIGH");
    expect(gsliveWeblogFlagSeverity("DELAY_MISMATCH")).toBe("HIGH");
    expect(gsliveWeblogFlagSeverity("ODDS_DRIFT")).toBe("MEDIUM");
    expect(gsliveWeblogFlagSeverity("SOMETHING_NEW")).toBe("MEDIUM");
  });

  test("carries no session material, admin name, ticket number, or log detail", () => {
    const serialized = JSON.stringify(buildFixtureArtifact());
    expect(serialized).not.toMatch(/GSID|cookie|bearer|authorization/i);
    expect(serialized).not.toContain("opsadmin");
    expect(serialized).not.toContain("1074652273");
    expect(serialized).not.toContain("Affiliate adjustment");
    expect(serialized).not.toContain("Bet placed @");
  });

  test("refuses to build a measured artifact without a configured session", () => {
    expect(() =>
      buildFixtureArtifact({ session: { configured: false, source: null } }),
    ).toThrow(/without a configured session/);
  });

  test("rejects an unparseable window", () => {
    expect(() =>
      buildFixtureArtifact({ window: { fromIso: "yesterday", toIso: "now" } }),
    ).toThrow(/window/);
    expect(() =>
      buildFixtureArtifact({
        window: {
          fromIso: "2026-11-04T12:00:00.000Z",
          toIso: "2026-11-03T12:00:00.000Z",
        },
      }),
    ).toThrow(/fromIso must be <= window.toIso/);
  });
});

describe("loadGsliveWeblogActivity", () => {
  test("missing artifact is not_measured with the honest reason and command", () => {
    const root = mkdtempSync(join(tmpdir(), "gslive-weblog-missing-"));
    try {
      const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
      expect(activity.status).toBe("not_measured");
      expect(activity.source).toBeNull();
      expect(activity.asOf).toBeNull();
      expect(activity.ageSeconds).toBeNull();
      expect(activity.stale).toBe(false);
      expect(activity.accounts).toEqual([]);
      expect(activity.summary).toEqual({
        accounts: 0,
        bets: 0,
        flagsByCode: {},
      });
      expect(activity.reason).toContain("not found");
      expect(activity.reason).toContain(GSLIVE_WEBLOG_ARTIFACT_RELATIVE);
      expect(activity.command).toBe(GSLIVE_WEBLOG_REFRESH_COMMAND);
      expect(activity.parseErrors).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a measured artifact is surfaced with asOf/ageSeconds from generatedAtIso", () => {
    withTempRoot((root) => {
      const artifact = buildFixtureArtifact();
      const activity = loadGsliveWeblogActivity({
        root,
        now: new Date(FIXED_NOW.getTime() + 60_000),
      });
      expect(activity.status).toBe("measured");
      expect(activity.source).toBe(artifact.source);
      expect(activity.asOf).toBe(FIXED_NOW.toISOString());
      expect(activity.ageSeconds).toBe(60);
      expect(activity.stale).toBe(false);
      expect(activity.accounts).toEqual(artifact.accounts);
      expect(activity.summary).toEqual(artifact.summary);
      expect(activity.parseErrors).toBe(1);
      expect(activity.reason).toBeUndefined();
      expect(activity.command).toBe(GSLIVE_WEBLOG_REFRESH_COMMAND);
    });
  });

  test("stales only after the 6h threshold", () => {
    withTempRoot((root) => {
      const boundary = loadGsliveWeblogActivity({
        root,
        now: new Date(
          FIXED_NOW.getTime() + GSLIVE_WEBLOG_STALE_AFTER_SECONDS * 1000,
        ),
      });
      expect(boundary.ageSeconds).toBe(GSLIVE_WEBLOG_STALE_AFTER_SECONDS);
      expect(boundary.stale).toBe(false);

      const stale = loadGsliveWeblogActivity({
        root,
        now: new Date(
          FIXED_NOW.getTime() + (GSLIVE_WEBLOG_STALE_AFTER_SECONDS + 1) * 1000,
        ),
      });
      expect(stale.status).toBe("measured");
      expect(stale.ageSeconds).toBe(GSLIVE_WEBLOG_STALE_AFTER_SECONDS + 1);
      expect(stale.stale).toBe(true);
    });
  });

  test("accepts the <root>/gslive-weblogs/latest.json location too", () => {
    withTempRoot((root) => {
      const activity = loadGsliveWeblogActivity({
        root,
        now: new Date(FIXED_NOW.getTime() + 1000),
      });
      expect(activity.status).toBe("measured");
      expect(activity.ageSeconds).toBe(1);
    }, GSLIVE_WEBLOG_ARTIFACT_RELATIVE_ALT);
  });

  test("rejects invalid JSON instead of best-effort parsing", () => {
    withTempRoot(
      (root) => {
        const path = join(root, GSLIVE_WEBLOG_ARTIFACT_RELATIVE);
        mkdirSync(dirname(path), { recursive: true });
        // ast-grep-ignore: node-fs-read-write-file -- malformed fixture for a sync loader.
        writeFileSync(path, "{ not json");
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("not_measured");
        expect(activity.reason).toContain("not valid JSON");
        expect(activity.accounts).toEqual([]);
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      null,
    );
  });

  test("rejects a wrong schemaVersion", () => {
    const artifact = buildFixtureArtifact();
    withTempRoot(
      (root) => {
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("not_measured");
        expect(activity.reason).toContain("schemaVersion");
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      { ...artifact, schemaVersion: 2 } as unknown as GsliveWeblogArtifact,
    );
  });

  test("rejects a wrong kind", () => {
    const artifact = buildFixtureArtifact();
    withTempRoot(
      (root) => {
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("not_measured");
        expect(activity.reason).toContain("kind");
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      {
        ...artifact,
        kind: "gslive-weblogs-v0",
      } as unknown as GsliveWeblogArtifact,
    );
  });

  test("rejects a malformed account row rather than returning a partial measurement", () => {
    const artifact = buildFixtureArtifact();
    withTempRoot(
      (root) => {
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("not_measured");
        expect(activity.reason).toContain("failed validation");
        expect(activity.reason).toContain("severity");
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      {
        ...artifact,
        accounts: [
          {
            ...(artifact
              .accounts[0] as GsliveWeblogArtifact["accounts"][number]),
            flags: [{ code: "SOMETHING", severity: "LOW", count: 1 }],
          },
        ],
      } as unknown as GsliveWeblogArtifact,
    );
  });

  test("omits parseErrors when an older artifact does not carry it (no fabricated zero)", () => {
    const artifact = buildFixtureArtifact();
    const withoutParseErrors = { ...artifact } as Record<string, unknown>;
    delete withoutParseErrors.parseErrors;
    withTempRoot(
      (root) => {
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("measured");
        expect(activity.parseErrors).toBeUndefined();
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      withoutParseErrors as unknown as GsliveWeblogArtifact,
    );
  });

  test("a generatedAtIso in the future is reported, not clamped into a measurement", () => {
    const artifact = buildFixtureArtifact();
    withTempRoot(
      (root) => {
        const activity = loadGsliveWeblogActivity({ root, now: FIXED_NOW });
        expect(activity.status).toBe("not_measured");
        expect(activity.reason).toContain("future");
      },
      GSLIVE_WEBLOG_ARTIFACT_RELATIVE,
      {
        ...artifact,
        generatedAtIso: new Date(
          FIXED_NOW.getTime() + 2 * 60 * 60 * 1000,
        ).toISOString(),
      },
    );
  });
});

describe("scripts/gslive_weblog_refresh.ts --dry-run", () => {
  test("prints the plan with no network, no session resolution, and no write", () => {
    const outPath = join(
      tmpdir(),
      `gslive-weblogs-dry-run-${process.pid}.json`,
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        resolve(REPO_ROOT, "scripts/gslive_weblog_refresh.ts"),
        "--dry-run",
        "--from",
        "1793163600",
        "--to",
        "1793771999",
        "--max-bets",
        "7",
        "--out",
        outPath,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...Bun.env,
          GSID: "",
          GSID_COOKIE: "",
          GSLIVE_SESSION_FILE: "/nonexistent/gslive-session",
          XDG_CONFIG_HOME: "/nonexistent-xdg",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    expect(stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("dry run");
    expect(stdout).toContain("1793163600");
    expect(stdout).toContain("1793771999");
    expect(stdout).toContain("getBetReport");
    expect(stdout).toContain("getBetLog");
    expect(stdout).toContain("watchlist accounts");
    expect(stdout).toContain("up to 7 sampled bets");
    expect(stdout).toContain(outPath);
    expect(stdout).not.toMatch(/GSID=/);
    expect(existsSync(outPath)).toBe(false);
  });
});
