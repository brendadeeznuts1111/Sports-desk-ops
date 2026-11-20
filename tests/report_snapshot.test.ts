/**
 * @file tests/report_snapshot.test.ts
 * @description bun:test snapshot contract for a generated report.
 *
 * Property matchers cover dynamic fields. Inline snapshots cover small
 * derived values. File snapshots cover rendered text. Error snapshots cover
 * the typed message. The file matcher is local: Bun 1.4.4 has no
 * `toMatchFileSnapshot`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

declare module "bun:test" {
  interface Matchers<T = unknown> {
    toMatchFileSnapshot(path: string, hint?: string): void;
  }
}

interface InputRow {
  readonly id: number;
  readonly name: string;
  readonly age: number;
}

interface Report {
  readonly requestId: string;
  readonly generatedAt: string;
  readonly total: number;
  readonly summary: readonly { readonly id: number; readonly name: string }[];
}

interface RedactedSurface {
  readonly bucket: string;
  readonly token: string;
}

function generateReport(data: readonly InputRow[]): Report {
  return {
    requestId: Bun.randomUUIDv7(),
    generatedAt: new Date().toISOString(),
    total: data.length,
    summary: data.map((item) => ({ id: item.id, name: item.name })),
  };
}

class ReportSnapshotError extends Error {
  readonly code = "ERR_REPORT_SNAPSHOT";

  constructor(message: string) {
    super(message);
    this.name = "ReportSnapshotError";
  }
}

function snapshotText(value: unknown): string {
  if (typeof value === "string") return value;
  return Bun.inspect(value, { colors: false });
}

function commandLine(): readonly string[] {
  // Bun 1.4.4 drops `--update-snapshots` from `process.argv`. The process
  // command line still carries the flag on Linux.
  try {
    return readFileSync("/proc/self/cmdline")
      .toString()
      .split("\0")
      .filter((part) => part.length > 0);
  } catch {
    return process.argv;
  }
}

function updateSnapshotsRequested(): boolean {
  const args = commandLine();
  return args.includes("--update-snapshots") || args.includes("-u");
}

function ciForbidsNewSnapshots(): boolean {
  const ci = Bun.env.CI;
  return ci === "true" || ci === "1";
}

expect.extend({
  toMatchFileSnapshot(actual: unknown, filePath: string, hint?: string) {
    const label = hint ? `${hint} (${filePath})` : filePath;
    if (filePath.startsWith("/") || filePath.split("/").includes("..")) {
      return {
        pass: false,
        message: () =>
          `${label}: file snapshot path must stay beside the test file`,
      };
    }
    const target = fileURLToPath(new URL(filePath, import.meta.url));
    const received = snapshotText(actual);
    let expected: string | undefined;
    try {
      expected = readFileSync(target, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const missing = expected === undefined;
    if (missing && ciForbidsNewSnapshots() && !updateSnapshotsRequested()) {
      return {
        pass: false,
        message: () =>
          `${label}: snapshot file is missing and CI=${Bun.env.CI} will not create it`,
      };
    }
    if (missing || updateSnapshotsRequested()) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, received);
      return {
        pass: true,
        message: () => `${label}: wrote file snapshot`,
      };
    }
    const pass = expected === received;
    return {
      pass,
      message: () =>
        pass
          ? `${label}: file snapshot matched`
          : `${label}: file snapshot drifted\nexpected:\n${expected}\nreceived:\n${received}`,
    };
  },
});

describe("deterministic report snapshots", () => {
  const sample: readonly InputRow[] = [
    { id: 1, name: "Alice", age: 30 },
    { id: 2, name: "Bob", age: 25 },
  ];

  test("snapshots nested report with property matchers and explicit hint", () => {
    const report = generateReport(sample);

    expect(report).toMatchSnapshot(
      {
        requestId: expect.any(String),
        generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      "two-user report",
    );
  });

  test("snapshots small derived arrays inline for zero-indirection PR review", () => {
    const doubled = [1, 2, 3, 4, 5].map((n) => n * 2);

    expect(doubled).toMatchInlineSnapshot(`
      [
        2,
        4,
        6,
        8,
        10,
      ]
    `);
  });

  test("snapshots raw text/table output to a dedicated file via toMatchFileSnapshot", () => {
    const table = Bun.inspect.table(
      sample.map(({ id, name }) => ({ id, name })),
      ["id", "name"],
      { colors: false },
    );

    expect(table).toMatchFileSnapshot("./__snapshots__/sample-table.txt");
  });

  test("snapshots a typed error message without the stack", () => {
    expect(() => {
      throw new ReportSnapshotError("ERR_REPORT_SNAPSHOT: sample rejected");
    }).toThrowErrorMatchingSnapshot("rejected sample");
  });

  test("snapshots the redacted toJSON surface", () => {
    const token = "SECRET_CANARY_SNAPSHOT";
    const surface = {
      bucket: "sportsdesk-ops-reports",
      token,
      toJSON(): RedactedSurface {
        return { bucket: this.bucket, token: "[REDACTED_SECRET]" };
      },
    };

    const redacted = surface.toJSON();
    expect(redacted.token).toBe("[REDACTED_SECRET]");
    expect(JSON.stringify(redacted)).not.toContain(token);
    expect(redacted).toMatchSnapshot("redacted surface");
  });

  test("writes a Bun-format snapshot file", () => {
    const header = readFileSync(
      fileURLToPath(
        new URL(
          "./__snapshots__/report_snapshot.test.ts.snap",
          import.meta.url,
        ),
      ),
      "utf8",
    ).split("\n")[0];
    expect(header).toBe(
      "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots",
    );
  });
});
