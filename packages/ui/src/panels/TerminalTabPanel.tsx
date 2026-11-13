import type React from "react";
import { renderAnsiReact } from "../ansi.tsx";
import { styles } from "../dashboard_styles.ts";
import type { TerminalCategory, TerminalHistoryEntry } from "../types.ts";

export interface TerminalTabPanelProps {
  readonly terminalCategory: TerminalCategory;
  readonly onTerminalCategoryChange: (cat: TerminalCategory) => void;
  readonly terminalHistory: readonly TerminalHistoryEntry[];
  readonly onClearHistory: () => void;
  readonly copiedTerminalIdx: number | null;
  readonly onCopyOutput: (idx: number, stdout: string) => void;
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
  { label: "⚡ p GP301", cmd: "p GP301", cat: "SHARPS" },
  { label: "⚡ p BRT5229", cmd: "p BRT5229", cat: "SHARPS" },
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
  { label: "🌐 ws", cmd: "ws", cat: "NET" },
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
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span
            style={{
              fontSize: "11px",
              color: "#4ade80",
              fontFamily:
                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            ● PTY Engine Ready (Bun v1.4.4)
          </span>
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

      {/* Scrollable Terminal Screen */}
      <div style={styles.terminalBody}>
        {terminalHistory.map((item, idx) => (
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
                }}
              >
                <button
                  type="button"
                  style={{
                    background: "none",
                    border: "none",
                    color: "#64748b",
                    cursor: "pointer",
                    fontSize: "11px",
                    padding: "0 4px",
                  }}
                  title="Copy raw terminal output"
                  onClick={() => onCopyOutput(idx, item.stdout)}
                >
                  {copiedTerminalIdx === idx ? "✓ Copied" : "📋 Copy"}
                </button>
                <span style={styles.terminalMeta}>
                  {item.durationMs > 0 && `[${item.durationMs}ms] `}
                  exit: {item.exitCode}
                </span>
              </div>
            </div>
            <div style={styles.terminalOutput}>
              {renderAnsiReact(item.stdout)}
            </div>
          </div>
        ))}

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
      </div>

      {/* Keyboard Shortcuts Legend Bar */}
      <div style={styles.terminalKeyLegend}>
        <span>
          <kbd style={styles.kbd}>Tab</kbd> Autocomplete
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
          <kbd style={styles.kbd}>↑ / ↓</kbd> History
        </span>
        <span>
          <kbd style={styles.kbd}>Esc</kbd> Blur
        </span>
      </div>

      {/* Bottom Input Line */}
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
          onChange={(e) => onTerminalCommandChange(e.target.value)}
          onKeyDown={(e) => {
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
          }}
          placeholder="Type command or shortcode (e.g. 'p GP301', 'f syndicate', 'k', 'g', 'dir', 'var', 'stat', 'w', 'kb')..."
          style={styles.terminalInput}
          autoFocus
        />
        <button
          type="submit"
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
  );
}
