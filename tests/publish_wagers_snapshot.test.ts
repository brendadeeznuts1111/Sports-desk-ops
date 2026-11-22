import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const old = "2026-01-01T00:00:00.000Z";

function dryRun(source: Record<string, unknown>, observedEnd: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "wager-clock-"));
  try {
    const path = join(dir, "summary.json");
    writeFileSync(path, JSON.stringify({ source, window: { observedEnd } }));
    return Bun.spawnSync([
      process.execPath,
      "--no-env-file",
      "scripts/publish_wagers_snapshot.ts",
      "--dry-run",
      "--from",
      path,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("current live reads preserve the separate activity window, including an empty book", () => {
  const capturedAt = new Date().toISOString();
  const toEpochSec = Math.floor(Date.parse(capturedAt) / 1000);
  for (const observedEnd of [old, null]) {
    const result = dryRun(
      { kind: "live-ajax.php", capturedAt, toEpochSec },
      observedEnd,
    );
    expect(result.exitCode).toBe(0);
    const { payload } = JSON.parse(result.stdout.toString());
    expect(payload.capturedAt).toBe(capturedAt);
    expect(payload.window.observedEnd).toBe(observedEnd);
    expect(payload.staleness.stale).toBe(false);
  }
  const historical = dryRun(
    { kind: "live-ajax.php", capturedAt, toEpochSec: Date.parse(old) / 1000 },
    old,
  );
  expect(JSON.parse(historical.stdout.toString()).payload.staleness.stale).toBe(
    true,
  );
});

test("live reports require source evidence; offline reports retain their observed clock", () => {
  expect(dryRun({ kind: "live-ajax.php" }, old).exitCode).toBe(1);
  expect(dryRun({ kind: "live-ajax.php", capturedAt: old }, old).exitCode).toBe(
    1,
  );
  const offline = dryRun({ kind: "offline-csv" }, old);
  expect(offline.exitCode).toBe(0);
  expect(JSON.parse(offline.stdout.toString()).payload.capturedAt).toBe(old);
});
