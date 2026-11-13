/**
 * @file lib/wager_tokens.ts
 * @description Design tokens, TrueColor ANSI encoders, and precomputed styles for Wager Tiers.
 *
 * Provides a single source of truth for:
 * 1. UI React CSSProperties badges (zero-allocation render loop)
 * 2. Terminal PTY ANSI 24-bit TrueColor SGR escape sequences via Bun.color
 * 3. Bun.markdown.render() element callbacks gated by Bun.enableANSIColors
 */

import type { CSSProperties } from "react";

export type WagerTier =
  | "ORIGINATOR_HIGH_RISK"
  | "STEAM_MOVE"
  | "LATENCY_ARB"
  | "BASELINE"
  | "CRITICAL"
  | "STEAM"
  | "LATENCY"
  | "RECREATIONAL";

export const SURFACE = {
  panel: "#0d1527",
  border: "#1e293b",
  text: "#f1f5f9", // canonical; fixed drift from #f8fafc
  muted: "#94a3b8",
  accent: "#38bdf8",
} as const;

/**
 * Composite an alpha foreground color over an opaque backdrop to produce solid hex.
 * Uses Bun.color when running in Bun runtime; falls back to pure-TS hex math in browser.
 */
export const composite = (fg: string, a: number, bg: string): string => {
  const parseHex = (hex: string) => {
    const clean = hex.startsWith("#") ? hex.slice(1) : hex;
    const n = Number.parseInt(clean, 16);
    return Number.isNaN(n)
      ? null
      : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };

  let F: { r: number; g: number; b: number } | null = null;
  let B: { r: number; g: number; b: number } | null = null;

  try {
    if (typeof Bun !== "undefined" && typeof Bun.color === "function") {
      F = Bun.color(fg, "{rgb}") as { r: number; g: number; b: number } | null;
      B = Bun.color(bg, "{rgb}") as { r: number; g: number; b: number } | null;
    }
  } catch {
    // Fail through to pure-TS hex parser
  }

  if (!F) F = parseHex(fg);
  if (!B) B = parseHex(bg);

  if (!F || !B) return fg; // fail open — slightly off color is better than a crash
  const mix = (f: number, b: number) =>
    Math.round(f * a + b * (1 - a))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(F.r, B.r)}${mix(F.g, B.g)}${mix(F.b, B.b)}`;
};

/**
 * Solid hex tier tokens composited against SURFACE.panel (#0d1527).
 * Written as literal hex constants for zero runtime CPU overhead and 100% browser bundle safety.
 */
export const TIER = {
  ORIGINATOR_HIGH_RISK: {
    fg: "#f87171",
    bg: "#302332", // composite("#f87171", 0.15, SURFACE.panel)
    border: "#ef4444",
  },
  STEAM_MOVE: {
    fg: "#f59e0b", // canonical; fixed drift from #fb923c
    bg: "#31282a", // composite("#f59e0b", 0.15, SURFACE.panel)
    border: "#f59e0b",
  },
  LATENCY_ARB: {
    fg: "#c084fc",
    bg: "#282647", // composite("#c084fc", 0.15, SURFACE.panel)
    border: "#c084fc",
  },
  BASELINE: {
    fg: "#4ade80",
    bg: "#163334", // composite("#4ade80", 0.15, SURFACE.panel)
    border: "#22c55e",
  },
  // Backward-compatibility aliases for v2 tier keys
  CRITICAL: {
    fg: "#f87171",
    bg: "#302332",
    border: "#ef4444",
  },
  STEAM: {
    fg: "#f59e0b",
    bg: "#31282a",
    border: "#f59e0b",
  },
  LATENCY: {
    fg: "#c084fc",
    bg: "#282647",
    border: "#c084fc",
  },
  RECREATIONAL: {
    fg: "#4ade80",
    bg: "#163334",
    border: "#22c55e",
  },
} as const satisfies Record<
  WagerTier,
  { fg: string; bg: string; border: string }
>;

export const DEFAULT_TIER = {
  fg: "#94a3b8",
  bg: "#1b2336", // composite("#94a3b8", 0.1, SURFACE.panel)
  border: "#334155",
} as const;

export const BADGE_BASE: CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: "4px",
  fontSize: "11px",
  fontWeight: 600,
  whiteSpace: "nowrap",
};

/** Precomputed once — safe to reuse across every row and live re-render without GC churn */
export const WAGER_BADGE: Record<WagerTier, CSSProperties> = {
  ORIGINATOR_HIGH_RISK: {
    ...BADGE_BASE,
    color: TIER.ORIGINATOR_HIGH_RISK.fg,
    backgroundColor: TIER.ORIGINATOR_HIGH_RISK.bg,
    border: `1px solid ${TIER.ORIGINATOR_HIGH_RISK.border}`,
  },
  STEAM_MOVE: {
    ...BADGE_BASE,
    color: TIER.STEAM_MOVE.fg,
    backgroundColor: TIER.STEAM_MOVE.bg,
    border: `1px solid ${TIER.STEAM_MOVE.border}`,
  },
  LATENCY_ARB: {
    ...BADGE_BASE,
    color: TIER.LATENCY_ARB.fg,
    backgroundColor: TIER.LATENCY_ARB.bg,
    border: `1px solid ${TIER.LATENCY_ARB.border}`,
  },
  BASELINE: {
    ...BADGE_BASE,
    color: TIER.BASELINE.fg,
    backgroundColor: TIER.BASELINE.bg,
    border: `1px solid ${TIER.BASELINE.border}`,
  },
  // Backward compatibility
  CRITICAL: {
    ...BADGE_BASE,
    color: TIER.CRITICAL.fg,
    backgroundColor: TIER.CRITICAL.bg,
    border: `1px solid ${TIER.CRITICAL.border}`,
  },
  STEAM: {
    ...BADGE_BASE,
    color: TIER.STEAM.fg,
    backgroundColor: TIER.STEAM.bg,
    border: `1px solid ${TIER.STEAM.border}`,
  },
  LATENCY: {
    ...BADGE_BASE,
    color: TIER.LATENCY.fg,
    backgroundColor: TIER.LATENCY.bg,
    border: `1px solid ${TIER.LATENCY.border}`,
  },
  RECREATIONAL: {
    ...BADGE_BASE,
    color: TIER.RECREATIONAL.fg,
    backgroundColor: TIER.RECREATIONAL.bg,
    border: `1px solid ${TIER.RECREATIONAL.border}`,
  },
};

/** Safe fallback accessor for dynamic tier strings */
export function wagerBadge(tier: string): CSSProperties {
  if (tier in WAGER_BADGE) {
    return WAGER_BADGE[tier as WagerTier];
  }
  return {
    ...BADGE_BASE,
    color: DEFAULT_TIER.fg,
    backgroundColor: DEFAULT_TIER.bg,
    border: `1px solid ${DEFAULT_TIER.border}`,
  };
}

/** Convert a CSS hex string into an ANSI 24-bit TrueColor SGR escape code */
export function hexToSgr(hex: string, isBg = false): string {
  if (typeof Bun !== "undefined" && Bun.color) {
    const ansi = Bun.color(hex, "ansi-16m");
    if (ansi) return isBg ? ansi.replace("\x1b[38;", "\x1b[48;") : ansi;
  }
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  const n = Number.parseInt(clean, 16);
  if (Number.isNaN(n)) return "";
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const code = isBg ? 48 : 38;
  return `\x1b[${code};2;${r};${g};${b}m`;
}
