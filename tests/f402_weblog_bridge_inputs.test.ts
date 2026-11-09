import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bridgeWeblogCorpusPresent,
  F402_WEBLOG_OPERATOR_DEFAULT,
  resolveBridgeWeblogCorpusFrom,
} from "../lib/f402_weblog_bridge_inputs.ts";

describe("resolveBridgeWeblogCorpusFrom", () => {
  test("defaults to desk-date capture under out/f402/weblog", () => {
    const root = mkdtempSync(join(tmpdir(), "weblog-default-"));
    const dated = join(root, "out/f402/weblog/11-08-2026.jsonl");
    mkdirSync(dirname(dated), { recursive: true });
    writeFileSync(dated, "{}\n");
    try {
      const path = resolveBridgeWeblogCorpusFrom(root, {
        now: () => new Date("2026-11-08T12:00:00.000Z"),
        operatorDefaultDir: join(root, "no-operator"),
      });
      expect(path).toBe(dated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses operator default when env unset and repo default missing", () => {
    const root = mkdtempSync(join(tmpdir(), "weblog-operator-"));
    const operatorDir = join(root, "probes", "weblog");
    const corpus = join(operatorDir, "11-04-2026.jsonl");
    const older = join(operatorDir, "11-03-2026.jsonl");
    mkdirSync(operatorDir, { recursive: true });
    writeFileSync(corpus, "{}\n");
    writeFileSync(older, "{}\n");
    try {
      expect(
        resolveBridgeWeblogCorpusFrom(root, {
          now: () => new Date("2026-11-08T12:00:00.000Z"),
          operatorDefaultDir: operatorDir,
        }),
      ).toBe(corpus);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("error names all three paths when nothing is found", () => {
    const root = mkdtempSync(join(tmpdir(), "weblog-missing-"));
    const operatorDir = join(root, "probes", "weblog");
    mkdirSync(operatorDir, { recursive: true });
    const dated = join(root, "out/f402/weblog/11-08-2026.jsonl");
    try {
      expect(() =>
        resolveBridgeWeblogCorpusFrom(root, {
          now: () => new Date("2026-11-08T12:00:00.000Z"),
          operatorDefaultDir: operatorDir,
        }),
      ).toThrow(/F402_WEBLOG_FROM/);
      expect(() =>
        resolveBridgeWeblogCorpusFrom(root, {
          now: () => new Date("2026-11-08T12:00:00.000Z"),
          operatorDefaultDir: operatorDir,
        }),
      ).toThrow(dated);
      expect(() =>
        resolveBridgeWeblogCorpusFrom(root, {
          now: () => new Date("2026-11-08T12:00:00.000Z"),
          operatorDefaultDir: operatorDir,
        }),
      ).toThrow(`${operatorDir}/*.jsonl`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("F402_WEBLOG_FROM overrides default", () => {
    const dir = mkdtempSync(join(tmpdir(), "weblog-from-"));
    const corpus = join(dir, "activity.jsonl");
    writeFileSync(corpus, "{}\n");
    try {
      expect(
        resolveBridgeWeblogCorpusFrom("/repo", {
          env: { F402_WEBLOG_FROM: corpus },
        }),
      ).toBe(corpus);
      expect(bridgeWeblogCorpusPresent(corpus).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exports operator default probes path", () => {
    expect(F402_WEBLOG_OPERATOR_DEFAULT).toContain("probes/out/f402/weblog");
  });
});
