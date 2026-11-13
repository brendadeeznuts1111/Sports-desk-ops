/**
 * Agent environment doctor — report shape and severity rules.
 *
 * The script exists because the 2026-11-04 tool-call audit showed agents burning calls to
 * discover missing worktree dependencies, a gitignored customer book, no browser, and a
 * non-writable `~/.dsh`. The report must stay deterministic and machine-diffable, and a
 * warning must never turn into a failing exit code.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binLinkState,
  exitCode,
  parseBlockedInstallScripts,
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

describe("agent:doctor blocked install scripts", () => {
  // `bun pm untrusted` exits 0 in every case, so the text is the only signal.
  test("a clean run reports nothing blocked", () => {
    const clean = [
      "bun pm untrusted v1.4.4-canary.1 (89452d2ac)",
      "",
      "Found 0 untrusted dependencies with scripts.",
      "",
      'This means all packages with scripts are in "trustedDependencies" or none of your dependencies have scripts.',
    ].join("\n");
    expect(parseBlockedInstallScripts(clean)).toEqual([]);
  });

  test("a blocked postinstall is named with its phase", () => {
    const blocked = [
      "bun pm untrusted v1.4.4-canary.1 (89452d2ac)",
      "",
      "./node_modules/.bun/scripted-dep@file+..+dep/node_modules/scripted-dep @../dep",
      " » [postinstall]: true",
      "",
      "These dependencies had their lifecycle scripts blocked during install.",
      "",
      "If you trust them and wish to run their scripts, use `bun pm trust`.",
    ].join("\n");
    expect(parseBlockedInstallScripts(blocked)).toEqual([
      { packageName: "scripted-dep", phase: "postinstall" },
    ]);
  });

  test("a scoped package keeps its scope and the @version specifier is ignored", () => {
    const blocked = [
      "./node_modules/.bun/@scope+pkg@1.0.0/node_modules/@scope/pkg @1.0.0",
      " » [install]: node-gyp rebuild",
    ].join("\n");
    expect(parseBlockedInstallScripts(blocked)).toEqual([
      { packageName: "@scope/pkg", phase: "install" },
    ]);
  });
});

describe("agent:doctor bin link state", () => {
  test("a dangling workspace link is not reported as an absent bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-bins-"));
    try {
      writeFileSync(join(dir, "real-cli"), "#!/bin/sh\n", { mode: 0o755 });
      symlinkSync("real-cli", join(dir, "linked"));
      symlinkSync("gone", join(dir, "dangling"));

      expect(binLinkState(join(dir, "linked"))).toBe("ok");
      expect(binLinkState(join(dir, "dangling"))).toBe("dangling");
      expect(binLinkState(join(dir, "absent"))).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
