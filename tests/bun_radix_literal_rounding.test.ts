import { describe, expect, test } from "bun:test";

/* eslint-disable no-loss-of-precision -- the literals are the subject of the rounding assertions */

// Bun v1.4.5 fixed large hexadecimal, octal and binary literals rounding to a
// different double than Node, and the same bug in Bun.JSONC.parse().
// The IEEE-754 nearest double for 0xb3c8bf81fdf2247 is 0xb3c8bf81fdf2280.
const ROUNDED = 0xb3c8bf81fdf2280n;

describe("large radix literals and JSONC rounding", () => {
  test("hex, octal and binary literals round to the IEEE-754/Node double", () => {
    expect(BigInt(0xb3c8bf81fdf2247)).toBe(ROUNDED);
    expect(BigInt(0o54744277403767621107)).toBe(ROUNDED);
    expect(
      BigInt(0b101100111100100010111111100000011111110111110010001001000111),
    ).toBe(ROUNDED);
    expect(BigInt(809675930822713927)).toBe(ROUNDED);
  });

  test("JSONC.parse rounds the same radix and decimal values identically", () => {
    const hex = Bun.JSONC.parse('{"n": 0xb3c8bf81fdf2247}') as {
      n: number;
    };
    expect(BigInt(hex.n)).toBe(ROUNDED);
    const decimal = Bun.JSONC.parse('{"n": 809675930822713927}') as {
      n: number;
    };
    expect(BigInt(decimal.n)).toBe(ROUNDED);
  });
});
