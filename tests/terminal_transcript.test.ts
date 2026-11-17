import { describe, expect, test } from "bun:test";
import {
  AUTOCOMPLETE_COMMANDS,
  COMMAND_ALIASES,
} from "../lib/terminal_emulator.ts";
import {
  CLIENT_AUTOCOMPLETE_COMMANDS,
  suggestTerminalCommands,
  TERMINAL_COMMAND_SPECS,
  TERMINAL_SUGGESTION_LIMIT,
} from "../packages/ui/src/terminal_catalog.ts";
import {
  formatTerminalTranscript,
  matchTerminalHistory,
  stripAnsi,
  summarizeTerminalHistory,
  terminalTranscriptFilename,
} from "../packages/ui/src/terminal_transcript.ts";
import type { TerminalHistoryEntry } from "../packages/ui/src/types.ts";

const T0 = Date.UTC(2026, 10, 16, 3, 15, 22);

function entry(over: Partial<TerminalHistoryEntry>): TerminalHistoryEntry {
  return {
    command: "help",
    stdout: "",
    exitCode: 0,
    durationMs: 0,
    timestamp: T0,
    ...over,
  };
}

describe("terminal_transcript · ANSI stripping", () => {
  test("removes SGR colour, OSC-8 link wrappers and C0 controls, keeping text", () => {
    expect(stripAnsi("\x1b[31mCRITICAL\x1b[0m hold 91%")).toBe(
      "CRITICAL hold 91%",
    );
    expect(
      stripAnsi("\x1b]8;;https://desk.test/x\u001b\\SPECIAL\u001b]8;;\u001b\\"),
    ).toBe("SPECIAL");
    expect(stripAnsi("line\r\nnext\rlast\x07")).toBe("line\nnext\nlast");
    expect(stripAnsi("\x1b[38;2;255;0;0mtruecolor\x1b[0m")).toBe("truecolor");
  });
});

describe("terminal_transcript · history filter", () => {
  const history: readonly TerminalHistoryEntry[] = [
    entry({
      command: "risk",
      stdout: "\x1b[1mCRITICAL\x1b[0m key-number buyer, critical exposure",
      durationMs: 12,
    }),
    entry({ command: "stats", stdout: "cohort hold 91%", durationMs: 8 }),
    entry({ command: "help", stdout: "", durationMs: 0 }),
  ];

  test("an empty query is inactive and returns every entry", () => {
    const result = matchTerminalHistory(history, "   ");
    expect(result.active).toBe(false);
    expect(result.query).toBe("");
    expect(result.totalEntries).toBe(3);
    expect(result.totalHits).toBe(0);
    expect(result.matches.map((m) => m.historyIndex)).toEqual([0, 1, 2]);
  });

  test("matches case-insensitively against ANSI-stripped output", () => {
    const result = matchTerminalHistory(history, "critical");
    expect(result.active).toBe(true);
    expect(result.matches.map((m) => m.historyIndex)).toEqual([0]);
    expect(result.matches[0]?.hits).toBe(2);
    expect(result.totalHits).toBe(2);
  });

  test("matches the command itself", () => {
    const result = matchTerminalHistory(history, "sta");
    expect(result.matches.map((m) => m.historyIndex)).toEqual([1]);
    expect(result.totalHits).toBe(1);
  });

  test("reports an empty match set without pretending the history is empty", () => {
    const result = matchTerminalHistory(history, "no-such-token");
    expect(result.active).toBe(true);
    expect(result.matches).toEqual([]);
    expect(result.totalHits).toBe(0);
    expect(result.totalEntries).toBe(3);
  });
});

describe("terminal_transcript · run statistics", () => {
  test("excludes the seeded welcome buffer and uses nearest-rank percentiles", () => {
    const stats = summarizeTerminalHistory([
      entry({ durationMs: 0, synthetic: true }),
      entry({ durationMs: 40 }),
      entry({ durationMs: 10 }),
      entry({ durationMs: 30, exitCode: 1 }),
      entry({ durationMs: 20 }),
    ]);
    expect(stats.entries).toBe(5);
    expect(stats.executed).toBe(4);
    expect(stats.failed).toBe(1);
    expect(stats.totalMs).toBe(100);
    expect(stats.p50Ms).toBe(20);
    expect(stats.p95Ms).toBe(40);
  });

  test("counts a sub-millisecond run as executed but reports no latency sample", () => {
    const stats = summarizeTerminalHistory([
      entry({ durationMs: 0, synthetic: true }),
      entry({ durationMs: 0 }),
    ]);
    expect(stats.executed).toBe(1);
    expect(stats.failed).toBe(0);
    expect(stats.p50Ms).toBeNull();
    expect(stats.p95Ms).toBeNull();
  });

  test("an unexecuted welcome buffer reports null latency instead of 0ms", () => {
    const stats = summarizeTerminalHistory([
      entry({ durationMs: 0, synthetic: true }),
    ]);
    expect(stats.executed).toBe(0);
    expect(stats.p50Ms).toBeNull();
    expect(stats.p95Ms).toBeNull();
  });
});

describe("terminal_transcript · session export", () => {
  test("is deterministic, ANSI-free and carries exit/duration provenance", () => {
    const text = formatTerminalTranscript(
      [
        entry({
          command: "risk",
          stdout: "\x1b[31mCRITICAL\x1b[0m\n\n",
          durationMs: 12,
        }),
        entry({ command: "clear", stdout: "", durationMs: 1, exitCode: 0 }),
      ],
      { exportedAt: Date.UTC(2026, 10, 16, 3, 30, 0) },
    );

    expect(text).toContain("SportsDesk Operator Terminal — session transcript");
    expect(text).toContain("exported: 2026-11-16T03:30:00.000Z");
    expect(text).toContain("commands: 2 · failed: 0 · p50: 1ms · p95: 12ms");
    expect(text).toContain(
      "$ risk  · exit 0 · 12ms · 2026-11-16T03:15:22.000Z",
    );
    expect(text).toContain("CRITICAL");
    expect(text).toContain("(no output)");
    expect(text).not.toContain("\x1b[");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("omits the provenance header on request and stays empty for no history", () => {
    expect(formatTerminalTranscript([], { includeHeader: false })).toBe("");
    const body = formatTerminalTranscript(
      [entry({ command: "stats", stdout: "ok", durationMs: 3 })],
      { includeHeader: false },
    );
    expect(body.startsWith("$ stats")).toBe(true);
    expect(body).not.toContain("exported:");
  });

  test("builds a filesystem-safe transcript filename", () => {
    expect(
      terminalTranscriptFilename(Date.UTC(2026, 10, 16, 3, 30, 0, 5)),
    ).toBe("sportsdesk-terminal-2026-11-16T03-30-00-005Z.txt");
  });
});

describe("terminal_catalog · suggestion palette", () => {
  test("ranks a command prefix above an alias match and reports the alias", () => {
    const suggestions = suggestTerminalCommands("pro");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]?.command).toBe("profile");
    expect(suggestions[0]?.viaAlias).toBeNull();
    const viaAlias = suggestions.find(
      (suggestion) => suggestion.command === "conduits",
    );
    expect(viaAlias?.viaAlias).toBe("proxies");
  });

  test("is case-insensitive and matches shortcodes", () => {
    expect(suggestTerminalCommands("PRO")[0]?.command).toBe("profile");
    expect(suggestTerminalCommands("kb")[0]?.command).toBe("keybindings");
    expect(suggestTerminalCommands("sh")[0]?.command).toBe("sharps");
  });

  test("stays out of the way once arguments are being typed", () => {
    expect(suggestTerminalCommands("p GP301")).toEqual([]);
    expect(suggestTerminalCommands("")).toEqual([]);
    expect(suggestTerminalCommands("zzz")).toEqual([]);
  });

  test("releases a complete command so ↑/↓ keep recalling history", () => {
    expect(suggestTerminalCommands("help")).toEqual([]);
    expect(suggestTerminalCommands("HELP")).toEqual([]);
    expect(suggestTerminalCommands("profile")).toEqual([]);
    // A shortcode or partial token is still suggesting.
    expect(suggestTerminalCommands("h").length).toBeGreaterThan(0);
    expect(suggestTerminalCommands("prof")[0]?.command).toBe("profile");
  });

  test("respects the limit and the documented default", () => {
    expect(suggestTerminalCommands("s", 2)).toHaveLength(2);
    expect(suggestTerminalCommands("s").length).toBeLessThanOrEqual(
      TERMINAL_SUGGESTION_LIMIT,
    );
  });

  test("every suggestion carries usage, description and a group", () => {
    for (const suggestion of suggestTerminalCommands("d")) {
      expect(suggestion.usage.length).toBeGreaterThan(0);
      expect(suggestion.description.length).toBeGreaterThan(0);
      expect(suggestion.group.length).toBeGreaterThan(0);
    }
  });
});

describe("terminal_catalog · contract with lib/terminal_emulator.ts", () => {
  test("the client autocomplete list covers every server command", () => {
    const missing = AUTOCOMPLETE_COMMANDS.filter(
      (command) => !CLIENT_AUTOCOMPLETE_COMMANDS.includes(command),
    );
    expect(missing).toEqual([]);
  });

  test("the client autocomplete list has no duplicates", () => {
    expect(new Set(CLIENT_AUTOCOMPLETE_COMMANDS).size).toBe(
      CLIENT_AUTOCOMPLETE_COMMANDS.length,
    );
  });

  test("every server alias is owned by the spec it resolves to", () => {
    const owner = new Map<string, string>();
    for (const spec of TERMINAL_COMMAND_SPECS) {
      owner.set(spec.command, spec.command);
      for (const alias of spec.aliases) {
        expect(owner.has(alias)).toBe(false);
        owner.set(alias, spec.command);
      }
    }

    const mismatches: string[] = [];
    for (const [alias, target] of Object.entries(COMMAND_ALIASES)) {
      const resolved = owner.get(alias);
      if (resolved === undefined) {
        mismatches.push(
          `${alias} is not in the client catalog (server: ${target})`,
        );
      } else if (resolved !== target) {
        mismatches.push(
          `${alias} resolves to ${resolved}, server says ${target}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("every client spec command and alias is known to the server", () => {
    const unknown: string[] = [];
    for (const spec of TERMINAL_COMMAND_SPECS) {
      const canonical =
        AUTOCOMPLETE_COMMANDS.includes(spec.command) ||
        COMMAND_ALIASES[spec.command] === spec.command;
      if (!canonical) unknown.push(`command ${spec.command}`);
      for (const alias of spec.aliases) {
        if (COMMAND_ALIASES[alias] !== spec.command) {
          unknown.push(`alias ${alias} -> ${spec.command}`);
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});
