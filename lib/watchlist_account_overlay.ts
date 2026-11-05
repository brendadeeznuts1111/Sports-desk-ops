/**
 * @file lib/watchlist_account_overlay.ts
 * @description Operator-managed watchlist account overlay.
 *
 * WHY THIS EXISTS
 *
 * The watchlist registry (`lib/gslive_manager_watchlist.ts`) is a hard-coded array. The
 * autobet signal engine only derives signals from accounts in that registry, so "watch this
 * account" used to require editing TypeScript source — and the captures show real customer
 * logins, which must not be committed into tracked code.
 *
 * This module keeps the code-defined registry as the immutable base and adds an operator
 * overlay in an untracked JSON file (`config/watchlist-accounts.json`, gitignored). The
 * autobet pipeline merges base + overlay when it derives signals; every other consumer of
 * the base registry is unchanged. A missing overlay is an empty overlay, never an error.
 *
 * SAFETY
 *
 * This module only records WHO the operator wants to watch. It does not gate, queue or
 * execute anything: the existing autobet gates still decide whether a signal is eligible,
 * the operator still approves every intent, and there is still no live order path.
 */

import { rename } from "node:fs/promises";
import { resolve } from "node:path";

import { isRecordValue } from "./zod_guards.ts";

import {
  buildGsLiveManagerUrls,
  getUnifiedWatchlistRegistry,
  type WatchlistUnifiedEntry,
} from "./gslive_manager_watchlist.ts";

/** Overlay path relative to the repo root. Gitignored: it holds operator-chosen logins. */
export const WATCHLIST_ACCOUNT_OVERLAY_REL_PATH =
  "config/watchlist-accounts.json";

export const WATCHLIST_ACCOUNT_SCHEMA_VERSION = 1 as const;

/** The closed source-category vocabulary shared with `WatchlistUnifiedEntry`. */
export const WATCHLIST_ACCOUNT_CATEGORIES = [
  "POLY_ONCHAIN_CTF_WHALE",
  "POLY_PARLAY_SYNDICATE",
  "SUBNET_BRIDGED_SHARP",
  "SIX_GATE_BET1_DISCOVERY",
  "INTERNAL_F402_SHARP",
  "FUNDING_DISTRIBUTOR_ROOT",
] as const;

export type WatchlistAccountCategory =
  (typeof WATCHLIST_ACCOUNT_CATEGORIES)[number];

/**
 * Default category for an operator-discovered account: it is the desk's own F402 customer
 * seen in the captures, not a proven on-chain whale. Labelling it honestly keeps the
 * engine's confidence weighting (`INTERNAL_F402_SHARP` = 30) truthful.
 */
export const DEFAULT_WATCHLIST_ACCOUNT_CATEGORY: WatchlistAccountCategory =
  "INTERNAL_F402_SHARP";

export type WatchlistOverlayErrorCode =
  | "overlay_invalid"
  | "overlay_unreadable"
  | "account_invalid"
  | "account_exists"
  | "account_not_found"
  | "account_read_only";

export class WatchlistOverlayError extends Error {
  readonly code: WatchlistOverlayErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: WatchlistOverlayErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "WatchlistOverlayError";
    this.code = code;
    this.details = details;
  }
}

export interface WatchlistOverlayAccount {
  readonly login: string;
  readonly agentId: string;
  readonly sourceCategory: WatchlistAccountCategory;
  readonly archetype: string;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly note: string;
}

export interface WatchlistAccountOverlay {
  readonly path: string;
  readonly exists: boolean;
  readonly schemaVersion: typeof WATCHLIST_ACCOUNT_SCHEMA_VERSION;
  readonly accounts: readonly WatchlistOverlayAccount[];
}

export interface WatchlistAccountCounts {
  readonly base: number;
  readonly overlay: number;
  readonly total: number;
}

/** One row in the operator-facing account list. `inBase` rows are read-only. */
export interface WatchlistAccountRow {
  readonly login: string;
  readonly agentId: string;
  readonly sourceCategory: string;
  readonly archetype: string;
  readonly addedAt: string | null;
  readonly addedBy: string | null;
  readonly note: string | null;
  readonly inBase: boolean;
}

export interface WatchlistAccountListing {
  readonly path: string;
  readonly exists: boolean;
  readonly counts: WatchlistAccountCounts;
  readonly accounts: readonly WatchlistAccountRow[];
}

const LOGIN_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,31}$/u;
const AGENT_PATTERN = /^[A-Z0-9][A-Z0-9_. :-]{0,63}$/u;

/** `player_CCC107` and `ccc107` both normalize to `CCC107`. */
export function normalizeAccountLogin(input: string): string {
  return input
    .trim()
    .replace(/^player_/iu, "")
    .toUpperCase();
}

export function isWatchlistAccountCategory(
  value: unknown,
): value is WatchlistAccountCategory {
  return (
    typeof value === "string" &&
    (WATCHLIST_ACCOUNT_CATEGORIES as readonly string[]).includes(value)
  );
}

function requireLogin(input: unknown, field: string): string {
  if (typeof input !== "string") {
    throw new WatchlistOverlayError(
      "account_invalid",
      `${field} must be a string`,
    );
  }
  const login = normalizeAccountLogin(input);
  if (login === "") {
    throw new WatchlistOverlayError("account_invalid", `${field} is empty`);
  }
  if (!LOGIN_PATTERN.test(login)) {
    throw new WatchlistOverlayError(
      "account_invalid",
      `${field} is not a valid customer login (letters, digits, _ . -; max 32)`,
      { value: login },
    );
  }
  return login;
}

function requireAgentId(input: unknown): string {
  if (typeof input !== "string") {
    throw new WatchlistOverlayError(
      "account_invalid",
      "agentId must be a string",
    );
  }
  const agentId = input.trim().toUpperCase();
  if (agentId === "") {
    throw new WatchlistOverlayError("account_invalid", "agentId is empty");
  }
  if (!AGENT_PATTERN.test(agentId)) {
    throw new WatchlistOverlayError(
      "account_invalid",
      "agentId is not valid (letters, digits, _ . - : space; max 64)",
      { value: agentId },
    );
  }
  return agentId;
}

function optionalText(input: unknown, max: number): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "string") {
    throw new WatchlistOverlayError("account_invalid", "expected a string");
  }
  const text = input.trim();
  if (text.length > max) {
    throw new WatchlistOverlayError(
      "account_invalid",
      `text exceeds ${max} characters`,
    );
  }
  return text;
}

function parseStoredAccount(
  raw: unknown,
  index: number,
): WatchlistOverlayAccount {
  if (!isRecordValue(raw)) {
    throw new WatchlistOverlayError(
      "overlay_invalid",
      `accounts[${index}] is not an object`,
    );
  }
  const login = requireLogin(raw["login"], `accounts[${index}].login`);
  const agentId = requireAgentId(raw["agentId"] ?? raw["agent"]);
  const category = raw["sourceCategory"];
  if (!isWatchlistAccountCategory(category)) {
    throw new WatchlistOverlayError(
      "overlay_invalid",
      `accounts[${index}].sourceCategory is not a known category`,
      { value: category },
    );
  }
  const addedAt =
    typeof raw["addedAt"] === "string" &&
    !Number.isNaN(Date.parse(raw["addedAt"]))
      ? new Date(raw["addedAt"]).toISOString()
      : null;
  if (addedAt === null) {
    throw new WatchlistOverlayError(
      "overlay_invalid",
      `accounts[${index}].addedAt is not an ISO timestamp`,
    );
  }
  return {
    login,
    agentId,
    sourceCategory: category,
    archetype: optionalText(raw["archetype"], 200),
    addedAt,
    addedBy: optionalText(raw["addedBy"], 120) || "unknown",
    note: optionalText(raw["note"], 500),
  };
}

export interface ParseOverlayResult {
  readonly ok: true;
  readonly accounts: readonly WatchlistOverlayAccount[];
}
export interface ParseOverlayFailure {
  readonly ok: false;
  readonly errors: readonly string[];
}
export type ParseOverlayOutcome = ParseOverlayResult | ParseOverlayFailure;

/** Parse the overlay file body. `{ accounts: [...] }` or a bare array are both accepted. */
export function parseWatchlistAccountOverlay(
  raw: unknown,
): ParseOverlayOutcome {
  let list: unknown;
  let schemaVersion = WATCHLIST_ACCOUNT_SCHEMA_VERSION;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (isRecordValue(raw)) {
    list = raw["accounts"];
    if (raw["schemaVersion"] !== undefined) {
      if (raw["schemaVersion"] !== WATCHLIST_ACCOUNT_SCHEMA_VERSION) {
        return {
          ok: false,
          errors: [
            `schemaVersion ${String(raw["schemaVersion"])} is not supported (expected ${WATCHLIST_ACCOUNT_SCHEMA_VERSION})`,
          ],
        };
      }
      schemaVersion = WATCHLIST_ACCOUNT_SCHEMA_VERSION;
    }
  } else {
    return {
      ok: false,
      errors: [
        "overlay root must be an object with an accounts array or a bare array",
      ],
    };
  }
  void schemaVersion;
  if (!Array.isArray(list)) {
    return { ok: false, errors: ["accounts must be an array"] };
  }
  const accounts: WatchlistOverlayAccount[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < list.length; index += 1) {
    try {
      const account = parseStoredAccount(list[index], index);
      if (seen.has(account.login)) {
        errors.push(`accounts[${index}].login duplicates ${account.login}`);
        continue;
      }
      seen.add(account.login);
      accounts.push(account);
    } catch (error) {
      if (error instanceof WatchlistOverlayError) {
        errors.push(error.message);
      } else {
        errors.push(
          `accounts[${index}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, accounts };
}

/** Absolute overlay path for a repo root. */
export function overlayPathFor(root: string): string {
  return resolve(root, WATCHLIST_ACCOUNT_OVERLAY_REL_PATH);
}

/**
 * Read the overlay. A missing file is `exists: false` with zero accounts; a malformed file
 * throws `overlay_invalid`/`overlay_unreadable` rather than silently dropping accounts.
 */
export async function loadWatchlistAccountOverlay(
  root: string,
): Promise<WatchlistAccountOverlay> {
  const absolute = overlayPathFor(root);
  let text: string;
  try {
    text = await Bun.file(absolute).text();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return {
        path: WATCHLIST_ACCOUNT_OVERLAY_REL_PATH,
        exists: false,
        schemaVersion: WATCHLIST_ACCOUNT_SCHEMA_VERSION,
        accounts: [],
      };
    }
    throw new WatchlistOverlayError(
      "overlay_unreadable",
      `cannot read ${WATCHLIST_ACCOUNT_OVERLAY_REL_PATH}`,
      undefined,
      { cause: error },
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new WatchlistOverlayError(
      "overlay_invalid",
      `${WATCHLIST_ACCOUNT_OVERLAY_REL_PATH} is not valid JSON`,
      undefined,
      { cause: error },
    );
  }
  const parsed = parseWatchlistAccountOverlay(raw);
  if (!parsed.ok) {
    throw new WatchlistOverlayError(
      "overlay_invalid",
      `${WATCHLIST_ACCOUNT_OVERLAY_REL_PATH} is invalid: ${parsed.errors.join("; ")}`,
      { errors: parsed.errors },
    );
  }
  return {
    path: WATCHLIST_ACCOUNT_OVERLAY_REL_PATH,
    exists: true,
    schemaVersion: WATCHLIST_ACCOUNT_SCHEMA_VERSION,
    accounts: parsed.accounts,
  };
}

/**
 * Atomically replace the overlay. `rename` is same-directory, so a reader either sees the old
 * file or the complete new one; a crash mid-write cannot leave truncated JSON.
 */
export async function writeWatchlistAccountOverlay(
  root: string,
  accounts: readonly WatchlistOverlayAccount[],
): Promise<void> {
  const absolute = overlayPathFor(root);
  const body = `${JSON.stringify(
    {
      schemaVersion: WATCHLIST_ACCOUNT_SCHEMA_VERSION,
      accounts,
    },
    null,
    2,
  )}\n`;
  const temporary = `${absolute}.tmp-${process.pid}-${Date.now()}`;
  await Bun.write(temporary, body);
  await rename(temporary, absolute);
}

export interface AddWatchlistAccountInput {
  readonly login: string;
  readonly agentId: string;
  readonly sourceCategory?: string;
  readonly archetype?: string;
  readonly note?: string;
  readonly actor: string;
  /** Testing clock; defaults to now. */
  readonly now?: Date;
}

export interface AddWatchlistAccountResult {
  readonly account: WatchlistOverlayAccount;
  readonly overlay: WatchlistAccountOverlay;
  readonly counts: WatchlistAccountCounts;
}

/** Add one account. Refuses a login the base registry or the overlay already watches. */
export async function addWatchlistAccount(
  root: string,
  input: AddWatchlistAccountInput,
): Promise<AddWatchlistAccountResult> {
  const login = requireLogin(input.login, "login");
  const agentId = requireAgentId(input.agentId);
  const category = input.sourceCategory ?? DEFAULT_WATCHLIST_ACCOUNT_CATEGORY;
  if (!isWatchlistAccountCategory(category)) {
    throw new WatchlistOverlayError(
      "account_invalid",
      `unknown sourceCategory ${category}`,
      { allowed: WATCHLIST_ACCOUNT_CATEGORIES },
    );
  }
  const actor = optionalText(input.actor, 120);
  if (actor === "") {
    throw new WatchlistOverlayError("account_invalid", "actor is required");
  }
  const base = getUnifiedWatchlistRegistry();
  const baseLogins = new Set(
    base.map((entry) => normalizeAccountLogin(entry.customerLogin)),
  );
  if (baseLogins.has(login)) {
    throw new WatchlistOverlayError(
      "account_exists",
      `${login} is already watched by the built-in registry`,
      { login, scope: "base" },
    );
  }
  const current = await loadWatchlistAccountOverlay(root);
  if (current.accounts.some((account) => account.login === login)) {
    throw new WatchlistOverlayError(
      "account_exists",
      `${login} is already in the operator watchlist`,
      { login, scope: "overlay" },
    );
  }
  const account: WatchlistOverlayAccount = {
    login,
    agentId,
    sourceCategory: category,
    archetype:
      optionalText(input.archetype, 200) ||
      `Operator-watched F402 account (${login})`,
    addedAt: (input.now ?? new Date()).toISOString(),
    addedBy: actor,
    note: optionalText(input.note, 500),
  };
  const accounts = [...current.accounts, account];
  await writeWatchlistAccountOverlay(root, accounts);
  return {
    account,
    overlay: { ...current, exists: true, accounts },
    counts: {
      base: base.length,
      overlay: accounts.length,
      total: base.length + accounts.length,
    },
  };
}

export interface RemoveWatchlistAccountResult {
  readonly removed: WatchlistOverlayAccount;
  readonly overlay: WatchlistAccountOverlay;
  readonly counts: WatchlistAccountCounts;
}

/**
 * Remove one operator-added account. A base-registry account is read-only here (it lives in
 * source); removing it would silently change every consumer of the base registry.
 */
export async function removeWatchlistAccount(
  root: string,
  loginInput: string,
): Promise<RemoveWatchlistAccountResult> {
  const login = requireLogin(loginInput, "login");
  const current = await loadWatchlistAccountOverlay(root);
  const index = current.accounts.findIndex(
    (account) => account.login === login,
  );
  if (index === -1) {
    const base = getUnifiedWatchlistRegistry();
    const inBase = base.some(
      (entry) => normalizeAccountLogin(entry.customerLogin) === login,
    );
    throw inBase
      ? new WatchlistOverlayError(
          "account_read_only",
          `${login} is a built-in watchlist account and cannot be removed from the overlay`,
          { login, scope: "base" },
        )
      : new WatchlistOverlayError(
          "account_not_found",
          `${login} is not in the operator watchlist`,
          { login },
        );
  }
  const removed = current.accounts[index];
  if (removed === undefined) {
    throw new WatchlistOverlayError(
      "account_not_found",
      `${login} is not in the operator watchlist`,
      { login },
    );
  }
  const accounts = current.accounts.filter((_, i) => i !== index);
  await writeWatchlistAccountOverlay(root, accounts);
  const base = getUnifiedWatchlistRegistry();
  return {
    removed,
    overlay: { ...current, accounts },
    counts: {
      base: base.length,
      overlay: accounts.length,
      total: base.length + accounts.length,
    },
  };
}

/** Operator-facing account list: built-in rows plus overlay rows, `inBase` marked. */
export async function listWatchlistAccounts(
  root: string,
): Promise<WatchlistAccountListing> {
  const overlay = await loadWatchlistAccountOverlay(root);
  const base = getUnifiedWatchlistRegistry();
  const rows: WatchlistAccountRow[] = base.map((entry) => ({
    login: entry.customerLogin,
    agentId: entry.agentId,
    sourceCategory: entry.sourceCategory,
    archetype: entry.archetype,
    addedAt: null,
    addedBy: null,
    note: null,
    inBase: true,
  }));
  for (const account of overlay.accounts) {
    rows.push({
      login: account.login,
      agentId: account.agentId,
      sourceCategory: account.sourceCategory,
      archetype: account.archetype,
      addedAt: account.addedAt,
      addedBy: account.addedBy,
      note: account.note === "" ? null : account.note,
      inBase: false,
    });
  }
  return {
    path: overlay.path,
    exists: overlay.exists,
    counts: {
      base: base.length,
      overlay: overlay.accounts.length,
      total: rows.length,
    },
    accounts: rows,
  };
}

/**
 * Build the full registry entry for an overlay account. Mirrors
 * `getUnifiedWatchlistRegistry()`'s derivation so the engine sees one consistent shape.
 */
export function overlayAccountToUnifiedEntry(
  account: WatchlistOverlayAccount,
  rank: number,
): WatchlistUnifiedEntry {
  const gsLiveUrls = buildGsLiveManagerUrls(account.login);
  return {
    rank,
    customerLogin: account.login,
    paddedCustomerId11: account.login.padEnd(11, " "),
    gsLivePlayerId: gsLiveUrls.gsLivePlayerId,
    agentId: account.agentId,
    // The base registry attributes every row to one master; an operator overlay has no
    // master, and inventing one would pollute agent rollups. `OPERATOR_OVERLAY` is explicit.
    masterAgentId: "OPERATOR_OVERLAY",
    proxyWallet: null,
    shortWallet: null,
    sourceCategory: account.sourceCategory,
    archetype: account.archetype,
    hasPendingWagers: false,
    openLegsCount: 0,
    openVolumeUsd: 0,
    primaryRotations: [],
    openBetsSummary: account.note,
    alertPipeline:
      "operator watchlist overlay (no venue alert wired; signals derive from captures)",
    enforcementStatus: "OBSERVED",
    f402CustomerProfileUrl: `https://fantasy402.com/manager.html?customer=${encodeURIComponent(
      account.login,
    )}&agent=${encodeURIComponent(account.agentId)}`,
    polymarketProfileUrl: null,
    polymarketPositionsApiUrl: null,
    polygonscanUrl: null,
    gsLiveUrls,
  };
}

/**
 * Merge the built-in registry with the operator overlay. Overlay rows are appended in rank
 * order after the base rows; a login present in both resolves to the overlay row (Map.set
 * last-wins), which is what `registryLookup` consumes.
 */
export function mergeWatchlistRegistry(
  base: readonly WatchlistUnifiedEntry[],
  accounts: readonly WatchlistOverlayAccount[],
): WatchlistUnifiedEntry[] {
  const merged = new Map<string, WatchlistUnifiedEntry>();
  for (const entry of base) {
    merged.set(normalizeAccountLogin(entry.customerLogin), entry);
  }
  accounts.forEach((account, index) => {
    merged.set(
      account.login,
      overlayAccountToUnifiedEntry(account, base.length + index + 1),
    );
  });
  return [...merged.values()];
}
