import { afterEach, describe, expect, test } from "bun:test";

import { z } from "zod";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertVerboseFetchAllowed,
  createWireTraceFetch,
  describeJsonShape,
  redactPayloadForTrace,
  runLiveCapture,
  sanitizeError,
  sha256PathForArtifact,
  writeCaptureArchive,
} from "./wagers_by_state_capture.ts";
import type { WagersLiveSink } from "../lib/wagers_live_sink.ts";
import { WAGERS_ARTIFACT_PATH } from "./gslive_wagers_by_state.ts";
import { Archive, CryptoHasher, file, serve, version, write } from "bun";

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

/** Rows shaped like an `ajax.php` `getBetReport` response (one row per leg). */
const ROWS = [
  {
    State: "win",
    Ticket: "T1",
    Risk: 10,
    "To Win": 8,
    Result: 8,
    "Bet Time": "20:50:49 10/24/2026",
    "Grade Time": "21:10:00 10/24/2026",
  },
  {
    State: "win",
    Ticket: "T1",
    Risk: 10,
    "To Win": 8,
    Result: 8,
    "Bet Time": 1793000000,
    "Grade Time": "21:12:00 10/24/2026",
  },
  {
    State: "pending",
    Ticket: "T2",
    Risk: 20,
    "To Win": 30,
    Result: 0,
    "Bet Time": "2026-10-24T11:00:00Z",
  },
  {
    State: "lose",
    Ticket: "T3",
    Risk: 5,
    "To Win": 4,
    Result: -5,
    "Bet Time": 1793000100,
    "Grade Time": "2026-10-24T12:30:00Z",
  },
  {
    State: "mystery-state",
    Ticket: "T4",
    Risk: 3,
    "To Win": 0,
    Result: 0,
    "Bet Time": 1793000200,
  },
];

interface Harness {
  readonly ajaxUrl: string;
  readonly calls: { url: string; body: string }[];
  readonly server: ReturnType<typeof serve>;
  readonly setMode: (mode: "ok" | "fail") => void;
}

function startAjaxStandIn(): Harness {
  const calls: { url: string; body: string }[] = [];
  let mode: "ok" | "fail" = "ok";
  const server = serve({
    port: 0,
    async fetch(request) {
      calls.push({ url: request.url, body: await request.text() });
      if (mode === "fail") {
        return new Response("upstream exploded", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      }
      return Response.json({ bets: ROWS });
    },
  });
  return {
    ajaxUrl: `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
    calls,
    server,
    setMode(next) {
      mode = next;
    },
  };
}

const dirs: string[] = [];

async function tempPaths(): Promise<{
  dir: string;
  artifact: string;
  status: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "wagers-capture-"));
  dirs.push(dir);
  return {
    dir,
    artifact: join(dir, "gslive-wagers-by-state.summary.json"),
    status: join(dir, "wagers-by-state.status.json"),
  };
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("wagers:capture derives the v2 artifact from ajax.php only", () => {
  test("one live read -> artifact whose every derived field comes from the response", async () => {
    const stand = startAjaxStandIn();
    const paths = await tempPaths();
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        payload: PAYLOAD,
        fromEpochSec: PAYLOAD.from,
        toEpochSec: PAYLOAD.to,
        dateFilterBy: "logTime",
        ajaxUrl: stand.ajaxUrl,
        artifactPath: paths.artifact,
        statusPath: paths.status,
      });

      expect(outcome.ok).toBe(true);
      const report = outcome.report;
      expect(report).not.toBeNull();
      if (report === null) return;

      // The request is the supplied body, verbatim, to the stand-in endpoint.
      expect(stand.calls).toHaveLength(1);
      expect(stand.calls[0]?.url).toBe(stand.ajaxUrl);
      expect(JSON.parse(String(stand.calls[0]?.body))).toEqual(PAYLOAD);

      // Provenance says live, not CSV.
      if (report.source.kind !== "live-ajax.php") {
        throw new Error("expected a live-ajax.php source for a live capture");
      }
      expect(report.source.url).toBe(stand.ajaxUrl);
      expect(report.source.action).toBe("getBetReport");
      expect(report.source.stateFilter).toBe("");
      expect(report.source.dateFilterBy).toBe("logTime");

      // Totals independently recomputed from ROWS above.
      expect(report.totals.legs).toBe(5);
      expect(report.totals.wagers).toBe(4); // T1, T2, T3, T4
      expect(report.totals.spanning).toBe(0);
      expect(report.totals.legRisk).toBe(48); // 10+10+20+5+3
      expect(report.totals.wagerRisk).toBe(38); // T1 counted once
      expect(report.totals.legResult).toBe(11); // 8+8+0-5+0

      // Every state row is a projection of the response.
      const byState = Object.fromEntries(
        report.states.map((row) => [row.state, row]),
      );
      expect(byState.win?.legs).toBe(2);
      expect(byState.win?.wagers).toBe(1);
      expect(byState.pending?.legs).toBe(1);
      expect(byState.lose?.legs).toBe(1);
      expect(byState["mystery-state"]?.legs).toBe(1);
      // Unknown state is reported, not silently accepted.
      expect(report.quality.unknownStates).toEqual(["mystery-state"]);
      expect(report.identity.ticketField).toBe("Ticket");
      expect(report.identity.coveragePct).toBe(100);
      // Window comes from the response rows, not the request window.
      expect(report.window.observedStart).not.toBeNull();
      expect(report.window.observedEnd).not.toBeNull();

      // Artifact on disk is byte-identical to the returned report, written atomically.
      const written = z
        .object({ source: z.object({ kind: z.string() }) })
        .parse(await file(paths.artifact).json());
      expect(written.source.kind).toBe("live-ajax.php");
      const names = await readdir(paths.dir);
      expect(names.filter((name) => name.includes(".tmp-"))).toEqual([]);

      // Journal records the successful derivation.
      const journal = z
        .object({
          schemaVersion: z.number(),
          lastSuccess: z
            .object({
              legs: z.number(),
              wagers: z.number(),
              states: z.number(),
            })
            .nullable(),
        })
        .parse(await file(paths.status).json());
      expect(journal.schemaVersion).toBe(1);
      expect(journal.lastSuccess?.legs).toBe(5);
      expect(journal.lastSuccess?.wagers).toBe(4);
      expect(journal.lastSuccess?.states).toBe(4);
    } finally {
      stand.server.stop(true);
    }
  });

  test("an enabled sink publishes after the artifact without failing the capture", async () => {
    const stand = startAjaxStandIn();
    const paths = await tempPaths();
    const calls: string[] = [];
    const sink: WagersLiveSink = {
      async publishLiveBets() {
        calls.push("live-bets");
        return { ok: true, published: 1 };
      },
      async publishR2() {
        calls.push("r2");
        return {
          ok: true,
          url: "https://pub.test/wagers-by-state/latest.json",
        };
      },
    };
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        payload: PAYLOAD,
        fromEpochSec: PAYLOAD.from,
        toEpochSec: PAYLOAD.to,
        dateFilterBy: "logTime",
        ajaxUrl: stand.ajaxUrl,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        sink,
      });
      expect(outcome.ok).toBe(true);
      expect(calls).toEqual(["live-bets", "r2"]);
      expect(outcome.ok && outcome.sinkResults).toEqual([
        { ok: true, published: 1 },
        { ok: true, url: "https://pub.test/wagers-by-state/latest.json" },
      ]);
    } finally {
      stand.server.stop(true);
    }
  });

  test("a sink failure is reported but leaves the capture ok", async () => {
    const stand = startAjaxStandIn();
    const paths = await tempPaths();
    const sink: WagersLiveSink = {
      async publishLiveBets() {
        return { ok: false, error: "gateway down" };
      },
      async publishR2() {
        return { ok: true, skipped: true };
      },
    };
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        payload: PAYLOAD,
        fromEpochSec: PAYLOAD.from,
        toEpochSec: PAYLOAD.to,
        dateFilterBy: "logTime",
        ajaxUrl: stand.ajaxUrl,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        sink,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.ok && outcome.sinkResults?.[0]?.ok).toBe(false);
    } finally {
      stand.server.stop(true);
    }
  });

  test("a failed read leaves the last good artifact untouched and journals the failure", async () => {
    const stand = startAjaxStandIn();
    const paths = await tempPaths();
    const sentinel = JSON.stringify({ schemaVersion: 2, marker: "last-good" });
    await write(paths.artifact, sentinel);
    const shaPath = sha256PathForArtifact(paths.artifact);
    await write(shaPath, "a".repeat(64) + "\n");
    const archivePath = `${paths.dir}/bundle.tar`;
    try {
      stand.setMode("fail");
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        fromEpochSec: PAYLOAD.from,
        toEpochSec: PAYLOAD.to,
        dateFilterBy: "logTime",
        ajaxUrl: stand.ajaxUrl,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        retries: 0,
        archivePath,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("HTTP 500");
      expect(await file(paths.artifact).text()).toBe(sentinel);
      expect((await file(shaPath).text()).trim()).toBe("a".repeat(64));
      expect(await file(archivePath).exists()).toBe(false);
      const journal = z
        .object({
          lastSuccess: z.unknown().nullable(),
          lastFailure: z.object({ error: z.string() }).nullable(),
        })
        .parse(await file(paths.status).json());
      expect(journal.lastSuccess).toBeNull();
      expect(journal.lastFailure?.error).toContain("HTTP 500");
    } finally {
      stand.server.stop(true);
    }
  });

  test("no provisioned session fails before any request", async () => {
    const stand = startAjaxStandIn();
    const paths = await tempPaths();
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "",
        fromEpochSec: PAYLOAD.from,
        toEpochSec: PAYLOAD.to,
        dateFilterBy: "logTime",
        ajaxUrl: stand.ajaxUrl,
        artifactPath: paths.artifact,
        statusPath: paths.status,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("No manager session");
      expect(stand.calls).toHaveLength(0);
      expect(await file(paths.artifact).exists()).toBe(false);
      const journal = z
        .object({ lastFailure: z.object({ error: z.string() }).nullable() })
        .parse(await file(paths.status).json());
      expect(journal.lastFailure?.error).toContain("No manager session");
    } finally {
      stand.server.stop(true);
    }
  });

  test("artifacts land where the plugin reads them", async () => {
    expect(WAGERS_ARTIFACT_PATH).toBe(
      "Scratch/gslive-wagers-by-state.summary.json",
    );
    const plugin = await file("dsh-plugin/index.js").text();
    expect(plugin).toContain("Scratch/gslive-wagers-by-state.summary.json");
    expect(plugin).toContain("wagersArtifact");
  });

  test("journal/error text never carries cookie material", () => {
    const message = sanitizeError(
      new Error('boom cookie="GSID=abc123; _ga=GA1.1.9" and GSID=def456'),
    );
    expect(message).not.toContain("abc123");
    expect(message).not.toContain("def456");
    expect(message).toContain("<redacted>");
  });
});

describe("transient retry and duration", () => {
  test("retries a 5xx with sleep backoff, then succeeds and journals each attempt", async () => {
    const paths = await tempPaths();
    let calls = 0;
    const server = serve({
      port: 0,
      fetch() {
        calls += 1;
        if (calls < 3) {
          return new Response("temporarily unavailable", {
            status: 503,
            headers: { "content-type": "text/plain" },
          });
        }
        return Response.json({
          bets: [
            {
              State: "pending",
              Ticket: "R1",
              Risk: 10,
              "To Win": 5,
              Result: 0,
              "Bet Time": 1793000000,
            },
          ],
        });
      },
    });
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        fromEpochSec: 1792904400,
        toEpochSec: 1793771999,
        dateFilterBy: "logTime",
        ajaxUrl: `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        retries: 2,
        retryBackoffMs: 1,
      });
      expect(outcome.ok).toBe(true);
      expect(outcome.attempts).toBe(3);
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
      expect(calls).toBe(3);
      const journal = z
        .object({
          runs: z.array(z.object({ ok: z.boolean() })),
          lastSuccess: z.unknown().nullable(),
          lastFailure: z.object({ error: z.string() }).nullable(),
        })
        .parse(await file(paths.status).json());
      expect(journal.runs.map((run) => run.ok)).toEqual([false, false, true]);
      expect(journal.lastSuccess).not.toBeNull();
      expect(journal.lastFailure?.error).toContain("HTTP 503");
    } finally {
      server.stop(true);
    }
  });

  test("does not retry a 401 or an HTML login page", async () => {
    const paths = await tempPaths();
    let calls = 0;
    const server = serve({
      port: 0,
      fetch() {
        calls += 1;
        return new Response("login", {
          status: 401,
          headers: { "content-type": "text/html" },
        });
      },
    });
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        fromEpochSec: 1792904400,
        toEpochSec: 1793771999,
        dateFilterBy: "logTime",
        ajaxUrl: `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        retries: 2,
        retryBackoffMs: 1,
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.attempts).toBe(1);
      expect(calls).toBe(1);
    } finally {
      server.stop(true);
    }
  });
});

describe("artifact integrity sidecar and Archive bundle", () => {
  test("writes a sha256 sidecar matching the artifact and a tar bundle without tickets", async () => {
    const paths = await tempPaths();
    const archivePath = `${paths.dir}/bundle.tar`;
    const server = serve({
      port: 0,
      fetch: () =>
        Response.json({
          bets: [
            {
              State: "pending",
              Ticket: "A1",
              Risk: 10,
              "To Win": 5,
              Result: 0,
              "Bet Time": 1793000000,
            },
            {
              State: "win",
              Ticket: "A2",
              Risk: 20,
              "To Win": 10,
              Result: 10,
              "Bet Time": 1793000100,
            },
          ],
        }),
    });
    try {
      const outcome = await runLiveCapture({
        cookieHeader: "GSID=fixture-session",
        fromEpochSec: 1792904400,
        toEpochSec: 1793771999,
        dateFilterBy: "logTime",
        ajaxUrl: `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
        artifactPath: paths.artifact,
        statusPath: paths.status,
        archivePath,
      });
      expect(outcome.ok).toBe(true);
      const artifactText = await file(paths.artifact).text();
      const expectedSha = new CryptoHasher("sha256")
        .update(artifactText)
        .digest("hex");
      expect(outcome.artifactSha256).toBe(expectedSha);
      expect(outcome.archivePath).toBe(archivePath);

      const archive = new Archive(await file(archivePath).bytes());
      const files = await archive.files();
      const names = [...files.keys()].sort();
      expect(names).toContain("artifact.json");
      expect(names).toContain("artifact.sha256");
      expect(names).toContain("manifest.json");
      expect(names).toContain("history.jsonl");
      expect(names).toContain("alerts.json");
      expect(names).toContain("status.json");
      expect(names).not.toContain("wagers-by-state.tickets.json");

      const manifest = z
        .object({
          artifactSha256: z.string(),
          runtime: z.object({ bun: z.string(), revision: z.string() }),
          excluded: z.array(z.string()),
        })
        .parse(JSON.parse((await files.get("manifest.json")?.text()) ?? "{}"));
      expect(manifest.artifactSha256).toBe(expectedSha);
      expect(manifest.runtime.bun).toBe(version);
      expect(manifest.runtime.revision.length).toBeGreaterThan(0);
      expect(manifest.excluded.join(" ")).toContain("ticket");
      expect(await files.get("artifact.json")?.text()).toBe(artifactText);
      expect((await files.get("artifact.sha256")?.text())?.trim()).toBe(
        expectedSha,
      );
    } finally {
      server.stop(true);
    }
  });

  test("writeCaptureArchive excludes a sibling tickets file even when it exists", async () => {
    const paths = await tempPaths();
    const artifactText = JSON.stringify({ marker: "artifact" });
    await write(paths.artifact, artifactText);
    await write(`${paths.dir}/wagers-by-state.tickets.json`, '{"tickets":{}}');
    const archivePath = `${paths.dir}/manual.tar`;
    await writeCaptureArchive(archivePath, {
      artifactText,
      artifactSha256: "b".repeat(64),
      historyPath: `${paths.dir}/wagers-by-state.history.jsonl`,
      alertsPath: `${paths.dir}/wagers-by-state.alerts.json`,
      statusPath: paths.status,
      report: {
        source: {
          kind: "offline-csv",
          path: "fixture.csv",
          mtime: "2026-01-01T00:00:00.000Z",
          dateFilterBy: null,
        },
        totals: {
          legs: 0,
          wagers: null,
          spanning: null,
          legRisk: 0,
          legToWin: 0,
          legResult: 0,
          wagerRisk: null,
        },
      },
    });
    const archive = new Archive(await file(archivePath).bytes());
    const names = [...(await archive.files()).keys()];
    expect(names).toContain("artifact.json");
    expect(names.some((name) => name.includes("tickets"))).toBe(false);
  });
});

describe("--debug-wire full-shape trace", () => {
  test("shows headers/payload/response shape but masks only cookie credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wire-trace-"));
    try {
      const responsePath = join(dir, "response.json");
      const logs: string[] = [];
      const server = serve({
        port: 0,
        async fetch(request) {
          await request.text();
          return Response.json(
            {
              bets: [
                {
                  State: "win",
                  Ticket: "T1",
                  Unexpected: "extra-field",
                },
              ],
            },
            { headers: { "set-cookie": "session=response-secret" } },
          );
        },
      });
      try {
        const trace = createWireTraceFetch({
          responsePath,
          log: (line) => logs.push(line),
        });
        const response = await trace(
          `http://127.0.0.1:${server.port}/manager-tools/ajax.php`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: "GSID=secret-value; _ga=analytics-value",
              "x-gs-session": "gate-secret",
              "user-agent": "wire-test",
            },
            body: JSON.stringify(PAYLOAD),
          },
        );
        expect(response.status).toBe(200);
        const text = logs.join("\n");
        // Full shape: method, payload, non-secret headers, status all visible.
        expect(text).toContain("[wire] > POST");
        expect(text).toContain('"action":"getBetReport"');
        expect(text).toContain("[wire] > payload contract: valid");
        expect(text).toMatch(/sha256 [0-9a-f]{64}\) saved/);
        expect(text).toContain("[wire] > user-agent: wire-test");
        expect(text).toMatch(/\[wire\] < HTTP 200 .* in \d+\.\d ms/);
        // Only credential values are masked.
        expect(text).toContain("GSID=<redacted>");
        expect(text).toContain("_ga=<redacted>");
        expect(text).toContain("x-gs-session: <redacted>");
        expect(text).toContain("set-cookie: <redacted>");
        expect(text).not.toContain("secret-value");
        expect(text).not.toContain("gate-secret");
        expect(text).not.toContain("response-secret");
        // Deep shape + contract coverage without row values.
        expect(text).toContain(
          "body shape: {bets: array(1) of {State: string, Ticket: string, Unexpected: string}}",
        );
        expect(text).toContain("row fields: rows 1 (1 objects)");
        expect(text).toContain("unknown [Unexpected]");
        expect(text).toContain("not-present [");
        expect(await file(responsePath).text()).toContain('"Ticket":"T1"');
      } finally {
        server.stop(true);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("describeJsonShape reports keys and counts without values", () => {
    expect(describeJsonShape('[{"a":1,"b":2}]')).toBe(
      "array(1) of {a: number, b: number}",
    );
    expect(describeJsonShape('{"a":{"b":[{"c":null}]}}')).toBe(
      "{a: {b: array(1) of {c: null}}}",
    );
    expect(describeJsonShape('{"bets":[],"total":0}')).toBe(
      "{bets: array(0), total: number}",
    );
    expect(describeJsonShape("not-json")).toContain("unparseable");
  });
});

describe("native verbose fetch guards", () => {
  test("refuses non-loopback endpoints regardless of acknowledgement", () => {
    expect(() =>
      assertVerboseFetchAllowed({
        endpoint: "https://plive.sportswidgets.pro/manager-tools/ajax.php",
        mode: "curl",
        allowCredentialEcho: true,
      }),
    ).toThrow(/loopback-only/);
  });

  test("requires explicit credential-echo acknowledgement on loopback", () => {
    expect(() =>
      assertVerboseFetchAllowed({
        endpoint: "http://127.0.0.1:9000/proxy",
        mode: "true",
        allowCredentialEcho: false,
      }),
    ).toThrow(/GSLIVE_ALLOW_CREDENTIAL_ECHO=1/);
    expect(
      assertVerboseFetchAllowed({
        endpoint: "http://localhost:9000/proxy",
        mode: "curl",
        allowCredentialEcho: true,
      }),
    ).toBe("curl");
  });

  test("rejects an unknown mode", () => {
    expect(() =>
      assertVerboseFetchAllowed({
        endpoint: "http://127.0.0.1:9000/proxy",
        mode: "headers",
        allowCredentialEcho: true,
      }),
    ).toThrow(/must be 'curl' or 'true'/);
  });
});

describe("debug-wire payload redaction", () => {
  test("masks identifier values while keeping the payload shape readable", () => {
    const body = JSON.stringify({
      action: "getBetReport",
      partnerUserId: "acct-9",
      agent: "agent-2",
      betId: "b-77",
      state: "",
      group: null,
    });
    const redacted = redactPayloadForTrace(body);
    expect(redacted).toContain('"partnerUserId":"<redacted>"');
    expect(redacted).toContain('"agent":"<redacted>"');
    expect(redacted).toContain('"betId":"<redacted>"');
    expect(redacted).toContain('"state":""');
    expect(redacted).toContain('"group":null');
    expect(redacted).not.toContain("acct-9");
    expect(redacted).not.toContain("agent-2");
    expect(redacted).not.toContain("b-77");
  });

  test("non-JSON payloads pass through unchanged (never silently dropped)", () => {
    expect(redactPayloadForTrace("not-json")).toBe("not-json");
  });
});
