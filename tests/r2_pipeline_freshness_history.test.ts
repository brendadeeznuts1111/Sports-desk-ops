import { describe, expect, test } from "bun:test";
import {
  computeR2SinkSlaStatus,
  createR2PipelineService,
  probeDaemon4020Status,
} from "@sportsdesk-ops/backend";

/**
 * The history endpoint is deliberately process-local: these tests pin the
 * sampling rule (throttled by interval, bypassed by a state change, bounded ring)
 * so an empty series can only mean "not sampled yet".
 */
describe("R2 pipeline freshness arithmetic & process-local history", () => {
  test("computeR2SinkSlaStatus derives breach and utilization without inventing an age", () => {
    expect(computeR2SinkSlaStatus(null, 3_600)).toEqual({
      breachSeconds: null,
      utilizationPct: null,
      breachStartedAt: null,
      remainingSeconds: null,
    });
    expect(computeR2SinkSlaStatus(300, 3_600)).toEqual({
      breachSeconds: 0,
      utilizationPct: 8,
      breachStartedAt: null,
      remainingSeconds: 3_300,
    });
    expect(computeR2SinkSlaStatus(3_600, 3_600)).toEqual({
      breachSeconds: 0,
      utilizationPct: 100,
      breachStartedAt: null,
      remainingSeconds: 0,
    });
    // The breach timestamp anchors on Last-Modified + SLA, not on the rounded age.
    expect(
      computeR2SinkSlaStatus(
        7_200,
        3_600,
        Date.parse("2026-11-18T00:00:00.000Z") - 7_200_000,
      ),
    ).toEqual({
      breachSeconds: 3_600,
      utilizationPct: 200,
      breachStartedAt: "2026-11-17T23:00:00.000Z",
      remainingSeconds: null,
    });
    // A zero SLA target must not produce a division-by-zero Infinity.
    expect(computeR2SinkSlaStatus(10, 0)).toEqual({
      breachSeconds: 9,
      utilizationPct: 1_000,
      breachStartedAt: null,
      remainingSeconds: null,
    });
  });

  test("probeAll stamps per-sink sla math from the observed publish age", async () => {
    const clock = makeClock("2026-11-18T00:00:00.000Z");
    const service = createR2PipelineService({
      fetchImpl: makeSinkFetcher(clock, {
        "f402-bet-ticker": 300,
        "gslive-tally": 7_200,
        "wagers-by-state": 108_000,
      }),
      now: clock.now,
      cacheTtlMs: 0,
    });

    const report = await service.probeAll({ refresh: true });
    const ticker = report.sinks.find((sink) => sink.id === "f402-bet-ticker");
    expect(ticker?.state).toBe("fresh");
    expect(ticker?.sla).toEqual({
      breachSeconds: 0,
      utilizationPct: 8,
      breachStartedAt: null,
      remainingSeconds: 3_300,
    });

    const tally = report.sinks.find((sink) => sink.id === "gslive-tally");
    expect(tally?.state).toBe("stale");
    expect(tally?.sla).toEqual({
      breachSeconds: 3_600,
      utilizationPct: 200,
      breachStartedAt: "2026-11-17T23:00:00.000Z",
      remainingSeconds: null,
    });

    const missing = report.sinks.find((sink) => sink.id === "f402-weblog");
    expect(missing?.state).toBe("missing");
    expect(missing?.sla).toEqual({
      breachSeconds: null,
      utilizationPct: null,
      breachStartedAt: null,
      remainingSeconds: null,
    });

    // Publish stale AND data window stale: the input corpus is the blocker, not
    // a republish (which would only move the timestamp).
    const wagers = report.sinks.find((sink) => sink.id === "wagers-by-state");
    expect(wagers?.diagnostic?.blockerClass).toBe("upstream_capture_stale");
    expect(wagers?.diagnostic?.headline).toContain("Republish Would Replay");
  });

  test("history is throttled by interval, bounded, and records a state change immediately", async () => {
    const clock = makeClock("2026-11-18T00:00:00.000Z");
    const service = createR2PipelineService({
      fetchImpl: makeSinkFetcher(clock, {
        "f402-bet-ticker": 300,
        "gslive-tally": 7_200,
      }),
      now: clock.now,
      cacheTtlMs: 0,
      historyLimit: 3,
      historyMinIntervalSeconds: 60,
    });

    const first = await service.getHistory({ refresh: true });
    expect(first.source).toBe("process-memory");
    expect(first.minSampleIntervalSeconds).toBe(60);
    expect(first.sampledSince).toBe("2026-11-18T00:00:00.000Z");
    for (const series of first.sinks) {
      expect(series.sampleCount).toBe(1);
      expect(series.samples).toHaveLength(1);
      expect(series.samples[0]?.at).toBe("2026-11-18T00:00:00.000Z");
    }

    // Inside the interval: a new probe is not a new sample.
    clock.advanceSeconds(30);
    const throttled = await service.probeAll({ refresh: true });
    const throttledTally = throttled.sinks.find(
      (sink) => sink.id === "gslive-tally",
    );
    expect(throttledTally?.state).toBe("stale");
    expect(
      (await service.getHistory()).sinks.find((s) => s.id === "gslive-tally")
        ?.sampleCount,
    ).toBe(1);

    // Past the interval: one more sample.
    clock.advanceSeconds(31);
    await service.probeAll({ refresh: true });
    expect(
      (await service.getHistory()).sinks.find((s) => s.id === "gslive-tally")
        ?.sampleCount,
    ).toBe(2);

    // A state change bypasses the throttle so the transition is on the record.
    const ages: Record<string, number> = {
      "f402-bet-ticker": 300,
      "gslive-tally": 7_200,
    };
    const transition = createR2PipelineService({
      fetchImpl: makeSinkFetcher(clock, ages),
      now: clock.now,
      cacheTtlMs: 0,
      historyLimit: 3,
      historyMinIntervalSeconds: 600,
    });
    await transition.probeAll({ refresh: true });
    ages["gslive-tally"] = 60;
    clock.advanceSeconds(5);
    await transition.probeAll({ refresh: true });
    const transitionTally = (await transition.getHistory()).sinks.find(
      (series) => series.id === "gslive-tally",
    );
    expect(transitionTally?.sampleCount).toBe(2);
    expect(transitionTally?.samples.map((s) => s.state)).toEqual([
      "stale",
      "fresh",
    ]);
  });

  test("the ring keeps the newest samples and limit returns a tail", async () => {
    const clock = makeClock("2026-11-18T00:00:00.000Z");
    const service = createR2PipelineService({
      fetchImpl: makeSinkFetcher(clock, { "f402-bet-ticker": 300 }),
      now: clock.now,
      cacheTtlMs: 0,
      historyLimit: 3,
      historyMinIntervalSeconds: 0,
    });

    for (let i = 0; i < 5; i++) {
      if (i > 0) clock.advanceSeconds(60);
      await service.probeAll({ refresh: true });
    }

    const series = (await service.getHistory()).sinks.find(
      (sink) => sink.id === "f402-bet-ticker",
    );
    expect(series?.sampleCount).toBe(3);
    expect(series?.samples).toHaveLength(3);
    expect(series?.samples.map((s) => s.at)).toEqual([
      "2026-11-18T00:02:00.000Z",
      "2026-11-18T00:03:00.000Z",
      "2026-11-18T00:04:00.000Z",
    ]);

    const tail = (await service.getHistory({ limit: 2 })).sinks.find(
      (sink) => sink.id === "f402-bet-ticker",
    );
    expect(tail?.sampleCount).toBe(3);
    expect(tail?.samples).toHaveLength(2);
    expect(tail?.samples.at(-1)?.at).toBe("2026-11-18T00:04:00.000Z");
  });

  test("probeDaemon4020Status surfaces parsed auth sources from /health", async () => {
    const fixedNow = new Date("2026-11-18T00:00:00.000Z");
    const healthBody = {
      operationalStatus: "degraded",
      degradedReasons: [{ message: "GSLive session expired" }],
      checks: {
        auth: {
          f402: { status: "ok", source: "session-file" },
          gslive: {
            status: "expired",
            source: "keychain",
            remediation: "printf '%s' '<GSID>' | bun run secrets:gslive set",
          },
        },
      },
    };

    const ok = await probeDaemon4020Status({
      fetchImpl: async () => Response.json(healthBody),
      now: () => fixedNow,
    });
    expect(ok.state).toBe("degraded");
    expect(ok.auth?.f402).toEqual({
      status: "ok",
      source: "session-file",
      remediation: null,
    });
    expect(ok.auth?.gslive?.status).toBe("expired");
    expect(ok.auth?.gslive?.remediation).toContain("secrets:gslive");

    // A 503 auth-down daemon still reports its parsed auth sources.
    const down = await probeDaemon4020Status({
      fetchImpl: async () => Response.json(healthBody, { status: 503 }),
      now: () => fixedNow,
    });
    expect(down.online).toBe(true);
    expect(down.auth?.gslive?.status).toBe("expired");

    // Older /health shapes keep sources.auth; a malformed source is null, not "ok".
    const fallback = await probeDaemon4020Status({
      fetchImpl: async () =>
        Response.json({
          sources: { auth: { f402: { status: "ok" }, gslive: "bad-shape" } },
        }),
      now: () => fixedNow,
    });
    expect(fallback.auth?.f402).toEqual({
      status: "ok",
      source: null,
      remediation: null,
    });
    expect(fallback.auth?.gslive).toBeNull();
  });

  test("a cached probe does not duplicate a sample", async () => {
    const clock = makeClock("2026-11-18T00:00:00.000Z");
    const service = createR2PipelineService({
      fetchImpl: makeSinkFetcher(clock, { "f402-bet-ticker": 300 }),
      now: clock.now,
      cacheTtlMs: 60_000,
      historyLimit: 10,
      historyMinIntervalSeconds: 0,
    });

    await service.probeAll({ refresh: true });
    clock.advanceSeconds(5);
    await service.probeAll(); // served from cache
    const series = (await service.getHistory()).sinks.find(
      (sink) => sink.id === "f402-bet-ticker",
    );
    expect(series?.sampleCount).toBe(1);
  });
});

interface Clock {
  readonly now: () => Date;
  advanceSeconds: (seconds: number) => void;
}

function makeClock(iso: string): Clock {
  let nowMs = Date.parse(iso);
  return {
    now: () => new Date(nowMs),
    advanceSeconds: (seconds) => {
      nowMs += seconds * 1000;
    },
  };
}

function makeSinkFetcher(
  clock: Clock,
  agesBySink: Readonly<Record<string, number>>,
): (url: string) => Promise<Response> {
  return async (url: string): Promise<Response> => {
    if (url.startsWith("http://127.0.0.1:4020/")) {
      return Response.json({ operationalStatus: "ok" });
    }
    const sinkId = Object.keys(agesBySink).find((id) =>
      url.endsWith(`/${id}/latest.json`),
    );
    if (sinkId === undefined) return new Response(null, { status: 404 });
    const modifiedMs = clock.now().getTime() - agesBySink[sinkId]! * 1000;
    return new Response(
      JSON.stringify({ generatedAt: new Date(modifiedMs).toISOString() }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Last-Modified": new Date(modifiedMs).toUTCString(),
        },
      },
    );
  };
}
