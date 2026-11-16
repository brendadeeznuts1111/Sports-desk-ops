// toolchain/verify-bun.sh + the bin/dx DX_VERIFY_RUNTIME guard. Runtime-agnostic on purpose:
// it builds throwaway pins around a throwaway "binary", so the suite passes on any Bun and can
// gate a Bun upgrade (docs/runtime-upgrade.md) without asserting which Bun is running it.
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const VERIFY = join(REPO, "toolchain/verify-bun.sh");
const dir = mkdtempSync(join(tmpdir(), "verify-bun-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PLATFORMS = [
  "linux-x64",
  "linux-x64-baseline",
  "linux-aarch64",
  "darwin-aarch64",
  "darwin-x64",
];
const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function writePin(name: string, binarySha256: string): string {
  const path = join(dir, name);
  const platforms = Object.fromEntries(
    PLATFORMS.map((p) => [p, { binarySha256 }]),
  );
  writeFileSync(
    path,
    JSON.stringify({ name: "bun", version: "0.0.0-test", platforms }),
  );
  return path;
}

function run(env: Record<string, string>, args: string[] = []) {
  const r = Bun.spawnSync(["sh", VERIFY, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return {
    code: r.exitCode,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
}

const fakeBin = join(dir, "fake-bun");
const fakeBytes = new TextEncoder().encode("\x7fELF not really bun\n");
writeFileSync(fakeBin, fakeBytes);
chmodSync(fakeBin, 0o755);
const goodPin = writePin("good.pin.json", sha256(fakeBytes));
const badPin = writePin("bad.pin.json", "0".repeat(64));

describe("toolchain/verify-bun.sh", () => {
  test("passes when the binary hash matches the pin, and prints the resolved path", () => {
    const r = run({ DX_BUN_BIN: fakeBin, DX_BUN_PIN: goodPin }, [
      "--print-path",
    ]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(fakeBin);
    expect(r.err).toContain("verify-bun: OK bun 0.0.0-test");
  });

  test("fails (exit 1) on a hash mismatch", () => {
    const r = run({ DX_BUN_BIN: fakeBin, DX_BUN_PIN: badPin });
    expect(r.code).toBe(1);
    expect(r.err).toContain("MISMATCH");
  });

  test("follows an npm/pnpm cmd-shim to the real binary", () => {
    const shimDir = join(dir, "shim/bin");
    mkdirSync(join(dir, "shim/lib"), { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(dir, "shim/lib/bun.exe"), fakeBytes);
    const shim = join(shimDir, "bun");
    writeFileSync(
      shim,
      '#!/bin/sh\nbasedir=$(dirname "$0")\n"$basedir/../lib/bun.exe"   "$@"\nexit $?\n',
    );
    chmodSync(shim, 0o755);
    const r = run({ DX_BUN_BIN: shim, DX_BUN_PIN: goodPin }, ["--print-path"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(join(dir, "shim/lib/bun.exe"));
  });

  test("fails closed (exit 2) on a script it does not recognise", () => {
    const wrapper = join(dir, "wrapper");
    writeFileSync(wrapper, '#!/bin/sh\nexec /somewhere/else/bun "$@"\n');
    chmodSync(wrapper, 0o755);
    expect(run({ DX_BUN_BIN: wrapper, DX_BUN_PIN: goodPin }).code).toBe(2);
  });

  test("fails closed (exit 2) when the binary or pin is missing", () => {
    expect(
      run({ DX_BUN_BIN: join(dir, "nope"), DX_BUN_PIN: goodPin }).code,
    ).toBe(2);
    expect(
      run({ DX_BUN_BIN: fakeBin, DX_BUN_PIN: join(dir, "nope.json") }).code,
    ).toBe(2);
  });
});

describe("bin/dx DX_VERIFY_RUNTIME guard", () => {
  const dx = (env: Record<string, string>) =>
    Bun.spawnSync([join(REPO, "bin/dx"), "help"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, ...env },
    });

  test("off by default: a bad pin does not affect dx", () => {
    expect(dx({ DX_BUN_PIN: badPin }).exitCode).toBe(0);
  });

  test("on: a matching runtime lets dx run and names the verified binary", () => {
    // Pin the bun running this test, and put exactly that binary first on PATH.
    const bunDir = join(dir, "pinned-bin");
    mkdirSync(bunDir, { recursive: true });
    symlinkSync(process.execPath, join(bunDir, "bun"));
    const realPin = writePin(
      "real.pin.json",
      sha256(new Uint8Array(readFileSync(process.execPath))),
    );
    const r = dx({
      DX_VERIFY_RUNTIME: "1",
      DX_BUN_PIN: realPin,
      PATH: `${bunDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("verify-bun: OK");
  });

  test("on: a mismatching runtime stops dx with exit 70 before it runs anything", () => {
    const r = dx({ DX_VERIFY_RUNTIME: "1", DX_BUN_PIN: badPin });
    expect(r.exitCode).toBe(70);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toContain(
      "does not match toolchain/bun.pin.json",
    );
  });
});

describe("toolchain/bun.pin.json", () => {
  const pin = JSON.parse(
    readFileSync(join(REPO, "toolchain/bun.pin.json"), "utf8"),
  );
  test("matches .bun-version and pins every platform by zip and binary sha256", () => {
    expect(pin.version).toBe(
      readFileSync(join(REPO, ".bun-version"), "utf8").trim(),
    );
    expect(pin.signer.fingerprint).toMatch(/^[0-9A-F]{40}$/);
    for (const p of PLATFORMS) {
      expect(pin.platforms[p].zipSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.platforms[p].binarySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.platforms[p].url).toBe(
        `https://github.com/oven-sh/bun/releases/download/${pin.tag}/${pin.platforms[p].asset}`,
      );
    }
  });
});
