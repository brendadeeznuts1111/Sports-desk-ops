#!/usr/bin/env bun
/**
 * @file scripts/bun_native_rules.ts
 * @description Read-only repository rules behind `scripts/verify_ci_gates.ts`.
 *
 * Every rule inspects the checkout and returns a result; nothing here writes, installs or
 * fetches. The two facts that make the rules safe to run in this repo:
 *
 * - `bun.lock` is Bun 1.4.4's **text** lockfile and carries `lockfileVersion: 2`. The older
 *   "version 1" assertion (and any `bun.lockb`) does not describe this tree.
 * - The root `.env` is a 1Password FIFO on the operator machine. `isRegularFile()` filters
 *   non-regular files before reading, matching Bun's own automatic loader, so a rule run
 *   cannot block on a pipe that waits for a writer.
 *
 * The rule identifiers are the contract `verify_ci_gates.ts` reports; keep them stable.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

export type RuleResult = {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
};

const FOREIGN_LOCKFILES = [
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
] as const;

/** Files where a registry URL or an auth assignment would leak a credential. */
const CREDENTIAL_FILES = ["bunfig.toml", ".npmrc"] as const;

/** Prefixes that define commands; docs and fixtures are not scanned for `bun i -g`. */
const COMMAND_PREFIXES = [
  "scripts/",
  "bin/",
  ".github/",
  "cli/",
  "services/",
] as const;

const COMMAND_FILES = ["package.json"] as const;

const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".sh",
  ".json",
  ".yml",
  ".yaml",
] as const;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function keyedLines(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match;
    if (key !== undefined && value !== undefined && !keys.has(key)) {
      keys.set(key, value.trim());
    }
  }
  return keys;
}

/**
 * The env files a rule may read: root-level `.env*` (examples excluded) plus the operator
 * files the runbooks name. Symlinks and FIFOs are skipped, not followed.
 */
export function envFiles(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        name === "registry.env" ||
        name === "r2.env" ||
        name === "pages.env" ||
        name.startsWith(".env"),
    )
    .filter((name) => !name.endsWith(".example"))
    .filter((name) => isRegularFile(join(root, name)))
    .sort();
}

/** One text `bun.lock` at the root, `lockfileVersion: 2`, no foreign or nested lockfiles. */
export function checkLockfiles(root: string): RuleResult[] {
  const results: RuleResult[] = [];
  const lockPath = join(root, "bun.lock");
  const text = readText(lockPath);

  if (text === null) {
    return [
      {
        id: "lockfile/single-text",
        ok: false,
        detail: "bun.lock is missing",
      },
    ];
  }

  results.push({
    id: "lockfile/single-text",
    ok: true,
    detail: "bun.lock is the only lockfile",
  });

  try {
    const parsed = Bun.JSONC.parse(text) as { lockfileVersion?: unknown };
    const version = parsed.lockfileVersion;
    results.push({
      id: "lockfile/version",
      ok: version === 2,
      detail: `lockfileVersion=${String(version)} (Bun 1.4.4 text lockfile is 2)`,
    });
  } catch (error) {
    results.push({
      id: "lockfile/version",
      ok: false,
      detail: `bun.lock is not JSONC-parseable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const foreign = FOREIGN_LOCKFILES.filter((name) =>
    existsSync(join(root, name)),
  );
  results.push({
    id: "lockfile/no-foreign",
    ok: foreign.length === 0,
    detail:
      foreign.length === 0
        ? "no bun.lockb/package-lock.json/yarn.lock/pnpm-lock.yaml"
        : foreign.join(", "),
  });

  const nested: string[] = [];
  let packages: string[] = [];
  try {
    packages = readdirSync(join(root, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    packages = [];
  }
  for (const name of packages) {
    for (const lock of ["bun.lock", "bun.lockb"] as const) {
      const relative = `packages/${name}/${lock}`;
      if (existsSync(join(root, relative))) nested.push(relative);
    }
  }
  results.push({
    id: "lockfile/no-nested",
    ok: nested.length === 0,
    detail:
      nested.length === 0 ? "no nested workspace lockfiles" : nested.join(", "),
  });

  const bunfig = readText(join(root, "bunfig.toml"));
  if (bunfig !== null) {
    try {
      const parsed = Bun.TOML.parse(bunfig) as {
        install?: { lockfile?: { print?: unknown } };
      };
      const print = parsed.install?.lockfile?.print;
      results.push({
        id: "lockfile/no-yarn-print",
        ok: print === undefined,
        detail:
          print === undefined
            ? "no [install.lockfile].print"
            : `[install.lockfile].print=${String(print)}`,
      });
    } catch (error) {
      results.push({
        id: "lockfile/no-yarn-print",
        ok: false,
        detail: `bunfig.toml is not TOML-parseable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return results;
}

/** No URL userinfo, no literal `_auth`/`_authToken`, no `:username=`/`:_password=`. */
export function checkCredentials(root: string): RuleResult[] {
  const results: RuleResult[] = [];
  const files = CREDENTIAL_FILES.map((name) => join(root, name)).filter(
    (path) => isRegularFile(path),
  );

  const urlHits: string[] = [];
  const literalAuth: string[] = [];
  const npmrc = join(root, ".npmrc");

  for (const path of files) {
    const text = readText(path);
    if (text === null) continue;
    const label = path.slice(root.length + 1);
    text.split("\n").forEach((line, index) => {
      const location = `${label}:${index + 1}`;
      if (/https?:\/\/[^\s"'/@]+:[^\s"'/@]+@/.test(line))
        urlHits.push(location);
      const auth = /(?:^|[\s;])(?:_auth|_authToken)=(\S+)/.exec(line);
      if (auth?.[1] !== undefined && !auth[1].startsWith("$"))
        literalAuth.push(location);
      if (/:username=|:_password=/.test(line)) literalAuth.push(location);
    });
  }

  results.push({
    id: "credentials/no-url-userinfo",
    ok: urlHits.length === 0,
    detail:
      urlHits.length === 0 ? "no user:pass@ registry URLs" : urlHits.join(", "),
  });

  results.push({
    id: "credentials/no-literal-auth",
    ok: literalAuth.length === 0,
    detail:
      literalAuth.length === 0
        ? "no literal _auth/_authToken/:username= entries"
        : literalAuth.join(", "),
  });

  results.push({
    id: "credentials/no-repo-npmrc",
    ok: !existsSync(npmrc),
    detail: existsSync(npmrc)
      ? "repo .npmrc exists; registry config belongs in ~/.npmrc"
      : "no repo .npmrc",
  });

  // A 112-char pre-Base64 Azure PAT must never sit behind NPM_PASSWORD.
  const patHits: string[] = [];
  for (const file of [...envFiles(root), ".npmrc"]) {
    const text = readText(
      file === ".npmrc" ? join(root, file) : join(root, file),
    );
    if (text === null) continue;
    const value = keyedLines(text).get("NPM_PASSWORD");
    if (value === undefined) continue;
    const bare = value.replace(/^["']|["']$/g, "");
    const decoded = Buffer.from(bare, "base64").toString("utf8");
    if (bare.length === 112 || decoded.length === 112) patHits.push(file);
  }
  results.push({
    id: "credentials/no-double-base64-pat",
    ok: patHits.length === 0,
    detail:
      patHits.length === 0
        ? "no 112-char NPM_PASSWORD PAT (ERR_NPM_DOUBLE_BASE64_PAT)"
        : patHits.join(", "),
  });

  return results;
}

/**
 * Cloudflare credentials stay out of Bun's *auto-loaded* root env files, and the R2 and
 * Pages tokens never share one file. Regular files only: this checkout's `.env` is a FIFO.
 */
export function checkEnvIsolation(root: string): RuleResult[] {
  const files = envFiles(root);
  const bleed: string[] = [];
  const autoLoaded: string[] = [];

  for (const name of files) {
    const text = readText(join(root, name));
    if (text === null) continue;
    const keys = keyedLines(text);
    const hasR2 = keys.has("CLOUDFLARE_R2_API_TOKEN");
    const hasPages = keys.has("CLOUDFLARE_API_TOKEN");
    if (hasR2 && hasPages) bleed.push(name);
    const isAutoLoaded =
      name === ".env" ||
      name === ".env.local" ||
      name.startsWith(".env.production");
    if (isAutoLoaded && (hasR2 || hasPages)) autoLoaded.push(name);
  }

  return [
    {
      id: "env/no-cloudflare-token-bleed",
      ok: bleed.length === 0 && autoLoaded.length === 0,
      detail:
        bleed.length === 0 && autoLoaded.length === 0
          ? files.length === 0
            ? "no regular env files (FIFO/symlink skipped)"
            : `checked ${files.length} regular env file(s); no Cloudflare token in .env/.env.local/.env.production*`
          : [
              bleed.length === 0
                ? ""
                : `both tokens in ${bleed.join(", ")} (ERR_CF_TOKEN_BLEED_10000)`,
              autoLoaded.length === 0
                ? ""
                : `Cloudflare token in auto-loaded ${autoLoaded.join(", ")}`,
            ]
              .filter((part) => part !== "")
              .join("; "),
    },
  ];
}

/** `bun.lock` text attributes precede `*.lockb`, and `binary` precedes `diff=lockb`. */
export function checkGitattributes(root: string): RuleResult[] {
  const path = join(root, ".gitattributes");
  const text = readText(path);
  if (text === null) {
    return [
      {
        id: "gitattributes/order",
        ok: false,
        detail: ".gitattributes is missing",
      },
    ];
  }

  const lines = text.split("\n").map((line) => line.trim());
  const bunLock = lines.findIndex(
    (line) => line.split(/\s+/)[0] === "bun.lock",
  );
  const lockb = lines.findIndex((line) => line.split(/\s+/)[0] === "*.lockb");
  const problems: string[] = [];

  if (bunLock === -1) problems.push("missing `bun.lock` rule");
  if (lockb === -1) problems.push("missing `*.lockb` rule");
  if (bunLock !== -1 && lockb !== -1 && bunLock > lockb) {
    problems.push("`*.lockb` is declared before `bun.lock`");
  }

  if (bunLock !== -1) {
    const rule = lines[bunLock] ?? "";
    for (const attr of ["text", "eol=lf", "linguist-generated=true"]) {
      if (!rule.split(/\s+/).includes(attr))
        problems.push(`bun.lock rule lacks ${attr}`);
    }
  }

  if (lockb !== -1) {
    const tokens = (lines[lockb] ?? "").split(/\s+/);
    const binary = tokens.indexOf("binary");
    const diff = tokens.indexOf("diff=lockb");
    if (binary === -1) problems.push("*.lockb rule lacks binary");
    if (diff === -1) problems.push("*.lockb rule lacks diff=lockb");
    if (binary !== -1 && diff !== -1 && binary > diff) {
      problems.push("`diff=lockb` is declared before `binary`");
    }
  }

  return [
    {
      id: "gitattributes/order",
      ok: problems.length === 0,
      detail:
        problems.length === 0
          ? "bun.lock (text) before *.lockb (binary, diff=lockb)"
          : problems.join("; "),
    },
  ];
}

/** Zero tracked SQLite/database artifacts. JSON is not checked: 196 tracked `.json` files. */
export function checkTrackedDatabases(root: string): RuleResult[] {
  const git = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z", "*.sqlite", "*.sqlite3", "*.db"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0) {
    return [
      {
        id: "artifacts/no-tracked-databases",
        ok: false,
        detail: `git ls-files failed: ${git.stderr.toString().trim()}`,
      },
    ];
  }
  const tracked = git.stdout
    .toString()
    .split("\0")
    .filter((entry) => entry !== "");
  return [
    {
      id: "artifacts/no-tracked-databases",
      ok: tracked.length === 0,
      detail:
        tracked.length === 0
          ? "no tracked *.sqlite/*.sqlite3/*.db"
          : tracked.join(", "),
    },
  ];
}

/** No documented or scripted global install (`bun i -g`, `bun install -g`). */
export function checkGlobalInstalls(root: string): RuleResult[] {
  const git = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z"],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0) {
    return [
      {
        id: "pm/no-global-install",
        ok: false,
        detail: `git ls-files failed: ${git.stderr.toString().trim()}`,
      },
    ];
  }

  const hits: string[] = [];
  for (const path of git.stdout.toString().split("\0")) {
    if (path === "") continue;
    // This module names the forbidden command in its own regex source; scanning it would
    // always match itself. Its only job is the pattern, not a global install.
    if (path === "scripts/bun_native_rules.ts") continue;
    const inPrefix = COMMAND_PREFIXES.some((prefix) => path.startsWith(prefix));
    const isCommandFile = (COMMAND_FILES as readonly string[]).includes(path);
    const extension = path.slice(path.lastIndexOf("."));
    if (!inPrefix && !isCommandFile) continue;
    if (
      !inPrefix &&
      !(SCANNED_EXTENSIONS as readonly string[]).includes(extension)
    )
      continue;
    const full = join(root, path);
    try {
      if (statSync(full).size > 512_000) continue;
    } catch {
      continue;
    }
    const text = readText(full);
    if (text === null) continue;
    text.split("\n").forEach((line, index) => {
      if (/\bbun\s+(?:i|install)\s+-g\b/.test(line))
        hits.push(`${path}:${index + 1}`);
    });
  }

  return [
    {
      id: "pm/no-global-install",
      ok: hits.length === 0,
      detail:
        hits.length === 0
          ? "no `bun i -g` in command surfaces"
          : hits.join(", "),
    },
  ];
}

export function runAllRules(root: string): RuleResult[] {
  return [
    ...checkLockfiles(root),
    ...checkCredentials(root),
    ...checkEnvIsolation(root),
    ...checkGitattributes(root),
    ...checkTrackedDatabases(root),
    ...checkGlobalInstalls(root),
  ];
}
