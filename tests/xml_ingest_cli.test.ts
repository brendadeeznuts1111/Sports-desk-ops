import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProbe,
  endpointUrl,
  taxonomyCommand,
  describeStatus,
  probeDaemonEndpoint,
  statusCommand,
} from "../scripts/xml_ingest_cli.ts";

/**
 * `scripts/xml_ingest_cli.ts` is the operator surface for the canonical XML-ingest snapshot:
 * `status` answers why `GET /api/xml-odds/soa` is 502, `ingest` forwards to the shipped publisher
 * (including `--dry-run`), and `parse` forwards to the local parser. These pin the dispatch and
 * the one-line rendering; the publish path itself is covered by
 * `tests/xml_parse_sportsdesk_ops_cli.test.ts`.
 */

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "scripts", "xml_ingest_cli.ts");

function run(args: readonly string[]): {
  readonly code: number;
  readonly out: string;
  readonly err: string;
} {
  const result = Bun.spawnSync([process.execPath, "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  return {
    code: result.exitCode,
    out: result.stdout.toString(),
    err: result.stderr.toString(),
  };
}

describe("xml CLI dispatch", () => {
  test("help lists the three subcommands and --dry-run", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("./bin/dx xml status");
    expect(result.out).toContain("./bin/dx xml ingest");
    expect(result.out).toContain("./bin/dx xml parse");
    expect(result.out).toContain("--dry-run");
  });

  test("ingest forwards --help to the shipped publisher", () => {
    const result = run(["ingest", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("xml-parse — canonical XML ingest");
    expect(result.out).toContain("--dry-run");
  });

  test("an unknown subcommand is a usage error, not a silent success", () => {
    const result = run(["publish"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain('unknown subcommand "publish"');
  });

  test("status accepts only --json", () => {
    const result = run(["status", "--wat"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("unknown flag --wat");
  });
});

describe("describeStatus", () => {
  test("renders a published snapshot", () => {
    const line = describeStatus({
      available: true,
      payload: {
        rowCount: 3,
        watermarkCursor: "0:3",
        generatedAt: "2026-11-18T19:00:00.000Z",
        basis: "r2-xml-ingest",
      },
    });
    expect(line.ok).toBe(true);
    expect(line.summary).toContain("3 row(s)");
    expect(line.summary).toContain("watermark 0:3");
  });

  test("keeps the route's reason when nothing is published", () => {
    const line = describeStatus({
      available: false,
      reason: "R2 manifest manifests/xml-ingest/latest unavailable: HTTP 404",
    });
    expect(line.ok).toBe(false);
    expect(line.summary).toContain("HTTP 404");
  });
});

/** The daemon probe is the other half of "why is the panel empty"; these pin each answer. */
describe("probeDaemonEndpoint", () => {
  const base = "http://127.0.0.1:4020";

  test("200 means the route is serving rows", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: true, rowCount: 7 }),
    );
    expect(probe).toMatchObject({
      reachable: true,
      status: 200,
      kind: "serving",
    });
    expect(probe.detail).toContain("7 row");
  });

  test("a cached answer says so, and stays a serving probe", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: true, rowCount: 7, cached: true, stale: false }),
    );
    expect(probe).toMatchObject({
      kind: "serving",
      cached: true,
      stale: false,
    });
    expect(probe.detail).toBe("7 row(s), cached");
  });

  test("a stale answer names itself — the rows are the last good snapshot", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: true, rowCount: 7, cached: true, stale: true }),
    );
    expect(probe).toMatchObject({ kind: "serving", cached: true, stale: true });
    expect(probe.detail).toBe("7 row(s), cached, stale — last good snapshot");
    // The one line an operator reads must not present stale rows as current.
    expect(describeProbe(probe)).toContain("stale — last good snapshot");
  });

  test("a body without cache flags reads as a fresh read", async () => {
    // A daemon predating the route cache sends neither flag; guessing "cached" would be wrong.
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: true, rowCount: 7 }),
    );
    expect(probe).toMatchObject({ cached: false, stale: false });
    expect(probe.detail).toBe("7 row(s)");
  });

  test("non-boolean cache flags are not read as true", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: true, rowCount: 7, cached: "yes", stale: 1 }),
    );
    expect(probe).toMatchObject({ cached: false, stale: false });
    expect(probe.detail).toBe("7 row(s)");
  });

  test("502 means the route is live and the snapshot is missing", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json(
        {
          success: false,
          status: "unavailable",
          error: "R2 manifest … unavailable: HTTP 404",
        },
        { status: 502 },
      ),
    );
    expect(probe.kind).toBe("artifact-missing");
    expect(probe.detail).toContain("R2 manifest");
  });

  test("404 means this daemon build predates the route", async () => {
    const probe = await probeDaemonEndpoint(base, async () =>
      Response.json({ success: false, error: "Not Found" }, { status: 404 }),
    );
    expect(probe.kind).toBe("route-absent");
    expect(describeProbe(probe)).toContain("restart it");
  });

  test("a connection error is unreachable, not a throw", async () => {
    const probe = await probeDaemonEndpoint(base, async () => {
      throw new Error("Connection refused");
    });
    expect(probe.kind).toBe("unreachable");
    expect(describeProbe(probe)).toContain("unreachable");
  });

  test("the origin honours SPORTSDESK_DAEMON_URL and PORT", async () => {
    const seen: string[] = [];
    await statusCommand({
      json: true,
      env: { SPORTSDESK_DAEMON_URL: "http://127.0.0.1:4999", PORT: "4020" },
      readArtifact: async () => ({ available: false, reason: "none" }),
      daemonFetch: async (url) => {
        seen.push(url);
        return Response.json({}, { status: 502 });
      },
    });
    expect(seen).toEqual(["http://127.0.0.1:4999/api/xml-odds/soa"]);
  });
});

describe("statusCommand exit code", () => {
  test("0 only when the artifact is published and the daemon serves it", async () => {
    const artifact = async () => ({
      available: true as const,
      payload: {
        rowCount: 1,
        watermarkCursor: "0:1",
        generatedAt: "2026-11-18T19:00:00.000Z",
        basis: "r2-xml-ingest",
      },
    });
    expect(
      await statusCommand({
        json: true,
        readArtifact: artifact,
        daemonFetch: async () => Response.json({ rowCount: 1 }),
      }),
    ).toBe(0);
    expect(
      await statusCommand({
        json: true,
        readArtifact: artifact,
        daemonFetch: async () => Response.json({}, { status: 502 }),
      }),
    ).toBe(1);
  });
});

/**
 * The probe accepts a `URL` and a base that carries a path prefix. `new URL("/api/x", "http://h/base")`
 * answers `http://h/api/x` — an absolute path discards the base prefix — so the resolver strips the
 * leading slashes and treats the base as a directory.
 */
describe("endpointUrl", () => {
  test("resolves a path against a bare origin", () => {
    expect(endpointUrl("http://127.0.0.1:4020", "/api/x").toString()).toBe(
      "http://127.0.0.1:4020/api/x",
    );
    expect(endpointUrl("http://h:1/", "api/x").toString()).toBe(
      "http://h:1/api/x",
    );
  });

  test("keeps a base path prefix instead of discarding it", () => {
    expect(endpointUrl(new URL("http://h:1/desk"), "/api/x").toString()).toBe(
      "http://h:1/desk/api/x",
    );
    expect(endpointUrl("http://h:1/desk/", "api/x").toString()).toBe(
      "http://h:1/desk/api/x",
    );
  });

  test("accepts a URL object for the base", () => {
    expect(
      endpointUrl(new URL("https://desk.example"), "/api/x").toString(),
    ).toBe("https://desk.example/api/x");
  });
});

describe("probeDaemonEndpoint with a URL base", () => {
  test("probes the resolved path and reports the origin", async () => {
    const seen: string[] = [];
    const probe = await probeDaemonEndpoint(
      new URL("http://h:1/desk"),
      async (url) => {
        seen.push(url);
        return Response.json({ rowCount: 2 });
      },
      1_000,
      "/api/xml-odds/soa",
    );
    expect(seen).toEqual(["http://h:1/desk/api/xml-odds/soa"]);
    expect(probe).toMatchObject({ origin: "http://h:1", kind: "serving" });
  });
});

/**
 * `dx xml taxonomy` publishes the table `xml:ingest` reads. The dense codes come from the portal,
 * so the command takes them as input; `--dry-run` validates and plans without credentials.
 */
describe("xml taxonomy", () => {
  function withTempTable(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "xml-taxonomy-"));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  const TABLE = JSON.stringify([
    { sport: "FOOTBALL", subSport: "NFL", denseCode6: 1, aliases: ["NFL"] },
    { sport: "BASKETBALL", subSport: "NBA", denseCode6: 3 },
  ]);

  test("--dry-run prints the plan and writes nothing", async () => {
    const path = withTempTable("table.json", TABLE);
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await taxonomyCommand(path, { dryRun: true })).toBe(0);
    } finally {
      process.stdout.write = write;
    }
    const plan = JSON.parse(chunks.join("")) as Record<string, unknown>;
    expect(plan.dry_run).toBe(true);
    expect(plan.entries).toBe(2);
    expect(plan.manifest_key).toBe("manifests/portal-taxonomy/latest");
    expect(String(plan.generation_key)).toMatch(
      /^generations\/portal-taxonomy\/gen-1-/,
    );
  });

  test("an invalid table is rejected before any write", async () => {
    const path = withTempTable(
      "bad.json",
      JSON.stringify([{ sport: "FOOTBALL", subSport: "NFL", denseCode6: 64 }]),
    );
    await expect(taxonomyCommand(path, { dryRun: true })).rejects.toThrow(
      "ERR_PORTAL_TAXONOMY_INVALID",
    );
  });

  test("a file that is neither an array nor {entries} is a usage error", async () => {
    const path = withTempTable("shape.json", JSON.stringify({ nope: true }));
    expect(await taxonomyCommand(path, { dryRun: true })).toBe(2);
  });
});
