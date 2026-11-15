/** Static terminal command vocabulary and help text; carries no customer data. */

export const CLIENT_AUTOCOMPLETE_COMMANDS: readonly string[] = [
  "profile",
  "find",
  "sharps",
  "syndicates",
  "key-numbers",
  "gini",
  "directives",
  "risk",
  "stats",
  "who",
  "dns",
  "reverse",
  "cron",
  "markdown",
  "capabilities",
  "clear",
  "help",
  "keybindings",
  "p",
  "f",
  "sh",
  "syn",
  "k",
  "g",
  "dir",
  "var",
  "stat",
  "w",
  "d",
  "r",
  "cr",
  "md",
  "cls",
  "h",
  "kb",
];

export const TERMINAL_WELCOME_HELP_STDOUT =
  "\x1b[1;36m╔════════════════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
  "\x1b[1;36m║   ⚡ SPORTSDESK & FANTASY402 INTERACTIVE PTY TERMINAL (Bun.Terminal)     ║\x1b[0m\n" +
  "\x1b[1;36m╚════════════════════════════════════════════════════════════════════════════╝\x1b[0m\n" +
  "\x1b[90mEngine: Bun.spawn + Bun.Terminal PTY · Host: sportsdesk-ops · Invariant: autoExecute: false\x1b[0m\n\n" +
  "\x1b[1;33mCommands & Canonical Shortcodes:\x1b[0m\n" +
  "  \x1b[1;32mprofile <id>\x1b[0m (aliases: \x1b[32mp, c\x1b[0m) Inspect multidimensional sharpness radar (flags: \x1b[36m--radar\x1b[0m, \x1b[36m--json\x1b[0m, \x1b[36m--wagers\x1b[0m)\n" +
  "  \x1b[1;32mfind <query>\x1b[0m (aliases: \x1b[32mf, s\x1b[0m) Search accounts (flags: \x1b[36m-t <tier>\x1b[0m, \x1b[36m-s <sport>\x1b[0m, \x1b[36m-a <action>\x1b[0m)\n" +
  "  \x1b[1;32msharps\x1b[0m (aliases: \x1b[32msh, top\x1b[0m)    Top sharp originators ranked by Sharpness Composite Index\n" +
  "  \x1b[1;32msyndicates\x1b[0m (aliases: \x1b[32msyn\x1b[0m)       Detected hook syndicate clusters & sub-accounts\n" +
  "  \x1b[1;32mkey-numbers\x1b[0m (aliases: \x1b[32mk, keys\x1b[0m) Football key number buyers (3, 7, 10, 14, 21) hit rates & edge\n" +
  "  \x1b[1;32mgini\x1b[0m (alias: \x1b[32mg\x1b[0m)               Stake inequality Gini rankings (flat unit vs Kelly vs martingale)\n" +
  "  \x1b[1;32mdirectives\x1b[0m (aliases: \x1b[32mdir\x1b[0m)     Actionable desk directives, limit caps & in-play delays\n" +
  "  \x1b[1;32mrisk\x1b[0m (aliases: \x1b[32mvar, cvar\x1b[0m)       7d Value-at-Risk (95%), CVaR shortfall & hold %\n" +
  "  \x1b[1;32mstats\x1b[0m (aliases: \x1b[32mstat\x1b[0m)          Full cohort breakdown & capital protection metrics\n" +
  "  \x1b[1;32mwho\x1b[0m (alias: \x1b[32mw\x1b[0m)                Operator desk, session, worktree & Bun runtime info\n" +
  "  \x1b[1;32mkeybindings\x1b[0m (alias: \x1b[32mkb\x1b[0m)        Terminal & GUI keyboard shortcuts cheat sheet\n" +
  "  \x1b[1;32mdns <host>\x1b[0m (alias: \x1b[32md\x1b[0m)         Benchmark c-ares vs system DNS resolver latency\n" +
  "  \x1b[1;32mreverse <ip>\x1b[0m (alias: \x1b[32mr, ip\x1b[0m)     Reverse DNS forensics & datacenter/residential IP lookup\n" +
  "  \x1b[1;32mcron <expr>\x1b[0m (alias: \x1b[32mcr\x1b[0m)        Inspect Bun.cron() schedule triggers\n" +
  "  \x1b[1;32mmarkdown\x1b[0m (alias: \x1b[32mmd\x1b[0m)           Render Markdown via native Bun.markdown.ansi\n" +
  "  \x1b[1;32mclear\x1b[0m (alias: \x1b[32mcls\x1b[0m)             Clear terminal screen buffer\n" +
  "  \x1b[1;32mhelp\x1b[0m (aliases: \x1b[32mh, ?\x1b[0m)           Display this reference manual\n\n" +
  "\x1b[1;33mKeyboard Shortcuts:\x1b[0m \x1b[36m[Tab]\x1b[0m Autocomplete · \x1b[36m[Ctrl+` / Cmd+K]\x1b[0m Toggle PTY · \x1b[36m[Ctrl+1/2/3]\x1b[0m Tabs · \x1b[36m[Ctrl+L]\x1b[0m Clear";

export const TERMINAL_INITIAL_COMMANDS: string[] = [
  "help",
  "sh",
  "k",
  "g",
  "dir",
  "var",
  "stat",
  "w",
  "kb",
];
