/**
 * @file src/dashboard/ansi.ts
 * @description Client-side ANSI parser & React renderer for Terminal Emulator.
 */

import React from "react";
import { rewriteBrokenDeskUrl } from "./links.ts";

export interface AnsiSegment {
  readonly text: string;
  readonly color?: string | undefined;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly underline?: boolean | undefined;
  readonly strikethrough?: boolean | undefined;
  readonly linkUrl?: string | undefined;
}

const ANSI_COLOR_MAP: Record<number, string> = {
  30: "#64748b",
  31: "#f87171",
  32: "#4ade80",
  33: "#fbbf24",
  34: "#60a5fa",
  35: "#c084fc",
  36: "#38bdf8",
  37: "#f8fafc",
  90: "#94a3b8",
  91: "#ef4444",
  92: "#22c55e",
  93: "#f59e0b",
  94: "#3b82f6",
  95: "#a855f7",
  96: "#06b6d4",
  97: "#ffffff",
};

const ANSI_BG_MAP: Record<number, string> = {
  40: "#0f172a",
  41: "rgba(239, 68, 68, 0.2)",
  42: "rgba(34, 197, 94, 0.2)",
  43: "rgba(245, 158, 11, 0.2)",
  44: "rgba(59, 130, 246, 0.2)",
  45: "rgba(168, 85, 247, 0.2)",
  46: "rgba(6, 182, 212, 0.2)",
  47: "#e2e8f0",
  100: "#1e293b",
};

/**
 * Convert an xterm-256 palette index (0..255) emitted by `Bun.markdown.ansi`
 * (e.g. `38;5;215` / `48;5;236` for dark inline code or `38;5;124` / `48;5;254`
 * for `AnsiTheme.light: true`) into a CSS color string.
 */
export function ansi256ToCss(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 8) return ANSI_COLOR_MAP[30 + index];
  if (index < 16) return ANSI_COLOR_MAP[90 + (index - 8)];
  if (index < 232) {
    const cube = index - 16;
    const rIdx = Math.floor(cube / 36);
    const gIdx = Math.floor((cube % 36) / 6);
    const bIdx = cube % 6;
    const chan = (v: number): number => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${chan(rIdx)}, ${chan(gIdx)}, ${chan(bIdx)})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

/* eslint-disable no-control-regex */
export function parseAnsiTokens(raw: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  // eslint-disable-next-line no-control-regex -- ANSI and OSC 8 sequences require control characters
  const tokenRegex =
    /\x1b]8;[a-zA-Z0-9;=]*;([^\x1b\x07]*)(?:\x1b\\|\x07)|\x1b\[([0-9;]*)m/g;

  let lastIndex = 0;
  let currentColor: string | undefined;
  let currentBg: string | undefined;
  let currentBold = false;
  let currentDim = false;
  let currentItalic = false;
  let currentUnderline = false;
  let currentStrikethrough = false;
  let currentLinkUrl: string | undefined;

  const pushText = (text: string): void => {
    if (text.length === 0) return;
    segments.push({
      text,
      color: currentLinkUrl ? (currentColor ?? "#38bdf8") : currentColor,
      bg: currentBg,
      bold: currentBold,
      dim: currentDim,
      ...(currentItalic ? { italic: true } : {}),
      underline: currentLinkUrl ? true : currentUnderline,
      ...(currentStrikethrough ? { strikethrough: true } : {}),
      ...(currentLinkUrl ? { linkUrl: currentLinkUrl } : {}),
    });
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      pushText(raw.slice(lastIndex, match.index));
    }

    if (match[1] !== undefined) {
      currentLinkUrl = match[1].length > 0 ? match[1] : undefined;
    } else if (match[2] !== undefined) {
      const paramStr = match[2];
      const codes =
        paramStr === ""
          ? [0]
          : paramStr
              .split(";")
              .filter((c, idx, arr) => !(idx === arr.length - 1 && c === ""))
              .map((c) => (c === "" ? 0 : Number.parseInt(c, 10)));
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) {
          currentColor = undefined;
          currentBg = undefined;
          currentBold = false;
          currentDim = false;
          currentItalic = false;
          currentUnderline = false;
          currentStrikethrough = false;
        } else if (code === 39) {
          currentColor = undefined;
        } else if (code === 49) {
          currentBg = undefined;
        } else if (code === 1) {
          currentBold = true;
        } else if (code === 2) {
          currentDim = true;
        } else if (code === 3) {
          currentItalic = true;
        } else if (code === 4) {
          currentUnderline = true;
        } else if (code === 9) {
          currentStrikethrough = true;
        } else if (code === 22) {
          currentBold = false;
          currentDim = false;
        } else if (code === 23) {
          currentItalic = false;
        } else if (code === 24) {
          currentUnderline = false;
        } else if (code === 29) {
          currentStrikethrough = false;
        } else if (
          code === 38 &&
          codes[i + 1] === 5 &&
          codes[i + 2] !== undefined
        ) {
          currentColor = ansi256ToCss(codes[i + 2]!);
          i += 2;
        } else if (
          code === 48 &&
          codes[i + 1] === 5 &&
          codes[i + 2] !== undefined
        ) {
          currentBg = ansi256ToCss(codes[i + 2]!);
          i += 2;
        } else if (
          code === 38 &&
          codes[i + 1] === 2 &&
          codes[i + 4] !== undefined
        ) {
          // ANSI 24-bit TrueColor foreground: 38;2;r;g;b
          const r = codes[i + 2]!;
          const g = codes[i + 3]!;
          const b = codes[i + 4]!;
          currentColor = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        } else if (
          code === 48 &&
          codes[i + 1] === 2 &&
          codes[i + 4] !== undefined
        ) {
          // ANSI 24-bit TrueColor background: 48;2;r;g;b
          const r = codes[i + 2]!;
          const g = codes[i + 3]!;
          const b = codes[i + 4]!;
          currentBg = `rgb(${r}, ${g}, ${b})`;
          i += 4;
        } else if (code >= 30 && code <= 37) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code >= 40 && code <= 47) {
          currentBg = ANSI_BG_MAP[code];
        } else if (code >= 90 && code <= 97) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code >= 100 && code <= 107) {
          currentBg = ANSI_BG_MAP[code];
        }
      }
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < raw.length) {
    pushText(raw.slice(lastIndex));
  }

  return segments;
}

export function renderAnsiReact(raw: string): React.ReactNode[] {
  const segments = parseAnsiTokens(raw);
  return segments.map((seg, i) => {
    const style: React.CSSProperties = {};
    if (seg.color) style.color = seg.color;
    if (seg.bg) style.backgroundColor = seg.bg;
    if (seg.bold) style.fontWeight = 700;
    if (seg.dim) style.opacity = 0.75;
    if (seg.italic) style.fontStyle = "italic";
    if (seg.underline && seg.strikethrough) {
      style.textDecoration = "underline line-through";
    } else if (seg.underline) {
      style.textDecoration = "underline";
    } else if (seg.strikethrough) {
      style.textDecoration = "line-through";
    }

    if (seg.linkUrl) {
      return (
        <a
          key={i}
          href={rewriteBrokenDeskUrl(seg.linkUrl)}
          target="_blank"
          rel="noreferrer"
          style={{ ...style, cursor: "pointer" }}
        >
          {seg.text}
        </a>
      );
    }

    return (
      <span key={i} style={style}>
        {seg.text}
      </span>
    );
  });
}
