import type React from "react";
import { wagerBadge } from "@sportsdesk-ops/contracts/wager-tokens";

export const styles = {
  container: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    backgroundColor: "#070b14",
    color: "#f1f5f9",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column" as const,
  },
  header: {
    padding: "14px 24px",
    backgroundColor: "#0d1527",
    borderBottom: "1px solid #1e293b",
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "12px",
    justifyContent: "space-between",
    alignItems: "center",
  },
  headerLeft: {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: "10px",
  },
  title: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 700,
    color: "#f1f5f9",
  },
  badge: (active: boolean) => ({
    padding: "4px 10px",
    borderRadius: "12px",
    fontSize: "12px",
    fontWeight: 600,
    backgroundColor: active
      ? "rgba(34, 197, 94, 0.15)"
      : "rgba(239, 68, 68, 0.15)",
    color: active ? "#4ade80" : "#f87171",
    border: `1px solid ${active ? "rgba(34, 197, 94, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
  }),
  tabNav: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
  },
  tabBtn: (active: boolean) => ({
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "7px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
    cursor: "pointer",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#94a3b8",
    border: "none",
    transition: "all 0.15s ease",
  }),
  keyShortcutBadge: {
    marginLeft: "2px",
    padding: "1px 5px",
    borderRadius: "4px",
    fontSize: "10px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontWeight: 600,
    backgroundColor: "rgba(15, 23, 42, 0.22)",
    opacity: 0.85,
  },
  main: {
    flex: 1,
    padding: "24px",
    maxWidth: "1600px",
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  kpiGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: "16px",
    marginBottom: "20px",
  },
  kpiCard: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
  },
  kpiLabel: {
    fontSize: "12px",
    color: "#94a3b8",
    textTransform: "uppercase" as const,
    fontWeight: 600,
    marginBottom: "4px",
  },
  kpiVal: {
    fontSize: "22px",
    fontWeight: 700,
    color: "#38bdf8",
    marginBottom: "4px",
  },
  kpiSub: {
    fontSize: "11px",
    color: "#64748b",
  },
  filterBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "12px",
    alignItems: "center",
    marginBottom: "20px",
  },
  searchInput: {
    flex: "1 1 300px",
    padding: "10px 14px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    color: "#f1f5f9",
    fontSize: "13px",
    outline: "none",
  },
  filterPills: {
    display: "flex",
    gap: "8px",
  },
  pill: (active: boolean) => ({
    padding: "8px 14px",
    borderRadius: "20px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "rgba(56, 189, 248, 0.2)" : "#0d1527",
    color: active ? "#38bdf8" : "#94a3b8",
    border: `1px solid ${active ? "#38bdf8" : "#1e293b"}`,
  }),
  showcaseGrid: {
    display: "grid",
    gridTemplateColumns: "3fr 2fr",
    gap: "24px",
  },
  tablePanel: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
    overflow: "hidden",
  },
  panelTitle: {
    margin: "0 0 16px 0",
    fontSize: "16px",
    color: "#f8fafc",
  },
  tableContainer: {
    overflowX: "auto" as const,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "12px",
  },
  thRow: {
    borderBottom: "2px solid #1e293b",
    textAlign: "left" as const,
  },
  th: {
    padding: "10px 12px",
    color: "#94a3b8",
    fontWeight: 600,
  },
  tr: (selected: boolean) => ({
    borderBottom: "1px solid #1e293b",
    cursor: "pointer",
    backgroundColor: selected ? "rgba(56, 189, 248, 0.08)" : "transparent",
    transition: "background 0.15s ease",
  }),
  td: {
    padding: "10px 12px",
    verticalAlign: "top" as const,
  },
  custCell: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  custLink: {
    color: "#38bdf8",
    textDecoration: "none",
    fontWeight: 600,
  },
  custAgent: {
    fontSize: "11px",
    color: "#64748b",
  },
  custSub: {
    fontSize: "11px",
    color: "#64748b",
  },
  subBadge: {
    fontSize: "10px",
    padding: "1px 5px",
    borderRadius: "4px",
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    color: "#f87171",
  },
  tierBadge: (tier: string) => {
    let color = "#94a3b8";
    let bg = "rgba(148, 163, 184, 0.1)";
    if (tier.includes("TIER_1") || tier.includes("ELITE")) {
      color = "#f87171";
      bg = "rgba(239, 68, 68, 0.2)";
    } else if (tier.includes("TIER_2") || tier.includes("STEAM")) {
      color = "#f59e0b";
      bg = "rgba(245, 158, 11, 0.2)";
    } else if (tier.includes("TIER_3") || tier.includes("DISCIPLINED")) {
      color = "#fbbf24";
      bg = "rgba(251, 191, 36, 0.2)";
    } else if (tier.includes("RECREATIONAL")) {
      color = "#4ade80";
      bg = "rgba(34, 197, 94, 0.15)";
    }
    return {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "4px",
      fontSize: "11px",
      fontWeight: 600,
      backgroundColor: bg,
      color,
    };
  },
  corrBadge: (tier: string) => {
    let color = "#94a3b8";
    if (tier === "CRITICAL") color = "#f87171";
    if (tier === "HIGH") color = "#fb923c";
    if (tier === "MODERATE") color = "#fbbf24";
    return {
      color,
      fontWeight: 600,
      fontSize: "11px",
    };
  },
  actionBadge: (act: string) => ({
    display: "inline-block",
    padding: "2px 6px",
    borderRadius: "4px",
    fontSize: "10px",
    fontWeight: 600,
    backgroundColor:
      act === "ALERT_OPERATOR"
        ? "rgba(239, 68, 68, 0.2)"
        : act === "MONITOR"
          ? "rgba(251, 191, 36, 0.2)"
          : "rgba(34, 197, 94, 0.15)",
    color:
      act === "ALERT_OPERATOR"
        ? "#f87171"
        : act === "MONITOR"
          ? "#fbbf24"
          : "#4ade80",
  }),
  inspectorPanel: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "20px",
    position: "sticky" as const,
    top: "20px",
    maxHeight: "calc(100vh - 40px)",
    overflowY: "auto" as const,
  },
  inspectorHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: "16px",
    borderBottom: "1px solid #1e293b",
    paddingBottom: "12px",
  },
  inspectorTitle: {
    margin: "0 0 4px 0",
    fontSize: "22px",
    color: "#f8fafc",
  },
  inspectorSub: {
    fontSize: "12px",
    color: "#94a3b8",
  },
  radarCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "14px",
    marginBottom: "16px",
  },
  cardHeader: {
    margin: "0 0 10px 0",
    fontSize: "13px",
    color: "#38bdf8",
    fontWeight: 600,
  },
  radarRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    fontSize: "11px",
    marginBottom: "8px",
  },
  progressBarBg: {
    width: "140px",
    height: "6px",
    backgroundColor: "#1e293b",
    borderRadius: "3px",
    overflow: "hidden",
  },
  progressBarFill: (pct: number, color: string) => ({
    width: `${Math.min(100, Math.max(0, pct))}%`,
    height: "100%",
    backgroundColor: color,
  }),
  detailGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "12px",
    marginBottom: "16px",
  },
  detailCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
    lineHeight: "1.6",
  },
  directiveCard: {
    backgroundColor: "rgba(239, 68, 68, 0.05)",
    border: "1px solid rgba(239, 68, 68, 0.3)",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
    marginBottom: "16px",
  },
  directiveRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "4px 0",
    borderBottom: "1px dashed rgba(239, 68, 68, 0.15)",
  },
  forensicCard: {
    backgroundColor: "#070b14",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "12px",
    fontSize: "12px",
  },
  forensicRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px",
  },
  forensicResult: {
    marginTop: "8px",
    padding: "8px",
    backgroundColor: "#0d1527",
    borderRadius: "4px",
    fontSize: "11px",
    color: "#38bdf8",
    border: "1px solid #1e293b",
  },
  actionBtnSmall: {
    padding: "4px 8px",
    borderRadius: "4px",
    backgroundColor: "#38bdf8",
    color: "#0f172a",
    fontSize: "11px",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  },
  dnsBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "16px",
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderRadius: "6px",
    border: "1px solid #1e293b",
    fontSize: "12px",
    color: "#cbd5e1",
    alignItems: "center",
    marginBottom: "16px",
  },
  dnsLabel: {
    fontWeight: 600,
    color: "#38bdf8",
  },
  toolsBar: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "16px",
    alignItems: "center",
    marginBottom: "20px",
  },
  toolItem: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
  },
  viewToggleGroup: {
    marginLeft: "auto",
    display: "flex",
    gap: "8px",
  },
  actionBtn: {
    padding: "8px 14px",
    borderRadius: "6px",
    backgroundColor: "#38bdf8",
    color: "#0f172a",
    fontSize: "12px",
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
  },
  toggleBtn: (active: boolean) => ({
    padding: "6px 12px",
    borderRadius: "6px",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "#38bdf8" : "#1e293b",
    color: active ? "#0f172a" : "#94a3b8",
    border: "none",
  }),
  input: {
    padding: "8px 12px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    color: "#f1f5f9",
    fontSize: "12px",
    outline: "none",
  },
  toolResult: {
    fontSize: "12px",
    color: "#38bdf8",
    backgroundColor: "#0d1527",
    padding: "6px 10px",
    borderRadius: "4px",
    border: "1px solid #1e293b",
  },
  renderedHtml: {
    backgroundColor: "#0d1527",
    padding: "24px",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    lineHeight: 1.6,
  },
  rawMarkdown: {
    backgroundColor: "#0d1527",
    padding: "24px",
    borderRadius: "8px",
    border: "1px solid #1e293b",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    fontSize: "13px",
    overflowX: "auto" as const,
    whiteSpace: "pre-wrap" as const,
  },
  loading: {
    padding: "48px",
    textAlign: "center" as const,
    color: "#94a3b8",
  },
  footer: {
    padding: "16px 24px",
    borderTop: "1px solid #1e293b",
    backgroundColor: "#0d1527",
    fontSize: "12px",
    color: "#64748b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  terminalContainer: {
    backgroundColor: "#060913",
    border: "1px solid #1e293b",
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column" as const,
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5)",
    overflow: "hidden",
  },
  terminalBar: {
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderBottom: "1px solid #1e293b",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  terminalWindowButtons: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  terminalDot: (color: string) => ({
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    backgroundColor: color,
    display: "inline-block",
  }),
  terminalTitle: {
    fontSize: "12px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    color: "#94a3b8",
    fontWeight: 600,
    marginLeft: "6px",
  },
  terminalChips: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
    padding: "8px 16px",
    backgroundColor: "#090e1c",
    borderBottom: "1px solid #1e293b",
  },
  terminalChip: {
    padding: "3px 8px",
    borderRadius: "4px",
    fontSize: "11px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    backgroundColor: "rgba(56, 189, 248, 0.1)",
    border: "1px solid rgba(56, 189, 248, 0.25)",
    color: "#38bdf8",
    cursor: "pointer",
  },
  terminalBody: {
    padding: "16px",
    minHeight: "480px",
    maxHeight: "600px",
    overflowY: "auto" as const,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.5",
    color: "#f8fafc",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    backgroundColor: "#060913",
  },
  terminalEntry: {
    marginBottom: "16px",
  },
  terminalPromptLine: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "6px",
    color: "#4ade80",
    fontWeight: 600,
  },
  terminalMeta: {
    color: "#64748b",
    fontSize: "10px",
  },
  terminalOutput: {
    paddingLeft: "8px",
    borderLeft: "2px solid rgba(56, 189, 248, 0.2)",
  },
  terminalInputBar: {
    display: "flex",
    alignItems: "center",
    padding: "10px 16px",
    backgroundColor: "#0d1527",
    borderTop: "1px solid #1e293b",
    gap: "10px",
  },
  terminalPromptSymbol: {
    color: "#4ade80",
    fontWeight: 700,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  terminalInput: {
    flex: 1,
    backgroundColor: "transparent",
    border: "none",
    outline: "none",
    color: "#f8fafc",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: "13px",
  },
  terminalKeyLegend: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "14px",
    padding: "6px 16px",
    backgroundColor: "#070c18",
    borderTop: "1px solid #1e293b",
    fontSize: "11px",
    color: "#64748b",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  kbd: {
    padding: "1px 5px",
    borderRadius: "3px",
    backgroundColor: "#1e293b",
    border: "1px solid #334155",
    color: "#38bdf8",
    fontSize: "10px",
    fontWeight: 600,
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "6px",
    padding: "0 10px",
    flex: "1 1 320px",
  },
  searchIcon: {
    color: "#64748b",
    marginRight: "6px",
    fontSize: "14px",
  },
  tierFilterGroup: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: "6px",
  },
  filterPill: (active: boolean) => ({
    padding: "6px 12px",
    borderRadius: "16px",
    fontSize: "11px",
    fontWeight: 600,
    cursor: "pointer",
    backgroundColor: active ? "rgba(56, 189, 248, 0.2)" : "#0d1527",
    color: active ? "#38bdf8" : "#94a3b8",
    border: `1px solid ${active ? "#38bdf8" : "#1e293b"}`,
    transition: "all 0.15s ease",
  }),
  tableCard: {
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "16px",
    overflow: "hidden",
    minWidth: 0,
  },
  tableHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "12px",
  },
  tableTitle: {
    margin: 0,
    fontSize: "15px",
    fontWeight: 700,
    color: "#f8fafc",
  },
  tableScroll: {
    overflowX: "auto" as const,
    minWidth: 0,
  },
  custLogin: {
    fontWeight: 700,
    color: "#38bdf8",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  },
  wagerBadge: (
    tier: string,
    dynamic?: Record<string, { fg: string; bg: string; border: string }> | null,
  ): React.CSSProperties => {
    if (dynamic && tier in dynamic) {
      const t = dynamic[tier]!;
      return {
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        whiteSpace: "nowrap",
        color: t.fg,
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
      };
    }
    return wagerBadge(tier);
  },
  wagerRow: (selected: boolean) => ({
    cursor: "pointer",
    backgroundColor: selected ? "rgba(56, 189, 248, 0.08)" : "transparent",
    borderLeft: selected ? "3px solid #38bdf8" : "3px solid transparent",
    transition: "background-color 0.15s ease",
  }),
  wagerInspectorCard: {
    marginTop: "20px",
    backgroundColor: "#0d1527",
    border: "1px solid #1e293b",
    borderRadius: "8px",
    padding: "20px",
  },
};
