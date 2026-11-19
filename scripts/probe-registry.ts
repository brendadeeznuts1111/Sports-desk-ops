import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const pkg = process.argv[2];
if (process.argv.length !== 3 || !pkg || pkg.startsWith("-") || /\s/.test(pkg)) {
  console.error("Usage: bun run scripts/probe-registry.ts <package>");
  process.exit(1);
}

const env = process.env;
const profile =
  env.SPORTSDESK_PROFILE || env.TERM_PROFILE || env.ITERM_PROFILE ||
  env.WT_PROFILE_NAME || env.STARSHIP_PROFILE || "default";
const configuredPath = env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig;
const path = configuredPath || join(homedir(), ".npmrc");
const configPath = resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function registryLabel(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.origin + url.pathname;
  } catch {
    return "(invalid registry URL)";
  }
}

const context = {
  profile, pkg, configPath,
  configSource: configuredPath ? "environment" : "default",
  configExists: existsSync(configPath),
  registryOverride: registryLabel(env.NPM_CONFIG_REGISTRY || env.npm_config_registry),
};

const start = performance.now();
const result = spawnSync(process.execPath, ["info", pkg, "version", "--json"], {
  encoding: "utf8",
});
const elapsedMs = Number((performance.now() - start).toFixed(2));

function fail(error: string, code = 1): never {
  console.error(JSON.stringify({ ok: false, ...context, elapsedMs, error }, null, 2));
  process.exit(code);
}

if (result.status !== 0) {
  fail(result.error?.name || result.signal || "bun info failed", result.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  fail("bun info returned invalid JSON");
}
const version = typeof payload === "string" ? payload : payload?.version;
if (typeof version !== "string" || !version.trim()) {
  fail("bun info returned no version string");
}
console.log(JSON.stringify({ ok: true, ...context, version, elapsedMs }, null, 2));
