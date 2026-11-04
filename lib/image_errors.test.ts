import { describe, expect, test } from "bun:test";
import { imageErrorCode } from "./image_errors.ts";

const rejection = (run: () => Promise<unknown>): Promise<unknown> =>
  run().then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("imageErrorCode", () => {
  test("reads the code off a real Bun.Image rejection", async () => {
    const error = await rejection(() =>
      new Bun.Image(new TextEncoder().encode("<html>")).metadata(),
    );
    expect(imageErrorCode(error)).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
  });

  test("leaves syscall codes from file-backed inputs to the caller", async () => {
    const error = await rejection(() =>
      Bun.file("/nonexistent/logo.png").image().metadata(),
    );
    expect(imageErrorCode(error)).toBeUndefined();
  });

  test("ERR_OUT_OF_MEMORY counts though bun-types 1.4.4 omits it", () => {
    const error = Object.assign(new Error("oom"), {
      code: "ERR_OUT_OF_MEMORY",
    });
    expect(imageErrorCode(error)).toBe("ERR_OUT_OF_MEMORY");
  });

  test("finds the code on the cause of a wrapping error", async () => {
    const inner = await rejection(() =>
      new Bun.Image(new TextEncoder().encode("<html>")).metadata(),
    );
    const outer = new Error("screenshot failed", { cause: inner });
    expect(imageErrorCode(outer)).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
  });

  test("non-errors and unknown codes are not image codes", () => {
    expect(imageErrorCode({ code: "ERR_IMAGE_DECODE_FAILED" })).toBeUndefined();
    expect(
      imageErrorCode(Object.assign(new Error("x"), { code: "ERR_X" })),
    ).toBeUndefined();
    expect(imageErrorCode("ERR_IMAGE_DECODE_FAILED")).toBeUndefined();
  });
});
