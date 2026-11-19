import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspect, parseArgs } from "node:util";

const env = process.env;
const authKeys = ["NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN"];
const secrets = new Set(Object.entries(env)
  .filter(([key, value]) => value && /(?:token|password|secret|_auth)$/i.test(key))
  .map(([, value]) => value as string));

function safe(text: string): string {
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\b(?:Basic|Bearer)\s+[^\s"',;]+/gi, "[redacted authorization]")
    .replace(/((?:_auth(?:Token)?|_password|password|authorization|[\w-]*token)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi, "$1[redacted]")
    .replace(/(?:https?:)?\/\/[^\s"'<>]+/gi, value => {
      try { return new URL(value, "https://localhost").origin; } catch { return "[redacted URL]"; }
    })
    .replace(/([?&](?:auth|token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

const json = process.argv.slice(2).includes("--json");
function emit(report: Record<string, unknown>, code = 0) {
  const stream = json || !code ? process.stdout : process.stderr;
  // Sanitize leaf strings before rendering, including config paths and profile names.
  const clean = JSON.stringify(report, (_k, v) => typeof v === "string" ? safe(v) : v, 2);
  stream.write((json ? clean : inspect(JSON.parse(clean), { depth: null, colors: stream.isTTY })) + "\n");
  process.exitCode = code;
}

function origin(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function config(path: string, scope: string) {
  const exists = existsSync(path);
  const rules: { key: string; origin: string | null }[] = [];
  let authConfigured = false;
  let readable = false;
  if (exists) {
    try {
      for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
        const match = /^\s*([^#;=]+?)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        const key = match[1]!;
        const raw = match[2]!;
        const value = raw.replace(/^(['"])(.*)\1$/, "$2");
        if (/(?:^|:)(?:_authToken|_auth|_password|username)$/i.test(key)) {
          authConfigured = true;
          if (value && !value.includes("${")) secrets.add(value);
        }
        if (key === "registry" || (scope && key === scope + ":registry")) {
          rules.push({ key, origin: origin(value.replace(/\$\{([^}]+)\}/g, (_, k: string) => env[k] ?? "")) });
        }
      }
      readable = true;
    } catch { /* Report unreadable config without echoing its contents. */ }
  }
  return { path, exists, readable, authConfigured, rules };
}

function versions(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(versions);
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  if ("version" in item) return versions(item.version);
  if ("dist-tags" in item) return versions(item["dist-tags"]);
  if ("latest" in item) return versions(item.latest);
  const tags = Object.values(item);
  return tags.every(v => typeof v === "string" && /^\d+\.\d+\.\d+/.test(v)) ? tags as string[] : [];
}

function failure(text: string) {
  if (/\b(401|403|E401|E403)\b/i.test(text)) return "auth: check token presence, scope and permissions";
  if (/\b(404|E404)\b/i.test(text)) return "not found: check registry, package and version";
  if (/certificate|\bTLS\b|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(text)) return "TLS: check CA trust";
  return "bun info failed";
}

function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: "boolean" }, cold: { type: "boolean" },
  } });
  const [pkg] = positionals;
  if (positionals.length !== 1 || !pkg || !/^(@[\w.-]+\/)?[\w.-]+(@[^\s/:?#]+)?$/.test(pkg)) {
    throw new Error("Usage: bun run scripts/probe-registry.ts <package> [--cold] [--json]");
  }
  const scope = pkg.startsWith("@") ? pkg.split("/")[0] : "";
  const profileKey = ["SPORTSDESK_PROFILE","TERM_PROFILE","ITERM_PROFILE","WT_PROFILE_NAME","STARSHIP_PROFILE"].find(k => env[k]);
  const configKey = ["NPM_CONFIG_USERCONFIG","npm_config_userconfig"].find(k => env[k]);
  const path = configKey ? env[configKey]! : join(homedir(), ".npmrc");
  const user = config(resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path), scope);
  const project = config(resolve(".npmrc"), scope);
  const registryEnv = Object.entries(env).filter(([key]) => {
    const name = key.toLowerCase();
    return name === "npm_config_registry" || (scope && name === "npm_config_" + scope + ":registry");
  }).map(([key, value]) => ({ key, origin: origin(value) }));
  const runtime = process.versions.bun ? process.execPath : null;
  const binary = runtime || "bun";
  const pathCheck = runtime ? null : spawnSync(binary, ["-p", "process.execPath"], { encoding: "utf8" });
  const bunPath = runtime || (pathCheck?.status === 0 ? pathCheck.stdout.trim() : null);
  const context = {
    pkg, profile: profileKey ? env[profileKey] : "default", profileKey: profileKey ?? null,
    bunPath, configPath: user.path, configExists: user.exists, configSource: configKey ?? "default",
    user, project, projectBunfigExists: existsSync(resolve("bunfig.toml")), registryEnv, registryOverride: origin(env.NPM_CONFIG_REGISTRY || env.npm_config_registry),
    authEnv: Object.fromEntries(authKeys.map(key => [key, Boolean(env[key])])),
  };
  if (!bunPath) {
    return emit({ ...context, ok: false, exitCode: pathCheck?.status ?? null, signal: pathCheck?.signal ?? null,
      error: pathCheck?.error?.message ?? "Unable to resolve bun from PATH" }, 1);
  }
  const samples = [];
  const coldDir = values.cold ? mkdtempSync(join(tmpdir(), "registry-probe-")) : null;
  try {
    for (const cold of coldDir ? [false, true] : [false]) {
      const start = performance.now();
      const result = spawnSync(bunPath, ["info", pkg, "version", "dist.tarball", "--json"], {
        encoding: "utf8", env: cold ? { ...env, BUN_INSTALL_CACHE_DIR: coldDir! } : env,
      });
      const elapsedMs = +(performance.now() - start).toFixed(3);
      const stderr = result.stderr || "";
      const response = /\bGET\s+(https?:\/\/[^\s]+)\s+-\s+(\d{3})\b/i.exec(stderr);
      const timing = {
        elapsedMs, cacheDirectory: cold ? "fresh temporary directory" : "inherited",
        force: false, noCache: false, metadataResponseOrigin: origin(response?.[1]),
        networkEvidence: response ? "GET status diagnostic" : "unobserved",
        cacheHit: null,
        cacheHint: elapsedMs < 50 ? "Fast run; cached metadata possible" : null,
        exitCode: result.status, signal: result.signal,
      };
      if (result.status !== 0) {
        samples.push({ ...timing, error: result.error?.message ?? failure(stderr), stderr: safe(stderr).trim().slice(-1200) });
        return emit({ ok: false, ...context, samples }, result.status ?? 1);
      }
      const parseStart = performance.now();
      let payload: unknown;
      try { payload = JSON.parse(result.stdout); } catch { /* Include sanitized excerpt below. */ }
      const parsed = [...new Set(versions(payload))];
      const parseMs = +(performance.now() - parseStart).toFixed(3);
      if (!parsed.length) {
        samples.push({ ...timing, parseMs, error: "Unexpected version payload", excerpt: safe(result.stdout).slice(0, 800) });
        return emit({ ok: false, ...context, samples }, 1);
      }
      const item = payload as { dist?: { tarball?: string }; "dist.tarball"?: string };
      samples.push({ ...timing, parseMs, version: parsed.length === 1 ? parsed[0] : parsed,
        tarballOrigin: origin(item.dist?.tarball ?? item["dist.tarball"]) });
    }
    const last = samples[samples.length - 1]!;
    emit({ ok: true, ...context, version: last.version, elapsedMs: last.elapsedMs, samples });
  } finally {
    if (coldDir) rmSync(coldDir, { recursive: true, force: true });
  }
}
try { main(); } catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : "Registry probe failed" }, 1);
}
