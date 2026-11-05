#!/usr/bin/env bun
/**
 * @file scripts/generate_tokens.ts
 * @description Single-Source Code Generator: tokens.toml -> TypeScript + CSS + HTML Dashboards.
 *
 * Enforces zero-drift invariants across the codebase.
 * Usage: bun run scripts/generate_tokens.ts (or bun run gen:tokens)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DASHBOARD_TEMPLATES,
  spliceDashboardHtml,
} from "../lib/gen_tokens/dashboard_templates.ts";
import {
  assertStrictGateEmission,
  buildManifestFromDisk,
  GEN_TOKENS_GATE_RUN_ID_ENV,
} from "../lib/gen_tokens/emission_manifest.ts";
import {
  GEN_TOKEN_EMISSION_MANIFEST,
  GEN_TOKEN_EMISSION_PATHS,
} from "../lib/gen_tokens/emission_targets.ts";
import { DOMAIN_BRANDED_TYPES_PATH } from "../lib/gen_tokens/domain_branded_section.ts";
import { DOMAIN_BRANDED_PREAMBLE } from "../lib/gen_tokens/domain_branded_preamble.ts";
import { DOMAIN_BRANDED_TRANSPORT } from "../lib/gen_tokens/domain_branded_transport.ts";
import { renderDomainBrandedSection7 } from "../lib/gen_tokens/domain_branded_section7.ts";
import {
  parseTokensToml,
  type TokensSsot,
  type UiRole,
} from "../lib/gen_tokens/tokens_ssot.ts";

const rootDir = resolve(import.meta.dir, "..");
const tomlPath = resolve(rootDir, "design/tokens.toml");
const emittedThisRun: string[] = [];

function recordEmission(repoRelativePath: string): void {
  if (!GEN_TOKEN_EMISSION_PATHS.includes(repoRelativePath)) {
    throw new Error(
      `[gen:tokens] internal: unregistered emission path ${repoRelativePath}`,
    );
  }
  emittedThisRun.push(repoRelativePath);
}

function emitRepoFile(
  repoRelativePath: string,
  absolutePath: string,
  content: string,
): void {
  writeFileSync(absolutePath, content, "utf-8");
  recordEmission(repoRelativePath);
}

function writeEmissionManifest(): void {
  assertStrictGateEmission(emittedThisRun);
  const runId = Bun.env[GEN_TOKENS_GATE_RUN_ID_ENV];
  const manifest = buildManifestFromDisk(rootDir, emittedThisRun, runId);
  const manifestPath = resolve(rootDir, GEN_TOKEN_EMISSION_MANIFEST);
  mkdirSync(resolve(manifestPath, ".."), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

if (!Bun.file(tomlPath).size) {
  console.error(`Error: tokens.toml not found at ${tomlPath}`);
  process.exit(1);
}

const tomlText = await Bun.file(tomlPath).text();
let ssot: TokensSsot;
try {
  ssot = parseTokensToml(tomlText);
} catch (e) {
  console.error(`[gen:tokens] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const { surfaces, ingestion, routes, ui } = ssot;

const UI_ROLES = new Set<UiRole>(["surface", "border", "text"]);
for (const t of ui) {
  if (!UI_ROLES.has(t.role) || Bun.color(t.hex, "number") === null) {
    console.error(
      `[gen:tokens] Error: ui token ${t.token_name} needs role surface|border|text and a Bun.color-parseable hex (got role=${t.role}, hex=${t.hex})`,
    );
    process.exit(1);
  }
}

console.log(`[gen:tokens] Loaded tokens.toml (v${ssot.meta.version}):`);
console.log(` - Surfaces : ${surfaces.length}`);
console.log(` - Ingestion: ${ingestion.length}`);
console.log(` - Routes   : ${routes.length}`);
console.log(` - UI       : ${ui.length}`);

// ============================================================================
// 1. GENERATE DOMAIN-BRANDED-TYPES.TS (SECTION 7)
// ============================================================================
const domainBrandedTypesPath = resolve(rootDir, DOMAIN_BRANDED_TYPES_PATH);
const generatedSection7 = renderDomainBrandedSection7(ssot);
const newDomainBrandedText = `${DOMAIN_BRANDED_PREAMBLE}\n\n${DOMAIN_BRANDED_TRANSPORT}\n\n${generatedSection7}`;
emitRepoFile(
  DOMAIN_BRANDED_TYPES_PATH,
  domainBrandedTypesPath,
  newDomainBrandedText,
);
console.log(`[gen:tokens] Emitted updated domain-branded-types.ts`);

// ============================================================================
// 2. GENERATE CSS DECLARATIONS & SYNCHRONIZE DASHBOARDS
// ============================================================================
const allTokens = [...surfaces, ...ui, ...ingestion, ...routes];

function generateHoudiniPropertyCss(): string {
  let css =
    "    /* ==========================================================================\n";
  css +=
    "       1. CSS Houdini @property Declarations (Generated from tokens.toml)\n";
  css +=
    "       Enforces specification-grade design tokens and prevents silent property drop.\n";
  css +=
    "       ========================================================================== */\n";

  for (const t of allTokens) {
    css += `    @property ${t.token_name} {\n`;
    css += `      syntax: '<color>';\n`;
    css += `      inherits: true;\n`;
    css += `      initial-value: ${t.hex};\n`;
    css += `    }\n`;
  }
  return css;
}

function generateRootVariablesCss(): string {
  let css = "    :root {\n";
  css +=
    "      /* Generated from tokens.toml (v" + ssot.meta.version + ") */\n";
  for (const t of allTokens) {
    css += `      ${t.token_name}: ${t.hex};\n`;
  }
  return css;
}

function spliceOrExit(
  html: string,
  filePath: string,
  marker: RegExp,
  replacement: string,
): string {
  if (!marker.test(html)) {
    console.error(
      `[gen:tokens] Error: splice marker not found in ${filePath}: ${marker.source}`,
    );
    process.exit(1);
  }
  return html.replace(marker, replacement);
}

const houdiniCss = generateHoudiniPropertyCss();
const rootVarsCss = generateRootVariablesCss();

for (const template of DASHBOARD_TEMPLATES) {
  const dashboardPath = resolve(rootDir, template.repoPath);
  let html = readFileSync(dashboardPath, "utf-8");
  html = spliceDashboardHtml(
    html,
    dashboardPath,
    template,
    houdiniCss,
    rootVarsCss,
    spliceOrExit,
  );
  emitRepoFile(template.repoPath, dashboardPath, html);
  console.log(`[gen:tokens] Emitted updated ${template.repoPath}`);
}

const bunBin = process.execPath || "bun";
const fmtPaths = emittedThisRun.map((p) => resolve(rootDir, p));
Bun.spawnSync([bunBin, "fmt", ...fmtPaths], {
  cwd: rootDir,
});
console.log(
  `[gen:tokens] Deterministically formatted generated files via bun fmt`,
);

writeEmissionManifest();
console.log("[gen:tokens] Generation completed successfully.");
