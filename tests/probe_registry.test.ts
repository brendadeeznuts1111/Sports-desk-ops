/**
 * `scripts/probe-registry.ts`: flag parsing, registry→canary resolution, probe classification and
 * the strict/loose exit rule. Every probe here uses an injected fetch, so no test touches a
 * registry.
 */
import { describe, expect, test } from "bun:test";

import {
  canaryUrl,
  exitCodeFor,
  parseArgs,
  parseProbePkg,
  probeAll,
  resolveProbeTargets,
  snapshotKeys,
  type ProbeResult,
} from "../scripts/probe-registry.ts";

const CONFIG = {
  defaultRegistry: "https://registry.npmjs.org/",
  scopes: { "@sportsdesk": "https://npm.pkg.github.com/" },
};

function fakeFetch(statusFor: (url: string) => number | "throw"): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const status = statusFor(url);
    if (status === "throw") throw new Error("ECONNREFUSED");
    return new Response("{}", { status });
  }) as unknown as typeof fetch;
}

describe("parseProbePkg", () => {
  test("accepts the default selector and a scope", () => {
    expect(parseProbePkg("default=bun")).toEqual({
      selector: "default",
      canary: "bun",
    });
    expect(parseProbePkg("@sportsdesk=@sportsdesk/contracts")).toEqual({
      selector: "@sportsdesk",
      canary: "@sportsdesk/contracts",
    });
  });

  test("rejects malformed or unscoped selectors", () => {
    expect(parseProbePkg("bun")).toBeNull();
    expect(parseProbePkg("=bun")).toBeNull();
    expect(parseProbePkg("default=")).toBeNull();
    expect(parseProbePkg("sportsdesk=bun")).toBeNull();
  });
});

describe("resolveProbeTargets", () => {
  test("defaults the default registry to the bun canary and leaves scope roots", () => {
    const { targets, errors } = resolveProbeTargets(CONFIG, []);
    expect(errors).toEqual([]);
    expect(targets).toEqual([
      {
        selector: "default",
        registry: "https://registry.npmjs.org/",
        canary: "bun",
      },
      {
        selector: "@sportsdesk",
        registry: "https://npm.pkg.github.com/",
        canary: null,
      },
    ]);
  });

  test("an explicit canary overrides the default and binds to its scope", () => {
    const { targets } = resolveProbeTargets(CONFIG, [
      { selector: "default", canary: "typescript" },
      { selector: "@sportsdesk", canary: "@sportsdesk/contracts" },
    ]);
    expect(targets.map((target) => target.canary)).toEqual([
      "typescript",
      "@sportsdesk/contracts",
    ]);
  });

  test("an unknown selector names the registries that do exist", () => {
    const { errors } = resolveProbeTargets(CONFIG, [
      { selector: "@missing", canary: "@missing/pkg" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("@missing");
    expect(errors[0]).toContain("@sportsdesk");
    expect(errors[0]).toContain("default");
  });
});

describe("canaryUrl", () => {
  test("keeps the @ and encodes the slash of a scoped packument", () => {
    expect(
      canaryUrl("https://npm.pkg.github.com/", "@sportsdesk/contracts"),
    ).toBe("https://npm.pkg.github.com/@sportsdesk%2fcontracts");
  });

  test("joins an unscoped name under a registry that has no trailing slash", () => {
    expect(canaryUrl("https://registry.npmjs.org", "bun")).toBe(
      "https://registry.npmjs.org/bun",
    );
  });
});

describe("probeAll", () => {
  test("classifies each registry independently", async () => {
    const { targets } = resolveProbeTargets(CONFIG, []);
    const results = await probeAll(targets, {
      fetchImpl: fakeFetch((url) =>
        url.includes("registry.npmjs.org") ? 200 : 404,
      ),
    });
    expect(results.map((result) => result.status)).toEqual([200, 404]);
    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.error).toBe("HTTP 404");
  });

  test("a transport error is a null status, not an exception", async () => {
    const { targets } = resolveProbeTargets(CONFIG, []);
    const results = await probeAll(targets, {
      fetchImpl: fakeFetch((url) =>
        url.includes("registry.npmjs.org") ? "throw" : 200,
      ),
    });
    expect(results[0]?.status).toBeNull();
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toContain("ECONNREFUSED");
  });
});

describe("exitCodeFor", () => {
  const ok = (status: number | null): ProbeResult => ({
    selector: "default",
    registry: "https://registry.npmjs.org/",
    canary: "bun",
    url: "https://registry.npmjs.org/bun",
    status,
    ok: status !== null && status >= 200 && status < 300,
    latencyMs: 1,
    error: status === null ? "ECONNREFUSED" : null,
  });

  test("strict fails on any non-answer, including a 404", () => {
    expect(exitCodeFor([ok(200), ok(404)], true)).toBe(1);
    expect(exitCodeFor([ok(200)], true)).toBe(0);
  });

  test("loose only fails on a transport error, because 404 means unpublished", () => {
    expect(exitCodeFor([ok(200), ok(404)], false)).toBe(0);
    expect(exitCodeFor([ok(null)], false)).toBe(1);
  });
});

describe("parseArgs", () => {
  test("collects repeated --probe-pkg values", () => {
    const parsed = parseArgs([
      "--probe-pkg",
      "default=bun",
      "--probe-pkg",
      "@sportsdesk=@sportsdesk/contracts",
      "--dry-run",
      "--json",
    ]);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.probePkg).toHaveLength(2);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.strict).toBe(false);
  });

  test("rejects an unknown flag, a bad --probe-pkg and a missing --out value", () => {
    expect(parseArgs(["--nope"])).toEqual({ error: 'unknown flag "--nope"' });
    expect(parseArgs(["--probe-pkg", "bun"])).toMatchObject({
      error: expect.stringContaining("default=<pkg>"),
    });
    expect(parseArgs(["--out"])).toEqual({ error: "--out needs a path" });
    expect(parseArgs(["--out", "--json"])).toEqual({
      error: "--out needs a path",
    });
  });
});

describe("snapshotKeys", () => {
  test("writes a timestamped object and the latest pointer", () => {
    expect(snapshotKeys("2026-11-20T17:30:00.000Z")).toEqual([
      "registry-probe/2026-11-20T17-30-00-000Z.json",
      "registry-probe/latest.json",
    ]);
  });
});
