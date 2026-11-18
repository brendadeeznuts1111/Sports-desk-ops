import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("version floor covers the hardened surface set", () => {
  expect(Bun.semver.satisfies(Bun.version, ">=1.4.4-0")).toBe(true);
});

test("hash family refuses no-arg/null/undefined/file handles with TypeError", () => {
  const handle = Bun.file(import.meta.path);
  const noArg = Bun.hash as unknown as () => bigint;
  const crcNoArg = Bun.hash.crc32 as unknown as () => number;
  expect(() => noArg()).toThrow(TypeError);
  expect(() => crcNoArg()).toThrow(TypeError);
  expect(() => Bun.hash(null as never)).toThrow(TypeError);
  expect(() => Bun.hash(undefined as never)).toThrow(TypeError);
  expect(() => Bun.hash(handle as never)).toThrow(TypeError);
  expect(() => Bun.hash.crc32(null as never)).toThrow(TypeError);
});

test("NaN options are RangeError, not TypeError", () => {
  // audit:bun-failclosed-ignore BUN-DNS-PREFETCH-NAN-RISK
  expect(() => Bun.dns.prefetch("example.com", Number.NaN)).toThrow(RangeError);
  expect(() => Bun.CSRF.generate("secret", { expiresIn: Number.NaN })).toThrow(
    RangeError,
  );

  const token = Bun.CSRF.generate("secret", { expiresIn: 60_000 });
  expect(() =>
    Bun.CSRF.verify(token, { secret: "secret", maxAge: Number.NaN }),
  ).toThrow(RangeError);

  expect(() => Bun.gzipSync("x", { memLevel: 0 } as never)).toThrow(RangeError);
  expect(() => Bun.gzipSync("x", { strategy: 5 } as never)).toThrow(RangeError);
  expect(() => Bun.deflateSync("x", { strategy: -1 } as never)).toThrow(
    RangeError,
  );
});

test("$.escape coerces; it is not an input validator", () => {
  expect(Bun.$.escape(null as never)).toBe("null");
  expect(Bun.$.escape(true as never)).toBe("true");
  expect(Bun.$.escape(new String("foo") as never)).toBe("foo");
  expect(typeof Bun.$.escape(42 as never)).toBe("string");
});

test("globstar inside braces matches deep paths", () => {
  // audit:bun-failclosed-ignore BUN-GLOB-BRACE-STARSTAR
  const brace = new Bun.Glob("{src/**,lib/**}");
  expect(brace.match("src/a/b.ts")).toBe(true);
  expect(brace.match("lib/a/b.ts")).toBe(true);

  const many = new Bun.Glob(
    `{${Array.from({ length: 12 }, (_, i) => `p${i}/**`).join(",")}}`,
  );
  expect(many.match("p11/a/b.ts")).toBe(true);

  let nested = "a";
  for (let i = 0; i < 12; i += 1) nested = `{${nested},x${i}}`;
  expect(new Bun.Glob(nested).match("a")).toBe(true);
});

test("scan truthy options include dotfiles and exclude directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bun-glob-truthy-"));
  try {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "visible.txt"), "");
    writeFileSync(join(dir, ".hidden"), "");

    const dotted: string[] = [];
    for await (const rel of new Bun.Glob("*").scan({
      cwd: dir,
      dot: 1,
    } as never)) {
      dotted.push(rel);
    }
    expect(dotted).toContain(".hidden");

    const files = Array.from(
      new Bun.Glob("*").scanSync({ cwd: dir, onlyFiles: 1 } as never),
    );
    expect(files).toContain("visible.txt");
    expect(files).not.toContain("sub");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CSRF generate(undefined, options) keeps the default secret", () => {
  expect(typeof Bun.CSRF.generate(undefined, { expiresIn: 60_000 })).toBe(
    "string",
  );
});
