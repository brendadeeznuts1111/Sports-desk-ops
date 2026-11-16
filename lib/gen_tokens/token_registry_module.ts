/**
 * @file lib/gen_tokens/token_registry_module.ts
 * @description Renders the UI-facing token registry module from the parsed
 * `design/tokens.toml` SSOT, so the Build-Matrix palette and the dashboard footer
 * read the same data the generated CSS is built from.
 */

export type RegistryModuleGroup =
  "surfaces" | "ui" | "sla" | "ingestion" | "routes";

export type RegistryModuleToken = {
  readonly token_name: string;
  readonly hex: string;
  readonly group: RegistryModuleGroup;
};

export type RegistryModuleAlias = {
  readonly alias: string;
  readonly target: string;
  readonly scope: "legacy" | "dashboard";
};

export type RegistryModuleInput = {
  readonly version: string;
  readonly tokens: readonly RegistryModuleToken[];
  readonly aliases: readonly RegistryModuleAlias[];
};

/**
 * Emits a deterministic TS module: canonical tokens in CSS emission order, then the
 * `:root` aliases (legacy first, dashboard second). The UI composes its palette and
 * the Copy-registry block from these arrays, so neither can drift from tokens.toml.
 */
export function renderTokenRegistryModule(input: RegistryModuleInput): string {
  const tokenLines = input.tokens
    .map(
      (token) =>
        `  { token: ${JSON.stringify(token.token_name)}, hex: ${JSON.stringify(token.hex)}, group: ${JSON.stringify(token.group)} },`,
    )
    .join("\n");
  const aliasLines = input.aliases
    .map(
      (alias) =>
        `  { alias: ${JSON.stringify(alias.alias)}, target: ${JSON.stringify(alias.target)}, scope: ${JSON.stringify(alias.scope)} },`,
    )
    .join("\n");

  return `/**
 * @file packages/ui/src/tokens.registry.generated.ts
 * @description Generated from design/tokens.toml (v${input.version}) via \`bun run gen:tokens\`.
 * DO NOT EDIT BY HAND — enforced by \`bun run gen:tokens:gate\`.
 */

/** tokens.toml SSOT version this module was generated from. */
export const TOKENS_TOML_VERSION = ${JSON.stringify(input.version)} as const;

export type GeneratedTokenGroup =
  | "surfaces"
  | "ui"
  | "sla"
  | "ingestion"
  | "routes";

export interface GeneratedToken {
  /** \`--sd-*\` custom property name. */
  readonly token: string;
  /** Canonical value emitted into both \`@property\` and \`:root\`. */
  readonly hex: string;
  /** Emitting section; the palette groups by this. */
  readonly group: GeneratedTokenGroup;
}

export interface GeneratedAlias {
  /** Alias emitted into \`:root\` as \`<alias>: var(<target>)\`. */
  readonly alias: string;
  /** Canonical token the alias resolves to. */
  readonly target: string;
  /** \`legacy\` ships in every stylesheet; \`dashboard\` only in the dashboard CSS. */
  readonly scope: "legacy" | "dashboard";
}

/** Canonical tokens in \`:root\` emission order. */
export const CANONICAL_TOKENS: readonly GeneratedToken[] = [
${tokenLines}
];

/** \`:root\` aliases in emission order (legacy first, then dashboard). */
export const TOKEN_ALIASES: readonly GeneratedAlias[] = [
${aliasLines}
];
`;
}
