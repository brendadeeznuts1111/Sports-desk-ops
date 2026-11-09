/**
 * @file src/dashboard/ansi.ts
 * @description Client-side ANSI parser & React renderer for Terminal Emulator.
 */

import React from "react";

export interface AnsiSegment {
  readonly text: string;
  readonly color?: string | undefined;
  readonly bg?: string | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly underline?: boolean | undefined;
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

/* eslint-disable no-control-regex */
export function parseAnsiTokens(raw: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  // eslint-disable-next-line no-control-regex -- ANSI and OSC 8 sequences require control characters
  const tokenRegex =
    /\x1b]8;[^\x1b\\]*(?:\x1b\\|\x07)([^\x1b]*)\x1b]8;;\x1b\\|\x1b\[([0-9;]*)m/g;

  let lastIndex = 0;
  let currentColor: string | undefined;
  let currentBg: string | undefined;
  let currentBold = false;
  let currentDim = false;
  let currentUnderline = false;

  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      const text = raw.slice(lastIndex, match.index);
      if (text.length > 0) {
        segments.push({
          text,
          color: currentColor,
          bg: currentBg,
          bold: currentBold,
          dim: currentDim,
          underline: currentUnderline,
        });
      }
    }

    if (match[1] !== undefined) {
      const full = match[0];
      // eslint-disable-next-line no-control-regex -- OSC 8 URL extraction requires control characters
      const urlMatch = /\x1b]8;[a-zA-Z0-9;=]*;([^\x1b\x07]+)/.exec(full);
      segments.push({
        text: match[1],
        color: "#38bdf8",
        underline: true,
        linkUrl: urlMatch?.[1],
      });
    } else if (match[2] !== undefined) {
      const codes = match[2]
        .split(";")
        .map((c) => (c === "" ? 0 : Number.parseInt(c, 10)));
      for (const code of codes) {
        if (code === 0) {
          currentColor = undefined;
          currentBg = undefined;
          currentBold = false;
          currentDim = false;
          currentUnderline = false;
        } else if (code === 1) {
          currentBold = true;
        } else if (code === 2) {
          currentDim = true;
        } else if (code === 4) {
          currentUnderline = true;
        } else if (code === 22) {
          currentBold = false;
          currentDim = false;
        } else if (code === 24) {
          currentUnderline = false;
        } else if (code >= 30 && code <= 37) {
          currentColor = ANSI_COLOR_MAP[code];
        } else if (code === 39) {
          currentColor = undefined;
        } else if (code >= 40 && code <= 47) {
          currentBg = ANSI_BG_MAP[code];
        } else if (code === 49) {
          currentBg = undefined;
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
    const text = raw.slice(lastIndex);
    if (text.length > 0) {
      segments.push({
        text,
        color: currentColor,
        bg: currentBg,
        bold: currentBold,
        dim: currentDim,
        underline: currentUnderline,
      });
    }
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
    if (seg.underline) style.textDecoration = "underline";

    if (seg.linkUrl) {
      return (
        <a
          key={i}
          href={seg.linkUrl}
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
