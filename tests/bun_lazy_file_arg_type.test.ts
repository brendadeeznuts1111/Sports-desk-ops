/**
 * @file tests/bun_lazy_file_arg_type.test.ts
 * @description Bun 1.4.4 rejects a lazy `Bun.file()` where these APIs take bytes or text: the
 * caller must read it first (`await file.text()` / `file.bytes()`). Measured 2026-11-18 on the
 * pinned binary; no network or file reads happen.
 */

import { describe, expect, test } from "bun:test";

const lazyFile = Bun.file(import.meta.path);

const consumers: readonly (readonly [string, () => unknown])[] = [
  [
    "Bun.CryptoHasher.update",
    () => new Bun.CryptoHasher("sha256").update(lazyFile as never),
  ],
  ["Bun.YAML.parse", () => Bun.YAML.parse(lazyFile as never)],
  ["Bun.TOML.parse", () => Bun.TOML.parse(lazyFile as never)],
];

describe("lazy Bun.file is not an accepted input", () => {
  for (const [name, consume] of consumers) {
    test(`${name} throws TypeError ERR_INVALID_ARG_TYPE`, () => {
      let caught: unknown;
      try {
        consume();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as { code?: unknown }).code).toBe("ERR_INVALID_ARG_TYPE");
    });
  }
});
