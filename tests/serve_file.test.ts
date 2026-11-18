/**
 * @file tests/serve_file.test.ts
 * @description `lib/serve_file.ts` against a real `Bun.serve`: every range form, validators, the
 * method guard and containment, asserted on the bytes that come back rather than on status alone.
 *
 * The 256 MB streaming case is not here — it measures resident memory, which is a benchmark, not a
 * regression. What is here is the contract each header makes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createServeFile,
  entityTag,
  ifRangeMatches,
  MAX_RANGES,
  mimeFor,
  parseByteRange,
} from "../lib/serve_file.ts";

const SIZE = 4096;
const CONTENT = new Uint8Array(SIZE).map((_, index) => index % 256);
const SECRET = "do not serve me";

let dir: string;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "serve-file-"));
  mkdirSync(join(dir, "media"), { recursive: true });
  mkdirSync(join(dir, "outside"), { recursive: true });
  await Bun.write(join(dir, "media", "video.mp4"), CONTENT);
  await Bun.write(join(dir, "media", ".env"), "SECRET=1\n");
  await Bun.write(join(dir, "outside", "secret.txt"), SECRET);
  symlinkSync(
    join(dir, "outside", "secret.txt"),
    join(dir, "media", "escape.txt"),
  );

  const serve = createServeFile({ root: join(dir, "media") });
  server = Bun.serve({
    port: 0,
    fetch: (req) => serve(req, new URL(req.url)),
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

const mediaUrl = (path: string): URL => new URL(path, server.url);

const bodyOf = async (response: Response): Promise<Uint8Array> =>
  new Uint8Array(await response.arrayBuffer());

describe("a plain read", () => {
  test("serves the whole file with a validator and advertises seekability", async () => {
    const response = await fetch(mediaUrl("/video.mp4"));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual(CONTENT);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(response.headers.get("last-modified")).not.toBeNull();
    expect(response.headers.get("content-disposition")).toBe("inline");
  });

  test("answers HEAD with the length and no body", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    expect(await bodyOf(response)).toHaveLength(0);
  });

  test("revalidates an unchanged file with 304", async () => {
    const first = await fetch(mediaUrl("/video.mp4"));
    const etag = first.headers.get("etag") ?? "";
    const cached = await fetch(mediaUrl("/video.mp4"), {
      headers: { "If-None-Match": etag },
    });
    expect(cached.status).toBe(304);
    expect(await bodyOf(cached)).toHaveLength(0);
  });
});

describe("a single range", () => {
  test("returns exactly the requested bytes", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-1023" },
    });
    expect(response.status).toBe(206);
    expect(await bodyOf(response)).toEqual(CONTENT.slice(0, 1024));
    expect(response.headers.get("content-range")).toBe(`bytes 0-1023/${SIZE}`);
    expect(response.headers.get("content-length")).toBe("1024");
    // Single-valued: delegating the range to Bun appends a second Accept-Ranges.
    expect(response.headers.get("accept-ranges")).toBe("bytes");
  });

  test("resolves a suffix range against the end of the file", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=-500" },
    });
    expect(response.status).toBe(206);
    expect(await bodyOf(response)).toEqual(CONTENT.slice(SIZE - 500));
    expect(response.headers.get("content-range")).toBe(
      `bytes ${SIZE - 500}-${SIZE - 1}/${SIZE}`,
    );
  });

  test("resolves an open-ended range", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=3000-" },
    });
    expect(response.status).toBe(206);
    expect(await bodyOf(response)).toEqual(CONTENT.slice(3000));
  });

  test("answers a range past EOF with 416 and no body", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=99999-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${SIZE}`);
    expect(await bodyOf(response)).toHaveLength(0);
  });

  test("mirrors a ranged HEAD in the headers without sending bytes", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      method: "HEAD",
      headers: { Range: "bytes=0-1023" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("1024");
    expect(await bodyOf(response)).toHaveLength(0);
  });
});

describe("If-Range", () => {
  test("keeps the range when the validator still matches", async () => {
    const { headers } = await fetch(mediaUrl("/video.mp4"));
    const etag = headers.get("etag") ?? "";
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-9", "If-Range": etag },
    });
    expect(response.status).toBe(206);
    expect(await bodyOf(response)).toEqual(CONTENT.slice(0, 10));
  });

  test("falls back to the whole file when the validator is stale", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-9", "If-Range": '"stale"' },
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual(CONTENT);
  });
});

describe("If-Modified-Since", () => {
  // The file is untouched until the "validators track the file" block below.
  const lastModified = async (): Promise<string> => {
    const response = await fetch(mediaUrl("/video.mp4"));
    return response.headers.get("last-modified") ?? "";
  };

  test("answers 304 when the file has not changed since the given date", async () => {
    const since = await lastModified();
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { "If-Modified-Since": since },
    });
    expect(response.status).toBe(304);
    expect(await bodyOf(response)).toHaveLength(0);
  });

  test("answers 200 when the file is newer than the given date", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { "If-Modified-Since": new Date(0).toUTCString() },
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual(CONTENT);
  });

  test("ignores an unparseable date instead of failing the read", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { "If-Modified-Since": "not-a-date" },
    });
    expect(response.status).toBe(200);
  });

  test("If-None-Match outranks If-Modified-Since", async () => {
    const since = await lastModified();
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: {
        "If-None-Match": '"some-other-file"',
        "If-Modified-Since": since,
      },
    });
    expect(response.status).toBe(200);
  });

  test("If-None-Match: * matches any current representation", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { "If-None-Match": "*" },
    });
    expect(response.status).toBe(304);
  });
});

describe("If-Range by date", () => {
  test("serves the range when the date has not passed", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: {
        Range: "bytes=0-9",
        "If-Range": new Date(Date.now() + 60_000).toUTCString(),
      },
    });
    expect(response.status).toBe(206);
    expect(await bodyOf(response)).toEqual(CONTENT.slice(0, 10));
  });

  test("sends the whole file when the date predates the file", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-9", "If-Range": new Date(0).toUTCString() },
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual(CONTENT);
  });

  test("ifRangeMatches rejects weak and unmatched entity-tags", () => {
    const mtime = 1_700_000_000_000;
    const etag = entityTag(4096, mtime);
    expect(ifRangeMatches(etag, etag, mtime)).toBe(true);
    expect(ifRangeMatches('"other"', etag, mtime)).toBe(false);
    expect(ifRangeMatches(`W/${etag}`, etag, mtime)).toBe(false);
    expect(ifRangeMatches("not-a-date", etag, mtime)).toBe(false);
    expect(
      ifRangeMatches(new Date(mtime + 5_000).toUTCString(), etag, mtime),
    ).toBe(true);
    expect(
      ifRangeMatches(new Date(mtime - 5_000).toUTCString(), etag, mtime),
    ).toBe(false);
  });
});

describe("multiple ranges", () => {
  test("answers with multipart/byteranges carrying each requested range", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-1,2000-2003" },
    });
    expect(response.status).toBe(206);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toStartWith("multipart/byteranges; boundary=");
    // A streamed body is chunked, so a Content-Length here would be a promise Bun does not keep.
    const declared = response.headers.get("content-length");
    const body = await bodyOf(response);
    if (declared !== null) expect(declared).toBe(String(body.byteLength));

    const boundary = contentType.split("boundary=")[1] ?? "";
    const parts = new TextDecoder("latin1")
      .decode(body)
      .split(`--${boundary}`)
      .filter((chunk) => chunk.trim() !== "" && chunk.trim() !== "--");
    expect(parts).toHaveLength(2);

    const [first, second] = parts.map((part) => {
      const split = part.indexOf("\r\n\r\n");
      return { head: part.slice(0, split), body: part.slice(split + 4) };
    });
    expect(first?.head).toContain(`Content-Range: bytes 0-1/${SIZE}`);
    expect(first?.body).toBe(
      new TextDecoder("latin1").decode(CONTENT.slice(0, 2)),
    );
    expect(second?.head).toContain(`Content-Range: bytes 2000-2003/${SIZE}`);
    expect(second?.body).toBe(
      new TextDecoder("latin1").decode(CONTENT.slice(2000, 2004)),
    );
  });

  test("ignores a spec past the range cap instead of expanding it", async () => {
    const spec = Array.from(
      { length: MAX_RANGES + 1 },
      (_, index) => `${index * 10}-${index * 10 + 1}`,
    ).join(",");
    const response = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: `bytes=${spec}` },
    });
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual(CONTENT);
  });
});

describe("guards", () => {
  test("refuses everything but GET and HEAD", async () => {
    const response = await fetch(mediaUrl("/video.mp4"), { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  for (const path of [
    "/nope.mp4",
    "/.env",
    "/../outside/secret.txt",
    "/%2e%2e%2foutside%2fsecret.txt",
    "/escape.txt",
    "/",
  ]) {
    test(`does not serve ${path}`, async () => {
      const response = await fetch(mediaUrl(path));
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(SECRET);
    });
  }
});

describe("validators track the file", () => {
  test("a rewrite changes the ETag and stops If-Range splicing", async () => {
    const before =
      (await fetch(mediaUrl("/video.mp4"))).headers.get("etag") ?? "";
    const replacement = new Uint8Array(9000).fill(7);
    await Bun.write(join(dir, "media", "video.mp4"), replacement);

    const spliced = await fetch(mediaUrl("/video.mp4"), {
      headers: { Range: "bytes=0-9", "If-Range": before },
    });
    expect(spliced.status).toBe(200);
    expect(await bodyOf(spliced)).toEqual(replacement);

    const after = (await fetch(mediaUrl("/video.mp4"))).headers.get("etag");
    expect(after).not.toBe(before);
  });
});

describe("pure helpers", () => {
  test("mimeFor prefers overrides and falls back to octet-stream", () => {
    expect(mimeFor("/x/clip.mp4")).toBe("video/mp4");
    expect(mimeFor("/x/clip.MP4")).toBe("video/mp4");
    expect(mimeFor("/x/clip.mp4", { ".mp4": "application/mp4" })).toBe(
      "application/mp4",
    );
    expect(mimeFor("/x/clip.unknownext")).toBe("application/octet-stream");
  });

  test("parseByteRange distinguishes ignore from unsatisfiable", () => {
    expect(parseByteRange("items=0-1", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=9-2", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=20-30", 10)).toEqual({
      kind: "unsatisfiable",
    });
    expect(parseByteRange("bytes=20-30,40-50", 10)).toEqual({
      kind: "unsatisfiable",
    });
  });

  test("parseByteRange clamps an end past EOF and keeps a satisfiable sibling", () => {
    expect(parseByteRange("bytes=5-999", 10)).toEqual({
      kind: "ranges",
      ranges: [{ start: 5, end: 9 }],
    });
    expect(parseByteRange("bytes=50-60,0-1", 10)).toEqual({
      kind: "ranges",
      ranges: [{ start: 0, end: 1 }],
    });
    expect(parseByteRange("bytes=-0", 10)).toEqual({ kind: "ignore" });
    expect(parseByteRange("bytes=-100", 10)).toEqual({
      kind: "ranges",
      ranges: [{ start: 0, end: 9 }],
    });
  });

  test("entityTag is stable for the same size and mtime", () => {
    expect(entityTag(4096, 1_700_000_000_000)).toBe(
      entityTag(4096, 1_700_000_000_000),
    );
    expect(entityTag(4096, 1_700_000_000_000)).not.toBe(
      entityTag(4096, 1_700_000_000_001),
    );
  });
});
