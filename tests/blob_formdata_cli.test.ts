import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression tests for `bun run blob:formdata`.
 *
 * Bun 1.4.4's Blob.formData() rejects its own multipart encoding
 * ("missing final boundary"); the CLI uses Request.formData(), the same path as
 * the daemon's /api/parse-formdata arm. These tests pin file, stdin, urlencoded
 * and malformed input.
 */

const repo = join(import.meta.dir, "..");
const script = join(repo, "bin/blob-formdata.ts");
const dir = mkdtempSync(join(tmpdir(), "blob-formdata-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function multipart(): Promise<{
  bytes: Uint8Array;
  contentType: string;
}> {
  const form = new FormData();
  form.append("alpha", "one");
  form.append("beta", "two words");
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "a.bin", {
      type: "application/octet-stream",
    }),
  );
  const request = new Request("http://localhost/", {
    method: "POST",
    body: form,
  });
  const contentType = request.headers.get("content-type");
  if (contentType === null) throw new Error("multipart request has no type");
  return { bytes: await request.bytes(), contentType };
}

async function run(args: string[], stdin?: Uint8Array) {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", script, ...args],
    cwd: repo,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    if (proc.stdin === undefined) {
      throw new Error("stdin pipe was not created");
    }
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    proc.stdout.text(),
    proc.stderr.text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("blob:formdata", () => {
  test("decodes multipart from a file", async () => {
    const { bytes, contentType } = await multipart();
    const path = join(dir, "body.bin");
    await Bun.write(path, bytes);

    const result = await run([path, contentType]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      alpha: "one",
      beta: "two words",
      file: {
        filename: "a.bin",
        size: 3,
        type: "application/octet-stream",
      },
    });
  });

  test("decodes multipart from stdin", async () => {
    const { bytes, contentType } = await multipart();
    const result = await run(["-", contentType], bytes);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      alpha: "one",
      beta: "two words",
      file: {
        filename: "a.bin",
        size: 3,
        type: "application/octet-stream",
      },
    });
  });

  test("decodes urlencoded with the default type or an explicit one", async () => {
    const path = join(dir, "body.txt");
    await Bun.write(path, "a=1&b=two+words");
    const result = await run([path, "application/x-www-form-urlencoded"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ a: "1", b: "two words" });
  });

  test("FileBlob.formData handles urlencoded, slice sets type, multipart is the 1.4.4 gap", async () => {
    const path = join(dir, "direct.txt");
    await Bun.write(path, "a=1&b=two+words");

    const direct = await Bun.file(path, {
      type: "application/x-www-form-urlencoded",
    }).formData();
    expect([...direct.entries()]).toEqual([
      ["a", "1"],
      ["b", "two words"],
    ]);

    const sliced = Bun.file(path).slice(0, "application/x-www-form-urlencoded");
    expect(sliced.type).toContain("application/x-www-form-urlencoded");
    expect([...(await sliced.formData()).entries()]).toEqual([
      ["a", "1"],
      ["b", "two words"],
    ]);

    const { bytes, contentType } = await multipart();
    const multipartPath = join(dir, "direct-multipart.bin");
    await Bun.write(multipartPath, bytes);
    await expect(
      Bun.file(multipartPath, { type: contentType }).formData(),
    ).rejects.toThrow(/invalid encoding|missing final boundary/i);
  });

  test("reports malformed multipart without a stack trace", async () => {
    const path = join(dir, "broken.bin");
    await Bun.write(
      path,
      "--boundary\r\ncontent-disposition: form-data; name=a\r\n\r\nvalue",
    );
    const result = await run([path, "multipart/form-data; boundary=boundary"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("blob-formdata:");
    expect(result.stderr).not.toContain("at ");
  });

  test("prints usage and exits 1 without a file", async () => {
    const result = await run([]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage: blob-formdata");
  });
});
