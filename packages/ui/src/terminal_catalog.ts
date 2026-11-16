/** Static terminal command vocabulary and help text; carries no customer data. */

/** Palette grouping; mirrors the Terminal tab's category filter plus utilities. */
export type TerminalCommandGroup =
  "SHARPS" | "DOWNLINES" | "RISK" | "NET" | "UTILITY";

/**
 * Structured command vocabulary shared by Tab autocomplete and the inline
 * suggestion palette. Canonical commands and shortcodes must agree with
 * `lib/terminal_emulator.ts` (`AUTOCOMPLETE_COMMANDS` / `COMMAND_ALIASES`);
 * `tests/terminal_transcript.test.ts` enforces that contract.
 */
export interface TerminalCommandSpec {
  readonly command: string;
  readonly usage: string;
  readonly description: string;
  readonly group: TerminalCommandGroup;
  readonly aliases: readonly string[];
}

export const TERMINAL_COMMAND_SPECS: readonly TerminalCommandSpec[] = [
  {
    command: "profile",
    usage: "profile <id>",
    description:
      "Inspect multidimensional sharpness radar (--radar, --json, --wagers)",
    group: "SHARPS",
    aliases: ["p", "c", "cust", "lookup"],
  },
  {
    command: "find",
    usage: "find <query>",
    description: "Search accounts (-t tier, -s sport, -a action)",
    group: "SHARPS",
    aliases: ["f", "s", "q", "search", "query"],
  },
  {
    command: "harvest",
    usage: "harvest",
    description: "Harvest live customer profiles into the cohort cache",
    group: "SHARPS",
    aliases: ["hv", "anomalies"],
  },
  {
    command: "sharps",
    usage: "sharps",
    description: "Top sharp originators by Sharpness Composite Index",
    group: "SHARPS",
    aliases: ["sh", "sharp", "top", "leaderboard"],
  },
  {
    command: "syndicates",
    usage: "syndicates",
    description: "Detected hook syndicate clusters & sub-accounts",
    group: "SHARPS",
    aliases: ["syn", "hook", "hooks"],
  },
  {
    command: "key-numbers",
    usage: "key-numbers",
    description:
      "Football key-number buyers (3, 7, 10, 14, 21) hit rates & edge",
    group: "SHARPS",
    aliases: ["k", "key", "keys", "keynumbers"],
  },
  {
    command: "gini",
    usage: "gini",
    description:
      "Stake inequality Gini rankings (flat unit vs Kelly vs martingale)",
    group: "SHARPS",
    aliases: ["g"],
  },
  {
    command: "rankings",
    usage: "rankings",
    description: "Rank players on the composite sharpness index",
    group: "DOWNLINES",
    aliases: ["rank", "ranks", "rank-all", "rk"],
  },
  {
    command: "conduits",
    usage: "conduits",
    description: "Proxy conduit clusters and their concentration",
    group: "DOWNLINES",
    aliases: ["proxies", "proxy"],
  },
  {
    command: "subagents",
    usage: "subagents",
    description: "Sub-agent rollups and downline handle",
    group: "DOWNLINES",
    aliases: ["sa", "subagent"],
  },
  {
    command: "trunks",
    usage: "trunks",
    description:
      "NOLAWOLF two-trunk rollup (TRACKTHIS vs NOLAPPH); try trunks detail trackthis",
    group: "DOWNLINES",
    aliases: ["trunk", "trees", "t"],
  },
  {
    command: "directives",
    usage: "directives",
    description: "Actionable desk directives, limit caps & in-play delays",
    group: "RISK",
    aliases: ["dir", "dirs", "limits"],
  },
  {
    command: "risk",
    usage: "risk",
    description: "7d Value-at-Risk (95%), CVaR shortfall & hold %",
    group: "RISK",
    aliases: ["var", "cvar", "forensics"],
  },
  {
    command: "stats",
    usage: "stats",
    description: "Full cohort breakdown & capital protection metrics",
    group: "RISK",
    aliases: ["stat", "summary"],
  },
  {
    command: "bursts",
    usage: "bursts",
    description: "Steam bursts and rapid-fire wager sequences",
    group: "RISK",
    aliases: ["burst", "steam", "b"],
  },
  {
    command: "quarantine",
    usage: "quarantine",
    description: "Burst-guard quarantine state per account",
    group: "RISK",
    aliases: ["guard", "quar", "burst-guard"],
  },
  {
    command: "who",
    usage: "who",
    description: "Operator desk, session, worktree & Bun runtime info",
    group: "NET",
    aliases: ["w"],
  },
  {
    command: "ws",
    usage: "ws",
    description: "WebSocket subscriptions and live channel counts",
    group: "NET",
    aliases: ["subscriptions"],
  },
  {
    command: "dns",
    usage: "dns <host>",
    description: "Benchmark c-ares vs system DNS resolver latency",
    group: "NET",
    aliases: ["d"],
  },
  {
    command: "reverse",
    usage: "reverse <ip>",
    description: "Reverse DNS forensics & datacenter/residential IP lookup",
    group: "NET",
    aliases: ["r", "rev", "ip"],
  },
  {
    command: "cron",
    usage: "cron <expr>",
    description: "Inspect Bun.cron() schedule triggers",
    group: "NET",
    aliases: ["cr"],
  },
  {
    command: "capabilities",
    usage: "capabilities",
    description: "Bun runtime capabilities & feature flags in this build",
    group: "NET",
    aliases: ["caps", "features"],
  },
  {
    command: "markdown",
    usage: "markdown [file]",
    description: "Render Markdown via native Bun.markdown.ansi",
    group: "UTILITY",
    aliases: ["md"],
  },
  {
    command: "clear",
    usage: "clear",
    description: "Clear the terminal screen buffer",
    group: "UTILITY",
    aliases: ["cls"],
  },
  {
    command: "help",
    usage: "help",
    description: "Display the reference manual",
    group: "UTILITY",
    aliases: ["h", "?"],
  },
  {
    command: "keybindings",
    usage: "keybindings",
    description: "Terminal & GUI keyboard shortcuts cheat sheet",
    group: "UTILITY",
    aliases: ["kb", "keyshelp"],
  },
];

/**
 * Canonical commands first, then shortcodes: `handleAutocomplete` uses
 * `startsWith` order, so a prefix that names a command must not be shadowed by
 * a shortcode defined earlier in the list.
 */
export const CLIENT_AUTOCOMPLETE_COMMANDS: readonly string[] = [
  ...new Set([
    ...TERMINAL_COMMAND_SPECS.map((spec) => spec.command),
    ...TERMINAL_COMMAND_SPECS.flatMap((spec) => spec.aliases),
  ]),
];

/** One palette row: the matched command, its usage and why it matched. */
export interface TerminalCommandSuggestion {
  readonly command: string;
  readonly usage: string;
  readonly description: string;
  readonly group: TerminalCommandGroup;
  /** Shortcode the query matched, when it did not match the command name. */
  readonly viaAlias: string | null;
}

export const TERMINAL_SUGGESTION_LIMIT = 6;

/**
 * Inline palette suggestions for the token being typed. Returns nothing once
 * the operator has started on arguments (a space is present) or has typed a
 * complete canonical command, so the palette neither covers the output nor
 * captures the ↑/↓ history keys while a real command is being composed.
 */
export function suggestTerminalCommands(
  rawInput: string,
  limit: number = TERMINAL_SUGGESTION_LIMIT,
): readonly TerminalCommandSuggestion[] {
  if (limit <= 0) return [];
  const input = rawInput.trim().toLowerCase();
  if (input.length === 0 || /\s/.test(input)) return [];
  if (
    TERMINAL_COMMAND_SPECS.some((spec) => spec.command.toLowerCase() === input)
  ) {
    return [];
  }

  const scored: {
    readonly spec: TerminalCommandSpec;
    readonly score: number;
    readonly viaAlias: string | null;
  }[] = [];

  for (const spec of TERMINAL_COMMAND_SPECS) {
    const command = spec.command.toLowerCase();
    if (command.startsWith(input)) {
      scored.push({ spec, score: 0, viaAlias: null });
      continue;
    }
    const prefixAlias = spec.aliases.find((alias) =>
      alias.toLowerCase().startsWith(input),
    );
    if (prefixAlias !== undefined) {
      scored.push({ spec, score: 1, viaAlias: prefixAlias });
      continue;
    }
    if (command.includes(input)) {
      scored.push({ spec, score: 2, viaAlias: null });
      continue;
    }
    const innerAlias = spec.aliases.find((alias) =>
      alias.toLowerCase().includes(input),
    );
    if (innerAlias !== undefined) {
      scored.push({ spec, score: 3, viaAlias: innerAlias });
    }
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.spec.command.length - b.spec.command.length ||
      a.spec.command.localeCompare(b.spec.command),
  );

  return scored.slice(0, limit).map(({ spec, viaAlias }) => ({
    command: spec.command,
    usage: spec.usage,
    description: spec.description,
    group: spec.group,
    viaAlias,
  }));
}

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
