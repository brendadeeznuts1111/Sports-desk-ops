/**
 * @file settings_prefs.ts
 * @description The portal Settings modal's four preferences, validated.
 *
 * Source: the portal's `#update-settings` modal — Wager Alerts (`Y`/`N` + a separate Wager
 * Alert Settings screen), Language (English / Spanish / Chinese (Simp) / French), Time Zone
 * (`0`–`3` = EST/CST/MST/PST), and Agent Menu (Left Menu / Tile Menu).
 *
 * What each one actually does in this repository is stated per field, because storing a
 * preference that changes nothing is how a settings panel starts lying. `language` is the only
 * one that does not alter the UI beyond `<html lang>`; there are no translated strings yet.
 */

export const SETTINGS_STORAGE_KEY = "sportsdesk-dashboard-settings";

export const NOTIFY_FLAGS = [
  { value: "Y", label: "On" },
  { value: "N", label: "Off" },
] as const;

export const LANGUAGES = [
  { value: "English", label: "English", lang: "en" },
  { value: "Spanish", label: "Spanish", lang: "es" },
  { value: "Chinese (Simp)", label: "Chinese (Simp)", lang: "zh-Hans" },
  { value: "French", label: "French", lang: "fr" },
] as const;

/** Portal timezone codes, in the modal's own order, with their UTC offsets in hours. */
export const TIMEZONES = [
  { value: "0", label: "(EST)", offsetHours: -5 },
  { value: "1", label: "(CST)", offsetHours: -6 },
  { value: "2", label: "(MST)", offsetHours: -7 },
  { value: "3", label: "(PST)", offsetHours: -8 },
] as const;

export const AGENT_MENUS = [
  { value: "Left Menu", label: "Left Menu" },
  { value: "Tile Menu", label: "Tile Menu" },
] as const;

export type NotifyFlag = (typeof NOTIFY_FLAGS)[number]["value"];
export type Language = (typeof LANGUAGES)[number]["value"];
export type TimezoneCode = (typeof TIMEZONES)[number]["value"];
export type AgentMenu = (typeof AGENT_MENUS)[number]["value"];

export interface DashboardSettings {
  readonly notify: NotifyFlag;
  readonly language: Language;
  readonly timezone: TimezoneCode;
  readonly agentMenu: AgentMenu;
}

export const DEFAULT_SETTINGS: DashboardSettings = {
  notify: "Y",
  language: "English",
  timezone: "1",
  agentMenu: "Left Menu",
};

function pick<T extends string>(
  options: readonly { readonly value: T }[],
  value: unknown,
  fallback: T,
): T {
  const raw = typeof value === "string" ? value.trim() : "";
  return options.some((option) => option.value === raw) ? (raw as T) : fallback;
}

/** Validates a stored or posted settings blob; unknown values fall back, never throw. */
export function readSettings(payload: unknown): DashboardSettings {
  if (typeof payload !== "object" || payload === null) return DEFAULT_SETTINGS;
  const record = payload as Record<string, unknown>;
  return {
    notify: pick(NOTIFY_FLAGS, record.notify, DEFAULT_SETTINGS.notify),
    language: pick(LANGUAGES, record.language, DEFAULT_SETTINGS.language),
    timezone: pick(TIMEZONES, record.timezone, DEFAULT_SETTINGS.timezone),
    agentMenu: pick(AGENT_MENUS, record.agentMenu, DEFAULT_SETTINGS.agentMenu),
  };
}

export function timezoneOffsetHours(code: TimezoneCode): number {
  return (
    TIMEZONES.find((zone) => zone.value === code)?.offsetHours ??
    TIMEZONES[0].offsetHours
  );
}

export function languageTag(language: Language): string {
  return (
    LANGUAGES.find((entry) => entry.value === language)?.lang ??
    LANGUAGES[0].lang
  );
}

/**
 * Renders an instant in the selected portal timezone.
 *
 * The portal's codes are fixed UTC offsets (EST −5 … PST −8), not IANA zones, so this shifts
 * the clock by a constant. That means it is correct for the season the offset describes and
 * does not follow US daylight saving — the portal's own selector has the same limitation.
 */
export function formatInTimezone(
  iso: string | null | undefined,
  code: TimezoneCode,
  options?: { readonly withDate?: boolean },
): string {
  if (iso === null || iso === undefined || iso === "") return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "";

  const shifted = new Date(
    parsed.getTime() + timezoneOffsetHours(code) * 60 * 60 * 1000,
  );
  const zone = TIMEZONES.find((entry) => entry.value === code);
  const time = shifted.toISOString().slice(11, 19);
  const date = shifted.toISOString().slice(0, 10);
  const label = zone?.label ?? "";

  return options?.withDate === false
    ? `${time} ${label}`.trim()
    : `${date} ${time} ${label}`.trim();
}

/** What each preference changes in this dashboard, for the settings panel to show. */
export const SETTINGS_EFFECTS: Readonly<
  Record<keyof DashboardSettings, string>
> = {
  notify:
    "Shows or hides the Telegram alert buttons on watchlist accounts. Sending still needs the admin token.",
  language:
    "Sets the document language only. No strings are translated yet, so the UI stays in English.",
  timezone:
    "Shifts every timestamp this dashboard renders (capture, observation and extraction times).",
  agentMenu:
    "Switches the panel layout between a single column (Left Menu) and a tile grid (Tile Menu).",
};
