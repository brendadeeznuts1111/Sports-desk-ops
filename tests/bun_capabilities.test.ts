import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * Guards the runtime surface the capture and docs tooling actually calls.
 *
 * A Bun downgrade or a stripped build should fail here rather than halfway through a capture run.
 * Presence and contract checks: this never opens a socket or a database.
 *
 * The type surface is pinned to `bun-types` 1.4.4, which is not the same file bun.com/reference
 * renders. Where the two disagree, the test records which layer wins instead of leaving the next
 * reader to rediscover it.
 */
describe("Bun capabilities used by the ops tooling", () => {
  test("version floor", () => {
    expect(Bun.semver.satisfies(Bun.version, ">=1.4.4-0")).toBe(true);
  });

  test("network primitives exist", () => {
    expect(typeof Bun.fetch).toBe("function");
    expect(typeof Bun.serve).toBe("function");
    expect(typeof Bun.connect).toBe("function");
    expect(typeof Bun.listen).toBe("function");
    expect(typeof Bun.udpSocket).toBe("function");
    expect(typeof Bun.FetchSession).toBe("function");
    expect(typeof WebSocket).toBe("function");
  });

  test("node:crypto argon2 is RFC 9106-correct at production parameters", async () => {
    // v1.4.1 shipped argon2 in node:crypto; bin/bun_surface.ts pins it as "compat". This is a
    // known-answer check, not a length check: the RFC 9106 Argon2id vector (message 0x01 x32,
    // nonce 0x02 x16, secret 0x03 x8, associated data 0x04 x12, t=3, m=32 KiB, p=4, tag 32).
    const crypto = (await import("node:crypto")) as unknown as Record<
      string,
      unknown
    >;
    const argon2Sync = crypto["argon2Sync"] as
      | ((algorithm: string, options: Record<string, unknown>) => Buffer)
      | undefined;
    const randomBytes = crypto["randomBytes"] as (size: number) => Buffer;
    expect(typeof argon2Sync).toBe("function");

    const rfcTag = argon2Sync!("argon2id", {
      message: Buffer.alloc(32, 1),
      nonce: Buffer.alloc(16, 2),
      secret: Buffer.alloc(8, 3),
      associatedData: Buffer.alloc(12, 4),
      parallelism: 4,
      tagLength: 32,
      memory: 32,
      passes: 3,
    });
    expect(rfcTag.toString("hex")).toBe(
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    );

    // Production shape: OWASP-style Argon2id (19 MiB, t=2, p=1) with a 16-byte nonce. The tag is
    // deterministic for a stored nonce and changes when the nonce does.
    const nonce = randomBytes(16);
    const options = {
      message: "pw",
      nonce,
      parallelism: 1,
      tagLength: 32,
      memory: 19_456,
      passes: 2,
    };
    const first = argon2Sync!("argon2id", options);
    const second = argon2Sync!("argon2id", options);
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(true);
    expect(
      argon2Sync!("argon2id", {
        ...options,
        nonce: randomBytes(16),
      }).equals(first),
    ).toBe(false);
  });

  test("the WebSocket client extension exposes pause/resume", () => {
    const socket = WebSocket.prototype as unknown as Record<string, unknown>;
    expect(typeof socket["pause"]).toBe("function");
    expect(typeof socket["resume"]).toBe("function");
  });

  test("DNS resolution is available for the capture preflight", () => {
    // `Bun.dns.lookup` is the call `capture:preflight` depends on; verify it exists in this build.
    // `resolve` is present at runtime but missing from the 1.4.4 type surface, hence the cast.
    const dns = Bun.dns as unknown as Record<string, unknown>;
    expect(typeof dns["lookup"]).toBe("function");
    expect(typeof dns["resolve"]).toBe("function");
  });

  test("storage and parsing APIs exist", () => {
    expect(typeof Bun.SQL).toBe("function");
    expect(typeof Bun.S3Client).toBe("function");
    expect(typeof Bun.RedisClient).toBe("function");
    expect(typeof Bun.cron).toBe("function");
    expect(typeof Bun.Image).toBe("function");
    expect(typeof Bun.CookieMap).toBe("function");
    expect(typeof Bun.secrets.get).toBe("function");
    expect(typeof Bun.JSONL.parse).toBe("function");
    expect(typeof HTMLRewriter).toBe("function");
  });

  test("primitives bun.com files under Bun.* are globals", () => {
    // /reference/bun lists "class Bun.WebSocket", "Bun.Worker" and "Bun.EventSource".
    // None of them is a property of `Bun` at runtime; the first two are globals. Assert both
    // directions so a future release that does hang them off `Bun` fails here, not in webview.ts.
    const bun = Bun as unknown as Record<string, unknown>;
    expect(typeof globalThis.WebSocket).toBe("function");
    expect(typeof globalThis.Worker).toBe("function");
    expect(bun["WebSocket"]).toBeUndefined();
    expect(bun["Worker"]).toBeUndefined();
  });

  test("Image error codes the fallback branches on are typed", () => {
    // The 1.4.4 binary knows ERR_OUT_OF_MEMORY — the literal is in the executable and the
    // reference page lists it — but bun-types 1.4.4 stops at six codes, so comparing against it
    // is TS2367 ("no overlap") and needs a cast. This switch is the tripwire: the day the
    // installed declarations grow a member, `bun check` fails here and `ImageErrorCode` in
    // lib/image_errors.ts drops its ERR_OUT_OF_MEMORY addition.
    const codeOf = (code: Bun.Image.ErrorCode): string => {
      switch (code) {
        case "ERR_IMAGE_FORMAT_UNSUPPORTED":
        case "ERR_IMAGE_TOO_MANY_PIXELS":
        case "ERR_IMAGE_DECODE_FAILED":
        case "ERR_IMAGE_ENCODE_FAILED":
        case "ERR_IMAGE_UNKNOWN_FORMAT":
        case "ERR_INVALID_STATE":
          return code;
        default: {
          const unhandled: never = code;
          return unhandled;
        }
      }
    };
    expect(codeOf("ERR_IMAGE_UNKNOWN_FORMAT")).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
  });

  test("placeholder() reflects the source, not the pipeline", async () => {
    // `placeholder()` is a terminal over the *source*: chaining resize before it changes nothing.
    // Guarded because dx shot builds its blur previews from it and the docs state it in a comment
    // only, not in a signature.
    const file = Bun.file(
      "docs/assets/pipeline-per-office-ip-and-reconciliation.png",
    );
    if (!(await file.exists())) return; // doc assets are regenerated by a separate gate
    const { width, height } = await file.image().metadata();
    const url = await file
      .image()
      .resize(1, 200, { fit: "fill" })
      .placeholder();
    const png = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    const blurAspect = png.readUInt32BE(16) / png.readUInt32BE(20);
    expect(Math.abs(blurAspect - width / height)).toBeLessThan(0.15);
  });

  test("Bun.build plugin onLoad returns contents and loader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-plugin-load-"));
    try {
      const entry = join(dir, "entry.ts");
      await Bun.write(
        entry,
        'import { answer } from "virtual:answer";\nconsole.log(answer);\n',
      );

      const build = await Bun.build({
        entrypoints: [entry],
        target: "bun",
        plugins: [
          {
            name: "virtual-answer",
            setup(build) {
              build.onResolve({ filter: /^virtual:/ }, (args) => ({
                path: args.path,
                namespace: "virtual",
              }));
              build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
                contents: new TextEncoder().encode("export const answer = 42;"),
                loader: "ts",
              }));
            },
          },
        ],
      });

      expect(build.success).toBe(true);
      expect(await build.outputs[0]!.text()).toContain("42");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FileSystemRouter applies nextjs options and scriptSrc", () => {
    // An in-process `Bun.build()` switches a process-global asset mode: every router constructed
    // afterwards reports `scriptSrc` as `origin + "/abs:" + filePath` instead of the
    // assetPrefix-relative path. Run the probe in a child so this pins the documented contract and
    // keeps passing if Bun stops leaking that state.
    const probe = `
      const { mkdtempSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const dir = mkdtempSync(join(tmpdir(), "bun-fs-router-"));
      try {
        writeFileSync(join(dir, "index.tsx"), "export default 1;");
        writeFileSync(join(dir, "about.tsx"), "export default 2;");
        writeFileSync(join(dir, "ignored.js"), "export default 3;");
        const router = new Bun.FileSystemRouter({
          style: "nextjs",
          dir,
          origin: "https://example.test",
          assetPrefix: "/static/",
          fileExtensions: [".tsx"],
        });
        const about = router.match("/about");
        const noOrigin = new Bun.FileSystemRouter({
          style: "nextjs",
          dir,
          fileExtensions: [".tsx"],
        });
        console.log(JSON.stringify({
          dir: realpathSync(dir),
          missing: router.match("/missing"),
          filePath: about === null ? null : about.filePath,
          kind: about === null ? null : about.kind,
          scriptSrc: about === null ? null : about.scriptSrc,
          assetPrefix: router.assetPrefix,
          queryZero: router.match("/?0=a")?.query ?? null,
          origin: router.origin,
          noOrigin: noOrigin.origin,
        }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    `;
    const child = Bun.spawnSync([process.execPath, "-e", probe], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = child.stdout.toString().trim();
    const stderr = child.stderr.toString().trim();
    expect({ code: child.exitCode, stderr }).toEqual({ code: 0, stderr: "" });

    const result = JSON.parse(stdout) as {
      dir: string;
      missing: unknown;
      filePath: string;
      kind: string;
      scriptSrc: string;
      assetPrefix: string | null;
      queryZero: Record<string, string> | null;
      origin: string | null;
      noOrigin: string | null;
    };
    expect(result.missing).toBeNull();
    expect(result.filePath).toBe(join(result.dir, "about.tsx"));
    expect(result.kind).toBe("exact");
    expect(result.scriptSrc).toBe("https://example.test/static/about.tsx");
    // Next-release fixes: assetPrefix is exposed (was always undefined), and a
    // numeric-only query key is not listed twice.
    expect(result.assetPrefix).toBe("/static/");
    expect(result.queryZero).toEqual({ "0": "a" });
    // Next-release types fix: origin is `string | null`, not always a string.
    expect(result.origin).toBe("https://example.test");
    expect(result.noOrigin).toBeNull();
  });

  test("StructuredSerializeOptions transfer detaches the source buffer", async () => {
    const source = new ArrayBuffer(8);
    new Uint8Array(source).set([1, 2, 3]);
    const clone = structuredClone({ buffer: source }, { transfer: [source] });
    expect(source.byteLength).toBe(0);
    expect([...new Uint8Array(clone.buffer)]).toEqual([1, 2, 3, 0, 0, 0, 0, 0]);

    const channel = new MessageChannel();
    try {
      const sent = new ArrayBuffer(4);
      const received = new Promise<{ buffer: ArrayBuffer }>((resolve) => {
        channel.port1.onmessage = (event) => resolve(event.data);
      });
      channel.port2.postMessage({ buffer: sent }, { transfer: [sent] });
      const message = await received;
      expect(sent.byteLength).toBe(0);
      expect(message.buffer.byteLength).toBe(4);
    } finally {
      channel.port1.close();
    }
  });

  test("MessagePort travels through StructuredSerializeOptions.transfer", async () => {
    const carrier = new MessageChannel();
    const transferred = new MessageChannel();
    try {
      const received = new Promise<MessagePort>((resolve, reject) => {
        carrier.port2.onmessage = (event) => {
          const port = event.ports[0];
          if (port) resolve(port);
          else reject(new Error("transfer delivered no MessagePort"));
        };
      });
      carrier.port1.postMessage(null, { transfer: [transferred.port2] });

      const port = await received;
      try {
        expect(port).toBeInstanceOf(MessagePort);
        const reply = new Promise((resolve) => {
          port.onmessage = (event) => resolve(event.data);
        });
        transferred.port1.postMessage("hello");
        expect(await reply).toBe("hello");
      } finally {
        port.close();
        transferred.port1.close();
      }
    } finally {
      carrier.port1.close();
    }
  });

  test("GenericTransformStream exposes readable and writable", () => {
    const stream = new CompressionStream("gzip");
    expect(stream.readable).toBeInstanceOf(ReadableStream);
    expect(stream.writable).toBeInstanceOf(WritableStream);
  });

  test("AddEventListenerOptions once, passive and signal are honored", () => {
    const target = new EventTarget();
    let once = 0;
    target.addEventListener("once", () => (once += 1), { once: true });
    target.dispatchEvent(new Event("once"));
    target.dispatchEvent(new Event("once"));
    expect(once).toBe(1);

    let passive = 0;
    target.addEventListener("passive", () => (passive += 1), { passive: true });
    target.dispatchEvent(new Event("passive"));
    expect(passive).toBe(1);

    const controller = new AbortController();
    let signalled = 0;
    target.addEventListener("signal", () => (signalled += 1), {
      signal: controller.signal,
    });
    target.dispatchEvent(new Event("signal"));
    controller.abort();
    target.dispatchEvent(new Event("signal"));
    expect(signalled).toBe(1);
  });

  test("direct ReadableStream source writes and closes", async () => {
    const source: Bun.DirectUnderlyingSource<Uint8Array> = {
      type: "direct",
      async pull(controller) {
        await controller.write(new TextEncoder().encode("hello"));
        controller.close();
      },
    };
    const stream = new ReadableStream<Uint8Array>(source as never);
    const bytes = await Bun.readableStreamToArrayBuffer(stream);
    expect(new TextDecoder().decode(bytes)).toBe("hello");
  });

  test("readableStreamToArrayBuffer concatenates typed chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const buffer = await Bun.readableStreamToArrayBuffer(stream);
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3, 4, 5]);

    const empty = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    expect((await Bun.readableStreamToArrayBuffer(empty)).byteLength).toBe(0);
  });

  test("GlobScanOptions defaults exclude dotfiles, symlinked dirs and directories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-glob-options-"));
    try {
      mkdirSync(join(dir, "real", "sub"), { recursive: true });
      await Bun.write(join(dir, "real", "sub", "a.txt"), "x");
      await Bun.write(join(dir, ".hidden"), "x");
      symlinkSync("real", join(dir, "linkdir"));
      symlinkSync("missing", join(dir, "broken"));

      const list = async (options: Bun.GlobScanOptions): Promise<string[]> => {
        const out: string[] = [];
        for await (const rel of new Bun.Glob("**/*").scan({
          cwd: dir,
          ...options,
        })) {
          out.push(rel);
        }
        return out.sort();
      };

      expect(await list({})).toEqual(["real/sub/a.txt"]);
      expect(await list({ dot: true })).toContain(".hidden");
      expect(await list({ followSymlinks: true })).toContain(
        "linkdir/sub/a.txt",
      );
      expect(await list({ followSymlinks: false })).not.toContain(
        "linkdir/sub/a.txt",
      );
      const all = await list({ onlyFiles: false });
      expect(all).toContain("real");
      expect(all).toContain("linkdir");
      expect(all).toContain("broken");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // bun.sh/docs/runtime/glob#supported-glob-patterns — every case is a documented example,
  // measured against 1.4.4. Pattern *syntax* is pinned here because a Bun upgrade that changes
  // glob parsing fails loudly instead of silently matching nothing in a capture scan; the
  // option defaults are pinned by the test above.
  test("Glob pattern syntax covers the documented wildcard set", () => {
    const matches = (pattern: string, path: string): boolean =>
      new Bun.Glob(pattern).match(path);

    // ? * ** and bracket classes, including ranges and negation
    expect(matches("???.ts", "foo.ts")).toBe(true);
    expect(matches("???.ts", "foobar.ts")).toBe(false);
    expect(matches("*.ts", "src/index.ts")).toBe(false);
    expect(matches("**/*.ts", "index.ts")).toBe(true);
    expect(matches("**/*.ts", "src/index.ts")).toBe(true);
    expect(matches("ba[rz].ts", "baz.ts")).toBe(true);
    expect(matches("ba[rz].ts", "bat.ts")).toBe(false);
    expect(matches("ba[!a-z].ts", "ba1.ts")).toBe(true);
    expect(matches("ba[!a-z].ts", "bax.ts")).toBe(false);
    // `[^…]` and `[!…]` are the same negation.
    expect(matches("a[^bc].ts", "ad.ts")).toBe(true);
    expect(matches("a[^bc].ts", "ab.ts")).toBe(false);

    // Parentheses are literal without an extended-glob prefix: this is a directory
    // named `(marketing)`, not an alternation.
    expect(matches("app/(marketing)/**", "app/(marketing)/x.ts")).toBe(true);
    expect(matches("app/(marketing)/**", "app/marketing/x.ts")).toBe(false);

    // braces: alternatives, nesting, numeric ranges, zero padding, step, letter range
    expect(matches("{a,b,c}.ts", "c.ts")).toBe(true);
    expect(matches("{a,b,c}.ts", "d.ts")).toBe(false);
    expect(matches("{a,{b,c}}.ts", "c.ts")).toBe(true);
    expect(matches("v{1..3}.ts", "v2.ts")).toBe(true);
    expect(matches("v{1..9..2}.ts", "v5.ts")).toBe(true);
    expect(matches("v{1..9..2}.ts", "v6.ts")).toBe(false);
    expect(matches("v{01..10}.ts", "v07.ts")).toBe(true);
    expect(matches("v{a..e}.ts", "vc.ts")).toBe(true);

    // extended globs: zero-or-one, one-or-more, zero-or-more, exactly-one, negation
    expect(matches("?(a|b).ts", ".ts")).toBe(true);
    expect(matches("?(a|b).ts", "a.ts")).toBe(true);
    expect(matches("?(a|b).ts", "ab.ts")).toBe(false);
    expect(matches("+(a|b).ts", "ab.ts")).toBe(true);
    expect(matches("*(a|b).ts", "abba.ts")).toBe(true);
    expect(matches("@(a|b).ts", "c.ts")).toBe(false);
    expect(matches("!(a|b).ts", "c.ts")).toBe(true);
    expect(matches("!(a|b).ts", "a.ts")).toBe(false);

    // 1.4.4 documented examples: nested negative group and path-segment alternation.
    expect(matches("**/!(*.test).ts", "src/cart.ts")).toBe(true);
    expect(matches("**/!(*.test).ts", "src/cart.test.ts")).toBe(false);
    expect(matches("src/@(app|lib)/**/*.ts", "src/app/a/b.ts")).toBe(true);
    expect(matches("shard-{1..3}.json", "shard-2.json")).toBe(true);

    // Literal-looking groups now parse as extglob: copy(1).txt no longer matches.
    expect(matches("*(1).txt", "1.txt")).toBe(true);
    expect(matches("*(1).txt", "copy(1).txt")).toBe(false);

    // A leading negative extglob is a pattern; it is not a package-negation string.
    expect(matches("!(g)/a.ts", "x/a.ts")).toBe(true);
    expect(matches("!(g)/a.ts", "g/a.ts")).toBe(false);

    // v1.4.3 → v1.4.4 migration: bracket-class the paren to retain the old literal match.
    expect(matches("*[(]1).txt", "copy(1).txt")).toBe(true);
    expect(matches("*[(]1).txt", "1.txt")).toBe(false);
    expect(matches("*\\{1..3\\}.txt", "x{1..3}.txt")).toBe(true);

    // Patterns changed; paths are still literal, so ordinary globs match these names.
    expect(matches("**/*.ts", "src/copy(1).ts")).toBe(true);
    expect(matches("**/*.ts", "src/{1..3}.ts")).toBe(true);
    expect(matches("**/*.ts", "src/!(g).ts")).toBe(true);

    // A leading `!` negates the whole pattern: it matches what the inner pattern does not.
    // Both inputs must be tested, or a `.ts`-vs-`.ts` pair looks like "matches nothing".
    expect(matches("!*.ts", "a.ts")).toBe(false);
    expect(matches("!*.ts", "b.js")).toBe(true);

    // `\` escapes a glob metacharacter, so this matches a literal `*` in the name.
    expect(matches("a\\*b.ts", "a*b.ts")).toBe(true);
    expect(matches("a\\*b.ts", "axb.ts")).toBe(false);

    // `match()` is a pure string test — it takes no scan options, so no `dot` policy.
    // These match even though `scan({ dot: false })` never returns them.
    expect(matches("**/*", ".env")).toBe(true);
    expect(matches("**/*", ".github/ci.yml")).toBe(true);
  });

  // The `**/` segment matching zero directories is the case tooling assumes and rarely asserts:
  // a scan rooted at a directory with files but no subdirectories must still find them.
  test("** matches root-level files during scan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-glob-root-"));
    try {
      await Bun.write(join(dir, "top.txt"), "x");
      mkdirSync(join(dir, "nested"), { recursive: true });
      await Bun.write(join(dir, "nested", "inner.txt"), "x");
      const found: string[] = [];
      for await (const rel of new Bun.Glob("**/*.txt").scan({ cwd: dir })) {
        found.push(rel);
      }
      expect(found.sort()).toEqual(["nested/inner.txt", "top.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FileSink accepts highWaterMark and end() flushes the write", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-filesink-"));
    try {
      const path = join(dir, "sink.txt");
      const sink = Bun.file(path).writer({ highWaterMark: 8 });
      const written = sink.write("x".repeat(1024));
      if (written instanceof Promise) await written;
      const ended = sink.end();
      if (ended instanceof Promise) await ended;

      expect(await Bun.file(path).text()).toHaveLength(1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ArrayBufferSink highWaterMark preallocates without stream mode", () => {
    const sink = new Bun.ArrayBufferSink();
    sink.start({ asUint8Array: true, highWaterMark: 64 * 1024 });
    sink.write("hello");
    sink.write(new Uint8Array([0x20, 0x77]));
    const out = sink.end() as Uint8Array;
    expect(new TextDecoder().decode(out)).toBe("hello w");
  });

  test("ArrayBufferSink flush returns chunks only in stream mode", () => {
    const sink = new Bun.ArrayBufferSink();
    sink.start({ stream: true, highWaterMark: 1024 });
    sink.write("hel");
    const first = sink.flush();
    expect(first).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(first as ArrayBuffer)).toBe("hel");
    sink.write("lo");
    const second = sink.flush();
    expect(new TextDecoder().decode(second as ArrayBuffer)).toBe("lo");
  });

  test("ArrayBufferSink write accepts string, typed array, ArrayBuffer and SharedArrayBuffer", () => {
    const sink = new Bun.ArrayBufferSink();
    sink.start({ asUint8Array: true });
    sink.write("hello ");
    sink.write(new Uint8Array([0x77, 0x6f])); // wo
    const arrayBuffer = new Uint8Array([0x72, 0x6c]).buffer as ArrayBuffer; // rl
    sink.write(arrayBuffer);
    const shared = new SharedArrayBuffer(2);
    new Uint8Array(shared).set([0x64, 0x21]); // d!
    sink.write(shared);
    expect(new TextDecoder().decode(sink.end() as Uint8Array)).toBe(
      "hello world!",
    );
  });

  test("ArrayBufferSink stream flush honors asUint8Array and accepts more writes", () => {
    const sink = new Bun.ArrayBufferSink();
    sink.start({ stream: true, asUint8Array: true, highWaterMark: 1024 });
    sink.write("hel");
    const first = sink.flush();
    expect(first).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(first as Uint8Array)).toBe("hel");
    sink.write("lo");
    const second = sink.flush();
    expect(new TextDecoder().decode(second as Uint8Array)).toBe("lo");
    sink.write("!");
    expect(new TextDecoder().decode(sink.end() as Uint8Array)).toBe("!");
  });

  test("BunFile.slice is lazy, does not open a missing file, and does not clamp size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunfile-slice-lazy-"));
    try {
      const path = join(dir, "bytes.txt");
      await Bun.write(path, "abcdef");
      const scoped = Bun.file(path).slice(0, 3);
      await Bun.write(path, "xyz123");
      expect(await scoped.text()).toBe("xyz"); // lazy read, not a copy

      const beyond = Bun.file(path).slice(2, 100);
      expect(await beyond.text()).toBe("z123");
      // 1.4.4 reports the requested span (98), not the clamped file length (4).
      expect(beyond.size).toBe(98);

      const missing = Bun.file(join(dir, "missing.txt")).slice(0, 5);
      expect(await missing.exists()).toBe(false);
      await expect(missing.text()).rejects.toThrow(/ENOENT/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("BunFile.slice treats end as an absolute byte offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bunfile-slice-"));
    try {
      const path = join(dir, "bytes.txt");
      await Bun.write(path, "abcdefghij");

      expect(await Bun.file(path).slice(2, 5).text()).toBe("cde");
      expect(await Bun.file(path).slice(0, 5).text()).toBe("abcde");
      expect(await Bun.file(path).slice(2).text()).toBe("cdefghij");
      expect(Bun.file(path).slice(2, 5).size).toBe(3);

      const typed = Bun.file(path).slice(2, "text/plain");
      expect(typed.type).toContain("text/plain");
      expect(await typed.text()).toBe("cdefghij");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("file().image().resize().webp().write() writes a WebP chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-image-chain-"));
    try {
      const source = join(dir, "photo.png");
      const target = join(dir, "thumb.webp");
      // 1x1 transparent PNG.
      await Bun.write(
        source,
        Uint8Array.fromBase64(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nH0AAAAASUVORK5CYII=",
        ),
      );

      const written = await Bun.file(source)
        .image()
        .resize(400)
        .webp()
        .write(target);
      expect(written).toBeGreaterThan(0);
      expect(await Bun.file(target).exists()).toBe(true);

      const meta = await new Bun.Image(
        await Bun.file(target).bytes(),
      ).metadata();
      expect(meta).toMatchObject({ width: 400, height: 400, format: "webp" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("inspect.table takes the whitelist only as a string array", () => {
    const rows = [{ a: 1, b: 2 }];
    const all = Bun.inspect.table(rows, { colors: false });
    const onlyB = Bun.inspect.table(rows, ["b"], { colors: false });
    expect(all).toContain(" a ");
    expect(all).toContain(" b ");
    expect(onlyB).not.toContain(" a ");
    expect(onlyB).toContain(" b ");
  });

  test("CookieMap iteration yields string pairs, not cookie objects", () => {
    const cookies = new Bun.CookieMap("a=1; b=2");
    expect([...cookies]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
    const first = [...cookies][0];
    expect(typeof first?.[1]).toBe("string");
  });

  test("which: resolves against PATH and honours the override", () => {
    expect(Bun.which("bun")).not.toBeNull();
    expect(Bun.which("bun-not-a-real-binary-xyz")).toBeNull();
    expect(
      Bun.which("bun-not-a-real-binary-xyz", { PATH: "/usr/bin:/bin" }),
    ).toBeNull();
  });

  test("which: PATH override returns the first executable, not the host path", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-which-"));
    try {
      const executable = join(dir, "sd-which-probe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(Bun.which("sd-which-probe", { PATH: dir })).toBe(executable);
      // The host PATH does not contain the temporary directory.
      expect(Bun.which("sd-which-probe")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which: launch PATH snapshot; explicit PATH is live", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-which-snapshot-"));
    const previous = Bun.env.PATH;
    try {
      const executable = join(dir, "sd-which-late-path");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      Bun.env.PATH = dir;
      // Measured Bun 1.4.4: mutating Bun.env.PATH does not re-resolve the
      // default lookup; it uses the process launch PATH. Explicit PATH does.
      expect(Bun.which("sd-which-late-path")).toBeNull();
      expect(Bun.which("sd-which-late-path", { PATH: dir })).toBe(executable);
    } finally {
      Bun.env.PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which: cwd is the base for a relative PATH entry", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-which-cwd-"));
    try {
      const executable = join(dir, "sd-which-cwd-probe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(Bun.which("sd-which-cwd-probe", { PATH: "" })).toBeNull();
      expect(Bun.which("sd-which-cwd-probe", { PATH: "." })).toBeNull();
      const withCwd = Bun.which("sd-which-cwd-probe", {
        cwd: dir,
        PATH: ".",
      });
      expect(withCwd).not.toBeNull();
      expect(withCwd?.endsWith("sd-which-cwd-probe")).toBe(true);
      expect(
        Bun.which("ls", {
          cwd: join(dir, "missing"),
          PATH: "/bin:/usr/bin",
        }),
      ).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which: skips empty PATH segments instead of treating them as cwd", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-which-empty-"));
    try {
      writeFileSync(join(dir, "sd-which-empty-probe"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      // POSIX says an empty segment means the current directory. Bun 1.4.4
      // skips it; record the divergence explicitly.
      for (const PATH of [":", "/bin::", "/bin:", "::/bin", "/bin::/usr/bin"]) {
        expect(
          Bun.which("sd-which-empty-probe", { cwd: dir, PATH }),
        ).toBeNull();
      }
      expect(
        Bun.which("sd-which-empty-probe", { cwd: dir, PATH: "." }),
      ).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which: requires an executable regular file and keeps symlink spelling", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-which-pred-"));
    try {
      writeFileSync(join(dir, "sd-not-exec"), "#!/bin/sh\n", { mode: 0o644 });
      expect(Bun.which("sd-not-exec", { PATH: dir })).toBeNull();

      mkdirSync(join(dir, "sd-dir"));
      expect(Bun.which("sd-dir", { PATH: dir })).toBeNull();

      const target = join(dir, "sd-target");
      writeFileSync(target, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const link = join(dir, "sd-link");
      symlinkSync(target, link);
      expect(Bun.which("sd-link", { PATH: dir })).toBe(link);

      symlinkSync(join(dir, "missing"), join(dir, "sd-broken"));
      expect(Bun.which("sd-broken", { PATH: dir })).toBeNull();

      // cwd is joined literally, not realpath'd.
      const real = join(dir, "real-bin");
      mkdirSync(real);
      writeFileSync(join(real, "sd-cwd-link"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const cwdLink = join(dir, "cwd-link");
      symlinkSync(real, cwdLink);
      const viaLink = Bun.which("sd-cwd-link", { cwd: cwdLink, PATH: "." });
      expect(viaLink).not.toBeNull();
      expect(viaLink?.startsWith(cwdLink)).toBe(true);
      expect(viaLink).not.toBe(join(real, "sd-cwd-link"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("which: default lookup and Bun.spawn share launch PATH", () => {
    if (process.platform === "win32") return;
    const proc = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const before = Bun.which("ls"); Bun.env.PATH = "/nonexistent"; const after = Bun.which("ls"); const spawned = Bun.spawn(["ls"], { stdout: "pipe", stderr: "pipe" }); console.log(JSON.stringify({ before, after, exit: await spawned.exited }));`,
      ],
      cwd: import.meta.dir,
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const observed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
      before: string | null;
      after: string | null;
      exit: number;
    };
    expect(observed.after).toBe(observed.before);
    expect(observed.exit).toBe(0);
  });

  test("which: spawn env replace and empty segments", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "bun-spawn-path-"));
    try {
      const executable = join(dir, "sd-spawn-path-probe");
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      // spawn skips empty segments like Bun.which, so a local binary is not
      // found through PATH ":" even with cwd set.
      expect(() =>
        Bun.spawn(["sd-spawn-path-probe"], {
          cwd: dir,
          env: { ...Bun.env, PATH: ":" },
          stdout: "pipe",
          stderr: "pipe",
        }),
      ).toThrow();

      // Explicit env REPLACES rather than merges: HOME is not inherited.
      const probe = Bun.spawn(["sh", "-c", 'printf %s "$HOME"'], {
        env: { PATH: "/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await new Response(probe.stdout).text()).toBe("");
      expect(await probe.exited).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("type-only Bun members have no runtime value", () => {
    // lib/bun_shapes.ts records these as kind "type": usable in type positions,
    // undefined if reached for as values. A release that starts exporting one as a
    // runtime value is a surface change to review, not a silent win.
    const bun = Bun as unknown as Record<string, unknown>;
    for (const name of [
      "CronController",
      "Env",
      "FetchProxyOption",
      "FileSink",
      "Server",
    ]) {
      expect(bun[name]).toBeUndefined();
    }
  });

  test("documented Bun variables keep their runtime kinds", () => {
    // The 22 `const Bun.*` variables on the reference page. Access only: cron/plugin/sql/redis
    // would schedule or connect if called, and password hashing is deliberately slow.
    expect(Array.isArray(Bun.argv)).toBe(true);
    expect(Bun.argv.every((arg) => typeof arg === "string")).toBe(true);
    expect(Bun.argv[0]).toBe(process.execPath);

    expect(typeof Bun.cron).toBe("function");
    expect(typeof Bun.cron.parse).toBe("function");
    expect(typeof Bun.cron.remove).toBe("function");

    expect(Array.isArray(Bun.embeddedFiles)).toBe(true);
    expect(typeof Bun.enableANSIColors).toBe("boolean");
    expect(Object.keys(Bun.env).length).toBeGreaterThan(0);
    expect(typeof Bun.fetch).toBe("function");

    expect(typeof Bun.hash).toBe("function");
    expect(typeof Bun.hash("x")).toBe("bigint");
    for (const name of [
      "adler32",
      "crc32",
      "cityHash32",
      "murmur32v2",
      "murmur32v3",
      "xxHash32",
    ] as const) {
      expect(typeof Bun.hash[name]("x")).toBe("number");
    }
    for (const name of [
      "wyhash",
      "cityHash64",
      "murmur64v2",
      "rapidhash",
      "xxHash3",
      "xxHash64",
    ] as const) {
      expect(typeof Bun.hash[name]("x")).toBe("bigint");
    }

    expect(Bun.isMainThread).toBe(true);
    expect(typeof Bun.isStandaloneExecutable).toBe("boolean");
    expect(typeof Bun.main).toBe("string");
    expect(isAbsolute(Bun.main)).toBe(true);

    expect(typeof Bun.password.hash).toBe("function");
    expect(typeof Bun.password.verify).toBe("function");
    expect(typeof Bun.plugin).toBe("function");
    expect(Bun.redis).toBeInstanceOf(Bun.RedisClient);
    expect(typeof Bun.revision).toBe("string");
    // Bun 1.4.4 exposes the default S3 binding as S3Client on macOS and S3Ref on
    // Linux. Both are the documented lazy S3 surface; assert the file() entry point.
    expect(typeof Bun.s3).toBe("object");
    expect(typeof Bun.s3.file).toBe("function");
    expect(typeof Bun.secrets.get).toBe("function");
    expect(typeof Bun.secrets.set).toBe("function");
    expect(typeof Bun.secrets.delete).toBe("function");
    expect(Bun.sql).toBeInstanceOf(Bun.SQL);
    for (const stream of [Bun.stdin, Bun.stdout, Bun.stderr]) {
      expect(typeof stream.text).toBe("function");
      expect(typeof stream.writer).toBe("function");
    }
    expect(Bun.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("version_with_sha is the version plus the short commit", () => {
    // scripts/probe_bun.ts reads this for its drift message; nothing asserted it existed.
    // Canary builds report `v1.4.4-canary.1 (<sha>)` while `Bun.version` stays `1.4.4`.
    expect(typeof Bun.version_with_sha).toBe("string");
    expect(Bun.version_with_sha.startsWith(`v${Bun.version}`)).toBe(true);
    expect(Bun.version_with_sha).toMatch(
      /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? \([0-9a-f]+\)$/,
    );
    const shortSha = /\(([0-9a-f]+)\)$/.exec(Bun.version_with_sha)?.[1];
    expect(shortSha).toBeDefined();
    expect(Bun.revision.startsWith(shortSha as string)).toBe(true);
  });

  test("Bun.$ exposes the shell-tag with escape/braces helpers and the fluent API", async () => {
    // bun.com/reference/bun#bun.$: `Bun.$` is the shell-tag used by dev scripts.
    // The repo-wide rule, codified in lib/f402_credentials_policy.ts and in
    // docs/bun-upstream-reference.md "Bun.$ — argv-only for credentials", is:
    //
    //   Never interpolate untrusted bytes into a `Bun.$` template. Credential paths must use
    //   `Bun.spawn([argv…])` with an explicit minimal env allowlist. If a dev script legitimately
    //   needs shell semantics on a user-provided string, `Bun.$.escape(value)` quotes it safely.
    //
    // This test proves the surface the one production use (tests/subprocess_deadlock.test.ts)
    // and any future dev script depends on: the shell-tag itself, the two pure helpers, and the
    // fluent env/.nothrow/.text pattern that is the only form approved for non-credential work.
    expect(typeof Bun.$).toBe("function");
    expect(typeof Bun.$.escape).toBe("function");
    expect(typeof Bun.$.braces).toBe("function");

    // `$.escape` quotes a string so interpolation does not re-enter the shell parser.
    const escaped = Bun.$.escape("foo bar; rm -rf /");
    expect(escaped).not.toBe("foo bar; rm -rf /");
    expect(escaped.length).toBeGreaterThan("foo bar; rm -rf /".length);
    // Release fix: non-string arguments are stringified, never passed through.
    expect(Bun.$.escape(null as unknown as string)).toBe("null");
    expect(Bun.$.escape(true as unknown as string)).toBe("true");
    expect(Bun.$.escape(new String("foo") as unknown as string)).toBe("foo");
    expect(typeof Bun.$.escape(42 as unknown as string)).toBe("string");

    // `$.braces` is pure bash brace expansion — no I/O, safe to call unconditionally.
    expect(Bun.$.braces("index.{js,ts}").sort()).toEqual([
      "index.js",
      "index.ts",
    ]);

    // Fluent: `.env()` injects variables, `.text()` reads stdout, zero echo to the test process.
    const text = (
      await Bun.$`echo $SPORTSDESK_SHELL_TEST_VALUE`
        .env({ ...Bun.env, SPORTSDESK_SHELL_TEST_VALUE: "ok" })
        .text()
    ).trim();
    expect(text).toBe("ok");

    // `.nothrow()` is the only safe way to tolerate a non-zero exit without a try/catch stack.
    const failed = await Bun.$`exit 7`.nothrow().quiet();
    expect(failed.exitCode).toBe(7);
  });

  test("subprocess resourceUsage exposes bigint cpuTime fields", async () => {
    const proc = Bun.spawn([process.execPath, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
    const usage = await proc.resourceUsage();
    if (usage === undefined) {
      throw new Error("resourceUsage() returned undefined after exit");
    }
    // The installed bun-types already declare cpuTime.user/system/total as bigint;
    // this pins the declaration to the values the subprocess actually reports.
    expect(typeof usage.cpuTime.user).toBe("bigint");
    expect(typeof usage.cpuTime.system).toBe("bigint");
    expect(typeof usage.cpuTime.total).toBe("bigint");
    expect(usage.cpuTime.total).toBe(usage.cpuTime.user + usage.cpuTime.system);
    expect(usage.cpuTime.user >= 0n).toBe(true);
  });

  test("standard Web APIs are global and interoperate", async () => {
    expect(typeof Blob).toBe("function");
    expect(typeof URL).toBe("function");
    expect(typeof Request).toBe("function");
    expect(typeof Response).toBe("function");
    expect(typeof Headers).toBe("function");

    const request = new Request("https://example.test/x?q=1", {
      method: "POST",
      body: new Blob(["hi"], { type: "text/plain" }),
    });
    expect(await request.text()).toBe("hi");
    expect(new URL(request.url).searchParams.get("q")).toBe("1");

    const response = new Response(new Blob(["ok"]));
    expect(await response.text()).toBe("ok");
    expect(new URL("/a", "https://example.test").href).toBe(
      "https://example.test/a",
    );
  });

  test("Bun.escapeHTML replaces the five HTML characters and stringifies values", () => {
    // bun.com/reference/bun/escapeHTML: input is string | number | boolean | object;
    // only the five characters are escaped, and every non-string is converted first.
    expect(Bun.escapeHTML("<script>alert('Hello World!')</script>")).toBe(
      "&lt;script&gt;alert(&#x27;Hello World!&#x27;)&lt;/script&gt;",
    );
    expect(Bun.escapeHTML("a & b < c > d \" e ' f")).toBe(
      "a &amp; b &lt; c &gt; d &quot; e &#x27; f",
    );
    // Non-strings are converted before escaping. The documented signature is
    // string | number | boolean | object; null/undefined are outside that type
    // but are measured here because the runtime still stringifies them.
    expect(Bun.escapeHTML(42)).toBe("42");
    expect(Bun.escapeHTML(true)).toBe("true");
    expect(Bun.escapeHTML({ a: 1 })).toBe("[object Object]");
    expect(Bun.escapeHTML([1, 2])).toBe("1,2");
    expect(Bun.escapeHTML(new String("x"))).toBe("x");
    expect(Bun.escapeHTML(null as never)).toBe("null");
    expect(Bun.escapeHTML(undefined as never)).toBe("undefined");
  });

  test("Bun.allocUnsafe returns a Uint8Array of the requested length (unzeroed)", () => {
    // bun.com/reference/bun#bun.allocUnsafe: up to 3.5x faster than `new Uint8Array(n)`
    // because the bytes are not zeroed. The two production call sites
    // (lib/f402_bet_ticker_jsonl.ts, scripts/live_positions_cron.ts) are safe because each one
    // immediately reads exactly `read` bytes from the file and then uses `subarray(0, read)` to
    // expose only the filled prefix — the unfilled tail is never read. See
    // docs/bun-upstream-reference.md "When to use `Bun.allocUnsafe` (and when NOT to)".
    expect(typeof Bun.allocUnsafe).toBe("function");
    const buf = Bun.allocUnsafe(1024);
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf.byteLength).toBe(1024);
    // Round-trip: fill fully, then read — proves the buffer is a usable Uint8Array.
    buf.fill(0x61);
    expect(buf[0]).toBe(0x61);
    expect(buf[1023]).toBe(0x61);
  });

  test("Bun.env aliases process.env in both directions", () => {
    expect(Bun.env).toBe(process.env);
    const key = "SPORTSDESK_BUN_ENV_ALIAS_PROBE";
    try {
      Bun.env[key] = "from-bun";
      expect(process.env[key]).toBe("from-bun");
      process.env[key] = "from-process";
      expect(Bun.env[key]).toBe("from-process");
    } finally {
      delete Bun.env[key];
    }
    expect(process.env[key]).toBeUndefined();
  });

  test("module 'bun' named exports share 1:1 reference identity with globalThis.Bun", async () => {
    const bunMod = (await import("bun")) as Record<string, unknown>;
    const bunGlobal = Bun as unknown as Record<string, unknown>;

    const modKeys = Reflect.ownKeys(bunMod)
      .filter(
        (k): k is string =>
          typeof k === "string" && k !== "default" && k !== "__esModule",
      )
      .sort();
    const globalKeys = Reflect.ownKeys(Bun)
      .filter((k): k is string => typeof k === "string")
      .sort();

    expect(modKeys).toEqual(globalKeys);
    for (const key of globalKeys) {
      expect(bunMod[key]).toBe(bunGlobal[key]);
    }

    expect(typeof Bun.password).toBe("object");
    expect(typeof Bun.password.hash).toBe("function");
    expect(typeof Bun.password.hashSync).toBe("function");
    expect(typeof Bun.password.verify).toBe("function");
    expect(typeof Bun.password.verifySync).toBe("function");
    expect(bunMod["password"]).toBe(Bun.password);
    expect(bunMod["sql"]).toBe(Bun.sql);
    expect(bunMod["SQL"]).toBe(Bun.SQL);
  });
});
