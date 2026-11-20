/**
 * @file tests/bun_formats_and_utilities.test.ts
 * @description Measured contract for Bun's built-in Formats (`YAML`, `TOML`, `JSON5`,
 * `JSONC`, `JSONL`, `markdown`, native config imports) and built-in utilities
 * (`escapeHTML`, `stringWidth`, `stripANSI`, `sliceAnsi`, `wrapAnsi`, `color`,
 * `deepEquals`, `deepMatch`, `peek`, `randomUUIDv7`, `randomUUIDv5`, `zstd*`,
 * `concatArrayBuffers`, `ArrayBufferSink`, `readableStreamTo*`, `pathToFileURL`,
 * `fileURLToPath`, `Cookie`, `CookieMap`, `nanoseconds`, `hash.crc32`).
 *
 * @see https://bun.sh/#:~:text=Formats,40+%20utilities
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @bun-behavior: formats-and-utilities

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(enc.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("Bun built-in Formats & 40+ Utilities", () => {
  test("Bun.YAML parses objects, multi-doc streams, and anchors, and stringifies flow vs block", () => {
    const basic = Bun.YAML.parse(
      "name: sportsdesk\nports:\n  - 4020\n  - 4024\nenabled: true\n",
    );
    expect(basic).toEqual({
      name: "sportsdesk",
      ports: [4020, 4024],
      enabled: true,
    });

    const multiDoc = Bun.YAML.parse("---\na: 1\n---\nb: 2\n");
    expect(multiDoc).toEqual([{ a: 1 }, { b: 2 }]);

    const anchored = Bun.YAML.parse(
      "base: &b\n  k: 42\nchild:\n  <<: *b\n  extra: true\n",
    );
    expect(anchored).toEqual({
      base: { k: 42 },
      child: { k: 42, extra: true },
    });

    expect(Bun.YAML.stringify({ a: 1, b: [2, 3] })).toBe("{a: 1,b: [2,3]}");
    const block = Bun.YAML.stringify({ a: 1, b: [2, 3] }, null, 2);
    expect(block).toContain("a: 1");
    expect(block).toContain("- 2");
    expect(Bun.YAML.parse(block)).toEqual({ a: 1, b: [2, 3] });
  });

  test("Bun.TOML and native config module imports (.yaml, .toml, .json5, .jsonc) load onto .default", async () => {
    const parsed = Bun.TOML.parse('[desk]\nport = 4024\ntags = ["a", "b"]\n');
    expect(parsed).toEqual({ desk: { port: 4024, tags: ["a", "b"] } });

    const tomlApi = Bun.TOML as typeof Bun.TOML & {
      stringify?: (value: unknown) => string;
    };
    expect(typeof tomlApi.stringify).toBe("function");
    const serialized = tomlApi.stringify!({ desk: { port: 4024, ok: true } });
    expect(serialized).toContain("[desk]");
    expect(Bun.TOML.parse(serialized)).toEqual({
      desk: { port: 4024, ok: true },
    });

    const dir = mkdtempSync(join(tmpdir(), "bun-formats-imports-"));
    tempDirs.push(dir);
    writeFileSync(join(dir, "cfg.yaml"), "desk: ops\nport: 4024\n");
    writeFileSync(join(dir, "cfg.toml"), 'desk = "ops"\nport = 4024\n');
    writeFileSync(
      join(dir, "cfg.json5"),
      "{ // comment\n  desk: 'ops', port: 4024, }\n",
    );
    writeFileSync(
      join(dir, "cfg.jsonc"),
      '// comment\n{"desk": "ops", "port": 4024,}\n',
    );

    const yamlMod = (await import(join(dir, "cfg.yaml"))) as {
      default: unknown;
    };
    const tomlMod = (await import(join(dir, "cfg.toml"))) as {
      default: unknown;
    };
    const json5Mod = (await import(join(dir, "cfg.json5"))) as {
      default: unknown;
    };
    const jsoncMod = (await import(join(dir, "cfg.jsonc"))) as {
      default: unknown;
    };

    const expected = { desk: "ops", port: 4024 };
    expect(yamlMod.default).toEqual(expected);
    expect(tomlMod.default).toEqual(expected);
    expect(json5Mod.default).toEqual(expected);
    expect(jsoncMod.default).toEqual(expected);
  });

  test("Bun.JSON5, Bun.JSONC, and Bun.JSONL handle extended syntax and incremental chunks", () => {
    const j5 = Bun.JSON5.parse(
      "{ // line comment\n  unquoted: 0x10, inf: Infinity, negInf: -Infinity, nan: NaN, trailing: [1, 2,], }",
    ) as Record<string, unknown>;
    expect(j5.unquoted).toBe(16);
    expect(j5.inf).toBe(Infinity);
    expect(j5.negInf).toBe(-Infinity);
    expect(Number.isNaN(j5.nan as number)).toBe(true);
    expect(j5.trailing).toEqual([1, 2]);
    expect(Bun.JSON5.stringify({ a: 1, b: [2, 3] })).toBe("{a:1,b:[2,3]}");

    expect(Bun.JSONC.parse('/* block */\n{"a": 1, "b": [1, 2,],}')).toEqual({
      a: 1,
      b: [1, 2],
    });

    expect(Bun.JSONL.parse('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    const chunk = Bun.JSONL.parseChunk('{"a":1}\n{"b":');
    expect(chunk.values).toEqual([{ a: 1 }]);
    expect(chunk.done).toBe(false);
    expect(chunk.error).toBeNull();
    expect(chunk.read).toBeGreaterThan(0);
  });

  test("Bun.markdown renders GFM, toggles tagFilter on raw HTML, and runs render callbacks", () => {
    const gfm = Bun.markdown.html(
      "# Hi\n\n| A | B |\n| - | - |\n| ~~x~~ | `y` |\n\n- [x] done\nvisit https://bun.sh\n",
      { tables: true, strikethrough: true, tasklists: true, autolinks: true },
    );
    expect(gfm).toContain("<h1>Hi</h1>");
    expect(gfm).toContain("<table>");
    expect(gfm).toContain("<del>x</del>");
    expect(gfm).toContain("checkbox");
    expect(gfm).toContain('<a href="https://bun.sh">https://bun.sh</a>');

    expect(Bun.markdown.html("hi <script>x</script>")).toBe(
      "<p>hi <script>x</script></p>\n",
    );
    expect(
      Bun.markdown.html("hi <script>x</script>", { tagFilter: true }),
    ).toBe("<p>hi &lt;script>x&lt;/script></p>\n");

    expect(
      Bun.markdown.render("**bold**", {
        strong: (c) => `[B:${c}]`,
        paragraph: (c) => c,
      }),
    ).toBe("[B:bold]");
  });

  test("escapeHTML, stringWidth, stripANSI, sliceAnsi, wrapAnsi, and Bun.color work natively", () => {
    expect(Bun.escapeHTML(`<img src="x" onerror='1&2'>`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#x27;1&amp;2&#x27;&gt;",
    );
    expect(Bun.stringWidth("🚀")).toBe(2);
    expect(Bun.stringWidth("\x1b[31mhi\x1b[0m")).toBe(2);
    expect(Bun.stripANSI("\x1b[1;36mhello\x1b[0m")).toBe("hello");
    expect(Bun.sliceAnsi("\x1b[31mhello world\x1b[0m", 0, 5)).toBe(
      "\x1b[31mhello\x1b[39m",
    );
    expect(Bun.wrapAnsi("\x1b[32mhello world\x1b[0m", 5)).toBe(
      "\x1b[32mhello\x1b[39m\n\u001b[32mworld\u001b[0m",
    );
    expect(Bun.color("rgb(56, 189, 248)", "hex")).toBe("#38bdf8");
    expect(Bun.color("#38bdf8", "ansi-16m")).toBe("\x1b[38;2;56;189;248m");
  });

  test("deepEquals, deepMatch argument order, peek, and randomUUIDv5/v7 contracts hold", () => {
    expect(Bun.deepEquals({ a: 1, b: undefined }, { a: 1 }, false)).toBe(true);
    expect(Bun.deepEquals({ a: 1, b: undefined }, { a: 1 }, true)).toBe(false);

    // Bun.deepMatch expects (subset, object); reversing returns false.
    expect(Bun.deepMatch({ b: { c: 2 } }, { a: 1, b: { c: 2, d: 3 } })).toBe(
      true,
    );
    expect(Bun.deepMatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(
      false,
    );
    expect(Bun.deepMatch([{ a: 1 }], [{ a: 1, b: 2 }])).toBe(true);
    expect(Bun.deepMatch([1, 2], [1, 2, 3])).toBe(false);

    const fulfilled = Promise.resolve("ready");
    const pending = new Promise<string>(() => {});
    const rejected = Promise.reject(new Error("boom"));
    rejected.catch(() => {});

    expect(Bun.peek.status(fulfilled)).toBe("fulfilled");
    expect(Bun.peek(fulfilled)).toBe("ready");
    expect(Bun.peek.status(pending)).toBe("pending");
    expect(Bun.peek(pending)).toBe(pending);
    expect(Bun.peek.status(rejected)).toBe("rejected");
    const peekErr: unknown = Bun.peek(rejected);
    expect(peekErr).toBeInstanceOf(Error);
    if (peekErr instanceof Error) {
      expect(peekErr.message).toBe("boom");
    }
    expect(Bun.peek(123)).toBe(123);

    const fixedMs = 1_700_000_000_000;
    const u1 = Bun.randomUUIDv7("hex", fixedMs);
    const u2 = Bun.randomUUIDv7("hex", fixedMs);
    expect(u2 > u1).toBe(true);
    expect(typeof Bun.randomUUIDv7("base64url", fixedMs)).toBe("string");
    expect(Bun.randomUUIDv7("buffer", fixedMs).byteLength).toBe(16);

    const dnsNs = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    expect(Bun.randomUUIDv5("sportsdesk", "dns")).toBe(
      Bun.randomUUIDv5("sportsdesk", dnsNs),
    );
    expect(Bun.randomUUIDv5("https://bun.sh", "url")).not.toBe(
      Bun.randomUUIDv5("https://bun.sh", "dns"),
    );
  });

  test("zstd compression, binary accumulators, readableStreamTo*, URL, Cookie, nanoseconds, and crc32", async () => {
    const sample = new TextEncoder().encode("sportsdesk-ops ".repeat(20));
    const compressedSync = Bun.zstdCompressSync(sample, { level: 3 });
    expect(compressedSync.byteLength).toBeLessThan(sample.byteLength);
    expect(new Uint8Array(Bun.zstdDecompressSync(compressedSync))).toEqual(
      sample,
    );

    const compressedAsync = await Bun.zstdCompress(sample, { level: 3 });
    expect(new Uint8Array(await Bun.zstdDecompress(compressedAsync))).toEqual(
      sample,
    );

    const joined = Bun.concatArrayBuffers([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
    ]);
    expect([...new Uint8Array(joined)]).toEqual([1, 2, 3, 4]);

    const sink = new Bun.ArrayBufferSink();
    sink.start({ asUint8Array: true });
    sink.write("ab");
    sink.write(new Uint8Array([0x63]));
    expect([...(sink.end() as Uint8Array)]).toEqual([97, 98, 99]);

    expect(await Bun.readableStreamToText(makeStream(["o", "k"]))).toBe("ok");
    expect(await Bun.readableStreamToJSON(makeStream(['{"ok":true}']))).toEqual(
      { ok: true },
    );
    expect([...(await Bun.readableStreamToBytes(makeStream(["AB"])))]).toEqual([
      65, 66,
    ]);
    expect(
      (await Bun.readableStreamToArrayBuffer(makeStream(["xyz"]))).byteLength,
    ).toBe(3);
    expect(
      (await Bun.readableStreamToArray(makeStream(["a", "b"]))).length,
    ).toBe(2);
    expect((await Bun.readableStreamToBlob(makeStream(["abcd"]))).size).toBe(4);

    const fd = new FormData();
    fd.set("k", "v");
    const req = new Request("http://localhost", { method: "POST", body: fd });
    const ct = req.headers.get("content-type")!;
    const boundary = ct.split("boundary=")[1]!;
    const parsedMultipart = await Bun.readableStreamToFormData(
      req.body!,
      boundary,
    );
    expect(parsedMultipart.get("k")).toBe("v");

    const badReq = new Request("http://localhost", {
      method: "POST",
      body: fd,
    });
    await expect(
      Bun.readableStreamToFormData(badReq.body!, ct),
    ).rejects.toThrow(/boundary is too long/i);

    const urlEncoded = await Bun.readableStreamToFormData(
      makeStream(["a=1&b=two"]),
    );
    expect(urlEncoded.get("a")).toBe("1");
    expect(urlEncoded.get("b")).toBe("two");

    const fileUrl = Bun.pathToFileURL("/tmp/sportsdesk test.txt");
    expect(fileUrl.href).toContain("sportsdesk%20test.txt");
    expect(Bun.fileURLToPath(fileUrl)).toBe("/tmp/sportsdesk test.txt");

    const cookies = new Bun.CookieMap("a=1; b=two");
    expect(cookies.get("b")).toBe("two");
    const serializedCookie = new Bun.Cookie("sid", "abc", {
      httpOnly: true,
      sameSite: "lax",
    }).serialize();
    expect(serializedCookie).toContain("sid=abc");
    expect(serializedCookie).toContain("HttpOnly");
    expect(serializedCookie).toContain("SameSite=Lax");

    const t0 = Bun.nanoseconds();
    const t1 = Bun.nanoseconds();
    expect(typeof t0).toBe("number");
    expect(t1).toBeGreaterThanOrEqual(t0);
    expect(Bun.hash.crc32("hello")).toBe(Bun.hash.crc32("hello"));
    expect(typeof Bun.hash.crc32("hello")).toBe("number");
  });
});
