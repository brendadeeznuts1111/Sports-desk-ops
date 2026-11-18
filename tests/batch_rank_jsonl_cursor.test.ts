import { describe, expect, test } from "bun:test";
import { advanceJsonlStringRemainder } from "../scripts/batch_rank_all_players.ts";

describe("batch-rank JSONL cursor", () => {
  test("advances past read when there is no error", () => {
    expect(
      advanceJsonlStringRemainder('{"a":1}\n{"b":2}\n', {
        read: 7,
        error: null,
      }),
    ).toBe('\n{"b":2}\n');
  });

  test("drops the poison line after a good prefix", () => {
    expect(
      advanceJsonlStringRemainder('{"a":1}\nBAD\n{"b":2}\n', {
        read: 7,
        error: new SyntaxError("bad"),
      }),
    ).toBe('{"b":2}\n');
  });

  test("drops leading blank lines and the first poison line", () => {
    expect(
      advanceJsonlStringRemainder('\n\nBAD\n{"ok":1}\n', {
        read: 0,
        error: new SyntaxError("bad"),
      }),
    ).toBe('{"ok":1}\n');
  });

  test("keeps an unterminated poison tail for the next chunk", () => {
    expect(
      advanceJsonlStringRemainder('{"a":1}\nBAD', {
        read: 7,
        error: new SyntaxError("bad"),
      }),
    ).toBe("BAD");
  });
});
