/**
 * Tool-call audit parser — deterministic joins and aggregates over synthetic session events.
 *
 * The audit is only useful if its numbers are reproducible, so the pure layer (parse, summarize,
 * normalize, render) is pinned without touching a real session bucket.
 */

import { describe, expect, test } from "bun:test";
import {
  normalize,
  parseSession,
  renderReport,
  summarize,
} from "../scripts/audit_tool_calls.ts";

const call = (seq: number, id: string, name: string, args: unknown) =>
  JSON.stringify({
    type: "tool/call",
    seq,
    time: 1_000 + seq,
    data: {
      turn: 1,
      step: seq,
      callId: id,
      name,
      arguments: JSON.stringify(args),
    },
  });

const result = (
  seq: number,
  id: string,
  text: string,
  options: { isError?: boolean; error?: unknown } = {},
) =>
  JSON.stringify({
    type: "tool/result",
    seq,
    time: 1_000 + seq + 10,
    data: {
      turn: 1,
      step: seq,
      message: {
        role: "tool",
        source: { kind: "tool", callId: id },
        toolCallId: id,
        content: [{ type: "text", text }],
        isError: options.isError === true,
      },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
  });

describe("normalize", () => {
  test("strips absolute paths, ids and numbers", () => {
    expect(
      normalize('cannot edit "/Users/me/x.ts" for call_abc123 at line 42'),
    ).toBe('cannot edit "<path>" for call_abc<n> at line <n>');
  });
});

describe("parseSession", () => {
  test("joins results to calls and carries error codes", () => {
    const rows = parseSession(
      "s",
      [
        call(1, "c1", "edit", { file_path: "a.ts" }),
        result(1, "c1", "Error: cannot edit a.ts — re-read", {
          isError: true,
          error: { name: "FsError", code: "FS_STALE_VERSION" },
        }),
        call(2, "c2", "bash", { command: "true", description: "ok" }),
        result(2, "c2", "done\n[exit code: 0]"),
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "edit",
      isError: true,
      code: "FsError/FS_STALE_VERSION",
    });
    expect(rows[1]).toMatchObject({ name: "bash", isError: false, code: null });
  });

  test("tolerates a partial trailing line", () => {
    expect(parseSession("s", '{"type":"tool/call",')).toEqual([]);
  });
});

describe("summarize", () => {
  const rows = parseSession(
    "s",
    [
      call(1, "c1", "edit", { file_path: "a" }),
      result(1, "c1", "Error: cannot edit a — re-read", {
        isError: true,
        error: { name: "FsError", code: "FS_STALE_VERSION" },
      }),
      call(2, "c2", "bash", { command: "false", description: "expected miss" }),
      result(2, "c2", "not found\n[exit code: 1]"),
      call(3, "c3", "bash", { command: "false", description: "expected miss" }),
      result(3, "c3", "not found\n[exit code: 1]"),
      call(4, "c4", "bash", { command: "true", description: "ok" }),
      result(4, "c4", "ok\n[exit code: 0]"),
    ].join("\n"),
  );

  test("reports tool error rates, bash misses and duplicates", () => {
    const report = summarize(rows);
    expect(report.results).toBe(4);
    expect(report.errors).toBe(1);
    const edit = report.tools.find((tool) => tool.name === "edit");
    expect(edit).toEqual({ name: "edit", calls: 1, errors: 1 });
    expect(report.bash).toMatchObject({ calls: 3, nonZero: 2 });
    expect(report.duplicates).toEqual({ groups: 1, wasted: 1 });
    expect(report.codes[0]).toEqual({
      code: "FsError/FS_STALE_VERSION",
      count: 1,
    });
  });

  test("renders the sections the runbook quotes", () => {
    const report = renderReport(summarize(rows));
    expect(report).toContain(
      "tool-call audit · 1 sessions · 4 tool results · 1 errors",
    );
    expect(report).toContain("== error codes ==");
    expect(report).toContain("== bash: 3 calls · 2 non-zero");
    expect(report).toContain("duplicate call groups: 1");
  });
});
