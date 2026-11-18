import { describe, expect, spyOn, test } from "bun:test";
import {
  isSystemError,
  processBridge3cStream,
  type SystemError,
} from "../packages/sportsdesk-ops/src/bridge/bridge_3c_reader.ts";

function makeSystemError(): SystemError {
  return Object.assign(new Error("EIO while reading the corpus"), {
    code: "EIO",
    errno: 5,
    path: "/tmp/corpus.jsonl",
    syscall: "read",
  });
}

describe("Bridge 3c SystemError handling", () => {
  test("recognizes system-call metadata", () => {
    expect(isSystemError(makeSystemError())).toBe(true);
    expect(isSystemError(new SyntaxError("bad json"))).toBe(false);
    expect(isSystemError(null)).toBe(false);
  });

  test("rethrows a parseChunk SystemError instead of wrapping or skipping it", async () => {
    const systemError = makeSystemError();
    const spy = spyOn(Bun.JSONL, "parseChunk").mockImplementation(
      () =>
        ({
          values: [],
          read: 0,
          done: false,
          error: systemError,
        }) as never,
    );
    try {
      const response = new Response('{"x":1}\n', {
        headers: { "content-type": "application/jsonl" },
      });
      await expect(
        processBridge3cStream(response, {
          compression: "none",
          parseMode: "bun-native-jsonl",
          errorMode: "skip",
        }),
      ).rejects.toBe(systemError);
    } finally {
      spy.mockRestore();
    }
  });

  test("propagates a byte-stream SystemError untouched", async () => {
    const systemError = makeSystemError();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(systemError);
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "application/jsonl" },
    });

    await expect(
      processBridge3cStream(response, {
        compression: "none",
        parseMode: "bun-native-jsonl",
      }),
    ).rejects.toBe(systemError);
  });

  test("still wraps a real SyntaxError as malformed JSON", async () => {
    const response = new Response("BAD\n", {
      headers: { "content-type": "application/jsonl" },
    });
    await expect(
      processBridge3cStream(response, {
        compression: "none",
        parseMode: "bun-native-jsonl",
        errorMode: "throw",
      }),
    ).rejects.toThrow("ERR_BRIDGE3C_MALFORMED_JSON");
  });
});
