#!/usr/bin/env bun
/** Probe: Bun.nanoseconds is a process-relative monotonic clock, not a timestamp source. */
const t0 = Bun.nanoseconds();
const wall0 = Date.now();
await Bun.sleep(25);
const t1 = Bun.nanoseconds();
const wall1 = Date.now();
const deltaMs = (t1 - t0) / 1e6;
const wallDeltaMs = wall1 - wall0;
const results = {
  monotonic: t1 > t0,
  deltaMs: Number(deltaMs.toFixed(3)),
  wallDeltaMs,
  magnitudeVsWallClock:
    t1 / 1e6 > 1e6 ? "process-relative (ms since start)" : String(t1),
  plausibleSleepDelta: deltaMs >= 20 && deltaMs < 200,
  wallClockAgreement: Math.abs(deltaMs - wallDeltaMs) < 50,
};
console.log(JSON.stringify(results, null, 2));
