import { describe, expect, test } from "bun:test";
import {
  F402_BETS_JSONL_OPERATOR_DEFAULT,
  resolveF402BetsJsonlPath,
} from "../lib/f402_bets_corpus_path.ts";

describe("resolveF402BetsJsonlPath", () => {
  const exists = (path: string) =>
    path === "/cli/bets.jsonl" ||
    path === "/env/bets.jsonl" ||
    path === "/default/bets.jsonl";

  test("prefers CLI over env over operator default", () => {
    expect(
      resolveF402BetsJsonlPath({
        cliValue: "/cli/bets.jsonl",
        environment: { F402_BETS_JSONL: "/env/bets.jsonl" },
        exists,
        operatorDefault: "/default/bets.jsonl",
      }),
    ).toBe("/cli/bets.jsonl");
    expect(
      resolveF402BetsJsonlPath({
        environment: { F402_BETS_JSONL: "/env/bets.jsonl" },
        exists,
        operatorDefault: "/default/bets.jsonl",
      }),
    ).toBe("/env/bets.jsonl");
    expect(
      resolveF402BetsJsonlPath({
        exists,
        operatorDefault: "/default/bets.jsonl",
      }),
    ).toBe("/default/bets.jsonl");
  });

  test("throws with override hint when resolved path is missing", () => {
    expect(() =>
      resolveF402BetsJsonlPath({
        cliValue: "/missing/bets.jsonl",
        exists: () => false,
        operatorDefault: "/default/bets.jsonl",
      }),
    ).toThrow(/f402-bets.jsonl not found/);
    expect(() =>
      resolveF402BetsJsonlPath({
        cliValue: "/missing/bets.jsonl",
        exists: () => false,
        operatorDefault: "/default/bets.jsonl",
      }),
    ).toThrow(/F402_BETS_JSONL/);
    expect(() =>
      resolveF402BetsJsonlPath({
        exists: () => false,
        operatorDefault: F402_BETS_JSONL_OPERATOR_DEFAULT,
      }),
    ).toThrow(F402_BETS_JSONL_OPERATOR_DEFAULT);
  });
});
