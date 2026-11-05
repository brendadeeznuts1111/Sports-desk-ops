#!/usr/bin/env node
/**
 * verify-load — dependency-free smoke test for the SportsDesk desk-status bundle.
 *
 * WHAT THIS PROVES (without a DSH Host):
 *   - the manifest wires the bundle (`dsh.bundle`, `dsh.client`, exports, files, locale, icon),
 *   - the Host half is a deliberate no-op (no services, no tools, no side effects),
 *   - the Client module declares the loader id, injects `slots` + `locale`, registers exactly one
 *     row on `conversation.composer.dock` (id `sportsdesk-desk-status`, order 40, locale NS),
 *   - every visible `t(...)` key exists in BOTH the embedded en and zh dictionaries, and
 *     `locale/en.json` and `locale/zh.json` have identical meta keys,
 *   - the poll effect owns its timer (`clearInterval` on dispose) and the row never writes DOM
 *     outside React, uses literal colors, or fetches any origin other than the desk's two routes.
 *
 * Runs under plain Node and under Bun: no Bun-only APIs, no TS imports, no network.
 *
 * Run: node dsh-plugin-ui/verify-load.mjs
 */
// ast-grep-ignore: node-fs-read-write-file -- this smoke test reads its own bundle files.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs under Node as well as Bun: import.meta.dir is Bun-only.
// ast-grep-ignore: bun-import-meta-dir
const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = "dsh-plugin-sportsdesk-desk-status";
const NS = "sportsdesk-desk-status";
const SLOT = "conversation.composer.dock";

let failed = 0;
let passed = 0;

/** @param {string} label @param {() => void} body */
function check(label, body) {
  try {
    body();
    passed += 1;
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL  ${label}\n        ${message}`);
  }
}

/** @param {unknown} condition @param {string} message */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** @param {string} path */
function readText(path) {
  return readFileSync(join(HERE, path), "utf8");
}

/** Leaf key paths of a locale dictionary, e.g. `meta.title`. */
function leafKeys(value, prefix = "") {
  if (value === null || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

const manifest = JSON.parse(readText("package.json"));

check("manifest: package identity and bundle wiring", () => {
  assert(manifest.name === NAME, `name is ${manifest.name}`);
  assert(
    typeof manifest.version === "string" &&
      /^\d+\.\d+\.\d+$/.test(manifest.version),
    `version is ${manifest.version}`,
  );
  assert(manifest.private === true, "bundle must stay private");
  assert(
    manifest.exports?.["."] === "./index.js",
    "exports['.'] must be ./index.js",
  );
  assert(
    manifest.exports?.["./client"] === "./client.js",
    "exports['./client'] must be ./client.js",
  );
  assert(
    manifest.exports?.["./locale/*.json"] === "./locale/*.json",
    "locale export is missing",
  );
  for (const file of [
    "index.js",
    "client.js",
    "locale/*.json",
    "verify-load.mjs",
  ]) {
    assert(manifest.files?.includes(file), `files must include ${file}`);
  }
  assert(
    manifest.dsh?.bundle?.patch === "./cordis.patch.yml",
    "dsh.bundle.patch must point at the patch",
  );
  assert(
    manifest.dsh?.client?.platform === "web",
    "dsh.client.platform must be web",
  );
  assert(
    manifest.dsh?.client?.immediately === true,
    "dsh.client.immediately must be true",
  );
  const inject = manifest.dsh?.client?.inject ?? [];
  assert(
    inject.includes("@deepseek-ai/dsh-client-ui-conversation"),
    "client must inject the conversation UI package",
  );
  assert(
    inject.includes("@deepseek-ai/dsh-client-locale"),
    "client must inject the locale package",
  );
});

check("manifest: patch, locale and icon exist", () => {
  for (const path of [
    "cordis.patch.yml",
    "icon.svg",
    "locale/en.json",
    "locale/zh.json",
  ]) {
    assert(existsSync(join(HERE, path)), `${path} is missing`);
  }
  assert(
    readText("cordis.patch.yml").includes(NAME),
    "patch does not name the bundle",
  );
});

check("locale: en and zh expose the same meta keys", () => {
  const en = leafKeys(JSON.parse(readText("locale/en.json"))).sort();
  const zh = leafKeys(JSON.parse(readText("locale/zh.json"))).sort();
  assert(en.length > 0, "en locale is empty");
  assert(Bun.deepEquals(en, zh), `en=${en.join(",")} zh=${zh.join(",")}`);
});

/* -------------------------------------------------------------------------- */
/* Host half                                                                  */
/* -------------------------------------------------------------------------- */

const host = await import(pathToFileURL(join(HERE, "index.js")).href);

check("host: apply is a deliberate no-op", () => {
  assert(typeof host.apply === "function", "apply is not exported");
  assert(host.apply.length === 0, "apply must not take services or config");
  const result = host.apply();
  assert(result === undefined, `apply returned ${String(result)}`);
});

/* -------------------------------------------------------------------------- */
/* Client half (static)                                                       */
/* -------------------------------------------------------------------------- */

const client = readText("client.js");

check("client: loader declares the bundle id and factory", () => {
  assert(client.includes("window.__ModuleLoader__.load({"), "no loader call");
  assert(
    client.includes(`id: "${NAME}"`),
    "loader id does not match the package",
  );
  assert(client.includes("factory(require)"), "no factory(require)");
  assert(
    client.includes('require("react")'),
    "React must come from require(react)",
  );
});

check("client: injects slots and locale", () => {
  assert(
    /inject:\s*\[\s*"slots"\s*,\s*"locale"\s*\]/.test(client),
    "inject list is missing",
  );
  assert(
    client.includes(`const NS = "${NS}"`),
    "locale namespace is not declared",
  );
  assert(
    client.includes("ctx.locale.register(NS, DICT)"),
    "dictionary is not registered",
  );
});

check("client: registers exactly the composer row", () => {
  assert(
    client.includes(`ctx.slots.inject("${SLOT}"`),
    "the row does not inject the composer dock",
  );
  assert(client.includes(`name: "${SLOT}"`), "slot name mismatch");
  assert(client.includes('id: "sportsdesk-desk-status"'), "row id mismatch");
  assert(client.includes("order: 40"), "row order mismatch");
  assert(
    client.includes("locale: NS"),
    "row locale must be the bundle namespace",
  );
});

check("client: poll effect owns its timer", () => {
  assert(client.includes("ctx.effect("), "no owned effects");
  assert(client.includes("setInterval("), "no poll timer");
  assert(client.includes("clearInterval(timer)"), "the timer is not cleared");
  assert(client.includes("disposed = true"), "no disposed guard");
});

check("client: stale and down tooltips carry restart guidance", () => {
  assert(client.includes('t("staleHint")'), "stale hint is not used");
  assert(client.includes('t("downHint")'), "down hint is not used");
});

check("client: fetches only the desk's two routes", () => {
  const urls = [...client.matchAll(/https?:\/\/[^\s"'`]+/g)].map((match) =>
    match[0].replace(/[.,;:)]+$/, ""),
  );
  assert(urls.length > 0, "no fetch origins found");
  for (const url of urls) {
    assert(
      url === "http://127.0.0.1:4020" ||
        url.startsWith("http://127.0.0.1:4020/"),
      `unexpected origin in client.js: ${url}`,
    );
  }
  assert(
    client.includes("http://127.0.0.1:4020/health"),
    "health route is missing",
  );
  assert(
    client.includes("http://127.0.0.1:4020/api/status"),
    "status route is missing",
  );
});

check("client: chrome is token-only and DOM-safe", () => {
  for (const forbidden of [
    "document.body",
    "innerHTML",
    "dangerouslySetInnerHTML",
    "eval(",
    "new Function",
  ]) {
    assert(!client.includes(forbidden), `client.js contains ${forbidden}`);
  }
  assert(
    !/@deepseek-ai\/dsh-client-/.test(client),
    "client imports a Harness Client package",
  );
  assert(
    !/(?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/.test(client),
    "client paints a literal color",
  );
  assert(
    client.includes("var(--dsw-alias-"),
    "client does not use host color tokens",
  );
});

check("client: every visible key exists in both dictionaries", () => {
  const start = client.indexOf("const DICT = {");
  assert(start >= 0, "DICT is missing");
  const dict = client.slice(start, client.indexOf("\n    };", start));
  const enAt = dict.indexOf("en: {");
  const zhAt = dict.indexOf("zh: {");
  assert(enAt >= 0 && zhAt > enAt, "DICT must declare en then zh");
  const keys = (block) =>
    [...block.matchAll(/^\s{8}([A-Za-z_]+):/gm)]
      .map((match) => match[1])
      .sort();
  const enKeys = keys(dict.slice(enAt, zhAt));
  const zhKeys = keys(dict.slice(zhAt));
  assert(enKeys.length > 0, "en dictionary is empty");
  assert(
    Bun.deepEquals(enKeys, zhKeys),
    `en=${enKeys.join(",")} zh=${zhKeys.join(",")}`,
  );
  const used = new Set(
    [...client.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]),
  );
  assert(used.size > 0, "the row uses no locale keys");
  for (const key of used) {
    assert(
      enKeys.includes(key),
      `t("${key}") is missing from the en dictionary`,
    );
    assert(
      zhKeys.includes(key),
      `t("${key}") is missing from the zh dictionary`,
    );
  }
});

/* -------------------------------------------------------------------------- */

if (failed > 0) {
  console.error(`\nverify-load: FAIL — ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(
  `\nverify-load: PASS — ${passed} checks (manifest, host no-op, client wiring)`,
);
