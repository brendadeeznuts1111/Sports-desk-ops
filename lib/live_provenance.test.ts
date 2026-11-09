import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeCaptureHealth, writeCaptureHealth } from "../lib/live_capture.ts";
import {
  persistLiveSnapshot,
  type LiveArtifactSnapshot,
  type PersistLiveOutcome,
} from "../lib/live_provenance.ts";

const NOW = new Date("2026-11-08T18:00:00.000Z");
const OBSERVED_AT = NOW.toISOString();
const ARTIFACT_TEXT = `{
  "schemaVersion": 1,
  "dataSource": "live:/cloud/api/Report/Pending@2026-11-08T18:00:00.000Z",
  "games": []
}
`;

/**
 * Module-private default throttle in `lib/live_provenance.ts` (not exported), the write instants
 * derived from it, and the wire counts the snapshots/health records carry.
 */
const DEFAULT_THROTTLE_MS = 60_000;
/** A write instant inside the throttle window (half the default). */
const INSIDE_THROTTLE_MS = DEFAULT_THROTTLE_MS / 2;
/** A small elapsed step; enough to tell a rewrite from the previous state. */
const ONE_SECOND_MS = 1_000;
const SNAPSHOT_ROWS = 2;
const CHANGED_SNAPSHOT_ROWS = SNAPSHOT_ROWS + 1;
const OTHER_SOURCE_ROWS = 300;
const OTHER_SOURCE_BYTES = 154_450;

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function snapshot(
  overrides: Partial<LiveArtifactSnapshot> = {},
): LiveArtifactSnapshot {
  return {
    source: "Pending",
    operation: "/cloud/api/Report/Pending",
    artifactPath: "data/live-bets.json",
    artifactText: ARTIFACT_TEXT,
    observedAt: OBSERVED_AT,
    transport: "injected-fetch",
    httpStatus: 200,
    rows: SNAPSHOT_ROWS,
    partial: false,
    ...overrides,
  };
}

function tmpRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), `live-provenance-${label}-`));
}

/** Narrow a write outcome so a test can read the fields the throttled variant lacks. */
function written(
  outcome: PersistLiveOutcome,
): Extract<PersistLiveOutcome, { wrote: true }> {
  if (!outcome.wrote) {
    throw new Error(`expected a write, got ${outcome.reason}`);
  }
  return outcome;
}

describe("persistLiveSnapshot", () => {
  test("first write creates the artifact and an api provenance record", async () => {
    const root = tmpRoot("first");
    try {
      const snap = snapshot();
      const outcome = written(
        await persistLiveSnapshot({ rootDir: root, snapshot: snap, now: NOW }),
      );

      expect(outcome.healthPath).toBe(join(root, "data/capture-health.json"));
      expect(outcome.artifactSha256).toBe(sha256Hex(ARTIFACT_TEXT));
      expect(outcome.state).toEqual({
        artifactPath: "data/live-bets.json",
        at: NOW.getTime(),
        sha256: outcome.artifactSha256,
      });

      // The artifact bytes are exactly what the caller built.
      expect(readFileSync(join(root, "data/live-bets.json"), "utf8")).toBe(
        ARTIFACT_TEXT,
      );

      const health = JSON.parse(readFileSync(outcome.healthPath, "utf8"));
      expect(health.schemaVersion).toBe(1);
      expect(health.updatedAt).toBe(OBSERVED_AT);
      expect(health.transport).toBe("injected-fetch");
      expect(health.sources.Pending).toMatchObject({
        source: "Pending",
        operation: "/cloud/api/Report/Pending",
        artifact: "data/live-bets.json",
        startedAt: OBSERVED_AT,
        finishedAt: OBSERVED_AT,
        outcome: "captured",
        transport: "injected-fetch",
        httpStatus: 200,
        rows: SNAPSHOT_ROWS,
        bytes: ARTIFACT_TEXT.length,
        bodySha256: sha256Hex(ARTIFACT_TEXT),
        artifactWritten: true,
        keptPreviousArtifact: false,
        error: null,
        provenanceClass: "api",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merge preserves an existing other-source record", async () => {
    const root = tmpRoot("merge");
    try {
      const healthPath = join(root, "data/capture-health.json");
      mkdirSync(join(root, "data"), { recursive: true });
      await writeCaptureHealth(
        healthPath,
        mergeCaptureHealth(
          null,
          [
            {
              source: "getBetTicker",
              operation: "getBetTicker",
              artifact: "data/live-wagers.json",
              startedAt: "2026-11-07T00:00:00.000Z",
              finishedAt: "2026-11-07T00:00:01.000Z",
              outcome: "captured",
              transport: "session-file",
              httpStatus: 200,
              rows: OTHER_SOURCE_ROWS,
              bytes: OTHER_SOURCE_BYTES,
              bodySha256: "a".repeat(64),
              artifactWritten: true,
              keptPreviousArtifact: false,
              error: null,
              provenanceClass: "api",
            },
          ],
          "2026-11-07T00:00:01.000Z",
          "session-file",
        ),
      );

      const outcome = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
        }),
      );

      const health = JSON.parse(readFileSync(outcome.healthPath, "utf8"));
      expect(health.updatedAt).toBe(OBSERVED_AT);
      expect(health.transport).toBe("injected-fetch");
      expect(Object.keys(health.sources).sort()).toEqual([
        "Pending",
        "getBetTicker",
      ]);
      // The other source's record is untouched by this write.
      expect(health.sources.getBetTicker).toMatchObject({
        rows: OTHER_SOURCE_ROWS,
        bytes: OTHER_SOURCE_BYTES,
        transport: "session-file",
        provenanceClass: "api",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unchanged artifact inside the throttle is not rewritten", async () => {
    const root = tmpRoot("throttle");
    try {
      const first = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
        }),
      );
      const artifactPath = join(root, "data/live-bets.json");
      const before = statSync(artifactPath).mtimeMs;

      const second = await persistLiveSnapshot({
        rootDir: root,
        snapshot: snapshot(),
        now: new Date(NOW.getTime() + INSIDE_THROTTLE_MS),
        previous: first.state,
      });

      expect(second.wrote).toBe(false);
      if (second.wrote) throw new Error("expected a throttled outcome");
      expect(second.reason).toBe("throttled");
      expect(second.state).toEqual(first.state);
      expect(statSync(artifactPath).mtimeMs).toBe(before);
      expect(readFileSync(artifactPath, "utf8")).toBe(ARTIFACT_TEXT);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("changed bytes write even inside the throttle", async () => {
    const root = tmpRoot("changed");
    try {
      const first = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
        }),
      );
      const changed = `${ARTIFACT_TEXT}`.replace('"games": []', '"games": [1]');

      const second = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot({
            artifactText: changed,
            rows: CHANGED_SNAPSHOT_ROWS,
          }),
          now: new Date(NOW.getTime() + ONE_SECOND_MS),
          previous: first.state,
        }),
      );

      expect(second.artifactSha256).toBe(sha256Hex(changed));
      expect(second.artifactSha256).not.toBe(first.artifactSha256);
      expect(readFileSync(join(root, "data/live-bets.json"), "utf8")).toBe(
        changed,
      );
      const health = JSON.parse(readFileSync(second.healthPath, "utf8"));
      expect(health.sources.Pending.bytes).toBe(changed.length);
      expect(health.sources.Pending.bodySha256).toBe(sha256Hex(changed));
      expect(health.sources.Pending.rows).toBe(CHANGED_SNAPSHOT_ROWS);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unchanged bytes write once the throttle interval lapses", async () => {
    const root = tmpRoot("elapsed");
    try {
      const first = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
        }),
      );

      const second = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: new Date(NOW.getTime() + DEFAULT_THROTTLE_MS),
          previous: first.state,
        }),
      );

      expect(second.state.at).toBe(NOW.getTime() + DEFAULT_THROTTLE_MS);
      expect(second.state.sha256).toBe(first.state.sha256);
      expect(readFileSync(join(root, "data/live-bets.json"), "utf8")).toBe(
        ARTIFACT_TEXT,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("throttleMs 0 always writes", async () => {
    const root = tmpRoot("always");
    try {
      const first = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
          throttleMs: 0,
        }),
      );
      const second = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
          throttleMs: 0,
          previous: first.state,
        }),
      );

      expect(second.state.at).toBe(first.state.at);
      expect(second.state.sha256).toBe(first.state.sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the artifact write is atomic and leaves no temp file behind", async () => {
    const root = tmpRoot("atomic");
    try {
      written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: NOW,
        }),
      );

      const entries = readdirSync(join(root, "data")).sort();
      expect(entries).toEqual(["capture-health.json", "live-bets.json"]);
      expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a custom health path is resolved under rootDir", async () => {
    const root = tmpRoot("custom-health");
    try {
      const outcome = written(
        await persistLiveSnapshot({
          rootDir: root,
          healthPath: "reports/live-health.json",
          snapshot: snapshot(),
          now: NOW,
        }),
      );

      expect(outcome.healthPath).toBe(join(root, "reports/live-health.json"));
      const health = JSON.parse(readFileSync(outcome.healthPath, "utf8"));
      expect(health.sources.Pending.outcome).toBe("captured");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a previous state for another artifact does not throttle this one", async () => {
    const root = tmpRoot("other-artifact");
    try {
      const other = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot({
            source: "getBetTicker",
            operation: "getBetTicker",
            artifactPath: "data/live-wagers.json",
            artifactText: '{"schemaVersion":1,"source":"x","LIST":[]}\n',
          }),
          now: NOW,
        }),
      );

      const pending = written(
        await persistLiveSnapshot({
          rootDir: root,
          snapshot: snapshot(),
          now: new Date(NOW.getTime() + ONE_SECOND_MS),
          previous: other.state,
        }),
      );

      expect(pending.state.artifactPath).toBe("data/live-bets.json");
      expect(readFileSync(join(root, "data/live-bets.json"), "utf8")).toBe(
        ARTIFACT_TEXT,
      );
      expect(readFileSync(join(root, "data/live-wagers.json"), "utf8")).toBe(
        '{"schemaVersion":1,"source":"x","LIST":[]}\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
