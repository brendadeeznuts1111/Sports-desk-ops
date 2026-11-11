import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runDeskProvenanceCli } from "../bin/desk-provenance.ts";
import {
  bunRevisionSha,
  bunRuntimeIdentity,
  compareBunToOracleManifest,
  deskProvenanceSnapshot,
  gitRepoHead,
  gitShortSha,
  GIT,
  GIT_REV_PARSE_HEAD,
} from "../lib/bun_runtime.ts";
import { resolveFourcRoot } from "../lib/fourc_root.ts";

const root = resolve(import.meta.dir, "..");

describe("bun_runtime", () => {
  test("git argv constants", () => {
    expect(GIT).toBe("git");
    expect(GIT_REV_PARSE_HEAD).toEqual(["git", "rev-parse", "HEAD"]);
  });

  test("Bun.revision is 40-char hex", () => {
    const rev = bunRevisionSha();
    expect(rev).toHaveLength(40);
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    expect(gitShortSha(rev)).toBe(rev.slice(0, 9));
  });

  test("bunRuntimeIdentity matches live Bun", () => {
    const id = bunRuntimeIdentity();
    expect(id.version).toBe(Bun.version);
    expect(id.revision).toBe(Bun.revision);
    expect(id.revisionComposite).toBe(
      `${Bun.version}+${Bun.revision.slice(0, 9)}`,
    );
  });

  test("gitRepoHead matches git rev-parse in sportsdesk-ops", () => {
    const fromLib = gitRepoHead(root);
    const proc = Bun.spawnSync({
      cmd: ["git", "rev-parse", "HEAD"],
      cwd: root,
      stdout: "pipe",
    });
    const fromGit = new TextDecoder().decode(proc.stdout).trim();
    expect(fromLib).toBe(fromGit);
  });

  test("deskProvenanceSnapshot includes bun and sportsdesk head", () => {
    const snap = deskProvenanceSnapshot({ oracleManifestPath: false });
    expect(snap.bun.revision).toBe(Bun.revision);
    const sportsdesk = snap.repos.find((r) => r.name === "sportsdesk-ops");
    expect(sportsdesk?.head).toBe(gitRepoHead(root));
  });

  test("compareBunToOracleManifest matches pinned manager oracle and supports portable vs strict execPath", () => {
    const manifestPath = resolve(
      root,
      "verification/manager-boot-oracle/pinned/manifest.json",
    );
    const check = compareBunToOracleManifest(manifestPath);
    expect(check.ok).toBe(true);
    expect(check.mismatches).toEqual([]);

    const tmp = mkdtempSync(join(tmpdir(), "oracle-pin-"));
    try {
      const customManifest = join(tmp, "manifest.json");
      writeFileSync(
        customManifest,
        JSON.stringify({
          runtime: {
            bunVersion: Bun.version,
            bunRevision: Bun.revision,
            bunExecutablePath: "/nonexistent/runner/bun",
          },
        }),
      );
      expect(compareBunToOracleManifest(customManifest).ok).toBe(true);
      const strict = compareBunToOracleManifest(customManifest, {
        strictExecPath: true,
      });
      expect(strict.ok).toBe(false);
      expect(strict.mismatches[0]).toContain("execPath:");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolveFourcRoot prefers FOURC_ROOT override then existing candidate", () => {
    expect(
      resolveFourcRoot({ FOURC_ROOT: "/custom/fourc", HOME: "/tmp" }),
    ).toBe("/custom/fourc");
    const fallback = resolveFourcRoot({
      HOME: "/nonexistent-home",
      CODE_ROOT: "/nonexistent-code",
    });
    expect(fallback).toBe("/nonexistent-home/4c-odds-intergration");
  });

  test("desk-provenance CLI runs cleanly via direct call and bun x --no-install", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "desk-prov-"));
    try {
      const outFile = join(tmp, "prov.json");
      const code = await runDeskProvenanceCli([
        "--out",
        outFile,
        "--out-only",
        "--check",
      ]);
      expect(code).toBe(0);
      const written = (await Bun.file(outFile).json()) as {
        bun: { version: string; revision: string };
        oracle: { ok: boolean };
      };
      expect(written.bun.version).toBe(Bun.version);
      expect(written.bun.revision).toBe(Bun.revision);
      expect(written.oracle.ok).toBe(true);

      const proc = Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "desk-provenance",
          "--yaml",
          "--check",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const yamlOut = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const parsed = Bun.YAML.parse(yamlOut) as {
        bun: { version: string };
        oracle: { ok: boolean };
      };
      expect(parsed.bun.version).toBe(Bun.version);
      expect(parsed.oracle.ok).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
