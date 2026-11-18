import { describe, expect, test } from "bun:test";
import {
  ERR_R2_INVALID_UTF8,
  ERR_R2_UNSUPPORTED_BOM,
  readStrictUtf8R2Object,
} from "../lib/r2_text.ts";

function source(bytes: Uint8Array): { bytes(): Promise<Uint8Array> } {
  return { bytes: async () => bytes };
}

describe("readStrictUtf8R2Object", () => {
  test("decodes valid UTF-8 and strips a UTF-8 BOM", async () => {
    expect(
      await readStrictUtf8R2Object(source(new TextEncoder().encode("café"))),
    ).toBe("café");
    expect(
      await readStrictUtf8R2Object(
        source(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])),
      ),
    ).toBe("hi");
    expect(await readStrictUtf8R2Object(source(new Uint8Array()))).toBe("");
  });

  test("rejects UTF-16 and UTF-32 BOMs explicitly", async () => {
    for (const bytes of [
      [0xff, 0xfe, 0x68, 0x00], // UTF-16 LE
      [0xfe, 0xff, 0x00, 0x68], // UTF-16 BE
      [0x00, 0x00, 0xfe, 0xff, 0x00, 0x00, 0x00, 0x68], // UTF-32 BE
      [0xff, 0xfe, 0x00, 0x00, 0x68, 0x00, 0x00, 0x00], // UTF-32 LE
    ]) {
      await expect(
        readStrictUtf8R2Object(source(new Uint8Array(bytes))),
      ).rejects.toThrow(ERR_R2_UNSUPPORTED_BOM);
    }
  });

  test("rejects invalid UTF-8 instead of returning U+FFFD", async () => {
    await expect(
      readStrictUtf8R2Object(source(new Uint8Array([0xff]))),
    ).rejects.toThrow(ERR_R2_INVALID_UTF8);
    await expect(
      readStrictUtf8R2Object(source(new Uint8Array([0xc3, 0x28]))),
    ).rejects.toThrow(TypeError);
  });
});
