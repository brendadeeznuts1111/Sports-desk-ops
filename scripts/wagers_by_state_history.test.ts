import { afterEach, describe, expect, test } from "bun:test";

import { z } from "zod";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  automationPathsForArtifact,
  buildWagersOsSchedulePlan,
  hasBlockingAlert,
  runLiveCapture,
  WAGERS_CAPTURE_CRON_TITLE,
  type LiveCaptureConfig,
  type LiveCaptureOutcome,
} from "./wagers_by_state_capture.ts";
import captureWorker from "./wagers_by_state_capture.ts";
import {
  parseJsonlChunkStrict,
  parseJsonlChunks,
  readWagersAlerts,
  readWagersHistory,
  readWagersTickets,
  WAGERS_ARTIFACT_PATH,
} from "./gslive_wagers_by_state.ts";

const PAYLOAD = {
  action: "getBetReport",
  partnerUserId: "",
  agent: "",
  eventId: "",
  freeBetId: "",
  state: "",
  sId: "",
  minVolume: "0",
  maxTimeUntilScore: "0",
  mId: "",
  from: 1792904400,
  fromTime: 0,
  to: 1793771999,
  toTime: 86399,
  betId: "",
  betGroupId: "",
  group: null,
  dateFilterBy: "logTime",
  partnerIds: "",
  period: null,
} as const;

interface Row {
  readonly state: string;
  readonly ticket: string;
  readonly risk?: number;
  readonly toWin?: number;
  readonly result?: number;
  /** Epoch seconds; defaults to a recent bet time. */
  readonly betTimeSec?: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function rowsFrom(specs: readonly Row[]): Record<string, unknown>[] {
  return specs.map((spec) => ({
    State: spec.state,
    Ticket: spec.ticket,
    Risk: spec.risk ?? 10,
    "To Win": spec.toWin ?? 8,
    Result: spec.result ?? 0,
    "Bet Time": spec.betTimeSec ?? nowSec() - 300,
  }));
}

function row(state: string, ticket: string, overrides: Partial<Row> = {}): Row {
  return { state, ticket, ...overrides };
}

type StandInMode = "ok" | "fail" | "malformed" | "slow";

interface Harness {
  readonly ajaxUrl: string;
  readonly calls: { url: string; body: string }[];
  readonly server: ReturnType<typeof Bun.serve>;
  readonly setRows: (rows: readonly Record<string, unknown>[]) => void;
  readonly setMode: (mode: StandInMode) => void;
}

function startAjaxStandIn(
  initial: readonly Record<string, unknown>[],
): Harness {
  let rows = [...initial];
  let mode: StandInMode = "ok";
  const calls: { url: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      calls.push({ url: request.url, body: await request.text() });
      if (mode === "fail") {
        return new Response("upstream exploded", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
      if (mode === "malformed") {
        return Response.json({ bets: "not-an-array" });
      }
      if (mode === "slow") {
        await Bun.sleep(600);
      }
      return Response.json({ bets: rows });
    },
  });
  return {
    ajaxUrl: `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
    calls,
    server,
    setRows(next) {
      rows = [...next];
    },
    setMode(next) {
      mode = next;
    },
  };
}

interface TempPaths {
  readonly dir: string;
  readonly artifact: string;
  readonly status: string;
  readonly history: string;
  readonly tickets: string;
  readonly alerts: string;
}

const dirs: string[] = [];

async function tempPaths(): Promise<TempPaths> {
  const dir = await mkdtemp(join(tmpdir(), "wagers-history-"));
  dirs.push(dir);
  const artifact = join(dir, "gslive-wagers-by-state.summary.json");
  const paths = automationPathsForArtifact(artifact);
  return {
    dir,
    artifact,
    status: join(dir, "wagers-by-state.status.json"),
    history: paths.history,
    tickets: paths.tickets,
    alerts: paths.alerts,
  };
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function captureConfig(
  stand: Harness,
  paths: TempPaths,
  overrides: Partial<LiveCaptureConfig> = {},
): LiveCaptureConfig {
  return {
    cookieHeader: "GSID=fixture-session",
    payload: PAYLOAD,
    fromEpochSec: PAYLOAD.from,
    toEpochSec: PAYLOAD.to,
    dateFilterBy: "logTime",
    ajaxUrl: stand.ajaxUrl,
    artifactPath: paths.artifact,
    statusPath: paths.status,
    ...overrides,
  };
}

async function capture(
  stand: Harness,
  paths: TempPaths,
  overrides: Partial<LiveCaptureConfig> = {},
): Promise<LiveCaptureOutcome> {
  return runLiveCapture(captureConfig(stand, paths, overrides));
}

async function noTmpLeftovers(dir: string): Promise<void> {
  const names = await readdir(dir);
  expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);
}

describe("capture history: the series behind the v2 artifact", () => {
  test("two consecutive captures append two lines, compute migrations and replace the ticket doc", async () => {
    const first = [
      row("win", "T1", { risk: 10, result: 8 }),
      row("pending", "T2", { risk: 20 }),
      row("lose", "T3", { risk: 5, result: -5 }),
      row("mystery-state", "T4", { risk: 3 }),
    ];
    const stand = startAjaxStandIn(rowsFrom(first));
    const paths = await tempPaths();
    try {
      const one = await capture(stand, paths);
      expect(one.ok).toBe(true);
      expect(one.delta).toBeNull(); // first capture: baseline, not an error
      expect(one.historyLine?.delta).toBeNull();

      const before = await readWagersTickets(paths.tickets);
      expect(before.missing).toBe(false);
      expect(before.doc?.tickets).toEqual({
        T1: "win",
        T2: "pending",
        T3: "lose",
        T4: "mystery-state",
      });

      // Second capture: T2 settles pending -> win, T5 is new, T3/T4 are gone.
      stand.setRows(
        rowsFrom([
          row("win", "T1", { risk: 10, result: 8 }),
          row("win", "T2", { risk: 20, result: 20 }),
          row("pending", "T5", { risk: 30 }),
        ]),
      );
      const two = await capture(stand, paths);
      expect(two.ok).toBe(true);
      const delta = two.delta;
      expect(delta).not.toBeNull();
      if (delta === null) return;
      expect(delta.newTickets).toBe(1);
      expect(delta.goneTickets).toBe(2);
      expect(delta.migrations).toEqual([
        { from: "pending", to: "win", tickets: 1 },
      ]);
      const win = delta.perState.find((entry) => entry.state === "win");
      expect(win).toBeDefined();
      expect(win?.legs).toBe(1); // 1 -> 2 legs
      const lose = delta.perState.find((entry) => entry.state === "lose");
      expect(lose?.legs).toBe(-1);
      // 1 pending leg both captures; only the attributed risk moved (20 -> 30).
      expect(
        delta.perState.find((entry) => entry.state === "pending")?.legs,
      ).toBe(0);
      expect(
        delta.perState.find((entry) => entry.state === "pending")?.wagerRisk,
      ).toBe(10);
      expect(delta.toCapturedAt).toBe(two.historyLine?.capturedAt ?? "missing");
      expect(delta.fromCapturedAt).toBe(
        one.historyLine?.capturedAt ?? "missing",
      );

      const after = await readWagersTickets(paths.tickets);
      expect(after.doc?.tickets).toEqual({
        T1: "win",
        T2: "win",
        T5: "pending",
      });
      expect(after.doc?.capturedAt).toBe(two.historyLine?.capturedAt ?? "x");

      const historyText = await Bun.file(paths.history).text();
      const read = await readWagersHistory(10, paths.history);
      expect(read.missing).toBe(false);
      expect(read.lines).toHaveLength(2);
      expect(read.lines[0]?.delta).toBeNull();
      expect(read.lines[1]?.delta?.migrations).toEqual([
        { from: "pending", to: "win", tickets: 1 },
      ]);
      // Contract rule: the history carries counts, never ticket ids. Match the id as a
      // JSON value, not a substring: an ISO timestamp such as 2026-11-04T11:43 also
      // contains "T1", so a substring check fails for ten hours out of every UTC day.
      expect(historyText).not.toMatch(/"T1"/);
      expect(historyText).not.toMatch(/"T5"/);
      expect(read.lines[0]?.qualityFlags).toContain("unknown_states");
      expect(read.lines[1]?.totals.legs).toBe(3);

      // The first capture saw the unknown state; the second raised a measured spike.
      expect(read.lines[0]?.alerts.map((alert) => alert.code)).toContain(
        "unknown_state",
      );
      // Alert document is always written on success and mirrors the history line.
      const alertsRead = await readWagersAlerts(paths.alerts);
      expect(alertsRead.missing).toBe(false);
      expect(alertsRead.doc?.schemaVersion).toBe(1);
      expect(alertsRead.doc?.sourceCapturedAt).toBe(
        two.historyLine?.capturedAt ?? "x",
      );
      expect(alertsRead.doc?.alerts).toEqual(two.alerts);
      await noTmpLeftovers(paths.dir);
    } finally {
      stand.server.stop(true);
    }
  });

  test("a spanning ticket is labelled with its observed states, never an invented one", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([row("pending", "P1"), row("win", "P1", { result: 8 })]),
    );
    const paths = await tempPaths();
    try {
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const tickets = await readWagersTickets(paths.tickets);
      expect(tickets.doc?.tickets).toEqual({ P1: "pending+win" });
    } finally {
      stand.server.stop(true);
    }
  });

  test("a failed capture rewrites no artifact, history, ticket doc or alert doc", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1")]));
    const paths = await tempPaths();
    try {
      const one = await capture(stand, paths);
      expect(one.ok).toBe(true);
      const snapshot = {
        artifact: await Bun.file(paths.artifact).text(),
        history: await Bun.file(paths.history).text(),
        tickets: await Bun.file(paths.tickets).text(),
        alerts: await Bun.file(paths.alerts).text(),
      };

      stand.setMode("fail");
      const two = await capture(stand, paths);
      expect(two.ok).toBe(false);
      expect(two.error).toContain("HTTP 500");
      expect(two.historyLine).toBeNull();
      expect(two.alerts).toEqual([]);

      expect(await Bun.file(paths.artifact).text()).toBe(snapshot.artifact);
      expect(await Bun.file(paths.history).text()).toBe(snapshot.history);
      expect(await Bun.file(paths.tickets).text()).toBe(snapshot.tickets);
      expect(await Bun.file(paths.alerts).text()).toBe(snapshot.alerts);
      expect((await readWagersHistory(10, paths.history)).lines).toHaveLength(
        1,
      );
    } finally {
      stand.server.stop(true);
    }
  });

  test("a corrupt ticket doc keeps the capture green: delta null plus alert_read_error", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1")]));
    const paths = await tempPaths();
    try {
      await Bun.write(paths.tickets, "{not valid json");
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      expect(outcome.delta).toBeNull();
      expect(outcome.alertCodes).toContain("alert_read_error");
      const read = await readWagersHistory(10, paths.history);
      expect(read.lines).toHaveLength(1);
      expect(read.lines[0]?.delta).toBeNull();
      const tickets = await readWagersTickets(paths.tickets);
      expect(tickets.error).toBeNull(); // repaired by the successful capture
      expect(tickets.doc?.tickets).toEqual({ T1: "win" });
    } finally {
      stand.server.stop(true);
    }
  });

  test("history rotation keeps the newest --keep-history lines", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1")]));
    const paths = await tempPaths();
    try {
      for (let index = 0; index < 5; index += 1) {
        const outcome = await capture(stand, paths, { keepHistory: 3 });
        expect(outcome.ok).toBe(true);
      }
      const read = await readWagersHistory(10, paths.history);
      expect(read.lines).toHaveLength(3);
      const artifact = z
        .object({
          source: z.object({
            kind: z.literal("live-ajax.php"),
            capturedAt: z.string(),
          }),
        })
        .parse(await Bun.file(paths.artifact).json());
      expect(read.lines.at(-1)?.capturedAt).toBe(artifact.source.capturedAt);
      const historyText = await Bun.file(paths.history).text();
      expect(historyText.endsWith("\n")).toBe(true);
      await noTmpLeftovers(paths.dir);
    } finally {
      stand.server.stop(true);
    }
  });
});

describe("alerts: deterministic thresholds over measured fields", () => {
  test("a clean capture raises no alerts and --fail-on-alert would not trip", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([row("win", "T1", { risk: 10, result: 8 })]),
    );
    const paths = await tempPaths();
    try {
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      expect(outcome.alerts).toEqual([]);
      expect(hasBlockingAlert(outcome.alerts)).toBe(false);
      const alertsRead = await readWagersAlerts(paths.alerts);
      expect(alertsRead.doc?.alerts).toEqual([]);
    } finally {
      stand.server.stop(true);
    }
  });

  test("pending aging fires at 24h (warn) and at 72h (critical)", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([
        row("pending", "T1", { betTimeSec: nowSec() - 30 * 3600 }),
        row("pending", "T2", {
          betTimeSec: nowSec() - 80 * 3600,
          risk: 20,
        }),
      ]),
    );
    const paths = await tempPaths();
    try {
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const pending = outcome.alerts.find(
        (alert) => alert.code === "pending_aging",
      );
      expect(pending).toBeDefined();
      expect(pending?.severity).toBe("critical");
      expect(pending?.summary).toContain("2 pending legs older than 24h");
      expect(hasBlockingAlert(outcome.alerts)).toBe(true);
    } finally {
      stand.server.stop(true);
    }

    // A lower --pending-warn-hours maps to the report's 1h bucket.
    const stand2 = startAjaxStandIn(
      rowsFrom([
        row("pending", "T1", { betTimeSec: nowSec() - 2 * 3600 }),
        row("pending", "T2", { betTimeSec: nowSec() - 2 * 3600, risk: 5 }),
      ]),
    );
    const paths2 = await tempPaths();
    try {
      const relaxed = await capture(stand2, paths2);
      expect(
        relaxed.alerts.some((alert) => alert.code === "pending_aging"),
      ).toBe(false);
      const strict = await capture(stand2, paths2, {
        alertThresholds: {
          pendingWarnHours: 1,
          spikePct: 25,
          spikeMin: 20,
          cadenceMinutes: 30,
        },
      });
      expect(strict.alerts.map((alert) => alert.code)).toContain(
        "pending_aging",
      );
      expect(
        strict.alerts.find((alert) => alert.code === "pending_aging")?.summary,
      ).toContain("2 pending legs older than 1h");
    } finally {
      stand2.server.stop(true);
    }
  });

  test("a state spike fires when legs move >= --spike-min and >= --spike-pct", async () => {
    const stand = startAjaxStandIn(
      rowsFrom(
        Array.from({ length: 40 }, (_, index) =>
          row("win", `W${index}`, { risk: 10, result: 8 }),
        ),
      ),
    );
    const paths = await tempPaths();
    try {
      expect((await capture(stand, paths)).ok).toBe(true);
      stand.setRows(
        rowsFrom(
          Array.from({ length: 60 }, (_, index) =>
            row("win", `W${index}`, { risk: 10, result: 8 }),
          ),
        ),
      );
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const spikes = outcome.alerts.filter(
        (alert) => alert.code === "state_spike",
      );
      const legs = spikes.find((alert) => alert.summary.includes("legs"));
      expect(legs).toBeDefined();
      expect(legs?.summary).toBe("win legs moved +50%");
      expect(legs?.detail).toBe("+20 on 40");
      // wagerRisk moved 400 -> 600: same +50% rule on the money metric.
      expect(spikes.some((alert) => alert.summary.includes("wagerRisk"))).toBe(
        true,
      );
    } finally {
      stand.server.stop(true);
    }
  });

  test("a spike below the absolute minimum is not reported", async () => {
    const stand = startAjaxStandIn(
      rowsFrom(
        Array.from({ length: 2 }, (_, index) =>
          row("win", `W${index}`, { risk: 1, result: 8 }),
        ),
      ),
    );
    const paths = await tempPaths();
    try {
      expect((await capture(stand, paths)).ok).toBe(true);
      stand.setRows(
        rowsFrom(
          Array.from({ length: 4 }, (_, index) =>
            row("win", `W${index}`, { risk: 1, result: 8 }),
          ),
        ),
      );
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      // +2 legs and +2 wagerRisk are both below --spike-min 20, so neither metric alerts.
      expect(outcome.alerts.some((alert) => alert.code === "state_spike")).toBe(
        false,
      );
    } finally {
      stand.server.stop(true);
    }
  });

  test("unknown states and coherence violations are reported with counts", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([
        row("mystery-state", "T1"),
        row("win", "T2", { result: -1 }),
        row("lose", "T3", { result: 5 }),
      ]),
    );
    const paths = await tempPaths();
    try {
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const codes = outcome.alerts.map((alert) => alert.code);
      expect(codes).toContain("unknown_state");
      expect(codes).toContain("coherence_violation");
      expect(
        outcome.alerts.find((alert) => alert.code === "unknown_state")?.detail,
      ).toBe("mystery-state");
      expect(
        outcome.alerts.find((alert) => alert.code === "coherence_violation")
          ?.detail,
      ).toBe("win with result<=0=1; lose with result>=0=1");
    } finally {
      stand.server.stop(true);
    }
  });

  test("ticket churn fires above 25% of a book of at least 20 wagers", async () => {
    const stand = startAjaxStandIn(
      rowsFrom(
        Array.from({ length: 40 }, (_, index) => row("pending", `P${index}`)),
      ),
    );
    const paths = await tempPaths();
    try {
      expect((await capture(stand, paths)).ok).toBe(true);
      stand.setRows(
        rowsFrom(
          Array.from({ length: 40 }, (_, index) =>
            row("pending", `N${index}`, { risk: 12 }),
          ),
        ),
      );
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const churn = outcome.alerts.find(
        (alert) => alert.code === "ticket_churn",
      );
      expect(churn).toBeDefined();
      expect(churn?.detail).toBe("new=40; gone=40; previousWagers=40");
    } finally {
      stand.server.stop(true);
    }
  });

  test("capture_stale fires when the previous artifact is older than 2x cadence", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1")]));
    const paths = await tempPaths();
    try {
      const staleCapturedAt = new Date(Date.now() - 90 * 60_000).toISOString();
      await Bun.write(
        paths.artifact,
        JSON.stringify({
          schemaVersion: 2,
          source: { kind: "live-ajax.php", capturedAt: staleCapturedAt },
        }),
      );
      const outcome = await capture(stand, paths, {
        alertThresholds: {
          pendingWarnHours: 24,
          spikePct: 25,
          spikeMin: 20,
          cadenceMinutes: 30,
        },
      });
      expect(outcome.ok).toBe(true);
      const stale = outcome.alerts.find(
        (alert) => alert.code === "capture_stale",
      );
      expect(stale).toBeDefined();
      expect(stale?.summary).toBe("previous artifact older than 60 min");

      // A fresh artifact (just captured) is not stale on the next run.
      const fresh = await capture(stand, paths);
      expect(fresh.alerts.some((alert) => alert.code === "capture_stale")).toBe(
        false,
      );
    } finally {
      stand.server.stop(true);
    }
  });

  test("history/alerts carry counts and alert text only, never ticket identifiers", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([
        row("pending", "SECRET-TICKET-1", {
          betTimeSec: nowSec() - 30 * 3600,
        }),
        row("win", "SECRET-TICKET-2", { result: 8 }),
      ]),
    );
    const paths = await tempPaths();
    try {
      await capture(stand, paths);
      await capture(stand, paths); // second line carries a delta with ticket counts
      const historyText = await Bun.file(paths.history).text();
      const alertsText = await Bun.file(paths.alerts).text();
      expect(historyText).not.toContain("SECRET-TICKET");
      expect(alertsText).not.toContain("SECRET-TICKET");
      expect(historyText).toContain('"newTickets":0');
    } finally {
      stand.server.stop(true);
    }
  });
});

describe("--fail-on-alert exit semantics (end to end)", () => {
  test("exits 1 after a successful warned capture and 0 without the flag", async () => {
    const stand = startAjaxStandIn(
      rowsFrom([row("pending", "T1", { betTimeSec: nowSec() - 30 * 3600 })]),
    );
    const bun = Bun.which("bun") ?? "bun";
    const cliPath = join(import.meta.dir, "wagers_by_state_capture.ts");
    try {
      for (const withFlag of [false, true]) {
        const paths = await tempPaths();
        const args = [
          bun,
          cliPath,
          "--ajax-url",
          stand.ajaxUrl,
          "--from",
          String(PAYLOAD.from),
          "--to",
          String(PAYLOAD.to),
          "--out",
          paths.artifact,
          "--status",
          paths.status,
        ];
        if (withFlag) args.push("--fail-on-alert");
        const proc = Bun.spawn(args, {
          env: { ...Bun.env, GSID: "fixture-session" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const exitCode = await proc.exited;
        const stderr = await new Response(proc.stderr).text();
        expect(exitCode).toBe(withFlag ? 1 : 0);
        expect(await Bun.file(paths.artifact).exists()).toBe(true);
        expect((await readWagersHistory(10, paths.history)).lines).toHaveLength(
          1,
        );
        expect(
          (await readWagersAlerts(paths.alerts)).doc?.alerts.map(
            (alert) => alert.code,
          ),
        ).toContain("pending_aging");
        if (withFlag) {
          expect(stderr).toContain("--fail-on-alert is set");
        } else {
          expect(stderr).not.toContain("--fail-on-alert is set");
        }
      }
    } finally {
      stand.server.stop(true);
    }
  }, 20_000);
});

describe("history/alerts readers: MISSING and UNSUPPORTED are distinct", () => {
  test("missing files are reported as missing, never as empty data", async () => {
    const paths = await tempPaths();
    const history = await readWagersHistory(10, paths.history);
    expect(history.missing).toBe(true);
    expect(history.lines).toEqual([]);
    const alerts = await readWagersAlerts(paths.alerts);
    expect(alerts.missing).toBe(true);
    expect(alerts.doc).toBeNull();
    const tickets = await readWagersTickets(paths.tickets);
    expect(tickets.missing).toBe(true);
  });

  test("an unknown history schemaVersion is UNSUPPORTED, not best-effort parsed", async () => {
    const paths = await tempPaths();
    await Bun.write(
      paths.history,
      `${JSON.stringify({ schemaVersion: 2, capturedAt: "2026-11-03T00:00:00.000Z" })}\n`,
    );
    const read = await readWagersHistory(10, paths.history);
    expect(read.missing).toBe(false);
    expect(read.unsupported).toBe(true);
    expect(read.lines).toEqual([]);
  });
});

describe("OS-level scheduling: plan and validate only, never install here", () => {
  test("a valid schedule yields the next fire, worker path and operator commands", () => {
    const plan = buildWagersOsSchedulePlan("*/15 * * * *");
    expect(plan.title).toBe(WAGERS_CAPTURE_CRON_TITLE);
    expect(plan.schedule).toBe("*/15 * * * *");
    const next = Date.parse(plan.nextFireIso);
    expect(Number.isFinite(next)).toBe(true);
    expect(next).toBeGreaterThan(Date.now() - 1000);
    expect(next).toBeLessThanOrEqual(Date.now() + 16 * 60_000);
    expect(plan.workerPath.endsWith("scripts/wagers_by_state_capture.ts")).toBe(
      true,
    );
    expect(plan.installCommand).toBe(
      'bun run wagers:capture --install-os --cron "*/15 * * * *"',
    );
    expect(plan.uninstallCommand).toBe("bun run wagers:capture --uninstall-os");
  });

  test("an invalid schedule fails closed before any install", () => {
    expect(() => buildWagersOsSchedulePlan("not a cron expression")).toThrow();
    expect(() => buildWagersOsSchedulePlan("*/0 * * * *")).toThrow();
  });

  test("the module exports the OS worker entry `default { scheduled }`", () => {
    expect(typeof captureWorker.scheduled).toBe("function");
  });
});

describe("capture paths", () => {
  test("automation documents are siblings of the artifact (contract paths by default)", () => {
    expect(automationPathsForArtifact(WAGERS_ARTIFACT_PATH)).toEqual({
      history: "scratch/wagers-by-state.history.jsonl",
      tickets: "scratch/wagers-by-state.tickets.json",
      alerts: "scratch/wagers-by-state.alerts.json",
    });
    expect(automationPathsForArtifact("tmp/x/artifact.json")).toEqual({
      history: "tmp/x/wagers-by-state.history.jsonl",
      tickets: "tmp/x/wagers-by-state.tickets.json",
      alerts: "tmp/x/wagers-by-state.alerts.json",
    });
  });
});

describe("observable JSONL truncation (Bun.JSONL.parseChunk)", () => {
  test("a truncated history aborts the capture instead of deriving a delta from a short series", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1")]));
    const paths = await tempPaths();
    try {
      await Bun.write(
        paths.history,
        '{"schemaVersion":1,"capturedAt":"2026-01-01T00:00:00.000Z"}\n{"schemaVersion":1,"capt',
      );
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("truncated");
      expect(await Bun.file(paths.artifact).exists()).toBe(false);
    } finally {
      stand.server.stop(true);
    }
  });
  const enc = new TextEncoder();
  const complete = '{"a":1}\n{"b":2}\n';

  test("parseChunk accepts a string, a plain ArrayBuffer, and a view alike", () => {
    for (const input of [
      complete,
      enc.encode(complete).buffer,
      enc.encode(complete),
    ]) {
      const parsed = parseJsonlChunkStrict(input);
      expect(parsed.values).toEqual([{ a: 1 }, { b: 2 }]);
      expect(parsed.done).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.unreadBytes).toBe(0);
    }
  });

  test("an incomplete tail is reported, never silently dropped", () => {
    const parsed = parseJsonlChunkStrict('{"a":1}\n{"b":');
    expect(parsed.values).toEqual([{ a: 1 }]);
    expect(parsed.done).toBe(false);
    expect(parsed.unreadBytes).toBeGreaterThan(0);
  });

  test("chunked parsing carries only the partial tail across boundaries", async () => {
    const bytes = enc.encode(complete);
    const chunks = Array.from(bytes).map((byte) => Uint8Array.of(byte));
    const parsed = await parseJsonlChunks(chunks);
    expect(parsed.values).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parsed.error).toBeNull();
    expect(parsed.unreadTail).toHaveLength(0);

    const torn = await parseJsonlChunks(
      enc.encode('{"a":1}\n{"b":').reduce<Uint8Array[]>((acc, byte) => {
        acc.push(Uint8Array.of(byte));
        return acc;
      }, []),
    );
    expect(torn.values).toEqual([{ a: 1 }]);
    expect(torn.error).toBeNull();
    expect(torn.unreadTail.length).toBeGreaterThan(0);
  });

  test("readWagersHistory throws on a torn final line instead of returning a short series", async () => {
    const paths = await tempPaths();
    const historyPath = join(paths.dir, "wagers-by-state.history.jsonl");
    const line = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      sourceKind: "live-ajax.php",
      totals: {
        legs: 1,
        wagers: 1,
        spanning: 0,
        legRisk: 0,
        wagerRisk: 0,
        legToWin: 0,
        legResult: 0,
      },
      states: [],
      delta: null,
      qualityFlags: [],
      alerts: [],
    };
    await Bun.write(
      historyPath,
      `${JSON.stringify(line)}\n{"schemaVersion":1,"capt`,
    );
    await expect(readWagersHistory(10, historyPath)).rejects.toThrow(
      /truncated/,
    );
  });

  test("a malformed complete line is still skipped and counted", async () => {
    const paths = await tempPaths();
    const historyPath = join(paths.dir, "wagers-by-state.history.jsonl");
    const line = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      sourceKind: "live-ajax.php",
      totals: {
        legs: 1,
        wagers: 1,
        spanning: 0,
        legRisk: 0,
        wagerRisk: 0,
        legToWin: 0,
        legResult: 0,
      },
      states: [],
      delta: null,
      qualityFlags: [],
      alerts: [],
    };
    await Bun.write(
      historyPath,
      `${JSON.stringify(line)}\nnot-json\n${JSON.stringify(line)}\n`,
    );
    const read = await readWagersHistory(10, historyPath);
    expect(read.lines).toHaveLength(2);
    expect(read.invalidLines).toBe(1);
    expect(read.missing).toBe(false);
    expect(read.unsupported).toBe(false);
  });
});

describe("verification matrix: claims that must not drift", () => {
  test("multi-leg wager: legs and distinct wagers separate end-to-end", async () => {
    const multiLeg = [
      {
        State: "win",
        Ticket: "P1",
        Id: "L1",
        Risk: 5,
        "To Win": 4,
        Result: 4,
        "Bet Time": nowSec() - 300,
      },
      {
        State: "win",
        Ticket: "P1",
        Id: "L2",
        Risk: 5,
        "To Win": 4,
        Result: 4,
        "Bet Time": nowSec() - 300,
      },
    ];
    const stand = startAjaxStandIn(multiLeg);
    const paths = await tempPaths();
    try {
      const outcome = await capture(stand, paths);
      expect(outcome.ok).toBe(true);
      const artifact = z
        .object({
          totals: z.object({
            legs: z.number(),
            wagers: z.number().nullable(),
          }),
        })
        .parse(await Bun.file(paths.artifact).json());
      expect(artifact.totals.legs).toBe(2);
      expect(artifact.totals.wagers).toBe(1);
    } finally {
      stand.server.stop(true);
    }
  });

  test("identical re-capture is idempotent: zero delta, migrations empty", async () => {
    const rows = [row("win", "T1", { result: 8 }), row("pending", "T2")];
    const stand = startAjaxStandIn(rowsFrom(rows));
    const paths = await tempPaths();
    try {
      expect((await capture(stand, paths)).ok).toBe(true);
      const second = await capture(stand, paths);
      expect(second.ok).toBe(true);
      expect(second.delta?.newTickets).toBe(0);
      expect(second.delta?.goneTickets).toBe(0);
      expect(second.delta?.migrations).toEqual([]);
      const read = await readWagersHistory(10, paths.history);
      expect(read.lines).toHaveLength(2);
      expect(read.lines.at(-1)?.delta?.newTickets).toBe(0);
    } finally {
      stand.server.stop(true);
    }
  });

  test("pending_aging summary carries the pending count (1 vs 2)", async () => {
    const aged = nowSec() - 25 * 3600;
    const one = startAjaxStandIn(
      rowsFrom([row("pending", "T1", { betTimeSec: aged })]),
    );
    const pathsOne = await tempPaths();
    try {
      const outcome = await capture(one, pathsOne);
      const alert = outcome.ok
        ? outcome.alerts.find((entry) => entry.code === "pending_aging")
        : undefined;
      expect(alert?.summary).toContain("1 pending legs older than 24h");
    } finally {
      one.server.stop(true);
    }

    const two = startAjaxStandIn(
      rowsFrom([
        row("pending", "T1", { betTimeSec: aged }),
        row("pending", "T2", { betTimeSec: aged, risk: 5 }),
      ]),
    );
    const pathsTwo = await tempPaths();
    try {
      const outcome = await capture(two, pathsTwo);
      const alert = outcome.ok
        ? outcome.alerts.find((entry) => entry.code === "pending_aging")
        : undefined;
      expect(alert?.summary).toContain("2 pending legs older than 24h");
    } finally {
      two.server.stop(true);
    }
  });

  test("failure matrix leaves the artifact untouched and journals lastFailure", async () => {
    const stand = startAjaxStandIn(rowsFrom([row("win", "T1", { result: 8 })]));
    const paths = await tempPaths();
    try {
      expect((await capture(stand, paths)).ok).toBe(true);
      const baseline = await Bun.file(paths.artifact).text();

      for (const mode of ["fail", "malformed"] as const) {
        stand.setMode(mode);
        const outcome = await capture(stand, paths, { retries: 0 });
        expect(outcome.ok).toBe(false);
        expect(await Bun.file(paths.artifact).text()).toBe(baseline);
      }

      stand.setMode("slow");
      const timedOut = await capture(stand, paths, {
        retries: 0,
        timeoutMs: 100,
      });
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) expect(timedOut.error).toContain("timed out");
      expect(await Bun.file(paths.artifact).text()).toBe(baseline);

      const journal = z
        .object({ lastFailure: z.object({ error: z.string() }).nullable() })
        .parse(await Bun.file(paths.status).json());
      expect(journal.lastFailure?.error).toContain("timed out");

      stand.setMode("ok");
      const truncated = join(paths.dir, "wagers-by-state.history.jsonl");
      await Bun.write(
        truncated,
        '{"schemaVersion":1,"capturedAt":"2026-01-01T00:00:00.000Z"}\n{"schemaVersion":1,"capt',
      );
      const truncArtifact = join(paths.dir, "artifact-trunc.json");
      const trunc = await capture(stand, paths, {
        historyPath: truncated,
        artifactPath: truncArtifact,
        retries: 0,
      });
      expect(trunc.ok).toBe(false);
      if (!trunc.ok) expect(trunc.error).toContain("truncated");
      expect(await Bun.file(truncArtifact).exists()).toBe(false);
    } finally {
      stand.server.stop(true);
    }
  });
});
