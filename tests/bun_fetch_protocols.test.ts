import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const listen = { hostname: "127.0.0.1", port: 0, development: false } as const;
const localS3 = (endpoint: string) => ({
  endpoint, accessKeyId: "local", secretAccessKey: "fixture-secret", region: "us-east-1",
});

test("file URLs accept empty and localhost authorities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bun-file-"));
  try {
    const path = join(directory, "a b.txt");
    await writeFile(path, "file contents");
    const url = pathToFileURL(path);
    for (const authority of ["", "localhost"]) {
      const input = "file://" + authority + url.pathname;
      expect(await (await fetch(input)).text()).toBe("file contents");
    }
    if (process.platform !== "win32") {
      await expect(fetch("file://other.host" + url.pathname)).rejects.toMatchObject({
        code: "ERR_INVALID_FILE_URL_HOST",
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("data: decodes a base64 payload and preserves its media type", async () => {
  const url = new URL("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==");
  expect(url.protocol).toBe("data:");
  for (const input of [url, url.href]) {
    const response = await fetch(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("text/plain");
    expect(await response.text()).toBe("Hello, World!");
  }
});

test("blob: reads the registered object and preserves its media type", async () => {
  const href = URL.createObjectURL(new Blob(["Hello, World!"], { type: "text/plain" }));
  try {
    expect(typeof href).toBe("string");
    const url = new URL(href);
    expect(url.protocol).toBe("blob:");
    for (const input of [url, href]) {
      const response = await fetch(input);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")?.split(";")[0]).toBe("text/plain");
      expect(await response.text()).toBe("Hello, World!");
    }
  } finally {
    URL.revokeObjectURL(href);
  }
});

test("HTTP request validation and refused connection have distinct codes", async () => {
  const server = Bun.serve({ ...listen, fetch: () => new Response("unexpected") });
  const url = server.url;
  try {
    for (const method of ["GET", "HEAD"]) {
      await expect(fetch(url, { method, body: "x" })).rejects.toMatchObject({
        name: "TypeError", code: "ERR_INVALID_ARG_VALUE",
      });
    }
    await expect(fetch(url, { proxy: url.href, unix: "/unused.sock" })).rejects.toMatchObject({
      name: "TypeError", code: "ERR_INVALID_ARG_VALUE",
    });
  } finally {
    await server.stop(true);
  }
  await expect(fetch(url, { keepalive: false })).rejects.toMatchObject({
    name: "TypeError", code: "ECONNREFUSED", message: expect.stringMatching(/^ECONNREFUSED/),
  });
});

test("HTTP Blob and FormData uploads carry the appropriate content type", async () => {
  const server = Bun.serve({ ...listen, async fetch(request) {
    const type = request.headers.get("content-type");
    const value = type?.startsWith("multipart/")
      ? (await request.formData()).get("field")
      : await request.text();
    return Response.json({ type, value });
  } });
  try {
    const blob = new Blob(["payload"], { type: "application/x-desk" });
    const post = async (body: BodyInit, headers?: HeadersInit) =>
      (await fetch(server.url, { method: "POST", body, headers })).json();
    expect(await post(blob)).toEqual({ type: "application/x-desk", value: "payload" });
    expect(await post(blob, { "Content-Type": "text/custom" })).toEqual({ type: "text/custom", value: "payload" });
    const form = new FormData();
    form.append("field", "payload");
    expect(await post(form)).toEqual({
      type: expect.stringMatching(/^multipart\/form-data;\s*boundary=.+/i), value: "payload",
    });
  } finally {
    await server.stop(true);
  }
});

test("HTTPS rejects an untrusted loopback certificate and accepts the explicit CA", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bun-tls-"));
  try {
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048",
      "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", key, "-out", cert]);
    if (!generated.success) throw new Error(generated.stderr.toString());
    const server = Bun.serve({ ...listen, tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch: () => new Response("trusted") });
    try {
      for (const tls of [undefined, { rejectUnauthorized: true }]) {
        await expect(fetch(server.url, { tls })).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
      }
      const response = await fetch(server.url, { tls: { ca: await Bun.file(cert).text(), rejectUnauthorized: true } });
      expect(await response.text()).toBe("trusted");
    } finally {
      await server.stop(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("s3 URLs expose method translation and return service error responses", async () => {
  const received: Array<[string, string, string]> = [];
  const denied = "<Error><Code>AccessDenied</Code></Error>";
  const server = Bun.serve({ ...listen, async fetch(request) {
    const path = new URL(request.url).pathname;
    received.push([request.method, path, await request.text()]);
    return path.endsWith("/denied")
      ? new Response(denied, { status: 403 })
      : new Response("stored");
  } });
  try {
    const s3 = localS3(server.url.origin);
    for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      const body = method === "GET" ? undefined : "payload";
      const response = await fetch("s3://bucket/key", { method, body, s3 });
      expect(response.status).toBe(200);
      expect(received.at(-1)).toEqual([method === "POST" ? "PUT" : method, "/bucket/key", body ?? ""]);
      await response.text();
    }
    const response = await fetch("s3://bucket/denied", { s3 });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(denied);
  } finally {
    await server.stop(true);
  }
});

test("s3 streaming upload initiates, uploads numbered parts, and completes", async () => {
  const events: string[] = [];
  const parts = new Map<number, number>();
  const server = Bun.serve({ ...listen, async fetch(request) {
    const query = new URL(request.url).searchParams;
    if (request.method === "POST" && query.has("uploads")) {
      events.push("init");
      return new Response("<InitiateMultipartUploadResult><UploadId>local</UploadId></InitiateMultipartUploadResult>");
    }
    if (query.get("uploadId") !== "local") return new Response(null, { status: 400 });
    if (request.method === "PUT") {
      events.push("part");
      const number = Number(query.get("partNumber"));
      parts.set(number, (await request.arrayBuffer()).byteLength);
      return new Response(null, { headers: { ETag: '"part-' + number + '"' } });
    }
    if (request.method === "POST") {
      events.push("complete");
      return new Response("<CompleteMultipartUploadResult><ETag>done</ETag></CompleteMultipartUploadResult>");
    }
    return new Response(null, { status: 400 });
  } });
  try {
    const mib = 1024 * 1024;
    const chunk = new Uint8Array(mib);
    let remaining = 12;
    const body = new ReadableStream({ pull(controller) {
      if (remaining-- > 0) controller.enqueue(chunk);
      else controller.close();
    } });
    const response = await fetch("s3://bucket/key", {
      method: "PUT", body, s3: { ...localS3(server.url.origin), partSize: 5 * mib },
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(events).toEqual(["init", "part", "part", "part", "complete"]);
    expect(Array.from(parts).sort(([a], [b]) => a - b)).toEqual([[1, 5 * mib], [2, 5 * mib], [3, 2 * mib]]);
  } finally {
    await server.stop(true);
  }
});
