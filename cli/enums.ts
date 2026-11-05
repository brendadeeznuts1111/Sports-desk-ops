/**
 * @file enums.ts
 * @description Small label helpers that are not part of the line/ticker parser: wager status
 * (`getWagerStatus` in the portal) and the L-key mapping for it.
 */
import { t, type LangArg, type UiTable } from "./i18n.ts";

export const WAGER_STATUS_LABEL: Readonly<Record<string, string>> = {
  W: "Won",
  L: "Lost",
  X: "Cancelled/Pushed",
  P: "Pending",
};

const WAGER_STATUS_KEY: Readonly<Record<string, string>> = {
  W: "L-223",
  L: "L-222",
  P: "L-233",
};

/** `W` → Won, `L` → Lost, `X` → Cancelled/Pushed, unknown/empty → Pending. */
export function wagerStatusLabel(
  code: string | null,
  lang: LangArg = "ENGLISH",
  table?: UiTable,
): string {
  if (code === null || code.trim() === "") return t("L-233", lang, table);
  const key = code.trim().toUpperCase();
  const lkey = WAGER_STATUS_KEY[key];
  if (lkey !== undefined) return t(lkey, lang, table);
  return WAGER_STATUS_LABEL[key] ?? code;
}
