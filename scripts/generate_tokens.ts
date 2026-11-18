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
  renderAccessibilityMedia,
  renderCasHoudiniProperties,
  renderCasVars,
  renderLayoutMotionVars,
} from "../lib/gen_tokens/css_option_sections.ts";
import { emitGeneratedAnsiTokensModule } from "../lib/gen_tokens/ansi_tokens_module.ts";
import { renderTokenRegistryModule } from "../lib/gen_tokens/token_registry_module.ts";
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
const { surfaces, ingestion, routes, ui, sla } = ssot;
const { layout, motion, cas_states: casStates } = ssot;
const accessibilityAliases = ssot.aliases.accessibility;

const UI_ROLES = new Set<UiRole>([
  "surface",
  "border",
  "border_hairline",
  "border_interactive",
  "focus",
  "text",
]);
for (const t of ui) {
  if (!UI_ROLES.has(t.role) || Bun.color(t.hex, "number") === null) {
    console.error(
      `[gen:tokens] Error: ui token ${t.token_name} needs valid role and Bun.color-parseable hex (got role=${t.role}, hex=${t.hex})`,
    );
    process.exit(1);
  }
}

const slaCssTokens = sla.flatMap((s) => [
  { token_name: s.token_name, hex: s.fg_hex },
  { token_name: `${s.token_name}-bg`, hex: s.bg_hex },
  { token_name: `${s.token_name}-border`, hex: s.border_hex },
]);

const legacyAliases = ssot.aliases.legacy;
const dashboardAliases = ssot.aliases.dashboard;

console.log(`[gen:tokens] Loaded tokens.toml (v${ssot.meta.version}):`);
console.log(` - Surfaces : ${surfaces.length}`);
console.log(` - Ingestion: ${ingestion.length}`);
console.log(` - Routes   : ${routes.length}`);
console.log(` - UI       : ${ui.length}`);
console.log(` - SLA      : ${sla.length} (${slaCssTokens.length} CSS tokens)`);
console.log(
  ` - Aliases  : ${legacyAliases.length} legacy + ${dashboardAliases.length} dashboard`,
);

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
const allTokens = [
  ...surfaces.map((token) => ({ ...token, group: "surfaces" as const })),
  ...ui.map((token) => ({ ...token, group: "ui" as const })),
  ...slaCssTokens.map((token) => ({ ...token, group: "sla" as const })),
  ...ingestion.map((token) => ({ ...token, group: "ingestion" as const })),
  ...routes.map((token) => ({ ...token, group: "routes" as const })),
];

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
  css += renderCasHoudiniProperties(casStates, "    ");
  return css;
}

function generateRootVariablesCss(): string {
  let css = "    :root {\n";
  css +=
    "      /* Generated from tokens.toml (v" + ssot.meta.version + ") */\n";
  for (const t of allTokens) {
    css += `      ${t.token_name}: ${t.hex};\n`;
  }
  for (const entry of legacyAliases) {
    css += `      ${entry.alias}: var(${entry.target});\n`;
  }
  css += renderLayoutMotionVars(layout, motion);
  css += renderCasVars(casStates);
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

function generateStandaloneDashboardTokensCss(): string {
  let css = `/**
 * @file src/dashboard/tokens.generated.css
 * @description Generated from design/tokens.toml (v${ssot.meta.version}) via \`bun run gen:tokens\`.
 * DO NOT EDIT BY HAND — enforced by \`bun run gen:tokens:gate\`.
 */

/* ==========================================================================
   1. CSS Houdini @property Declarations (Generated from tokens.toml)
   Enforces specification-grade design tokens and prevents silent property drop.
   ========================================================================== */
`;
  for (const t of allTokens) {
    css += `@property ${t.token_name} {\n`;
    css += `  syntax: "<color>";\n`;
    css += `  inherits: true;\n`;
    css += `  initial-value: ${t.hex};\n`;
    css += `}\n\n`;
  }
  css += renderCasHoudiniProperties(casStates);
  if (casStates !== undefined) css += "\n";

  css += `/* ==========================================================================
   2. Canonical :root Custom Properties & Semantic Surface Aliases
   ========================================================================== */
:root {
  color-scheme: dark;
  /* Generated from tokens.toml (v${ssot.meta.version}) */
`;
  for (const t of allTokens) {
    css += `  ${t.token_name}: ${t.hex};\n`;
  }
  for (const entry of legacyAliases) {
    css += `  ${entry.alias}: var(${entry.target});\n`;
  }
  css += `\n  /* Semantic dashboard aliases mapped to canonical tokens.toml variables */\n`;
  for (const entry of dashboardAliases) {
    css += `  ${entry.alias}: var(${entry.target});\n`;
  }
  css += renderLayoutMotionVars(layout, motion);
  css += renderCasVars(casStates);
  css += `}\n`;
  const accessibilityCss = renderAccessibilityMedia(accessibilityAliases);
  if (accessibilityCss.length > 0) css += `\n${accessibilityCss}`;
  return css;
}

const standaloneCssRelPath = "src/dashboard/tokens.generated.css";
const standaloneCssAbsPath = resolve(rootDir, standaloneCssRelPath);
mkdirSync(resolve(standaloneCssAbsPath, ".."), { recursive: true });
emitRepoFile(
  standaloneCssRelPath,
  standaloneCssAbsPath,
  generateStandaloneDashboardTokensCss(),
);
console.log(`[gen:tokens] Emitted updated ${standaloneCssRelPath}`);

// The UI palette + footer read the same arrays the CSS above was built from.
const registryRelPath = "packages/ui/src/tokens.registry.generated.ts";
const registryAbsPath = resolve(rootDir, registryRelPath);
mkdirSync(resolve(registryAbsPath, ".."), { recursive: true });
emitRepoFile(
  registryRelPath,
  registryAbsPath,
  renderTokenRegistryModule({
    version: ssot.meta.version,
    tokens: allTokens.map(({ token_name, hex, group }) => ({
      token_name,
      hex,
      group,
    })),
    aliases: [
      ...legacyAliases.map((alias) => ({ ...alias, scope: "legacy" as const })),
      ...dashboardAliases.map((alias) => ({
        ...alias,
        scope: "dashboard" as const,
      })),
    ],
    rootOptionDeclarations: [
      renderLayoutMotionVars(layout, motion),
      renderCasVars(casStates),
    ]
      .join("")
      .split("\n")
      .filter((line) => line.length > 0),
  }),
);
console.log(`[gen:tokens] Emitted updated ${registryRelPath}`);

const ansiRelPath = "lib/tokens_ansi.generated.ts";
const ansiAbsPath = resolve(rootDir, ansiRelPath);
mkdirSync(resolve(ansiAbsPath, ".."), { recursive: true });
emitRepoFile(
  ansiRelPath,
  ansiAbsPath,
  emitGeneratedAnsiTokensModule(
    ssot.cli_ansi_profiles ?? {},
    [...ingestion].sort((a, b) => a.channel_id - b.channel_id),
  ),
);
console.log(`[gen:tokens] Emitted updated ${ansiRelPath}`);

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
