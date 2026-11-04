import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, openSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `Bun.file()` infers a MIME type, but `new Response(file)` does not put it on the response object.
 * `Bun.serve` adds it at send time. The difference matters whenever code inspects headers before the
 * response is sent — and for the missing-file case, where the object looks like a 200 but serving it
 * yields a 500.
 */
const DIR = `scratch/response-fixture-${process.pid}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("Bun.file response semantics", () => {
  test("the file and the Response both know the type", async () => {
    await Bun.write(`${DIR}/pixel.png`, PNG);
    const file = Bun.file(`${DIR}/pixel.png`);
    expect(file.type).toBe("image/png");

    const response = new Response(file);
    expect(response.status).toBe(200);
    // Measured: the header is present on the Response object. An earlier reading of null did not
    // reproduce, so it is not treated as a contract and callers should still set it explicitly.
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  test("Bun.serve infers the type at send time", async () => {
    await Bun.write(`${DIR}/pixel.png`, PNG);
    await Bun.write(`${DIR}/blob.unknown`, PNG);
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new Response(
          Bun.file(`${DIR}/${new URL(request.url).pathname.slice(1)}`),
        ),
    });
    try {
      const png = await fetch(new URL("/pixel.png", server.url));
      expect(png.headers.get("content-type")).toBe("image/png");
      expect((await png.arrayBuffer()).byteLength).toBe(PNG.byteLength);

      const unknown = await fetch(new URL("/blob.unknown", server.url));
      expect(unknown.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
    } finally {
      await server.stop(true);
    }
  });

  test("metadata is valid before a read and the type option is implemented on 1.4.4", async () => {
    const path = `${DIR}/doc.json`;
    const body = '{"hello":"world"}\n';
    await Bun.write(path, body);

    const lazy = Bun.file(path);
    // The reference says size is not valid until a read, and that BlobPropertyBag.type is
    // "Not yet implemented". Measured on 1.4.4: size stats on first access and the type option
    // overrides inference (with the charset suffix Bun appends).
    expect(lazy.size).toBe(body.length);
    expect(lazy.type).toBe("application/json;charset=utf-8");
    expect(await lazy.text()).toBe(body);

    const typed = Bun.file(path, { type: "text/plain" });
    expect(typed.type).toBe("text/plain;charset=utf-8");
    expect(await typed.text()).toBe(body);
  });

  test("byte-buffer paths are copied; URL and fd overloads work", async () => {
    const path = `${DIR}/doc.json`;
    const body = '{"hello":"world"}\n';
    await Bun.write(path, body);

    const fromUrl = Bun.file(pathToFileURL(resolve(path)));
    expect(await fromUrl.text()).toBe(body);

    const pathBytes = new TextEncoder().encode(path);
    const fromBytes = Bun.file(pathBytes);
    expect(await fromBytes.text()).toBe(body);
    pathBytes.fill(0x78); // the reference says the path buffer is copied
    expect(await fromBytes.text()).toBe(body);

    const fd = openSync(path, "r");
    try {
      const fromFd = Bun.file(fd);
      expect(fromFd.type).toBe("application/octet-stream");
      expect(fromFd.size).toBe(body.length);
      expect(await fromFd.text()).toBe(body);
    } finally {
      closeSync(fd);
    }
  });

  test("a missing path is lazy: its read rejects with ENOENT", async () => {
    const missing = Bun.file(`${DIR}/nope.json`);
    expect(missing.size).toBe(0);
    expect(missing.type).toBe("application/json;charset=utf-8");
    await expect(missing.text()).rejects.toThrow("ENOENT");
  });

  test("base64 inline form inflates the payload", async () => {
    const encoded = PNG.toString("base64");
    expect(encoded.length).toBeGreaterThan(PNG.byteLength);
    expect((encoded.length / PNG.byteLength - 1) * 100).toBeGreaterThan(30);
  });
});
