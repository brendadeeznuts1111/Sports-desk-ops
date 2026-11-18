// AUTO-GENERATED FROM design/tokens.toml — DO NOT EDIT
export type AnsiProfileKey =
  "ghostty_interactive" | "tty_narrow" | "r2_telemetry_stream" | "pipe_ascii";

export const SD_ANSI_THEMES: Readonly<
  Record<AnsiProfileKey, Readonly<Bun.markdown.AnsiTheme>>
> = Object.freeze({
  ghostty_interactive: Object.freeze({
    colors: true,
    columns: 120,
    hyperlinks: true,
    kittyGraphics: false,
    light: false,
  }),
  tty_narrow: Object.freeze({
    colors: true,
    columns: 88,
    hyperlinks: true,
    kittyGraphics: false,
    light: false,
  }),
  r2_telemetry_stream: Object.freeze({
    colors: true,
    columns: 0,
    hyperlinks: false,
    kittyGraphics: false,
    light: false,
  }),
  pipe_ascii: Object.freeze({
    colors: false,
    columns: 0,
    hyperlinks: false,
    kittyGraphics: false,
    light: false,
  }),
});

export const CHANNEL_ANSI16M_FG_LUT: readonly string[] = Object.freeze([
  "\u001b[38;2;148;163;184m", // [0] NON_SPORTS (#94a3b8)
  "\u001b[38;2;41;182;246m", // [1] Internet (#29b6f6)
  "\u001b[38;2;143;163;191m", // [2] BLOCKED (#8fa3bf)
  "\u001b[38;2;34;211;154m", // [3] GATEWAY (#22d39a)
  "\u001b[38;2;255;120;120m", // [4] ALERT (#ff7878)
  "\u001b[38;2;245;158;11m", // [5] GSBUILDER (#f59e0b)
  "\u001b[38;2;74;222;128m", // [6] GSLIVE (#4ade80)
  "\u001b[38;2;125;211;252m", // [7] CSLEVEL2 (#7dd3fc)
  "\u001b[38;2;103;232;249m", // [8] LIVEBETTINGCWS (#67e8f9)
  "\u001b[38;2;165;180;252m", // [9] PHONE (#a5b4fc)
  "\u001b[38;2;226;232;240m", // [10] HOUSE (#e2e8f0)
]);

export const CHANNEL_BADGE_ANSI_LUT: readonly string[] = Object.freeze([
  "\u001b[38;2;148;163;184m· NON_SPORTS\u001b[39m",
  "\u001b[38;2;41;182;246m○ Internet\u001b[39m",
  "\u001b[38;2;143;163;191m⊘ BLOCKED\u001b[39m",
  "\u001b[38;2;34;211;154m◆ GATEWAY\u001b[39m",
  "\u001b[38;2;255;120;120m▲ ALERT\u001b[39m",
  "\u001b[38;2;245;158;11m⚡ GSBUILDER\u001b[39m",
  "\u001b[38;2;74;222;128m★ GSLIVE\u001b[39m",
  "\u001b[38;2;125;211;252m◇ CSLEVEL2\u001b[39m",
  "\u001b[38;2;103;232;249m◉ LIVEBETTINGCWS\u001b[39m",
  "\u001b[38;2;165;180;252m☎ PHONE\u001b[39m",
  "\u001b[38;2;226;232;240m▣ HOUSE\u001b[39m",
]);

export const CHANNEL_BADGE_ASCII_LUT: readonly string[] = Object.freeze([
  "[NON_SPORTS]",
  "[Internet]",
  "[BLOCKED]",
  "[GATEWAY]",
  "[ALERT]",
  "[GSBUILDER]",
  "[GSLIVE]",
  "[CSLEVEL2]",
  "[LIVEBETTINGCWS]",
  "[PHONE]",
  "[HOUSE]",
]);
