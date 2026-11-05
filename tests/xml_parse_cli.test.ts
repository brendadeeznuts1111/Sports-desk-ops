import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = join(import.meta.dir, "..", "bin", "xml-parse.ts");

function run(args: readonly string[]) {
  return Bun.spawnSync([process.execPath, BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function withTempFile(
  name: string,
  contents: string | Uint8Array,
  body: (file: string) => Promise<void> | void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "xml-parse-"));
  const file = join(dir, name);
  try {
    await Bun.write(file, contents);
    await body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("xml:parse CLI", () => {
  test("--xml serializes the full tree, comments included", async () => {
    await withTempFile(
      "doc.xml",
      '<p class="x">Hi <b>!</b><!-- bye --></p>',
      (file) => {
        const result = run([file, "--xml"]);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString().trim()).toBe(
          '<p class="x">Hi <b>!</b><!-- bye --></p>',
        );
      },
    );
  });

  test("--indent formats element-only content", async () => {
    await withTempFile("tree.xml", "<a><b>1</b></a>", (file) => {
      const result = run([file, "--xml", "--indent", "2"]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("<a>\n  <b>1</b>\n</a>");
    });
  });

  test("bytes honor the XML encoding declaration", async () => {
    const encoder = new TextEncoder();
    const iso = new Uint8Array([
      ...encoder.encode(`<?xml version="1.0" encoding="ISO-8859-1"?><a>`),
      0xe9,
      ...encoder.encode("</a>"),
    ]);
    await withTempFile("iso.xml", iso, (file) => {
      const result = run([file, "--xml"]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("<a>é</a>");
    });
  });

  test("default mode prints the compact JSON", async () => {
    await withTempFile("compact.xml", "<a>1</a>", (file) => {
      const result = run([file]);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ a: "1" });
    });
  });

  test("rejects conflicting or invalid flags", async () => {
    await withTempFile("flags.xml", "<a>1</a>", (file) => {
      const conflict = run([file, "--tree", "--xml"]);
      expect(conflict.exitCode).toBe(1);
      expect(conflict.stderr.toString()).toContain("mutually exclusive");

      const badIndent = run([file, "--xml", "--indent", "11"]);
      expect(badIndent.exitCode).toBe(1);
      expect(badIndent.stderr.toString()).toContain("0..10");
    });
  });
});
