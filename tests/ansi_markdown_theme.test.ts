import { describe, expect, test } from "bun:test";
import {
  SD_ANSI_THEMES,
  formatChannelBadge,
  renderOpsMarkdownAnsi,
  resolveCliAnsiTheme,
} from "../lib/cli_markdown_renderer.ts";
import { emitGeneratedAnsiTokensModule } from "../lib/gen_tokens/ansi_tokens_module.ts";
import { validateAnsiThemeProfiles } from "../lib/gen_tokens/tokens_ssot.ts";

describe("Bun.markdown.AnsiTheme <-> design/tokens.toml v1.5.0 gates", () => {
  test("COLORFGBG immunity: light=false stays invariant even when COLORFGBG simulates light terminal", () => {
    const prev = Bun.env.COLORFGBG;
    try {
      Bun.env.COLORFGBG = "0;15";
      const darkOut = renderOpsMarkdownAnsi(
        "Inline `packChannelHandle32` code",
        SD_ANSI_THEMES.ghostty_interactive,
      );
      Bun.env.COLORFGBG = "15;0";
      const baselineOut = renderOpsMarkdownAnsi(
        "Inline `packChannelHandle32` code",
        SD_ANSI_THEMES.ghostty_interactive,
      );
      expect(darkOut).toBe(baselineOut);
    } finally {
      if (prev === undefined) delete Bun.env.COLORFGBG;
      else Bun.env.COLORFGBG = prev;
    }
  });

  test("pipe_ascii emits zero ANSI escape bytes, zero OSC-8 sequences, and ASCII-only chrome", () => {
    const sample =
      "# SLA Breach\n\n| Channel | State |\n|---|---|\n| GSLIVE | [Runbook](https://desk.bookdeskops.com) |\n";
    const out = renderOpsMarkdownAnsi(
      new TextEncoder().encode(sample),
      SD_ANSI_THEMES.pipe_ascii,
    );
    expect(out.includes("\x1b")).toBe(false);
    expect(formatChannelBadge(6, SD_ANSI_THEMES.pipe_ascii)).toBe("[GSLIVE]");
    expect(formatChannelBadge(-1, SD_ANSI_THEMES.pipe_ascii)).toBe("[UNKNOWN]");
    expect(formatChannelBadge(16, SD_ANSI_THEMES.pipe_ascii)).toBe("[UNKNOWN]");
  });

  test("formatChannelBadge never aliases a non-integer id onto a channel", () => {
    // `>>> 0` used to coerce all of these onto channel 0, and truncate the float
    // to channel 1 — silent aliases onto real channels (measured on 1.4.4).
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 32,
      1.9,
      -0.5,
    ]) {
      expect(formatChannelBadge(value, SD_ANSI_THEMES.pipe_ascii)).toBe(
        "[UNKNOWN]",
      );
      expect(
        formatChannelBadge(value, SD_ANSI_THEMES.ghostty_interactive),
      ).toBe("[UNKNOWN]");
    }
    // The real ids still resolve, including the last one.
    expect(formatChannelBadge(0, SD_ANSI_THEMES.pipe_ascii)).toBe(
      "[NON_SPORTS]",
    );
    expect(formatChannelBadge(10, SD_ANSI_THEMES.pipe_ascii)).toBe("[HOUSE]");
  });

  test("emitGeneratedAnsiTokensModule rejects an empty profile set instead of emitting invalid TS", () => {
    // generate_tokens.ts passes `ssot.cli_ansi_profiles ?? {}`; without this
    // guard the union joins nothing and the generated file reads
    // `export type AnsiProfileKey = ;`, which fails at parse time.
    expect(() =>
      emitGeneratedAnsiTokensModule({}, [
        { channel_id: 0, channel_code: "NON_SPORTS", hex: "#94a3b8" },
      ]),
    ).toThrow("ERR_SPEC_ANSI_PROFILES_MISSING");
  });

  test("emitGeneratedAnsiTokensModule rejects sparse or non-contiguous channel_id", () => {
    expect(() =>
      emitGeneratedAnsiTokensModule({}, [
        { channel_id: 0, channel_code: "NON_SPORTS", hex: "#94a3b8" },
        { channel_id: 2, channel_code: "BLOCKED", hex: "#8fa3bf" },
      ]),
    ).toThrow("ERR_SPEC_CHANNEL_LUT_NON_CONTIGUOUS");
  });

  test("ghostty_interactive emits OSC-8 hyperlinks and wraps cleanly within columns=120", () => {
    const md =
      "Inspect [Desk](https://desk.bookdeskops.com) " + "word ".repeat(40);
    const out = renderOpsMarkdownAnsi(md, SD_ANSI_THEMES.ghostty_interactive);
    expect(out.includes("\x1b]8;;https://desk.bookdeskops.com")).toBe(true);
    for (const line of out.split("\n")) {
      expect(
        Bun.stringWidth(line, {
          ambiguousIsNarrow: true,
          countAnsiEscapeCodes: false,
        }),
      ).toBeLessThanOrEqual(120);
    }
  });

  test("tty_narrow emits OSC-8 and wraps within columns=88", () => {
    const md =
      "Inspect [Desk](https://desk.bookdeskops.com) " + "word ".repeat(40);
    const out = renderOpsMarkdownAnsi(md, SD_ANSI_THEMES.tty_narrow);
    expect(out.includes("\x1b]8;;https://desk.bookdeskops.com")).toBe(true);
    for (const line of out.split("\n")) {
      expect(
        Bun.stringWidth(line, {
          ambiguousIsNarrow: true,
          countAnsiEscapeCodes: false,
        }),
      ).toBeLessThanOrEqual(88);
    }
  });

  test("r2_telemetry_stream keeps color, drops OSC-8 (link renders as text (url)), and never wraps at columns=0", () => {
    const md =
      "Inspect [Desk](https://desk.bookdeskops.com) " + "word ".repeat(40);
    const out = renderOpsMarkdownAnsi(md, SD_ANSI_THEMES.r2_telemetry_stream);
    expect(out.includes("\x1b]8;;")).toBe(false);
    // SGR styling wraps the closing paren, so compare the stripped text.
    const plain = Bun.stripANSI(out);
    expect(plain.includes("(https://desk.bookdeskops.com)")).toBe(true);
    expect(out.includes("\x1b[")).toBe(true);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  test("resolveCliAnsiTheme honours NO_COLOR and an explicit profile override", () => {
    const prevNoColor = Bun.env.NO_COLOR;
    const prevForce = Bun.env.FORCE_COLOR;
    try {
      delete Bun.env.FORCE_COLOR;
      Bun.env.NO_COLOR = "1";
      expect(resolveCliAnsiTheme()).toBe(SD_ANSI_THEMES.pipe_ascii);
      expect(resolveCliAnsiTheme("ghostty_interactive")).toBe(
        SD_ANSI_THEMES.ghostty_interactive,
      );
      Bun.env.FORCE_COLOR = "1";
      delete Bun.env.NO_COLOR;
      expect(resolveCliAnsiTheme().colors).toBe(true);
    } finally {
      if (prevNoColor === undefined) delete Bun.env.NO_COLOR;
      else Bun.env.NO_COLOR = prevNoColor;
      if (prevForce === undefined) delete Bun.env.FORCE_COLOR;
      else Bun.env.FORCE_COLOR = prevForce;
    }
  });

  test("Bun v1.4.4 inline-code punctuation wrap regression guard", () => {
    const md = "Verify " + "token ".repeat(18) + "`packChannelHandle32`.";
    const out = renderOpsMarkdownAnsi(md, {
      ...SD_ANSI_THEMES.tty_narrow,
      columns: 60,
    });
    expect(out.includes("`packChannelHandle32`\n.")).toBe(false);
  });

  test("validateAnsiThemeProfiles enforces dark surface polarity, kitty_graphics=false, and pipe_ascii fallback", () => {
    const baseProfiles = {
      ghostty_interactive: {
        profile_id: "ANSI_GHOSTTY_INTERACTIVE",
        colors: true,
        columns: 120,
        hyperlinks: true,
        kitty_graphics: false,
        light: false,
      },
      pipe_ascii: {
        profile_id: "ANSI_PIPE_ASCII",
        colors: false,
        columns: 0,
        hyperlinks: false,
        kitty_graphics: false,
        light: false,
      },
    };
    const contract = {
      surface_token: "--sd-surface-cli",
      max_dark_surface_l_star_milli: 20000,
      forbid_ambient_colorfgbg: true,
      forbid_kitty_disk_io_in_ci: true,
      ascii_fallback_profile: "pipe_ascii",
    };

    expect(() =>
      validateAnsiThemeProfiles("#04070e", baseProfiles, contract),
    ).not.toThrow();

    expect(() =>
      validateAnsiThemeProfiles(
        "#04070e",
        {
          ...baseProfiles,
          ghostty_interactive: {
            ...baseProfiles.ghostty_interactive,
            light: true,
          },
        },
        contract,
      ),
    ).toThrow("ERR_A11Y_ANSI_POLARITY_MISMATCH");

    expect(() =>
      validateAnsiThemeProfiles(
        "#04070e",
        {
          ...baseProfiles,
          ghostty_interactive: {
            ...baseProfiles.ghostty_interactive,
            kitty_graphics: true,
          },
        },
        contract,
      ),
    ).toThrow("ERR_SPEC_KITTY_LOCAL_DISK_FORBIDDEN");
  });
});
