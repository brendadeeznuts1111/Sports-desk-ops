import { dlopen } from "bun:ffi";
import { describe, expect, test } from "bun:test";

const isSupported =
  process.platform === "darwin" || process.platform === "linux";
const libcPath = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";

describe.skipIf(!isSupported)(
  "Bun FFI native buffer and cstring patterns",
  () => {
    test("buffer and buffer_length automatically resolve pointer and length at call time", () => {
      const { symbols, close } = dlopen(libcPath, {
        strnlen: {
          args: ["buffer", "buffer_length"],
          returns: "usize",
        },
      });

      try {
        const text = "SportsDesk-Fast-Native-FFI";
        const data = new TextEncoder().encode(text);

        // Passing the same buffer twice: argument 0 is pointer, argument 1 is byte length
        const resolvedLen = symbols.strnlen(data, data);
        expect(Number(resolvedLen)).toBe(data.byteLength);
        expect(Number(resolvedLen)).toBe(text.length);

        // Subarray verifies pointer offset and length derivation without separate .byteLength reads
        const sub = data.subarray(11, 22); // "Fast-Native"
        const subLen = symbols.strnlen(sub, sub);
        expect(Number(subLen)).toBe(11);
      } finally {
        close();
      }
    });

    test("cstring argument and return automatically converts between JS string and null-terminated C string", () => {
      const { symbols, close } = dlopen(libcPath, {
        getenv: {
          args: ["cstring"],
          returns: "cstring",
        },
      });

      try {
        // Query PATH which is universally set across environments
        const pathEnv = symbols.getenv("PATH");
        expect(typeof pathEnv).toBe("string");
        expect(pathEnv!.length).toBeGreaterThan(0);

        // Non-existent variable returns null pointer -> null in JS
        const nonExistent = symbols.getenv(
          "__NON_EXISTENT_SPORTSDESK_ENV_VAR__",
        );
        expect(nonExistent).toBeNull();
      } finally {
        close();
      }
    });
  },
);
