/**
 * @file format.ts
 * @description Compact number formatting for aggregate CLI tables (`nFormatter` in util.js).
 */

const UNITS = [
  { value: 1, symbol: "" },
  { value: 1e3, symbol: "K" },
  { value: 1e6, symbol: "M" },
  { value: 1e9, symbol: "G" },
  { value: 1e12, symbol: "T" },
  { value: 1e15, symbol: "P" },
  { value: 1e18, symbol: "E" },
] as const;

/** `612750` → `613K`, `1500000` → `2M`, `58` → `58`. */
export function nFormatter(value: number): string {
  if (!Number.isFinite(value)) return "";
  let index = 0;
  if (value >= 1e5) {
    for (index = UNITS.length - 1; index > 0; index--) {
      if (value >= UNITS[index]!.value) break;
    }
  }
  const scaled = Number((value / UNITS[index]!.value).toFixed(0));
  return `${scaled.toLocaleString("en-US")}${UNITS[index]!.symbol}`;
}
