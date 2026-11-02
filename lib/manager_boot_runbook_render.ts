/**
 * Manager-boot evidence docs → terminal.
 *
 * Bun.markdown surfaces (trusted repo markdown only):
 * - `html()` — HTML string; **not sanitized** (raw HTML, event handlers, `javascript:` hrefs pass through).
 * - `react()` — JSX with per-tag overrides (Plane 3 SSR elsewhere in the fleet).
 * - `render()` — callback per element; used here for gate-table ANSI + OSC 8 file links.
 *
 * GFM tables / strikethrough / task lists / autolinks: {@link DOCS_RENDER_OPTIONS} as parser third arg.
 * `.md` bundler loader + linear-time parser apply at the Bun runtime; see bun.com/docs/runtime/markdown.
 */

import { join } from "node:path";

import { DOCS_RENDER_OPTIONS } from "./docs_render_cache.ts";

const REPO_ROOT = join(import.meta.dir, "..");

export const MANAGER_BOOT_RUNBOOK_DOC = join(
  REPO_ROOT,
  "docs/evidence/manager-boot-hierarchy.md",
);

/** Appended operator loop (live path after oracle/gates are green). */
export const MANAGER_BOOT_OPERATOR_APPENDIX = `
## Operator loop (live)

1. **Seed session (human, once)** — WebView profile + MFA:

\`\`\`bash
bun run capture:f402-har -- --login --profile scratch/f402-manager-webview-profile
\`\`\`

2. **Replay probe** — GENERAL-only boundary, no PLAYERS retention:

\`\`\`bash
F402_WEBVIEW_PROFILE=scratch/f402-manager-webview-profile \\
  MODE=replay bun run probe:parse-tree -- \\
  --account tests/fixtures/f402-get-account-info-owner-fixture.json
\`\`\`

3. **Ingest** — levels 1–12 in \`agents\`; 13+ in \`skippedOverflow\`:

\`\`\`bash
bun run manager:ingest-hierarchy
\`\`\`

4. **Gate bundle** — fail-closed CI:

\`\`\`bash
bash scripts/ci/run-manager-oracle-gates.sh
\`\`\`
`.trim();

export interface ManagerBootRunbookRenderOptions {
  readonly colors?: boolean;
  readonly includeOperatorAppendix?: boolean;
}

function ansiEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

function osc8Link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** Custom \`Bun.markdown.render\` hooks tuned for evidence runbooks (headings, gates, commands). */
export function renderManagerBootRunbookTerminal(
  markdown: string,
  options: ManagerBootRunbookRenderOptions = {},
): string {
  const colors = ansiEnabled(options.colors);
  const reset = colors ? "\x1b[0m" : "";
  const bold = colors ? "\x1b[1m" : "";
  const dim = colors ? "\x1b[2m" : "";
  const cyan = colors ? "\x1b[36m" : "";
  const yellow = colors ? "\x1b[33m" : "";
  const green = colors ? "\x1b[32m" : "";
  const red = colors ? "\x1b[31m" : "";
  const underline = colors ? "\x1b[4m" : "";

  const gateStatus = (cell: string): string => {
    const t = cell.trim().toLowerCase();
    if (t.includes("blocked")) return `${yellow}${cell}${reset}`;
    if (t.includes("failed")) return `${red}${cell}${reset}`;
    if (t.includes("wired") || t.includes("ready") || t.includes("pass"))
      return `${green}${cell}${reset}`;
    return cell;
  };

  return Bun.markdown.render(
    markdown,
    {
      heading: (children, meta) => {
        const prefix =
          meta.level === 1
            ? `${bold}${cyan}`
            : meta.level === 2
              ? `${bold}${underline}`
              : bold;
        return `${prefix}${children}${reset}\n\n`;
      },
      paragraph: (children) => `${children}\n\n`,
      strong: (children) => `${bold}${children}${reset}`,
      emphasis: (children) => `${underline}${children}${reset}`,
      codespan: (children) => `${yellow}${children}${reset}`,
      code: (children) => `${dim}${children}${reset}\n`,
      blockquote: (children) => `${dim}│ ${children}${reset}\n`,
      link: (children, meta) => {
        const { href } = meta;
        if (href.startsWith("http://") || href.startsWith("https://")) {
          return colors ? osc8Link(String(children), href) : String(children);
        }
        if (href.endsWith(".md")) {
          const abs = href.startsWith("/")
            ? href
            : join(REPO_ROOT, "docs/evidence", href.replace(/^\.\//, ""));
          return colors
            ? osc8Link(String(children), `file://${abs}`)
            : String(children);
        }
        return String(children);
      },
      tr: (children) => `${children}\n`,
      th: (children) => `${bold}${cyan}${children}${reset} | `,
      td: (children) => `${gateStatus(String(children))} | `,
      hr: () => `${dim}${"─".repeat(48)}${reset}\n\n`,
      listItem: (children) => `  • ${children}\n`,
    },
    DOCS_RENDER_OPTIONS,
  );
}

/** Trusted internal markdown → HTML (`--html`); output is not sanitized. */
export function renderManagerBootRunbookHtml(markdown: string): string {
  return Bun.markdown.html(markdown, DOCS_RENDER_OPTIONS);
}

export async function loadManagerBootRunbookMarkdown(options?: {
  readonly includeOperatorAppendix?: boolean;
  readonly docPath?: string | undefined;
}): Promise<string> {
  const path = options?.docPath ?? MANAGER_BOOT_RUNBOOK_DOC;
  const body = await Bun.file(path).text();
  if (options?.includeOperatorAppendix === false) return body;
  return `${body.trim()}\n\n${MANAGER_BOOT_OPERATOR_APPENDIX}\n`;
}

export function printManagerBootRunbook(
  markdown: string,
  options?: ManagerBootRunbookRenderOptions,
): void {
  process.stdout.write(renderManagerBootRunbookTerminal(markdown, options));
}
