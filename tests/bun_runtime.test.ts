import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runDeskProvenanceCli } from "../bin/desk-provenance.ts";
import {
  bunRevisionSha,
  bunRuntimeIdentity,
  compareBunToOracleManifest,
  deskProvenanceSnapshot,
  deskRepoIdentities,
  gitRepoHead,
  gitShortSha,
  GIT,
  GIT_REV_PARSE_HEAD,
  resolveCodeRoot,
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

  test("resolveCodeRoot and deskRepoIdentities resolve capitalized CI checkouts without ~/code", () => {
    expect(
      resolveCodeRoot({
        CODE_ROOT: "  /custom/workspace  ",
        HOME: "/nonexistent-runner-home",
      }),
    ).toBe("/custom/workspace");
    expect(resolveCodeRoot({ HOME: "/nonexistent-runner-home" })).toBe(
      dirname(root),
    );
    expect(
      resolveCodeRoot(
        { HOME: "/nonexistent-runner-home" },
        "/nonexistent-repo-root",
      ),
    ).toBe("/nonexistent-runner-home/code");

    const tmp = mkdtempSync(join(tmpdir(), "ci-checkout-"));
    try {
      const homeWithCode = join(tmp, "dev-home");
      mkdirSync(join(homeWithCode, "code"), { recursive: true });
      const ciCodeRoot = join(tmp, "work", "Sports-desk-ops");
      const ciSelfRepoRoot = join(ciCodeRoot, "Sports-desk-ops");
      mkdirSync(ciSelfRepoRoot, { recursive: true });

      expect(
        Bun.spawnSync({ cmd: ["git", "init"], cwd: ciSelfRepoRoot }).exitCode,
      ).toBe(0);
      expect(
        Bun.spawnSync({
          cmd: ["git", "symbolic-ref", "HEAD", "refs/heads/main"],
          cwd: ciSelfRepoRoot,
        }).exitCode,
      ).toBe(0);
      writeFileSync(join(ciSelfRepoRoot, "README.md"), "ci checkout\n");
      expect(
        Bun.spawnSync({
          cmd: ["git", "add", "README.md"],
          cwd: ciSelfRepoRoot,
        }).exitCode,
      ).toBe(0);
      expect(
        Bun.spawnSync({
          cmd: [
            "git",
            "-c",
            "user.name=CI",
            "-c",
            "user.email=ci@example.com",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "initial ci commit",
          ],
          cwd: ciSelfRepoRoot,
        }).exitCode,
      ).toBe(0);

      expect(resolveCodeRoot({ HOME: homeWithCode }, ciSelfRepoRoot)).toBe(
        join(homeWithCode, "code"),
      );
      const resolvedRoot = resolveCodeRoot(
        { HOME: join(tmp, "runner-home") },
        ciSelfRepoRoot,
      );
      expect(resolvedRoot).toBe(ciCodeRoot);

      const repos = deskRepoIdentities(resolvedRoot, undefined, ciSelfRepoRoot);
      const sportsdesk = repos.find((r) => r.name === "sportsdesk-ops");
      const expectedHead = gitRepoHead(ciSelfRepoRoot);
      expect(expectedHead).toMatch(/^[0-9a-f]{40}$/);
      expect(sportsdesk?.path).toBe(ciSelfRepoRoot);
      expect(sportsdesk?.head).toBe(expectedHead);
      expect(sportsdesk?.branch).toBe("main");
      expect(sportsdesk?.dirty).toBe(false);

      const unrelated = deskRepoIdentities(
        join(tmp, "other-root"),
        undefined,
        ciSelfRepoRoot,
      );
      expect(
        unrelated.find((r) => r.name === "sportsdesk-ops")?.head,
      ).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("compareBunToOracleManifest evaluates pinned manifest and supports portable vs strict execPath", async () => {
    const manifestPath = resolve(
      root,
      "verification/manager-boot-oracle/pinned/manifest.json",
    );
    const manifestJson = (await Bun.file(manifestPath).json()) as {
      runtime?: { bunVersion?: string; bunRevision?: string };
    };
    const check = compareBunToOracleManifest(manifestPath);
    const matchesLiveBinary =
      manifestJson.runtime?.bunVersion === Bun.version &&
      manifestJson.runtime?.bunRevision === Bun.revision;
    expect(check.ok).toBe(matchesLiveBinary);
    if (matchesLiveBinary) {
      expect(check.mismatches).toEqual([]);
    } else {
      expect(check.mismatches.length).toBeGreaterThan(0);
    }

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
        "--no-oracle",
      ]);
      expect(code).toBe(0);
      const written = (await Bun.file(outFile).json()) as {
        bun: { version: string; revision: string };
      };
      expect(written.bun.version).toBe(Bun.version);
      expect(written.bun.revision).toBe(Bun.revision);

      const proc = Bun.spawn(
        [
          process.execPath,
          "x",
          "--no-install",
          "desk-provenance",
          "--yaml",
          "--no-oracle",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const yamlOut = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const parsed = Bun.YAML.parse(yamlOut) as {
        bun: { version: string; revision: string };
      };
      expect(parsed.bun.version).toBe(Bun.version);
      expect(parsed.bun.revision).toBe(Bun.revision);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
