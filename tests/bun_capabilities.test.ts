import { describe, expect, test } from "bun:test";

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

  test("node:crypto argon2 and the WebSocket client extension are usable", async () => {
    // v1.4.1 shipped argon2 in node:crypto and pause/resume on the WHATWG client socket.
    // Both are pinned in bin/bun_surface.ts ("compat"); this test proves the behaviour, not
    // just the property: a 32-byte tag for argon2id, and functions on the prototype.
    //
    // Params are the OWASP Password Storage Cheat Sheet recommendation for argon2id as of
    // 2024-01: memory 19 MiB (19456 KiB), 2 passes, parallelism 1, 16-byte RANDOM nonce,
    // 32-byte tag. Pinning these numbers here means the first production call site that needs
    // password hashing does not have to invent its own params; it copies these. Measured cost
    // on Bun 1.4.4 (Apple Silicon, 2026-11-04): ~20 ms per call, negligible for one CI run.
    const crypto = (await import("node:crypto")) as unknown as Record<
      string,
      unknown
    >;
    const argon2Sync = crypto["argon2Sync"] as
      | ((algorithm: string, options: Record<string, unknown>) => Buffer)
      | undefined;
    expect(typeof argon2Sync).toBe("function");
    const randomBytes = crypto["randomBytes"] as (size: number) => Buffer;
    const tag = argon2Sync!("argon2id", {
      message: "pw",
      nonce: randomBytes(16),
      parallelism: 1,
      tagLength: 32,
      memory: 19456,
      passes: 2,
    });
    expect(tag.length).toBe(32);
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
    // /reference/globals/bun lists "class Bun.WebSocket", "Bun.Worker" and "Bun.EventSource".
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

  test("Bun.which resolves against PATH and honours the override", () => {
    expect(Bun.which("bun")).not.toBeNull();
    expect(Bun.which("bun-not-a-real-binary-xyz")).toBeNull();
    expect(
      Bun.which("bun-not-a-real-binary-xyz", { PATH: "/usr/bin:/bin" }),
    ).toBeNull();
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

  test("version_with_sha is the version plus the short commit", () => {
    // scripts/probe_bun.ts reads this for its drift message; nothing asserted it existed.
    expect(typeof Bun.version_with_sha).toBe("string");
    expect(Bun.version_with_sha.startsWith(`v${Bun.version} (`)).toBe(true);
    const shortSha = /\(([0-9a-f]+)\)$/.exec(Bun.version_with_sha)?.[1];
    expect(shortSha).toBeDefined();
    expect(Bun.revision.startsWith(shortSha as string)).toBe(true);
  });
});
