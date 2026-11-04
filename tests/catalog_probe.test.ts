import { describe, expect, test } from "bun:test";
import {
  diffSports,
  parseCatalogArgs,
  renderCatalogReport,
  runCatalogProbe,
  type CatalogProbeDeps,
} from "../scripts/catalog_probe.ts";

const FIXTURE_RAW = {
  provider: "fantasy402",
  capturedAt: "2026-10-21T16:38:53.513Z",
  periodsCapturedAt: "2026-10-30T04:59:14.572Z",
  sportCount: 2,
  subSportCount: 3,
  sportPeriodCount: 2,
  collisions: [{ code: "Arena", sports: ["Football", "Horse Racing"] }],
  sports: [
    {
      sport: "Football",
      subSports: [
        { code: "NFL", name: "NFL" },
        { code: "COLL EXT", name: "College Extra" },
      ],
      periods: [{ name: "Game", number: 0 }],
    },
    {
      sport: "Basketball",
      subSports: [{ code: "NBA", name: "NBA" }],
      periods: [
        { name: "Game", number: 0 },
        { name: "1st Half", number: 1 },
      ],
    },
  ],
};

function deps(overrides: Partial<CatalogProbeDeps> = {}): CatalogProbeDeps {
  const out: string[] = [];
  return {
    env: {},
    now: () => new Date("2026-10-31T00:00:00.000Z"),
    stdout: (line) => out.push(line),
    stderr: (line) => out.push(line),
    writeFile: async () => {},
    ...overrides,
  };
}

describe("catalog probe — pure helpers", () => {
  test("diffSports reports added, removed, unchanged", () => {
    const diff = diffSports(
      ["Football", "Basketball", "Hockey"],
      ["Football", "Basketball", "Soccer"],
    );
    expect(diff.liveCount).toBe(3);
    expect(diff.fixtureCount).toBe(3);
    expect(diff.added).toEqual(["Hockey"]);
    expect(diff.removed).toEqual(["Soccer"]);
    expect(diff.unchanged).toBe(2);
  });

  test("diffSports tolerates empty and duplicate inputs", () => {
    expect(diffSports([], []).added).toEqual([]);
    expect(diffSports(["A", "A"], []).liveCount).toBe(1);
  });

  test("parseCatalogArgs defaults and overrides", () => {
    const base = parseCatalogArgs([]);
    expect(base.dryRun).toBe(false);
    expect(base.out).toBe("docs/evidence/captures/catalog");
    const parsed = parseCatalogArgs([
      "--dry-run",
      "--json",
      "--out",
      "/tmp/cat",
      "--fixture",
      "/tmp/f.json",
      "--timeout-ms",
      "5000",
    ]);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.out).toBe("/tmp/cat");
    expect(parsed.fixture).toBe("/tmp/f.json");
    expect(parsed.timeoutMs).toBe(5000);
  });

  test("parseCatalogArgs rejects unknown options and bad timeouts", () => {
    expect(() => parseCatalogArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseCatalogArgs(["--timeout-ms", "0"])).toThrow(
      /positive number/,
    );
  });

  test("parseCatalogArgs maps --proxy and --no-proxy to one option", () => {
    expect(parseCatalogArgs([]).proxy).toBeUndefined();
    expect(parseCatalogArgs(["--no-proxy"]).proxy).toBe(false);
    expect(parseCatalogArgs(["--proxy", "proxy.example:8080"]).proxy).toBe(
      "http://proxy.example:8080",
    );
    // An empty value means "read the environment" to Bun; the flag must not
    // quietly degrade into that, so it is rejected at parse time.
    expect(() => parseCatalogArgs(["--proxy", ""])).toThrow(/empty/);
    expect(() =>
      parseCatalogArgs(["--proxy", "ftp://proxy.example:8080"]),
    ).toThrow(/unsupported proxy protocol/);
    expect(() =>
      parseCatalogArgs(["--proxy", "http://proxy.example:8080", "--no-proxy"]),
    ).toThrow(/mutually exclusive/);
    expect(() =>
      parseCatalogArgs(["--no-proxy", "--proxy", "http://proxy.example:8080"]),
    ).toThrow(/mutually exclusive/);
  });

  test("renderCatalogReport includes counts, diff and sub-sport/period inventory", () => {
    const fixture = FIXTURE_RAW;
    const md = renderCatalogReport({
      fixture: fixture as never,
      fixturePath: "tests/fixtures/x.json",
      liveSports: ["Football", "Basketball"],
      diff: diffSports(["Football", "Basketball"], ["Football", "Basketball"]),
      capturedAt: "2026-10-31T00:00:00.000Z",
      captureSha256: "a".repeat(64),
      endpoint: "/cloud/api/Manager/getSportsType",
      probeLease: "live",
    });
    expect(md).toContain("Live pregame catalog probe");
    expect(md).toContain("| Sports | 2 | 2 |");
    expect(md).toContain("sub-sports");
    expect(md).toContain("Arena");
  });
});

describe("catalog probe — CLI", () => {
  test("dry-run plans without auth, transport or writes", async () => {
    const out: string[] = [];
    const code = await runCatalogProbe(
      ["--dry-run", "--json"],
      deps({
        env: { F402_BASE_URL: "https://portal.example" },
        stdout: (line) => out.push(line),
      }),
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out[0] ?? "{}");
    expect(payload["dryRun"]).toBe(true);
    expect(payload["endpoint"]).toBe("/cloud/api/Manager/getSportsType");
    expect(payload["targetHost"]).toBe("portal.example");
  });

  test("live mode refuses without the env gate and names only env var names", async () => {
    const out: string[] = [];
    const code = await runCatalogProbe(
      ["--json"],
      deps({
        env: { F402_BASE_URL: "", F402_AGENT_ID: "", F402_PASSWORD: "" },
        stdout: (line) => out.push(line),
      }),
    );
    expect(code).toBe(2);
    const payload = JSON.parse(out[0] ?? "{}");
    expect(payload["error"]?.["code"]).toBe("LIVE_GATE");
  });
});
