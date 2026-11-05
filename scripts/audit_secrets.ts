#!/usr/bin/env bun
/**
 * @file scripts/audit_secrets.ts
 * @description Compare the environment variables the code reads with `lib/secret_manifest.ts`.
 *
 *   bun run audit:secrets                 enforce: exit 1 on an unregistered secret-like name
 *   bun run audit:secrets --report-only   print findings, always exit 0
 *   bun run audit:secrets --explain NAME  every place NAME is read
 *
 * Reads tracked files only (`git ls-files`), so a stray local file cannot change the result.
 */
import {
  NON_SECRET_ALLOWLIST,
  SECRET_MANIFEST,
  manifestNames,
} from "../lib/secret_manifest.ts";
import {
  audit,
  explainUnregistered,
  scanEnvReads,
} from "../lib/secret_audit.ts";
import type { SourceFile } from "../lib/secret_audit.ts";

const MANIFEST_PATHS = [
  "lib/secret_manifest.ts",
  "lib/secret_audit.ts",
  "scripts/audit_secrets.ts",
];

const args = process.argv.slice(2);
const reportOnly = args.includes("--report-only");
const explainIndex = args.indexOf("--explain");
const explainName = explainIndex === -1 ? undefined : args[explainIndex + 1];
if (explainIndex !== -1 && explainName === undefined) {
  console.error("audit:secrets: --explain needs a variable name");
  process.exit(2);
}

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|fixtures)\//.test(path) || /\.test\.[cm]?[jt]s$/.test(path)
  );
}

async function trackedFiles(): Promise<string[]> {
  const child = Bun.spawn(["git", "ls-files", "*.ts", "*.js", "*.mjs"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([child.stdout.text(), child.exited]);
  if (code !== 0) {
    console.error(
      "audit:secrets: `git ls-files` failed; run it inside the repo",
    );
    process.exit(2);
  }
  return out.split("\n").filter((line) => line !== "");
}

const everything: SourceFile[] = [];
for (const path of await trackedFiles()) {
  const file = Bun.file(path);
  if (!(await file.exists())) continue;
  everything.push({ path, text: await file.text() });
}
const sources = everything.filter(
  (file) => !isTestPath(file.path) && !file.path.startsWith("docs/"),
);

if (explainName !== undefined) {
  let hits = 0;
  for (const file of everything) {
    for (const read of scanEnvReads(file.text)) {
      if (read.name !== explainName) continue;
      console.log(`${file.path}:${read.line}`);
      hits += 1;
    }
  }
  const entry = SECRET_MANIFEST.find(
    (secret) => secret.envName === explainName,
  );
  console.log(
    entry === undefined
      ? `${explainName}: not in the manifest (${hits} read${hits === 1 ? "" : "s"})`
      : `${explainName}: in the manifest, groups ${entry.groups.join("+")} (${hits} read${hits === 1 ? "" : "s"})`,
  );
  process.exit(0);
}

const result = audit({
  sources,
  everything,
  registered: manifestNames(),
  entries: SECRET_MANIFEST.map((secret) => ({
    names: [
      secret.envName,
      ...(secret.aliases ?? []),
      ...(secret.keychainName === null ? [] : [secret.keychainName]),
    ],
  })),
  allowlist: NON_SECRET_ALLOWLIST,
  manifestPaths: MANIFEST_PATHS,
});

for (const item of result.unregistered) {
  console.error(`${explainUnregistered(item)}\n`);
}
for (const name of result.badAllowlist) {
  console.error(
    `NON_SECRET_ALLOWLIST entry ${name} is registered, or does not end in a soft suffix (_KEY, _KEY_ID, _ID): remove it`,
  );
}
for (const name of result.dead) {
  console.warn(
    `warning: ${name} is in the manifest but no file outside it mentions it`,
  );
}

const failed = result.unregistered.length > 0 || result.badAllowlist.length > 0;
console.log(
  `audit:secrets: ${SECRET_MANIFEST.length} manifest entries, ${sources.length} source files, ` +
    `${result.unregistered.length} unregistered, ${result.dead.length} unreferenced` +
    (failed && reportOnly ? " (report only: not failing)" : ""),
);
process.exit(failed && !reportOnly ? 1 : 0);
