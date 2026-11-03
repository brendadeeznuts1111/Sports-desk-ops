import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  artifactSpecFor,
  artifactTextFor,
  buildCaptureRequest,
  isUsableCapture,
  liveCapturePlan,
  liveOperationPath,
  measuredRows,
  mergeCaptureHealth,
  pasteArtifactPlan,
  probeOpFor,
  readCaptureHealth,
  REPO_LIVE_ARTIFACTS,
  runCapturePlan,
  validatePaste,
  writeCaptureHealth,
  type CaptureHttpResponse,
  type LiveCaptureHealth,
  type LiveCaptureSource,
} from "./live_capture.ts";

const pendingBody = JSON.stringify({
  Pending: [
    {
      TicketNumber: 1072983884,
      WagerNumber: 1,
      customerID: "TESTCUST",
      WagerStatus: "P",
      Outcome: "P",
      WagerType: "S",
      AmountWagered: 6500,
      ToWinAmount: 6500,
      Description: "Soccer #200153 Arsenal PK -110 - For Game",
    },
  ],
});

const tickerBody = JSON.stringify({
  LIST: [{ Login: "TESTAGENT", WagerNumber: 1, Risk: 100 }],
});

function tmpDir(label: string): string {
  return join(tmpdir(), `live-capture-${label}-${Date.now()}-${Math.random()}`);
}

function captured(response: CaptureHttpResponse) {
  return async (): Promise<CaptureHttpResponse> => response;
}

function sourceOf(operation: string): LiveCaptureSource {
  const source = liveCapturePlan({ only: [operation] })[0];
  if (source === undefined) throw new Error(`no source for ${operation}`);
  return source;
}

describe("liveCapturePlan", () => {
  test("puts the artifact builders first and keeps every operation unique", () => {
    const plan = liveCapturePlan();
    expect(plan.length).toBeGreaterThan(2);
    const operations = plan.map((source) => source.operation);
    expect(new Set(operations).size).toBe(operations.length);
    expect(plan[0]?.builder).not.toBe("raw");
    expect(plan[0]?.builder).not.toBe("raw");
    const pending = plan.find((source) => source.operation === "Pending");
    expect(pending?.artifact).toBe("data/live-bets.json");
    expect(pending?.needsCustomer).toBe(true);
    const ticker = plan.find((source) => source.operation === "getBetTicker");
    expect(ticker?.artifact).toBe("data/live-wagers.json");
    expect(ticker?.needsCustomer).toBe(false);
    for (const source of plan) {
      expect(probeOpFor(source.operation)?.readOnly).toBe(true);
    }
  });

  test("includes every read-only probe operation, and --only narrows it", () => {
    const all = liveCapturePlan();
    const artifactSources = liveCapturePlan({ includeRaw: false });
    expect(artifactSources.every((source) => source.builder !== "raw")).toBe(
      true,
    );
    expect(artifactSources.length).toBe(2);
    expect(all.length).toBeGreaterThan(artifactSources.length);
    const narrowed = liveCapturePlan({ only: ["Pending"] });
    expect(narrowed.map((source) => source.operation)).toEqual(["Pending"]);
  });
});

describe("buildCaptureRequest", () => {
  test("encodes the observed wire body for each operation", () => {
    const pendingOp = probeOpFor("Pending");
    const tickerOp = probeOpFor("getBetTicker");
    if (pendingOp === null || tickerOp === null) throw new Error("op missing");

    const pending = buildCaptureRequest(pendingOp, {
      base: "https://fantasy402.com",
      agentId: "BILLY666",
      customerId: "H1716",
    });
    expect(pending.url).toBe("https://fantasy402.com/cloud/api/Report/Pending");
    expect(pending.contentType).toContain("x-www-form-urlencoded");
    expect(pending.body).toContain("customerID=H1716");
    expect(pending.body).toContain("operation=Pending");
    expect(liveOperationPath(pendingOp)).toBe("/cloud/api/Report/Pending");

    const ticker = buildCaptureRequest(tickerOp, {
      base: "https://fantasy402.com",
      agentId: "BILLY666",
      customerId: "H1716",
    });
    expect(ticker.url).toBe(
      "https://fantasy402.com/cloud/api/Manager/getBetTicker",
    );
    expect(ticker.body).toContain("wagerNumber=0");
    expect(ticker.body).toContain("agentOwner=BILLY666");
  });
});

describe("payload guards", () => {
  test("counts rows per source shape", () => {
    expect(measuredRows(sourceOf("Pending"), pendingBody)).toBe(1);
    expect(measuredRows(sourceOf("getBetTicker"), tickerBody)).toBe(1);
    expect(measuredRows(sourceOf("Pending"), "<html>login</html>")).toBeNull();
  });

  test("empty artifact payload is not usable; parseable raw payload is", () => {
    expect(isUsableCapture(sourceOf("Pending"), pendingBody)).toBe(true);
    expect(isUsableCapture(sourceOf("Pending"), '{"Pending":[]}')).toBe(false);
    expect(isUsableCapture(sourceOf("getBetTicker"), '{"LIST":[]}')).toBe(
      false,
    );
    const raw = liveCapturePlan().find((source) => source.builder === "raw");
    if (raw === undefined) throw new Error("no raw source");
    expect(isUsableCapture(raw, '{"ok":true}')).toBe(true);
    expect(isUsableCapture(raw, "not json")).toBe(false);
  });

  test("builds the artifact text the builder functions return", () => {
    const text = artifactTextFor(
      sourceOf("Pending"),
      pendingBody,
      "2026-11-03T00:00:00.000Z",
    );
    expect(text).not.toBeNull();
    const artifact = JSON.parse(text as string) as {
      pendingCount: number;
      capturedAt: string;
      dataSource: string;
    };
    expect(artifact.pendingCount).toBe(1);
    expect(artifact.capturedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(artifact.dataSource).toContain("/cloud/api/Report/Pending");
  });
});

describe("runCapturePlan", () => {
  test("captures Pending and writes the artifact and raw body", async () => {
    const dir = tmpDir("pending");
    const artifactPath = join(dir, "live-bets.json");
    const rawPath = join(dir, "Pending.raw.json");
    const writes: { path: string; text: string }[] = [];
    const records = await runCapturePlan([sourceOf("Pending")], {
      transport: "test",
      request: captured({ status: 200, body: pendingBody }),
      async writeArtifact(_source, text) {
        writes.push({ path: artifactPath, text });
        await Bun.write(artifactPath, text);
      },
      async writeRaw(_source, body) {
        await Bun.write(rawPath, body);
      },
      async artifactExists() {
        return Bun.file(artifactPath).exists();
      },
      now: () => new Date("2026-11-03T00:00:00.000Z"),
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.outcome).toBe("captured");
    expect(records[0]?.rows).toBe(1);
    expect(records[0]?.artifactWritten).toBe(true);
    expect(records[0]?.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(writes).toHaveLength(1);
    expect(await Bun.file(rawPath).exists()).toBe(true);
    const artifact = (await Bun.file(artifactPath).json()) as {
      pendingCount: number;
    };
    expect(artifact.pendingCount).toBe(1);
  });

  test("an empty 2xx payload never overwrites the previous artifact", async () => {
    const dir = tmpDir("empty");
    const artifactPath = join(dir, "live-bets.json");
    await Bun.write(artifactPath, '{"pendingCount":7}\n');
    let artifactWrites = 0;
    const records = await runCapturePlan([sourceOf("Pending")], {
      transport: "test",
      request: captured({ status: 200, body: '{"Pending":[]}' }),
      async writeArtifact() {
        artifactWrites += 1;
      },
      async artifactExists() {
        return Bun.file(artifactPath).exists();
      },
    });
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.error).toContain("empty or non-JSON payload");
    expect(records[0]?.keptPreviousArtifact).toBe(true);
    expect(records[0]?.artifactWritten).toBe(false);
    expect(artifactWrites).toBe(0);
    expect(
      (await Bun.file(artifactPath).json()) as { pendingCount: number },
    ).toEqual({ pendingCount: 7 });
  });

  test("a non-2xx response is a failure with the status recorded", async () => {
    const records = await runCapturePlan([sourceOf("getBetTicker")], {
      transport: "test",
      request: captured({ status: 500, body: "boom" }),
    });
    expect(records[0]?.outcome).toBe("failed");
    expect(records[0]?.httpStatus).toBe(500);
    expect(records[0]?.bytes).toBe(4);
    expect(records[0]?.error).toBe("HTTP 500");
  });

  test("captures the ticker into a complete (partial: false) artifact", async () => {
    const dir = tmpDir("ticker");
    const artifactPath = join(dir, "live-wagers.json");
    const records = await runCapturePlan([sourceOf("getBetTicker")], {
      transport: "test",
      request: captured({ status: 200, body: tickerBody }),
      async writeArtifact(_source, text) {
        await Bun.write(artifactPath, text);
      },
    });
    expect(records[0]?.outcome).toBe("captured");
    const artifact = (await Bun.file(artifactPath).json()) as {
      partial: boolean;
      LIST: unknown[];
    };
    expect(artifact.partial).toBe(false);
    expect(artifact.LIST).toHaveLength(1);
  });

  test("a raw source writes no artifact", async () => {
    const raw = liveCapturePlan().find((source) => source.builder === "raw");
    if (raw === undefined) throw new Error("no raw source");
    let artifactWrites = 0;
    let rawWrites = 0;
    const records = await runCapturePlan([raw], {
      transport: "test",
      request: captured({ status: 200, body: '{"ok":true}' }),
      async writeArtifact() {
        artifactWrites += 1;
      },
      async writeRaw() {
        rawWrites += 1;
      },
    });
    expect(records[0]?.outcome).toBe("captured");
    expect(records[0]?.artifactWritten).toBe(false);
    expect(artifactWrites).toBe(0);
    expect(rawWrites).toBe(1);
  });
});

describe("capture health", () => {
  test("a missing snapshot is null, not an empty health", async () => {
    const path = join(tmpDir("missing"), "capture-health.json");
    expect(await readCaptureHealth(path)).toBeNull();
  });

  test("writes, reads back and merges per source", async () => {
    const dir = tmpDir("health");
    const path = join(dir, "capture-health.json");
    const first = mergeCaptureHealth(
      null,
      [
        {
          source: "Pending",
          operation: "Pending",
          artifact: "data/live-bets.json",
          startedAt: "2026-11-03T00:00:00.000Z",
          finishedAt: "2026-11-03T00:00:01.000Z",
          outcome: "captured",
          transport: "test",
          httpStatus: 200,
          rows: 2,
          bytes: 1234,
          bodySha256: "a".repeat(64),
          artifactWritten: true,
          keptPreviousArtifact: false,
          error: null,
        },
      ],
      "2026-11-03T00:00:02.000Z",
      "test",
    );
    await writeCaptureHealth(path, first);
    const readBack = await readCaptureHealth(path);
    expect(readBack?.sources.Pending?.rows).toBe(2);

    const merged = mergeCaptureHealth(
      readBack,
      [
        {
          ...first.sources.Pending!,
          source: "getBetTicker",
          operation: "getBetTicker",
          rows: 5,
          outcome: "captured",
        },
      ],
      "2026-11-03T00:01:00.000Z",
      "test",
    );
    expect(Object.keys(merged.sources).sort()).toEqual([
      "Pending",
      "getBetTicker",
    ]);
    expect(merged.sources.Pending?.rows).toBe(2);
    expect(merged.sources.getBetTicker?.rows).toBe(5);
    expect(merged.updatedAt).toBe("2026-11-03T00:01:00.000Z");
  });

  test("a corrupt snapshot reads as null rather than throwing", async () => {
    const dir = tmpDir("corrupt");
    const path = join(dir, "capture-health.json");
    await Bun.write(path, "{not json");
    expect(await readCaptureHealth(path)).toBeNull();
    const wrongVersion = await Bun.write(
      path,
      JSON.stringify({ schemaVersion: 2 }),
    );
    expect(wrongVersion).toBeGreaterThan(0);
    expect(await readCaptureHealth(path)).toBeNull();
  });
});

describe("artifact provenance", () => {
  const repoRoot = join(import.meta.dir, "..");

  test("classifies every live artifact as api or paste, and each path exists", async () => {
    expect(REPO_LIVE_ARTIFACTS).toHaveLength(6);
    const names = REPO_LIVE_ARTIFACTS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    expect(
      REPO_LIVE_ARTIFACTS.filter((spec) => spec.capturePath === "api")
        .map((spec) => spec.name)
        .sort(),
    ).toEqual(["live-bets", "live-wagers"]);
    expect(
      REPO_LIVE_ARTIFACTS.filter((spec) => spec.capturePath === "paste"),
    ).toHaveLength(4);
    for (const spec of REPO_LIVE_ARTIFACTS) {
      expect(await Bun.file(join(repoRoot, spec.path)).exists()).toBe(true);
      if (spec.capturePath === "api") {
        expect(spec.operation).not.toBeNull();
        expect(spec.pasteInput).toBeNull();
      } else {
        expect(spec.operation).toBeNull();
        expect(spec.pasteInput).not.toBeNull();
        expect(spec.pasteFileName).not.toBeNull();
      }
    }
    expect(pasteArtifactPlan().map((spec) => spec.name)).toEqual([
      "scoreboard",
      "game-admin-board",
      "contests",
      "analysis-cp-baseball",
    ]);
    expect(pasteArtifactPlan({ only: ["contests"] })).toHaveLength(1);
  });

  test("the committed JSON pastes validate against their own readers", async () => {
    for (const name of [
      "scoreboard",
      "game-admin-board",
      "analysis-cp-baseball",
    ]) {
      const spec = artifactSpecFor(name);
      if (spec === null) throw new Error(`no spec for ${name}`);
      const text = await Bun.file(join(repoRoot, spec.path)).text();
      const validation = validatePaste(spec, text, "2026-11-01T22:00:00.000Z");
      expect(validation.ok).toBe(true);
      expect(validation.reason).toBeNull();
      expect(validation.records).toBeGreaterThan(0);
      expect(validation.observedAt).toBe("2026-11-01");
      expect(validation.artifactText).not.toBeNull();
    }
  });

  test("a paste without observedAt is refused", () => {
    const spec = artifactSpecFor("scoreboard");
    if (spec === null) throw new Error("no scoreboard spec");
    const validation = validatePaste(
      spec,
      JSON.stringify({ games: [] }),
      "2026-11-01T22:00:00.000Z",
    );
    expect(validation.ok).toBe(false);
    expect(String(validation.reason)).toContain("observedAt");
  });

  test("an empty or wrong-shape paste is refused with a reason", () => {
    const board = artifactSpecFor("game-admin-board");
    if (board === null) throw new Error("no board spec");
    expect(
      validatePaste(board, "", "2026-11-01T00:00:00.000Z").reason,
    ).toContain("empty");
    expect(
      validatePaste(board, "not json", "2026-11-01T00:00:00.000Z").reason,
    ).toContain("not valid JSON");
    const wrong = validatePaste(
      board,
      JSON.stringify({ observedAt: "2026-11-01", games: "nope" }),
      "2026-11-01T00:00:00.000Z",
    );
    expect(wrong.ok).toBe(false);
    expect(String(wrong.reason)).toContain("did not validate");
  });

  test("contests markup is extracted into a stamped artifact", () => {
    const spec = artifactSpecFor("contests");
    if (spec === null) throw new Error("no contests spec");
    const html =
      '<div data-group="FOOTBALL"><a data-param="{&quot;contestNum&quot;:5,&quot;type&quot;:&quot;NFL - Super Bowl&quot;}"></a></div>';
    const validation = validatePaste(spec, html, "2026-11-02T10:00:00.000Z");
    expect(validation.ok).toBe(true);
    expect(validation.records).toBe(1);
    expect(validation.observedAt).toBe("2026-11-02T10:00:00.000Z");
    const artifact = JSON.parse(validation.artifactText as string) as {
      schemaVersion: number;
      source: string;
      extractedAt: string;
      entries: unknown[];
    };
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.source).toBe("markup:contests.html");
    expect(artifact.extractedAt).toBe("2026-11-02T10:00:00.000Z");
    expect(artifact.entries).toHaveLength(1);
  });

  test("empty contests markup is refused", () => {
    const spec = artifactSpecFor("contests");
    if (spec === null) throw new Error("no contests spec");
    const validation = validatePaste(
      spec,
      "<div>no contests</div>",
      "2026-11-02T10:00:00.000Z",
    );
    expect(validation.ok).toBe(false);
    expect(String(validation.reason)).toContain("no contest entries");
  });
});

export type { LiveCaptureHealth };
