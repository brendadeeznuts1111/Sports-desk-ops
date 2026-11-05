import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CORPUS_REL_PATH,
  buildCorpusDocument,
  sidecarLine,
} from "../scripts/capture/gslive_corpus.ts";

describe("GSLive corpus capture", () => {
  test("builds the r.bets document the fraud parser reads", () => {
    const rows = [{ id: "1", userID: "U001" }];
    const document = buildCorpusDocument(rows, 1_793_000_000, 1_793_021_600);
    expect(document).toEqual({
      r: { bets: rows },
      e: 0,
      d: "",
      from: 1_793_000_000,
      to: 1_793_021_600,
    });
    expect(DEFAULT_CORPUS_REL_PATH).toBe(
      "Scratch/security/corpus/gslive-betreport-latest.json",
    );
  });

  test("writes the sidecar line the loader matches by path", () => {
    expect(sidecarLine(DEFAULT_CORPUS_REL_PATH, "abc123")).toBe(
      `abc123  ${DEFAULT_CORPUS_REL_PATH}\n`,
    );
  });
});
