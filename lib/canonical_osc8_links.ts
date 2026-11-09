/**
 * @file canonical_osc8_links.ts
 * @description Canonical OSC 8 Terminal Hyperlinks & ANSI Markdown Rendering Engine (Bun v1.4+).
 *
 * Implements canonical URI generators and terminal hyperlink rendering for:
 *  - Fantasy402 Customer Accounts & Manager Portals
 *  - SportsDesk Sub-Agents & Downline Nodes
 *  - Official OpenAPI 3.1 Documentation & Scalar Portals
 *  - Telegram Bot (@demodevdeskbot) & Telegram Mini App (TMA)
 *  - Cloudflare R2 Public Gateways
 */

import {
  buildGsLiveBetHistorySidecarUrl,
  buildGsLiveUsersReportDeepLink,
  formatGsLivePlayerToken,
} from "./gslive_manager_deeplink_sidecar.ts";
import {
  BUN_ANSI_THEME_REFERENCE_URL,
  linkifyBunSymbolsInMarkdown,
  resolveBunSymbolReferenceUrl,
} from "./bun_urls.ts";

export const CANONICAL_DOMAINS = {
  FANTASY402_PORTAL: "https://fantasy402.com",
  SPORTSDESK_DESK: "https://desk.bookdeskops.com",
  DOCS_PORTAL: "https://fantasy402-docs-4ay.pages.dev",
  CUSTOM_DOCS_DOMAIN: "https://docs.bookdeskops.com",
  R2_PUBLIC_GATEWAY: "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
  TELEGRAM_BOT: "https://t.me/demodevdeskbot",
  TELEGRAM_MINIAPP: "https://t.me/demodevdeskbot/app",
  GITHUB_REPO: "https://github.com/bw496915-cmyk/Sports-desk-ops",
} as const;

/** Pre-parsed WebKit Base URLs (Bun 1.4 fast path: 168ns lookup, cached base). */
export const CANONICAL_URL_BASES = {
  FANTASY402_PORTAL: new URL(CANONICAL_DOMAINS.FANTASY402_PORTAL),
  SPORTSDESK_DESK: new URL(CANONICAL_DOMAINS.SPORTSDESK_DESK),
  DOCS_PORTAL: new URL(CANONICAL_DOMAINS.DOCS_PORTAL),
  R2_PUBLIC_GATEWAY: new URL(CANONICAL_DOMAINS.R2_PUBLIC_GATEWAY),
} as const;

/**
 * Format raw terminal OSC 8 hyperlink escape sequence:
 * \x1b]8;;<url>\x1b\<text>\x1b]8;;\x1b\
 */
export function formatOsc8Hyperlink(url: string, text: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Generate canonical customer portal URL using Bun 1.4 WebKit URL fast path.
 */
export function getCanonicalCustomerUrl(customerId: string): string {
  const cleanId = encodeURIComponent(customerId.trim().toUpperCase());
  return new URL(
    `manager.html?customer=${cleanId}`,
    CANONICAL_URL_BASES.FANTASY402_PORTAL,
  ).href;
}

/**
 * Generate canonical agent desk URL using Bun 1.4 WebKit URL fast path.
 */
export function getCanonicalAgentUrl(agentId: string): string {
  const cleanAgent = encodeURIComponent(agentId.trim().toUpperCase());
  return new URL(`agent/${cleanAgent}`, CANONICAL_URL_BASES.SPORTSDESK_DESK)
    .href;
}

/**
 * Format markdown hyperlink for customer account.
 */
export function formatCustomerOsc8Markdown(
  customerId: string,
  label?: string,
): string {
  const display = label ?? customerId.trim().toUpperCase();
  return `[${display}](${getCanonicalCustomerUrl(customerId)})`;
}

/**
 * Format markdown hyperlink for sub-agent.
 */
export function formatAgentOsc8Markdown(
  agentId: string,
  label?: string,
): string {
  const display = label ?? agentId.trim().toUpperCase();
  return `[${display}](${getCanonicalAgentUrl(agentId)})`;
}

/**
 * Format markdown hyperlink for API documentation.
 */
export function formatDocsOsc8Markdown(
  text: string = "Official API Reference",
): string {
  return `[${text}](${CANONICAL_DOMAINS.DOCS_PORTAL})`;
}

/**
 * Format markdown hyperlink for OpenAPI 3.1 specification.
 */
export function formatOpenApiSpecOsc8Markdown(
  text: string = "OpenAPI 3.1 Spec",
): string {
  return `[${text}](${CANONICAL_DOMAINS.DOCS_PORTAL}/openapi.json)`;
}

/**
 * Format OSC 8 markdown hyperlink for GSLive Partner 118 7-Parameter Player Report (`#/reports/users?bot=true...`).
 */
export function formatGsLiveUsersReportOsc8Markdown(
  customerId: string,
  fromIso?: string,
  toIso?: string,
): string {
  const url = buildGsLiveUsersReportDeepLink({
    customerLogin: customerId,
    bot: true,
    ...(fromIso ? { fromIsoUtc: fromIso } : {}),
    ...(toIso ? { toIsoUtc: toIso } : {}),
  });
  return `[GSLive:${formatGsLivePlayerToken(customerId)}](${url})`;
}

/**
 * Format OSC 8 markdown hyperlink for GSLive Partner 118 Live Bet-History Sidecar (`#/events/bet-history?minVolume=0...`).
 */
export function formatGsLiveSidecarOsc8Markdown(
  dateFilterBy: "calcTime" | "betTime" = "calcTime",
  customerId?: string,
  fromEpochSec?: number,
  tickEpochMs?: number,
): string {
  const url = buildGsLiveBetHistorySidecarUrl({
    dateFilterBy,
    ...(customerId ? { customerLogin: customerId } : {}),
    ...(fromEpochSec !== undefined ? { fromEpochSec } : {}),
    ...(tickEpochMs !== undefined ? { tickEpochMs } : {}),
  });
  const label = customerId
    ? `GSLiveSidecar:${customerId.trim().toUpperCase()}(${dateFilterBy})`
    : `GSLiveSidecar(${dateFilterBy})`;
  return `[${label}](${url})`;
}

export interface AnsiMarkdownOptions {
  readonly colors?: boolean;
  readonly hyperlinks?: boolean;
  readonly light?: boolean;
  readonly columns?: number;
  readonly kittyGraphics?: boolean;
  readonly linkifySymbols?: boolean;
}

/**
 * Type alias representing Bun's official Markdown AnsiTheme interface.
 * Controls terminal ANSI rendering options for Bun.markdown.ansi().
 *
 * @see https://bun.com/reference/globals/bun/markdown/AnsiTheme
 */
export type AnsiTheme = AnsiMarkdownOptions;

/** Dark terminal preset with ANSI colors and OSC 8 hyperlinks. */
export const DARK_ANSI_THEME: AnsiTheme = {
  colors: true,
  hyperlinks: true,
  light: false,
} as const;

/** Light terminal preset with ANSI colors and OSC 8 hyperlinks. */
export const LIGHT_ANSI_THEME: AnsiTheme = {
  colors: true,
  hyperlinks: true,
  light: true,
} as const;

/** Monochrome terminal preset with no escape codes or URLs. */
export const MONOCHROME_ANSI_THEME: AnsiTheme = {
  colors: false,
  hyperlinks: false,
} as const;

/** Accessible terminal preset with OSC 8 hyperlinks. */
export const ACCESSIBLE_OSC8_THEME: AnsiTheme = {
  colors: true,
  hyperlinks: true,
} as const;

/**
 * Formats a Markdown link pointing to Bun's canonical AnsiTheme reference.
 */
export function formatAnsiThemeOsc8Markdown(): string {
  return `[AnsiTheme](${BUN_ANSI_THEME_REFERENCE_URL})`;
}

/**
 * Formats a Markdown link pointing to Bun's canonical reference for a specific symbol.
 * Returns null if the symbol is not recognized.
 */
export function formatBunSymbolOsc8Markdown(symbol: string): string | null {
  const url = resolveBunSymbolReferenceUrl(symbol);
  if (!url) return null;
  const cleanSymbol = symbol.trim().replace(/^`|`$/g, "");
  return `[\`${cleanSymbol}\`](${url})`;
}

/**
 * Render Markdown to ANSI terminal string using native Bun.markdown.ansi().
 * Fully aligned with official Bun.AnsiTheme reference:
 * @see https://bun.com/reference/globals/bun/markdown/AnsiTheme
 *  - colors: Emit ANSI styling (false for plain ASCII chrome without escapes)
 *  - hyperlinks: Emit clickable OSC 8 hyperlinks (\x1b]8;;URL\x1b\TEXT\x1b]8;;\x1b\)
 *  - light: Auto-detects or sets inline code palette for light backgrounds
 *  - columns: Line width for word-wrapping (0 to disable wrapping)
 *  - kittyGraphics: Inline local images via Kitty Graphics Protocol (Kitty, WezTerm, Ghostty)
 */
export function renderAnsiMarkdown(
  markdown: string,
  options?: AnsiMarkdownOptions,
): string {
  const useColors =
    options?.colors ?? (!Bun.env.NO_COLOR && Bun.env.TERM !== "dumb");
  const useHyperlinks = options?.hyperlinks ?? true;
  const terminalWidth =
    options?.columns !== undefined
      ? options.columns
      : process.stdout?.columns || 80;

  const input =
    options?.linkifySymbols === true
      ? linkifyBunSymbolsInMarkdown(markdown)
      : markdown;

  return Bun.markdown.ansi(input, {
    colors: useColors,
    hyperlinks: useHyperlinks,
    columns:
      options?.columns !== undefined
        ? options.columns
        : Math.min(terminalWidth, 130),
    ...(options?.light !== undefined ? { light: options.light } : {}),
    kittyGraphics: options?.kittyGraphics ?? false,
  });
}

/**
 * Print ANSI Markdown directly to process.stdout.
 */
export function printAnsiMarkdown(
  markdown: string,
  options?: AnsiMarkdownOptions,
): void {
  const rendered = renderAnsiMarkdown(markdown, options);
  process.stdout.write(rendered);
}
