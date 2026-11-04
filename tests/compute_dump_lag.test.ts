import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PROD_SCHEMA_DUMP_FORMAT_VERSION } from "../lib/schema_prod_dump.ts";

describe("compute_dump_lag", () => {
  test("script exits 0 on fixture with git history", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        resolve(import.meta.dir, "../scripts/compute_dump_lag.ts"),
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(0);
    const out = await proc.stdout.text();
    const doc = JSON.parse(out) as {
      dump_lag_days: number;
      captured_at: string;
    };
    expect(doc.captured_at).toBeTruthy();
    expect(typeof doc.dump_lag_days).toBe("number");
  });

  test("script exits 1 when dump file has no git history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dump-lag-"));
    const path = join(dir, "orphan.json");
    writeFileSync(
      path,
      JSON.stringify({
        format_version: PROD_SCHEMA_DUMP_FORMAT_VERSION,
        captured_at: "2020-01-01T00:00:00.000Z",
        source: "test",
        tables: {},
        allowlist: {},
      }),
    );
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        resolve(import.meta.dir, "../scripts/compute_dump_lag.ts"),
        path,
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await proc.exited).toBe(1);
  });
});
