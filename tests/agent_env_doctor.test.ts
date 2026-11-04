/**
 * Agent environment doctor — report shape and severity rules.
 *
 * The script exists because the 2026-11-04 tool-call audit showed agents burning calls to
 * discover missing worktree dependencies, a gitignored customer book, no browser, and a
 * non-writable `~/.dsh`. The report must stay deterministic and machine-diffable, and a
 * warning must never turn into a failing exit code.
 */

import { describe, expect, test } from "bun:test";
import {
  exitCode,
  renderReport,
  type Check,
} from "../scripts/agent_env_doctor.ts";

const ok = (id: string): Check => ({ id, status: "ok", title: `${id} ok` });
const warn = (id: string): Check => ({
  id,
  status: "warn",
  title: `${id} warning`,
  fix: `fix ${id}`,
});
const fail = (id: string): Check => ({
  id,
  status: "fail",
  title: `${id} failure`,
  fix: `fix ${id}`,
});

describe("agent:doctor severity", () => {
  test("only a FAIL blocks", () => {
    expect(exitCode([])).toBe(0);
    expect(exitCode([ok("a"), warn("b")])).toBe(0);
    expect(exitCode([ok("a"), fail("b")])).toBe(1);
  });
});

describe("agent:doctor report", () => {
  test("reports counts and the RESULT line", () => {
    const report = renderReport([ok("a"), warn("b")], "/tmp/worktree");
    expect(report).toContain("agent:doctor · /tmp/worktree");
    expect(report).toContain("2 checks · 1 ok · 1 warn · 0 fail");
    expect(report).toContain("RESULT: PASS");
    expect(report).toContain("WARN b warning");
    expect(report).toContain("fix: fix b");
  });

  test("a FAIL prints its remedy and a failing RESULT", () => {
    const report = renderReport([fail("deps")], "/tmp/worktree");
    expect(report).toContain("FAIL deps failure");
    expect(report).toContain("fix: fix deps");
    expect(report).toContain("RESULT: FAIL");
  });

  test("OK checks never print a fix line", () => {
    const report = renderReport(
      [{ id: "a", status: "ok", title: "fine", fix: "should not print" }],
      "/tmp/worktree",
    );
    expect(report).not.toContain("should not print");
  });

  test("rendering is deterministic for identical checks", () => {
    const checks = [ok("runtime"), warn("deps"), fail("feed")];
    expect(renderReport(checks, "/r")).toBe(renderReport(checks, "/r"));
  });
});
