/**
 * @file lib/cli_markdown_token_callbacks.ts
 * @description `Bun.markdown.render()` callbacks that paint ops markdown with the
 * exact `design/tokens.toml` colours as 24-bit SGR, plus a box-drawing table
 * renderer and an ASCII profile.
 *
 * Why callbacks instead of `Bun.markdown.ansi(theme)`:
 *   - the theme API owns wrapping but not per-element colour, and
 *   - the ops runbooks need `[!WARNING]` callouts promoted to an SLA pill and
 *     tables that stay aligned around OSC-8 links and inline code.
 *
 * Two measured facts shape the implementation (Bun 1.4.4, 2026-11-18):
 *
 * 1. Callbacks fire bottom-up and `tr` receives its cells concatenated, so cell
 *    boundaries are gone by the time a row is rendered. `th`/`td` therefore push
 *    into a per-call accumulator and `table` draws the grid.
 * 2. Every reset is scoped (`\x1b[39m` / `\x1b[49m` / `\x1b[39;49m` / OSC-8
 *    terminator). `\x1b[0m` is never emitted, so these fragments can be embedded
 *    inside an already-styled line without clearing the caller's attributes.
 *
 * The context is module-level so the callback object is allocated once. That
 * makes `renderTrueColorOpsMarkdown` non-reentrant: concurrent or nested calls
 * would interleave table state. It is a CLI renderer, invoked one document at a
 * time; the second-call test pins that state does not leak between calls.
 */

import {
  ROUTE_CIRCUITS,
  SLA_STATES,
  UI_TOKENS,
} from "../design/domain-branded-types.ts";
import {
  SD_ANSI_THEMES,
  type AnsiProfileKey,
} from "./tokens_ansi.generated.ts";
import { displayWidth, padDisplay } from "./terminal_format.ts";

const FG_RESET = "\x1b[39m";
const FG_BG_RESET = "\x1b[39;49m";
const OSC_CLOSE = "\x1b]8;;\x07";

/** Resolves a token hex from the generated SSOT, failing closed on a typo. */
function tokenHex(tokenName: string): string {
  for (const token of UI_TOKENS) {
    if (token.tokenName === tokenName) return token.hex;
  }
  for (const route of ROUTE_CIRCUITS) {
    if (route.tokenName === tokenName) return route.hex;
  }
  for (const state of SLA_STATES) {
    if (state.tokenName === tokenName) return state.fgHex;
  }
  throw new Error(
    `ERR_ANSI_TOKEN_UNKNOWN: ${tokenName} is not a token in design/tokens.toml`,
  );
}

function rgb(hex: string): [number, number, number] {
  const packed = Bun.color(hex, "number");
  if (typeof packed !== "number") {
    throw new Error(`ERR_ANSI_HEX_UNPARSABLE: ${hex}`);
  }
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

function fg(hex: string): string {
  const [r, g, b] = rgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg(hex: string): string {
  const [r, g, b] = rgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

const SGR = Object.freeze({
  heading1: fg(tokenHex("--sd-focus-ring")),
  heading2: fg(tokenHex("--sd-text-primary")),
  textPrimary: fg(tokenHex("--sd-text-primary")),
  codeBg: bg(tokenHex("--sd-surface-elevated")),
  codeFg: fg(tokenHex("--sd-route-devig")),
  calloutBar: fg(tokenHex("--sd-sla-stale")),
  link: fg(tokenHex("--sd-route-devig")),
});

type TableState = {
  readonly rows: string[][];
  readonly aligns: string[][];
  current: string[];
  currentAligns: string[];
};

type RenderContext = {
  ascii: boolean;
  hyperlinks: boolean;
  /** ANSI escape sequences are emitted for the active colour profile. */
  colours: boolean;
  table: TableState | null;
};

let ctx: RenderContext = {
  ascii: false,
  hyperlinks: true,
  colours: true,
  table: null,
};

/**
 * Markdown tables accept an alignment string from the source table; anything that is not a known
 * alignment falls back to left. The measure and the pad are the shared ones, so a cell cannot be
 * measured by one rule and padded by another.
 */
function pad(value: string, width: number, align: string): string {
  return padDisplay(
    value,
    width,
    align === "right" || align === "center" ? align : "left",
  );
}

/** Renders the accumulated grid. Called once per table, after every `tr`. */
function renderTable(table: TableState): string {
  const columns = table.rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) return "";

  const widths: number[] = [];
  for (let column = 0; column < columns; column++) {
    widths.push(
      table.rows.reduce(
        (max, row) => Math.max(max, displayWidth(row[column] ?? "")),
        0,
      ),
    );
  }

  const horizontal = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`;
  const bodyRow = (row: string[], index: number): string => {
    const aligns = table.aligns[index] ?? [];
    const cells = widths.map((w, column) =>
      pad(row[column] ?? "", w, aligns[column] ?? "left"),
    );
    return `│ ${cells.join(" │ ")} │`;
  };

  if (ctx.ascii) {
    const asciiLine = (left: string, mid: string, right: string): string =>
      `${left}${widths.map((w) => "-".repeat(w + 2)).join(mid)}${right}`;
    const asciiRow = (row: string[], index: number): string => {
      const aligns = table.aligns[index] ?? [];
      const cells = widths.map((w, column) =>
        pad(row[column] ?? "", w, aligns[column] ?? "left"),
      );
      return `| ${cells.join(" | ")} |`;
    };
    const lines = [asciiLine("+", "+", "+")];
    lines.push(asciiRow(table.rows[0] ?? [], 0));
    lines.push(asciiLine("+", "+", "+"));
    for (let i = 1; i < table.rows.length; i++) {
      lines.push(asciiRow(table.rows[i] ?? [], i));
    }
    lines.push(asciiLine("+", "+", "+"));
    return `${lines.join("\n")}\n`;
  }

  const lines = [horizontal("┌", "┬", "┐")];
  lines.push(bodyRow(table.rows[0] ?? [], 0));
  lines.push(horizontal("├", "┼", "┤"));
  for (let i = 1; i < table.rows.length; i++) {
    lines.push(bodyRow(table.rows[i] ?? [], i));
  }
  lines.push(horizontal("└", "┴", "┘"));
  return `${lines.join("\n")}\n`;
}

const ALERT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "[!WARNING]": "SLA_STALE",
  "[!CAUTION]": "SLA_STALE",
  "[!IMPORTANT]": "SLA_WARN",
  "[!NOTE]": "SLA_FRESH",
  "[!TIP]": "SLA_FRESH",
});

function renderCallout(children: string): string {
  const firstBreak = children.indexOf("\n");
  const marker = (
    firstBreak < 0 ? children : children.slice(0, firstBreak)
  ).trim();
  const label = ALERT_LABELS[marker];
  if (label === undefined) {
    return ctx.colours
      ? `${SGR.calloutBar}│${FG_RESET} ${children}`
      : `| ${children}`;
  }
  const body = firstBreak < 0 ? "" : children.slice(firstBreak + 1).trim();
  if (ctx.ascii) return `| [${label}] ${body}`;
  return `${SGR.calloutBar}▎${FG_RESET} ${SGR.calloutBar}[${label}]${FG_RESET} ${body}`;
}

/**
 * Frozen callback set for `Bun.markdown.render()`. The profile is read from the
 * module context, so one object serves both colour and ASCII output.
 */
export const SD_MARKDOWN_TOKEN_CALLBACKS = Object.freeze({
  heading(children: string, meta: { level: number }): string {
    if (ctx.ascii) return `${"#".repeat(meta.level)} ${children}\n`;
    const colour = meta.level === 1 ? SGR.heading1 : SGR.heading2;
    return `${colour}${children}${FG_RESET}\n`;
  },

  paragraph(children: string): string {
    return `${children}\n`;
  },

  blockquote(children: string): string {
    return `${renderCallout(children)}\n`;
  },

  codespan(children: string): string {
    if (ctx.ascii) return children;
    return `${SGR.codeBg}${SGR.codeFg} ${children} ${FG_BG_RESET}`;
  },

  /**
   * Fenced / indented blocks. Without this the body renders inline with prose,
   * so a multi-line command block is indistinguishable from a paragraph — the
   * reason this callback exists rather than letting children pass through.
   */
  code(children: string, meta: { language?: string }): string {
    const body = children.replace(/\n+$/, "");
    if (body.length === 0) return "";
    const lines = body.split("\n");
    const label =
      typeof meta.language === "string" && meta.language.length > 0
        ? meta.language
        : "";

    if (ctx.ascii) {
      const out = label.length > 0 ? [`# ${label}`] : [];
      for (const line of lines) out.push(`  ${line}`);
      return `${out.join("\n")}\n`;
    }

    const width = lines.reduce(
      (max, line) => Math.max(max, displayWidth(line)),
      0,
    );
    const out: string[] = [];
    if (label.length > 0) {
      out.push(
        `${SGR.codeBg}${SGR.codeFg} ${label.padEnd(width + 1)}${FG_BG_RESET}`,
      );
    }
    for (const line of lines) {
      const padding = " ".repeat(Math.max(0, width - displayWidth(line)));
      out.push(
        `${SGR.codeBg}${SGR.textPrimary} ${line}${padding} ${FG_BG_RESET}`,
      );
    }
    return `${out.join("\n")}\n`;
  },

  link(children: string, meta: { href: string }): string {
    if (ctx.ascii) return `${children} (${meta.href})`;
    if (!ctx.hyperlinks) return `${SGR.link}${children}${FG_RESET}`;
    return `\x1b]8;;${meta.href}\x07${SGR.link}${children}${FG_RESET}${OSC_CLOSE}`;
  },

  strong(children: string): string {
    return ctx.ascii ? children : `\x1b[1m${children}\x1b[22m`;
  },

  emphasis(children: string): string {
    return ctx.ascii ? children : `\x1b[3m${children}\x1b[23m`;
  },

  th(children: string, meta: { align?: string }): string {
    ctx.table?.current.push(children);
    ctx.table?.currentAligns.push(meta.align ?? "left");
    return "";
  },

  td(children: string, meta: { align?: string }): string {
    ctx.table?.current.push(children);
    ctx.table?.currentAligns.push(meta.align ?? "left");
    return "";
  },

  tr(): string {
    if (ctx.table !== null) {
      ctx.table.rows.push(ctx.table.current);
      ctx.table.aligns.push(ctx.table.currentAligns);
      ctx.table.current = [];
      ctx.table.currentAligns = [];
    }
    return "";
  },

  thead(): string {
    return "";
  },

  tbody(): string {
    return "";
  },

  table(): string {
    if (ctx.table === null) return "";
    const rendered = renderTable(ctx.table);
    // Reset so the next table cannot inherit these rows.
    ctx.table = { rows: [], aligns: [], current: [], currentAligns: [] };
    return rendered;
  },
});

/**
 * Renders ops markdown with token-accurate SGR. Accepts the same string /
 * `Uint8Array` / `ArrayBuffer` inputs as the rest of the CLI renderer surface.
 */
export function renderTrueColorOpsMarkdown(
  input: string | Uint8Array | ArrayBuffer,
  theme: Readonly<Bun.markdown.AnsiTheme> = SD_ANSI_THEMES.ghostty_interactive,
): string {
  const ascii = theme.colors === false;
  ctx = {
    ascii,
    hyperlinks: !ascii && theme.hyperlinks !== false,
    colours: !ascii,
    table: { rows: [], aligns: [], current: [], currentAligns: [] },
  };

  try {
    const markdown =
      typeof input === "string" ? input : new TextDecoder().decode(input);
    // Callbacks own every element and emit only ANSI, so no source HTML reaches
    // the output: // trusted-markdown: callbacks replace every block and inline.
    const rendered = Bun.markdown.render(
      markdown,
      SD_MARKDOWN_TOKEN_CALLBACKS as never,
    );
    // The renderer emits block separators as bare newlines; collapse the runs
    // so a table followed by a paragraph keeps one blank line.
    return rendered.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  } finally {
    ctx = {
      ascii: false,
      hyperlinks: true,
      colours: true,
      table: null,
    };
  }
}

export type { AnsiProfileKey };
