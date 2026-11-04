/**
 * 3b needs an explicit, complete customer list; Report/Pending has no agent-wide scope. The
 * exporter normalizes an approved operator export, validates ids, and writes 0600 without ever
 * printing an id.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CustomerExportError,
  normalizeCustomerIds,
  parseCustomerExport,
  writeCustomerList,
} from "../scripts/export_f402_customers.ts";

const dir = mkdtempSync(join(tmpdir(), "export-customers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseCustomerExport", () => {
  test("JSON object rows use a customer-id field", () => {
    expect(
      parseCustomerExport(
        JSON.stringify([{ customer_id: "ABC123" }, { CustomerID: "DEF456" }]),
      ),
    ).toEqual(["ABC123", "DEF456"]);
  });

  test("JSON string arrays and nested containers", () => {
    expect(parseCustomerExport(JSON.stringify(["A1", "B2"]))).toEqual([
      "A1",
      "B2",
    ]);
    expect(
      parseCustomerExport(
        JSON.stringify({ customers: [{ customer_id: 1 }, "C3"] }),
      ),
    ).toEqual(["1", "C3"]);
  });

  test("CSV/TSV headers pick the customer column", () => {
    expect(
      parseCustomerExport("Customer,Ticket Number\nABC123,7\nDEF456,8"),
    ).toEqual(["ABC123", "DEF456"]);
    expect(parseCustomerExport("customer_id\tamount\nX1\t5\nY2\t6")).toEqual([
      "X1",
      "Y2",
    ]);
  });

  test("plain one-per-line input", () => {
    expect(parseCustomerExport("A1\n\nB2\n")).toEqual(["A1", "B2"]);
  });

  test("a missing id column is a usage error", () => {
    expect(() => parseCustomerExport("foo,bar\n1,2")).toThrow(
      /no customer-id column/,
    );
  });
});

describe("normalizeCustomerIds", () => {
  test("trims, de-duplicates, preserves order, and applies the limit", () => {
    expect(
      normalizeCustomerIds([" A1 ", "B2", "A1", "", "C3"], { limit: 2 }),
    ).toEqual(["A1", "B2"]);
  });

  test("rejects ids with whitespace or unsafe characters", () => {
    expect(() => normalizeCustomerIds(["bad id"])).toThrow(CustomerExportError);
    expect(() => normalizeCustomerIds(["x".repeat(65)])).toThrow(
      /invalid customer id/,
    );
  });
});

describe("writeCustomerList", () => {
  test("writes one id per line at 0600 and reports only lengths", () => {
    const path = join(dir, "nested", "customers.txt");
    const result = writeCustomerList(["ABC123", "XY"], path);
    expect(result).toEqual({
      path,
      count: 2,
      minChars: 2,
      maxChars: 6,
    });
    expect(readFileSync(path, "utf8")).toBe("ABC123\nXY\n");
    expect(statSync(path).mode & 0o077).toBe(0);
  });
});

describe("exporter CLI", () => {
  const script = join(import.meta.dir, "../scripts/export_f402_customers.ts");

  test("normalizes a source and prints no ids", () => {
    const source = join(dir, "source.json");
    writeFileSync(
      source,
      JSON.stringify([{ customer_id: "ABC123" }, { customer_id: "DEF456" }]),
    );
    const out = join(dir, "out", "customers.txt");
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "--no-env-file",
        "run",
        script,
        "--from",
        source,
        "--out",
        out,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("wrote 2 customer id(s)");
    expect(readFileSync(out, "utf8")).toBe("ABC123\nDEF456\n");
  });

  test("missing --from/--out is a usage error", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "--no-env-file", "run", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage:");
  });
});
