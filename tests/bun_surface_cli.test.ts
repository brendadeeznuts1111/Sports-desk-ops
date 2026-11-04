import { describe, expect, test } from "bun:test";

/**
 * `dx bun` is the runtime-surface diagnostic. These assert the contract agents
 * rely on: one JSON object on stdout, stable drift ids, and usage errors that
 * exit 2 instead of printing half a report.
 */

const SCRIPT = "bin/bun_surface.ts";

async function run(args: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

interface Report {
  runtime: {
    version: string;
    revision: string;
    typesVersion: string | null;
    typesMatch: boolean | null;
  };
  checks: { name: string; group: string; ok: boolean }[];
  namespaces: {
    value: string[];
    typeOnly: string[];
  } | null;
  baseline: {
    path: string;
    members: number;
    diffs: {
      severity: "removed" | "type" | "added";
      member: string;
      note: string;
    }[];
  } | null;
  types: {
    declared: number;
    runtime: number;
    absent: string[];
    undeclared: string[];
    namespaces: { name: string; absent: string[]; undeclared: string[] }[];
    error: string | null;
  } | null;
  missing: string[];
  drift: { id: string; note: string }[];
  proxy: {
    url: string | null;
    mode: "proxy" | "direct" | null;
    proxy: string | null;
    reason: string | null;
    env: { present: boolean; noProxyCount: number };
  } | null;
}

describe("dx bun", () => {
  test("reports the running version and a complete surface as JSON", async () => {
    const result = await run(["--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as Report;
    expect(report.runtime.version).toBe(Bun.version);
    expect(report.runtime.typesVersion).toBe(report.runtime.version);
    expect(report.runtime.typesMatch).toBe(true);
    expect(report.checks.length).toBeGreaterThan(20);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(report.missing).toEqual([]);
    // Without --url there is no routing decision, but the environment snapshot
    // is still reported so `--json` is a complete picture.
    expect(report.proxy?.url).toBeNull();
    expect(report.proxy?.mode).toBeNull();
    expect(report.proxy?.env).toHaveProperty("present");
  });

  test("names the drift it can prove", async () => {
    const report = JSON.parse((await run(["--json"])).stdout) as Report;
    const ids = report.drift.map((entry) => entry.id);
    expect(ids).toContain("websocket-global");
    expect(ids).toContain("dns-resolve");
  });

  test("derives the namespace split from the baseline", async () => {
    const report = JSON.parse((await run(["--json"])).stdout) as Report;

    // Value-backed: objects and classes that survive to runtime.
    expect(report.namespaces?.value).toContain("inspect");
    expect(report.namespaces?.value).toContain("Image");
    expect(report.namespaces?.value).toContain("JSONL");
    expect(report.namespaces?.value).toHaveLength(18);

    // Type-only: declared in bun-types, undefined at runtime.
    expect([...(report.namespaces?.typeOnly ?? [])].sort()).toEqual(
      [
        "Build",
        "Password",
        "Security",
        "Serve",
        "Spawn",
        "WebAssembly",
        "udp",
      ].sort(),
    );
    // One taxonomy: the baseline rows are the source of both the split and the diff.
    expect(report.baseline?.members).toBe(
      (report.namespaces?.value.length ?? 0) +
        (report.namespaces?.typeOnly.length ?? 0),
    );
  });

  test("checks a non-enumerable class static that Object.keys misses", async () => {
    const report = JSON.parse((await run(["--json"])).stdout) as Report;
    const closeAll = report.checks.find((c) => c.name === "WebView.closeAll");
    expect(closeAll?.ok).toBe(true);
    expect(Object.keys(Bun.WebView)).toEqual([]);
    expect(Object.getOwnPropertyNames(Bun.WebView)).toContain("closeAll");
    expect(typeof Bun.WebView.closeAll).toBe("function");
  });

  test("matches the checked-in probe baseline", async () => {
    const report = JSON.parse((await run(["--json"])).stdout) as Report;
    expect(report.baseline?.path).toBe("tests/bun_baseline.json");
    expect(report.baseline?.members).toBe(25);
    expect(report.baseline?.diffs).toEqual([]);
  });

  test("--no-baseline skips the diff and the derived namespace split", async () => {
    const report = JSON.parse(
      (await run(["--json", "--no-baseline"])).stdout,
    ) as Report;
    expect(report.baseline).toBeNull();
    expect(report.namespaces).toBeNull();
  });

  test("reports removed members and changed typeof, and exits 1", async () => {
    const path = `${Bun.env.TMPDIR ?? "/tmp"}/dx-bun-baseline-${Bun.randomUUIDv7()}.json`;
    const rows = [
      { k: "Image", t: "object", own: ["backend"] },
      { k: "WebView", t: "function", own: ["closeAll", "nope"] },
      { k: "Ghost", t: "function", own: [] },
    ];
    await Bun.write(
      path,
      JSON.stringify({ "ns.own": { stdout: JSON.stringify(rows) } }),
    );
    try {
      const result = await run(["--json", "--baseline", path]);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout) as Report;
      const diffs = report.baseline?.diffs ?? [];

      expect(diffs).toContainEqual(
        expect.objectContaining({ severity: "type", member: "Image" }),
      );
      expect(diffs).toContainEqual(
        expect.objectContaining({
          severity: "removed",
          member: "WebView.nope",
        }),
      );
      expect(diffs).toContainEqual(
        expect.objectContaining({ severity: "removed", member: "Ghost" }),
      );
      // A property the baseline lacks is a note, not a failure.
      expect(diffs).toContainEqual(
        expect.objectContaining({
          severity: "added",
          member: "WebView.prototype",
        }),
      );
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("--baseline with a missing file is a usage error", async () => {
    const result = await run(["--baseline", "/nonexistent/baseline.json"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("baseline not found");
  });

  test("--types computes declaration gaps instead of hardcoding them", async () => {
    const result = await run(["--json", "--types"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;

    expect(report.types?.error).toBeNull();
    expect(report.types?.declared).toBeGreaterThan(100);
    expect(report.types?.runtime).toBeGreaterThan(100);

    // Declared but never defined: the class bun-types documents as type-only.
    expect(report.types?.absent).toContain("CryptoHashInterface");
    // Present but undeclared: the binary is ahead of the package.
    expect(report.types?.undeclared).toContain("FFI");

    const dns = report.types?.namespaces.find((gap) => gap.name === "dns");
    expect(dns?.undeclared).toContain("resolve");

    // Prototype-chain members must not masquerade as missing.
    const shell = report.types?.namespaces.find((gap) => gap.name === "$");
    expect(shell?.absent).toEqual([]);
    const image = report.types?.namespaces.find((gap) => gap.name === "Image");
    expect(image?.absent).toEqual([]);
    // The subprocess builds a TypeScript program over ~237 lib/bun-types/@types/node files:
    // 0.6-1.4 s alone, 2.9-12.1 s under `bun test tests/ --parallel` (2026-11-02, 10 cores,
    // 6 runs), which crosses the 5 s default.
  }, 30_000);

  test("the fast path does not load the compiler", async () => {
    const report = JSON.parse((await run(["--json"])).stdout) as Report;
    expect(report.types).toBeNull();
  });

  test("resolves proxy routing for an http(s) URL", async () => {
    const result = await run(["--json", "--url", "https://portal.example/api"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.proxy?.url).toBe("https://portal.example/api");
    expect(["proxy", "direct"]).toContain(report.proxy?.mode ?? "");
    expect(typeof report.proxy?.reason).toBe("string");
    expect(report.proxy?.env).toHaveProperty("noProxyCount");
  });

  test("rejects non-http(s) and malformed --url with exit 2", async () => {
    const scheme = await run(["--url", "ftp://proxy.example"]);
    expect(scheme.code).toBe(2);
    expect(scheme.stderr).toContain("must be http(s)");

    const malformed = await run(["--url", "not a url"]);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain("not a valid URL");
  });

  test("unknown flags, a missing value and a non-baseline file exit 2", async () => {
    for (const args of [
      ["--jsno"],
      ["--url"],
      ["stray"],
      ["--baseline", "package.json"],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("error:");
    }
  });

  test("--help is layered and points at the command", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("dx bun");
    expect(result.stdout).toContain("--url");
    expect(result.stdout).toContain("Exit codes");
  });
});
