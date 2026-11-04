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

/**
 * Generate canonical customer portal URL.
 */
export function getCanonicalCustomerUrl(customerId: string): string {
  const cleanId = encodeURIComponent(customerId.trim().toUpperCase());
  return `${CANONICAL_DOMAINS.FANTASY402_PORTAL}/manager.html?customer=${cleanId}`;
}

/**
 * Generate canonical agent desk URL.
 */
export function getCanonicalAgentUrl(agentId: string): string {
  const cleanAgent = encodeURIComponent(agentId.trim().toUpperCase());
  return `${CANONICAL_DOMAINS.SPORTSDESK_DESK}/agent/${cleanAgent}`;
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
}

/**
 * Render Markdown to ANSI terminal string using native Bun.markdown.ansi().
 * Fully aligned with official https://bun.com/docs/runtime/markdown and Bun.AnsiTheme:
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
    options?.colors ?? (!process.env.NO_COLOR && process.env.TERM !== "dumb");
  const useHyperlinks = options?.hyperlinks ?? true;
  const terminalWidth =
    options?.columns !== undefined
      ? options.columns
      : process.stdout?.columns || 80;

  return Bun.markdown.ansi(markdown, {
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
