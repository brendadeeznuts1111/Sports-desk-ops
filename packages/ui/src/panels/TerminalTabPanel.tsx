import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderAnsiReact } from "../ansi.tsx";
import { styles } from "../dashboard_styles.ts";
import { suggestTerminalCommands } from "../terminal_catalog.ts";
import {
  formatTerminalTranscript,
  matchTerminalHistory,
  summarizeTerminalHistory,
  terminalTranscriptFilename,
} from "../terminal_transcript.ts";
import type { TerminalCategory, TerminalHistoryEntry } from "../types.ts";

/** Output longer than this collapses to a preview so one verbose command cannot bury the log. */
const TERMINAL_OUTPUT_PREVIEW_LINES = 40;

const ENTRY_ACTION_STYLE: React.CSSProperties = {
  backgroundColor: "rgba(15, 23, 42, 0.6)",
  border: "1px solid rgba(51, 65, 85, 0.7)",
  borderRadius: "4px",
  color: "#94a3b8",
  cursor: "pointer",
  fontSize: "11px",
  padding: "2px 6px",
};

export interface TerminalTabPanelProps {
  readonly terminalCategory: TerminalCategory;
  readonly onTerminalCategoryChange: (cat: TerminalCategory) => void;
  readonly terminalHistory: readonly TerminalHistoryEntry[];
  readonly onClearHistory: () => void;
  readonly copiedTerminalIdx: number | null;
  readonly onCopyOutput: (idx: number, stdout: string) => void;
  readonly copiedCommandIdx: number | null;
  readonly onCopyCommand: (idx: number, command: string) => void;
  readonly terminalLoading: boolean;
  readonly terminalBottomRef: React.RefObject<HTMLDivElement>;
  readonly terminalCommand: string;
  readonly onTerminalCommandChange: (cmd: string) => void;
  readonly commandHistory: readonly string[];
  readonly historyIndex: number;
  readonly onHistoryIndexChange: (idx: number) => void;
  readonly onAutocomplete: () => void;
  readonly onRunCommand: (cmd: string) => void;
}

const TERMINAL_CATEGORY_OPTIONS: readonly {
  readonly id: TerminalCategory;
  readonly label: string;
}[] = [
  { id: "ALL", label: "All Commands" },
  { id: "SHARPS", label: "🎯 Sharps & Profiling" },
  { id: "DOWNLINES", label: "🌲 Downlines & Conduits" },
  { id: "RISK", label: "🛡️ Risk & Directives" },
  { id: "NET", label: "🌐 Network & System" },
];

const QUICK_TERMINAL_CHIPS: readonly {
  readonly label: string;
  readonly cmd: string;
  readonly cat: Exclude<TerminalCategory, "ALL">;
}[] = [
  { label: "🌾 harvest", cmd: "harvest", cat: "SHARPS" },
  { label: "🏆 rank-all", cmd: "rank-all", cat: "SHARPS" },
  { label: "🏆 sh", cmd: "sh", cat: "SHARPS" },
  { label: "🔍 f syndicate", cmd: "f syndicate", cat: "SHARPS" },
  { label: "🚨 conduits", cmd: "conduits", cat: "DOWNLINES" },
  { label: "🌲 trunks", cmd: "trunks", cat: "DOWNLINES" },
  { label: "🏢 sa", cmd: "sa", cat: "DOWNLINES" },
  { label: "⚡ bursts", cmd: "bursts", cat: "RISK" },
  { label: "🛡️ quarantine", cmd: "quarantine", cat: "RISK" },
  { label: "🚨 dir", cmd: "dir", cat: "RISK" },
  { label: "📈 var", cmd: "var", cat: "RISK" },
  { label: "🔑 k", cmd: "k", cat: "RISK" },
  { label: "📊 g", cmd: "g", cat: "RISK" },
  { label: "📊 stat", cmd: "stat", cat: "RISK" },
  { label: "📝 md", cmd: "markdown", cat: "RISK" },
  {
    label: "🎨 md dashboard.md",
    cmd: "md --theme dark --columns 110 --linkify-symbols dashboard.md",
    cat: "RISK",
  },
  { label: "🌐 ws", cmd: "ws", cat: "NET" },
  { label: "🩺 health", cmd: "health --alerts", cat: "NET" },
  { label: "📋 status", cmd: "status --schedules", cat: "NET" },
  { label: "🌐 d fantasy402.com", cmd: "d fantasy402.com", cat: "NET" },
  { label: "🛡️ r 1.1.1.1", cmd: "r 1.1.1.1", cat: "NET" },
  { label: "👤 w", cmd: "w", cat: "NET" },
  { label: "⌨️ kb", cmd: "kb", cat: "NET" },
  { label: "❓ h", cmd: "h", cat: "NET" },
];

export function TerminalTabPanel({
  terminalCategory,
  onTerminalCategoryChange,
  terminalHistory,
  onClearHistory,
  copiedTerminalIdx,
  onCopyOutput,
  copiedCommandIdx,
  onCopyCommand,
  terminalLoading,
  terminalBottomRef,
  terminalCommand,
  onTerminalCommandChange,
  commandHistory,
  historyIndex,
  onHistoryIndexChange,
  onAutocomplete,
  onRunCommand,
}: TerminalTabPanelProps): React.ReactElement {
  const [pinnedToLatest, setPinnedToLatest] = useState<boolean>(true);
  const [expandedEntries, setExpandedEntries] = useState<readonly number[]>([]);
  const [wrapLines, setWrapLines] = useState<boolean>(false);
  const [filter, setFilter] = useState<string>("");
  const [suggestionIndex, setSuggestionIndex] = useState<number>(0);
  const [paletteDismissed, setPaletteDismissed] = useState<boolean>(false);
  const [inputFocused, setInputFocused] = useState<boolean>(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const filterResult = useMemo(
    () => matchTerminalHistory(terminalHistory, filter),
    [terminalHistory, filter],
  );
  const stats = useMemo(
    () => summarizeTerminalHistory(terminalHistory),
    [terminalHistory],
  );
  const suggestions = useMemo(
    () => (paletteDismissed ? [] : suggestTerminalCommands(terminalCommand)),
    [terminalCommand, paletteDismissed],
  );
  const paletteOpen = inputFocused && suggestions.length > 0;
  const activeSuggestionIndex = Math.min(
    suggestionIndex,
    Math.max(0, suggestions.length - 1),
  );

  useEffect(() => {
    setSuggestionIndex(0);
  }, [terminalCommand]);

  useEffect(() => {
    if (!pinnedToLatest) return;
    terminalBottomRef.current?.scrollIntoView({ block: "end" });
  }, [
    pinnedToLatest,
    terminalHistory.length,
    terminalLoading,
    terminalBottomRef,
  ]);

  const handleBodyScroll = () => {
    const el = bodyRef.current;
    if (el === null) return;
    setPinnedToLatest(el.scrollHeight - el.scrollTop - el.clientHeight <= 24);
  };

  const toggleEntry = (idx: number) => {
    setExpandedEntries((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx],
    );
  };

  const visibleOutput = (idx: number, stdout: string): string => {
    // A filter hit must be visible: expanding keeps it from living past the
    // 40-line preview collapse that hides it behind "… more lines".
    if (filterResult.active || expandedEntries.includes(idx)) return stdout;
    const lines = stdout.split("\n");
    if (lines.length <= TERMINAL_OUTPUT_PREVIEW_LINES) return stdout;
    const hidden = lines.length - TERMINAL_OUTPUT_PREVIEW_LINES;
    return `${lines.slice(0, TERMINAL_OUTPUT_PREVIEW_LINES).join("\n")}\n\x1b[90m… ${hidden} more lines (Show all)\x1b[0m`;
  };

  const jumpToLatest = () => {
    setPinnedToLatest(true);
    terminalBottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  };

  const handleCommandChange = (next: string) => {
    setPaletteDismissed(false);
    onTerminalCommandChange(next);
  };

  const acceptSuggestion = (command: string) => {
    setPaletteDismissed(false);
    onTerminalCommandChange(`${command} `);
  };

  const handleExportTranscript = () => {
    if (typeof document === "undefined") return;
    if (typeof URL.createObjectURL !== "function") return;
    const text = formatTerminalTranscript(terminalHistory);
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = terminalTranscriptFilename();
    anchor.rel = "noopener";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const handleCommandKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (paletteOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestionIndex((prev) => (prev + 1) % suggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestionIndex(
          (prev) => (prev - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && e.ctrlKey)) {
        e.preventDefault();
        const pick = suggestions[activeSuggestionIndex];
        if (pick !== undefined) acceptSuggestion(pick.command);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPaletteDismissed(true);
        return;
      }
    }

    if (e.key === "Tab") {
      e.preventDefault();
      onAutocomplete();
    } else if (e.ctrlKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      onClearHistory();
    } else if (e.ctrlKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      onTerminalCommandChange("");
    } else if (e.key === "Escape") {
      e.currentTarget.blur();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const nextIdx =
          historyIndex === -1
            ? commandHistory.length - 1
            : Math.max(0, historyIndex - 1);
        onHistoryIndexChange(nextIdx);
        onTerminalCommandChange(commandHistory[nextIdx] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex !== -1) {
        const nextIdx = historyIndex + 1;
        if (nextIdx >= commandHistory.length) {
          onHistoryIndexChange(-1);
          onTerminalCommandChange("");
        } else {
          onHistoryIndexChange(nextIdx);
          onTerminalCommandChange(commandHistory[nextIdx] ?? "");
        }
      }
    }
  };

  return (
    <div style={styles.terminalContainer}>
      {/* Window title bar */}
      <div style={styles.terminalBar}>
        <div style={styles.terminalWindowButtons}>
          <span style={styles.terminalDot("#ef4444")} />
          <span style={styles.terminalDot("#f59e0b")} />
          <span style={styles.terminalDot("#10b981")} />
          <span style={styles.terminalTitle}>
            SportsDesk Operator Terminal · Bun.Terminal (PTY) + Bun.spawn
          </span>
        </div>
        <div style={styles.terminalHeaderRight}>
          <span style={styles.terminalStat} data-terminal-stats="true">
            {stats.executed === 0
              ? "no runs yet"
              : `⏱ ${stats.executed} run${stats.executed === 1 ? "" : "s"}`}
            {stats.p50Ms !== null &&
              ` · p50 ${stats.p50Ms}ms · p95 ${stats.p95Ms ?? "—"}ms`}
            {stats.failed > 0 && (
              <span style={styles.terminalStatAlert}>
                {" "}
                · {stats.failed} failed
              </span>
            )}
          </span>
          <span
            style={{
              fontSize: "11px",
              color: "#4ade80",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            ● PTY Engine Ready
          </span>
          <button
            type="button"
            data-terminal-wrap-toggle="true"
            aria-pressed={wrapLines}
            style={{
              ...styles.actionBtn,
              padding: "3px 8px",
              fontSize: "11px",
              ...(wrapLines
                ? {
                    backgroundColor: "rgba(56, 189, 248, 0.16)",
                    border: "1px solid rgba(56, 189, 248, 0.45)",
                    color: "#7dd3fc",
                  }
                : {}),
            }}
            onClick={() => setWrapLines((prev) => !prev)}
            title="Toggle line wrapping (off preserves box-drawing tables via horizontal scroll)"
          >
            {wrapLines ? "↩ Wrap: On" : "↔ Wrap: Off"}
          </button>
          <button
            type="button"
            style={{
              ...styles.actionBtn,
              padding: "3px 8px",
              fontSize: "11px",
            }}
            onClick={handleExportTranscript}
            title="Download the ANSI-stripped session transcript (.txt)"
          >
            ⤓ Export
          </button>
          <button
            type="button"
            style={{
              ...styles.actionBtn,
              padding: "3px 8px",
              fontSize: "11px",
            }}
            onClick={onClearHistory}
            title="Clear terminal buffer"
          >
            Clear Screen
          </button>
        </div>
      </div>

      {/* Category Filter & Quick Query Toolbar */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "8px 12px",
          borderBottom: "1px solid #1e293b",
          backgroundColor: "#0b1222",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              marginRight: "4px",
            }}
          >
            Categories:
          </span>
          {TERMINAL_CATEGORY_OPTIONS.map((cat) => (
            <button
              key={cat.id}
              type="button"
              style={styles.filterPill(terminalCategory === cat.id)}
              onClick={() => onTerminalCategoryChange(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div style={styles.terminalChips}>
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              alignSelf: "center",
              marginRight: "4px",
            }}
          >
            Quick Queries:
          </span>
          {QUICK_TERMINAL_CHIPS.filter(
            (chip) =>
              terminalCategory === "ALL" || chip.cat === terminalCategory,
          ).map((chip) => (
            <button
              key={chip.cmd}
              type="button"
              style={styles.terminalChip}
              onClick={() => onRunCommand(chip.cmd)}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* ANSI-aware history filter */}
      <div style={styles.terminalFilterBar}>
        <span style={{ fontSize: "11px", color: "#64748b" }}>Filter</span>
        <input
          data-terminal-filter="true"
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setFilter("");
              e.currentTarget.blur();
            }
          }}
          placeholder="Filter commands & output (case-insensitive, ANSI-aware)…"
          aria-label="Filter terminal history"
          style={styles.terminalFilterInput}
        />
        {filterResult.active && (
          <>
            <span
              style={styles.terminalFilterCount}
              data-terminal-filter-count="true"
            >
              {filterResult.matches.length}/{filterResult.totalEntries} commands
              · {filterResult.totalHits} hits
            </span>
            <button
              type="button"
              data-terminal-filter-clear="true"
              style={ENTRY_ACTION_STYLE}
              onClick={() => setFilter("")}
              title="Clear the history filter"
            >
              ✕ clear
            </button>
          </>
        )}
      </div>

      {/* Scrollable Terminal Screen */}
      <div
        ref={bodyRef}
        className="sd-terminal-body"
        data-terminal-body="true"
        onScroll={handleBodyScroll}
        style={styles.terminalBody}
      >
        {filterResult.matches.map(({ entry: item, historyIndex: idx }) => (
          <div key={idx} style={styles.terminalEntry}>
            <div style={styles.terminalPromptLine}>
              <span>
                sportsdesk&gt;{" "}
                <span style={{ color: "#f8fafc" }}>{item.command}</span>
              </span>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                }}
              >
                <span style={styles.terminalMeta}>
                  {new Date(item.timestamp).toLocaleTimeString("en-US", {
                    hour12: false,
                  })}
                  {item.durationMs > 0 ? ` · ${item.durationMs}ms` : ""}
                </span>
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 700,
                    padding: "1px 6px",
                    borderRadius: "4px",
                    border: `1px solid ${
                      item.exitCode === 0
                        ? "rgba(74, 222, 128, 0.35)"
                        : "rgba(248, 113, 113, 0.35)"
                    }`,
                    backgroundColor:
                      item.exitCode === 0
                        ? "rgba(34, 197, 94, 0.12)"
                        : "rgba(239, 68, 68, 0.14)",
                    color: item.exitCode === 0 ? "#4ade80" : "#f87171",
                  }}
                >
                  exit {item.exitCode}
                </span>
                <button
                  type="button"
                  style={ENTRY_ACTION_STYLE}
                  title="Copy the command text"
                  onClick={() => onCopyCommand(idx, item.command)}
                >
                  {copiedCommandIdx === idx ? "✓ cmd" : "⧉ cmd"}
                </button>
                <button
                  type="button"
                  style={ENTRY_ACTION_STYLE}
                  title={`Run "${item.command}" again`}
                  onClick={() => onRunCommand(item.command)}
                >
                  ↻ Rerun
                </button>
                <button
                  type="button"
                  style={ENTRY_ACTION_STYLE}
                  title="Copy raw terminal output"
                  onClick={() => onCopyOutput(idx, item.stdout)}
                >
                  {copiedTerminalIdx === idx ? "✓ Copied" : "📋 Copy"}
                </button>
              </div>
            </div>
            <div
              className="sd-terminal-output"
              data-terminal-output="true"
              data-terminal-wrap={wrapLines ? "on" : "off"}
              style={
                wrapLines
                  ? {
                      ...styles.terminalOutput,
                      whiteSpace: "pre-wrap",
                      overflowX: "hidden",
                      wordBreak: "break-word",
                      lineHeight: "1.45",
                    }
                  : styles.terminalOutput
              }
            >
              {renderAnsiReact(visibleOutput(idx, item.stdout))}
            </div>
            {!filterResult.active &&
              item.stdout.split("\n").length >
                TERMINAL_OUTPUT_PREVIEW_LINES && (
                <div
                  style={{
                    padding: "6px 12px 10px",
                    borderTop: "1px solid rgba(30, 41, 59, 0.6)",
                    backgroundColor: "rgba(15, 23, 42, 0.45)",
                  }}
                >
                  <button
                    type="button"
                    style={{
                      padding: "4px 10px",
                      borderRadius: "5px",
                      border: "1px solid rgba(56, 189, 248, 0.35)",
                      backgroundColor: "rgba(56, 189, 248, 0.12)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                    onClick={() => toggleEntry(idx)}
                  >
                    {expandedEntries.includes(idx)
                      ? "Collapse output"
                      : `Show all ${item.stdout.split("\n").length} lines`}
                  </button>
                </div>
              )}
          </div>
        ))}

        {filterResult.active && filterResult.matches.length === 0 && (
          <div style={styles.terminalEmpty} data-terminal-empty="true">
            <span>No history matches “{filterResult.query}”.</span>
            <span style={{ color: "#64748b" }}>
              {filterResult.totalEntries} command
              {filterResult.totalEntries === 1 ? "" : "s"} searched.
            </span>
            <button
              type="button"
              data-terminal-filter-clear="true"
              style={ENTRY_ACTION_STYLE}
              onClick={() => setFilter("")}
            >
              Clear filter
            </button>
          </div>
        )}

        {terminalLoading && (
          <div style={{ color: "#38bdf8", padding: "8px 0" }}>
            <span>sportsdesk&gt; </span>
            <span style={{ opacity: 0.8 }}>
              Executing in native Bun.Terminal PTY...
            </span>
            <span style={{ animation: "pulse 1s infinite" }}> █</span>
          </div>
        )}
        <div ref={terminalBottomRef} />
        {!pinnedToLatest && (
          <button
            type="button"
            onClick={jumpToLatest}
            style={{
              position: "sticky",
              bottom: "0",
              marginLeft: "auto",
              display: "block",
              padding: "4px 10px",
              borderRadius: "6px",
              border: "1px solid rgba(56, 189, 248, 0.4)",
              backgroundColor: "rgba(56, 189, 248, 0.16)",
              color: "#7dd3fc",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            ↓ Jump to latest
          </button>
        )}
      </div>

      {/* Keyboard Shortcuts Legend Bar */}
      <div style={styles.terminalKeyLegend}>
        <span>
          <kbd style={styles.kbd}>Tab</kbd> Complete / accept suggestion
        </span>
        <span>
          <kbd style={styles.kbd}>Ctrl + `</kbd> /{" "}
          <kbd style={styles.kbd}>Cmd + K</kbd> Toggle PTY
        </span>
        <span>
          <kbd style={styles.kbd}>Ctrl + 1/2/3</kbd> Tabs
        </span>
        <span>
          <kbd style={styles.kbd}>Ctrl + L</kbd> Clear Screen
        </span>
        <span>
          <kbd style={styles.kbd}>Ctrl + C</kbd> Cancel
        </span>
        <span>
          <kbd style={styles.kbd}>↑ / ↓</kbd> History / suggestions
        </span>
        <span>
          <kbd style={styles.kbd}>Enter</kbd> Run
        </span>
        <span>
          <kbd style={styles.kbd}>Esc</kbd> Blur
        </span>
      </div>

      {/* Bottom Input Line (suggestion palette floats above it) */}
      <div style={styles.terminalInputWrapper}>
        {paletteOpen && (
          <div
            style={styles.terminalPalette}
            role="listbox"
            aria-label="Command suggestions"
            data-terminal-palette="true"
          >
            {suggestions.map((suggestion, idx) => (
              <button
                key={suggestion.command}
                type="button"
                role="option"
                aria-selected={idx === activeSuggestionIndex}
                data-terminal-suggestion={suggestion.command}
                title={`${suggestion.usage} — ${suggestion.description}`}
                style={styles.terminalPaletteRow(idx === activeSuggestionIndex)}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSuggestionIndex(idx)}
                onClick={() => acceptSuggestion(suggestion.command)}
              >
                <span style={styles.terminalPaletteUsage}>
                  {suggestion.usage}
                </span>
                <span style={styles.terminalPaletteDesc}>
                  {suggestion.description}
                </span>
                <span style={styles.terminalPaletteGroup}>
                  {suggestion.viaAlias === null
                    ? suggestion.group
                    : `alias ${suggestion.viaAlias}`}
                </span>
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRunCommand(terminalCommand);
          }}
          style={styles.terminalInputBar}
        >
          <span style={styles.terminalPromptSymbol}>sportsdesk$</span>
          <input
            data-terminal-input="true"
            type="text"
            value={terminalCommand}
            onChange={(e) => handleCommandChange(e.target.value)}
            onKeyDown={handleCommandKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Type command or shortcode (e.g. 'p <customer id>', 'f syndicate', 'k', 'g', 'dir', 'var', 'stat', 'w', 'kb')..."
            style={styles.terminalInput}
            autoFocus
          />
          <button
            type="submit"
            data-terminal-run="true"
            disabled={terminalLoading}
            style={{
              ...styles.actionBtn,
              backgroundColor: "#0284c7",
              borderColor: "#38bdf8",
              cursor: "pointer",
            }}
          >
            {terminalLoading ? "Running..." : "Run (PTY)"}
          </button>
        </form>
      </div>
    </div>
  );
}
