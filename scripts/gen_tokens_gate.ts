#!/usr/bin/env bun
/**
 * Zero-drift gate driven by GEN_TOKEN_EMISSION_TARGETS (explicit phases).
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  GEN_TOKENS_GATE_ENV,
  GEN_TOKENS_GATE_RUN_ID_ENV,
  verifyManifestAgainstDisk,
} from "../lib/gen_tokens/emission_manifest.ts";
import {
  GEN_TOKEN_EMISSION_MANIFEST,
  GEN_TOKEN_EMISSION_TARGETS,
  type GenTokenEmissionManifest,
} from "../lib/gen_tokens/emission_targets.ts";

const rootDir = path.resolve(import.meta.dir, "..");

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL ?? "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(args: string[]): { ok: boolean; stdout: string } {
  const r = spawnSync("git", args, {
    cwd: rootDir,
    encoding: "utf-8",
    env: gitEnv,
  });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

function run(cmd: string, args: string[]): number {
  const r = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: "inherit",
    encoding: "utf-8",
    env: cmd === "git" ? gitEnv : process.env,
  });
  return r.status ?? 1;
}

function pathsForReset(kind: "git-checkout-head" | "rm-before-gen"): string[] {
  return GEN_TOKEN_EMISSION_TARGETS.filter((t) => t.reset === kind).map(
    (t) => t.repoPath,
  );
}

function loadManifest(): GenTokenEmissionManifest | null {
  const manifestPath = path.join(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, "utf-8"),
    ) as GenTokenEmissionManifest;
  } catch {
    return null;
  }
}

function main(): number {
  const allPaths = GEN_TOKEN_EMISSION_TARGETS.map((t) => t.repoPath);

  if (!git(["diff", "--quiet", "--", ...allPaths]).ok) {
    console.error(
      "::error::generated token outputs are dirty — commit or stash before running gen:tokens:gate",
    );
    spawnSync("git", ["diff", "--stat", "--", ...allPaths], {
      cwd: rootDir,
      stdio: "inherit",
    });
    return 1;
  }

  const manifestPath = path.join(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  const checkoutPaths = pathsForReset("git-checkout-head");
  if (checkoutPaths.length > 0) {
    if (run("git", ["checkout", "HEAD", "--", ...checkoutPaths]) !== 0) {
      return 1;
    }
  }

  const rmPaths = pathsForReset("rm-before-gen");
  for (const p of rmPaths) {
    fs.rmSync(path.join(rootDir, p), { force: true });
  }

  const gateRunId = randomUUID();
  const genEnv = {
    ...Bun.env,
    [GEN_TOKENS_GATE_ENV]: "1",
    [GEN_TOKENS_GATE_RUN_ID_ENV]: gateRunId,
  };
  const gen = spawnSync("bun", ["run", "gen:tokens"], {
    cwd: rootDir,
    stdio: "inherit",
    encoding: "utf-8",
    env: genEnv,
  });
  if ((gen.status ?? 1) !== 0) {
    console.error(
      "::error::gen:tokens exited non-zero — fix scripts/generate_tokens.ts or tokens.toml (drift check skipped)",
    );
    return 1;
  }

  const manifest = loadManifest();
  if (!manifest) {
    console.error(
      "::error::gen:tokens did not write emission manifest (partial run or skip)",
    );
    return 1;
  }

  const manifestErr = verifyManifestAgainstDisk(rootDir, manifest, gateRunId);
  if (manifestErr) {
    console.error(`::error::${manifestErr}`);
    return 1;
  }

  let failed = 0;
  for (const target of GEN_TOKEN_EMISSION_TARGETS) {
    const full = path.join(rootDir, target.repoPath);
    if (!fs.existsSync(full)) {
      console.error(`::error::gen:tokens did not write ${target.repoPath}`);
      failed = 1;
      continue;
    }
    if (!git(["diff", "--quiet", "--", target.repoPath]).ok) {
      console.error(
        `::error::${target.repoPath} does not match gen:tokens output — run \`bun run gen:tokens\` and commit (do not hand-edit generated files)`,
      );
      spawnSync("git", ["diff", "--", target.repoPath], {
        cwd: rootDir,
        stdio: "inherit",
      });
      failed = 1;
    }
  }

  return failed;
}

process.exit(main());
