/**
 * @file tests/cli_markdown_token_callbacks.test.ts
 * @description Pins `Bun.markdown.render()` output for the ops runbook renderer:
 * token-accurate 24-bit SGR, box tables that stay aligned around OSC-8 links and
 * inline code, an ASCII profile with zero escape bytes, and no state bleed
 * between calls.
 *
 * Callback mechanics that shape these assertions (measured on Bun 1.4.4):
 *   - callbacks fire bottom-up, and `tr` receives its cells already concatenated,
 *     so the renderer accumulates cells in `th`/`td` and draws the grid in `table`
 *   - `codespan` is the inline-code callback; fenced blocks use `code`
 *   - only scoped resets are emitted (`\x1b[39m`, `\x1b[49m`, `\x1b[39;49m`,
 *     OSC-8 terminator), never `\x1b[0m`
 */

import { describe, expect, test } from "bun:test";
import {
  SD_MARKDOWN_TOKEN_CALLBACKS,
  renderTrueColorOpsMarkdown,
} from "../lib/cli_markdown_token_callbacks.ts";
import { SD_ANSI_THEMES } from "../lib/tokens_ansi.generated.ts";

const SAMPLE_RUNBOOK_MD = [
  "# Stage 4 R2 Manifest Triage",
  "",
  "> [!WARNING]",
  "> Manifest `manifests/channel-router/latest` hit HTTP 412 contention.",
  "",
  "| Channel | Latency | Runbook |",
  "| :--- | ---: | :---: |",
  "| `GSLIVE` | 42ms | [Inspect](https://desk.bookdeskops.com/modes/5) |",
  "| `INTERNET` | 1280ms | [Trace](https://desk.bookdeskops.com/modes/1) |",
  "",
].join("\n");

describe("Bun.markdown.render() token callbacks", () => {
  test("ghostty_interactive emits exact tokens.toml 24-bit RGB and zero resets", () => {
    expect(Object.isFrozen(SD_MARKDOWN_TOKEN_CALLBACKS)).toBe(true);

    const out = renderTrueColorOpsMarkdown(
      SAMPLE_RUNBOOK_MD,
      SD_ANSI_THEMES.ghostty_interactive,
    );

    // h1 uses --sd-focus-ring (#38bdf8)
    expect(out).toContain("\x1b[38;2;56;189;248m");
    // inline `GSLIVE` uses --sd-surface-elevated bg (#121c31) + --sd-route-devig fg (#22d3ee)
    expect(out).toContain(
      "\x1b[48;2;18;28;49m\x1b[38;2;34;211;238m GSLIVE \x1b[39;49m",
    );
    // [!WARNING] promotes to an SLA_STALE pill with a left bar
    expect(out).toContain("SLA_STALE");
    expect(out).toContain("▎");
    // OSC-8 hyperlink on the interactive profile
    expect(out).toContain("\x1b]8;;https://desk.bookdeskops.com/modes/5\x07");
    // Scoped resets only — never clobbers outer attributes with \x1b[0m
    expect(out.includes("\x1b[0m")).toBe(false);
  });

  test("GFM table columns keep identical visual width across OSC-8 and codespans", () => {
    const out = renderTrueColorOpsMarkdown(
      SAMPLE_RUNBOOK_MD,
      SD_ANSI_THEMES.ghostty_interactive,
    );
    const boxLines = out.split("\n").filter((line) => {
      const visible = Bun.stripANSI(line);
      return /^[┌│├└]/.test(visible);
    });

    expect(boxLines).toHaveLength(6); // top + header + mid + 2 rows + bottom
    const width = Bun.stringWidth(boxLines[0]!, {
      ambiguousIsNarrow: true,
      countAnsiEscapeCodes: false,
    });
    for (const line of boxLines) {
      expect(
        Bun.stringWidth(line, {
          ambiguousIsNarrow: true,
          countAnsiEscapeCodes: false,
        }),
      ).toBe(width);
    }
  });

  test("pipe_ascii emits 7-bit tables and callouts with zero escape bytes", () => {
    const ascii = renderTrueColorOpsMarkdown(
      new TextEncoder().encode(SAMPLE_RUNBOOK_MD),
      SD_ANSI_THEMES.pipe_ascii,
    );

    expect(ascii.includes("\x1b")).toBe(false);
    expect(ascii).toContain("| [SLA_STALE]");
    expect(ascii).toContain("+---");
    expect(ascii).toContain("Inspect (https://desk.bookdeskops.com/modes/5)");
  });

  test("a fenced command block stays a block, not inline prose", () => {
    const md =
      "Run:\n\n```bash\nbun test --changed\nbun run verify:fast\n```\n";
    const ansi = renderTrueColorOpsMarkdown(
      md,
      SD_ANSI_THEMES.ghostty_interactive,
    );
    // Language label plus one painted panel line per command.
    expect(ansi).toContain("bash");
    expect(
      ansi.split("\n").filter((l) => l.includes("\x1b[48;2;18;28;49m")),
    ).toHaveLength(3);
    expect(ansi.includes("\x1b[0m")).toBe(false);

    const ascii = renderTrueColorOpsMarkdown(md, SD_ANSI_THEMES.pipe_ascii);
    expect(ascii.includes("\x1b")).toBe(false);
    expect(ascii).toContain("# bash");
    expect(ascii).toContain("  bun test --changed");
  });

  test("consecutive calls reset the table accumulator with zero bleed", () => {
    const first = renderTrueColorOpsMarkdown(
      SAMPLE_RUNBOOK_MD,
      SD_ANSI_THEMES.ghostty_interactive,
    );
    expect(first).toContain("GSLIVE");

    const second = renderTrueColorOpsMarkdown(
      "| A |\n|---|\n| 1 |\n",
      SD_ANSI_THEMES.pipe_ascii,
    );
    expect(second).not.toContain("GSLIVE");
    expect(second).toContain("| A |");
    // The second table has exactly one data row: top + header + mid + row + bottom.
    expect(second.split("\n").filter((l) => l.startsWith("+"))).toHaveLength(3);
  });
});
