import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  // ast-grep-ignore: node-fs-read-write-file -- sync fixtures for a CLI contract test.
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  AUTOBET_CONFIG_REL_PATH,
  loadAutobetConfig,
  loadAutobetSignals,
} from "../lib/watchlist_autobet.ts";
import {
  WATCHLIST_ACCOUNT_OVERLAY_REL_PATH,
  WatchlistOverlayError,
  addWatchlistAccount,
  listWatchlistAccounts,
  loadWatchlistAccountOverlay,
  mergeWatchlistRegistry,
  parseWatchlistAccountOverlay,
  removeWatchlistAccount,
  overlayPathFor,
} from "../lib/watchlist_account_overlay.ts";
import { getUnifiedWatchlistRegistry } from "../lib/gslive_manager_watchlist.ts";

const CLI_PATH = join(import.meta.dir, "..", "cli", "watchlist_autobet_cli.ts");
const BASE_CONFIG = {
  schemaVersion: 1,
  enabled: true,
  mode: "paper",
  stakeUsd: 25,
  maxStakeUsd: 100,
  dailyStakeCapUsd: 500,
  perLeagueDailyStakeCapUsd: 250,
  minConfidence: 30,
  minDistinctAccounts: 1,
  minOneSidedShare: 0.6,
  maxSignalAgeSeconds: 900,
  allowFixtureSignals: false,
  allowLiveExecution: false,
  paperSlippageBps: 50,
  expireApprovedAfterMinutes: 120,
  ledgerPath: "Scratch/watchlist-autobet/ledger.jsonl",
  eligibleLeagues: ["NBA", "NFL", "CFB", "EPL", "NHL", "MLB"],
};

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(import.meta.dir, ".tmp-watchlist-overlay-"));
  temporaryRoots.push(root);
  return root;
}

function writeConfig(root: string): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, AUTOBET_CONFIG_REL_PATH),
    `${JSON.stringify(BASE_CONFIG, null, 2)}\n`,
  );
}

function writeRawOverlay(root: string, body: string): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(overlayPathFor(root), body);
}

interface CliResult {
  readonly code: number;
  readonly body: Record<string, unknown>;
}

function runCli(root: string, args: readonly string[]): CliResult {
  const proc = Bun.spawnSync({
    cmd: [
      process.execPath,
      CLI_PATH,
      ...args,
      "--json",
      "--root",
      root,
      "--now",
      "2026-11-05T01:00:00.000Z",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(proc.stdout.toString()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { code: proc.exitCode ?? -1, body };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected an object, got ${String(value)}`);
  }
  return value as Record<string, unknown>;
}

function rows(
  body: Record<string, unknown>,
): readonly Record<string, unknown>[] {
  const accounts = body["accounts"];
  if (!Array.isArray(accounts)) throw new Error("accounts is not an array");
  return accounts.map((entry) => record(entry));
}

afterAll(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* parse / load                                                               */
/* -------------------------------------------------------------------------- */

describe("watchlist account overlay: parse", () => {
  const valid = {
    login: "BRT104",
    agentId: "JACESFACES",
    sourceCategory: "INTERNAL_F402_SHARP",
    archetype: "Operator-watched F402 account",
    addedAt: "2026-11-05T01:00:00.000Z",
    addedBy: "operator",
    note: "top live risk",
  };

  test("accepts an object with schemaVersion and an accounts array", () => {
    const parsed = parseWatchlistAccountOverlay({
      schemaVersion: 1,
      accounts: [valid],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]?.login).toBe("BRT104");
    expect(parsed.accounts[0]?.sourceCategory).toBe("INTERNAL_F402_SHARP");
  });

  test("accepts a bare array", () => {
    const parsed = parseWatchlistAccountOverlay([valid]);
    expect(parsed.ok).toBe(true);
  });

  test("normalizes player_ prefix and lowercase", () => {
    const parsed = parseWatchlistAccountOverlay([
      { ...valid, login: "player_brt104" },
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.accounts[0]?.login).toBe("BRT104");
  });

  test("rejects an unknown source category", () => {
    const parsed = parseWatchlistAccountOverlay([
      { ...valid, sourceCategory: "NOT_A_CATEGORY" },
    ]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("sourceCategory");
  });

  test("rejects a duplicate login", () => {
    const parsed = parseWatchlistAccountOverlay([valid, valid]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("duplicates");
  });

  test("rejects an unsupported schemaVersion", () => {
    const parsed = parseWatchlistAccountOverlay({
      schemaVersion: 9,
      accounts: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("schemaVersion 9");
  });
});

describe("watchlist account overlay: load", () => {
  test("a missing overlay is empty, not an error", async () => {
    const root = makeTemporaryRoot();
    const overlay = await loadWatchlistAccountOverlay(root);
    expect(overlay.exists).toBe(false);
    expect(overlay.accounts).toHaveLength(0);
  });

  test("a malformed overlay throws overlay_invalid", async () => {
    const root = makeTemporaryRoot();
    writeRawOverlay(root, "{ not json");
    await expect(loadWatchlistAccountOverlay(root)).rejects.toBeInstanceOf(
      WatchlistOverlayError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* add / remove                                                               */
/* -------------------------------------------------------------------------- */

describe("watchlist account overlay: add/remove", () => {
  test("adds, lists and removes an operator account", async () => {
    const root = makeTemporaryRoot();
    const added = await addWatchlistAccount(root, {
      login: "brt104",
      agentId: "jacesfaces",
      actor: "operator",
      now: new Date("2026-11-05T01:00:00.000Z"),
    });
    expect(added.account.login).toBe("BRT104");
    expect(added.account.agentId).toBe("JACESFACES");
    expect(added.counts.overlay).toBe(1);

    const listing = await listWatchlistAccounts(root);
    expect(listing.exists).toBe(true);
    expect(listing.counts).toEqual({
      base: getUnifiedWatchlistRegistry().length,
      overlay: 1,
      total: getUnifiedWatchlistRegistry().length + 1,
    });
    const overlayRow = listing.accounts.find((row) => row.login === "BRT104");
    expect(overlayRow?.inBase).toBe(false);
    expect(overlayRow?.addedBy).toBe("operator");

    const removed = await removeWatchlistAccount(root, "player_BRT104");
    expect(removed.removed.login).toBe("BRT104");
    expect(removed.counts.overlay).toBe(0);
    const after = await loadWatchlistAccountOverlay(root);
    expect(after.accounts).toHaveLength(0);
  });

  test("refuses an account that is already in the built-in registry", async () => {
    const root = makeTemporaryRoot();
    await expect(
      addWatchlistAccount(root, {
        login: "BGD101",
        agentId: "BIGDAD",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "account_exists" });
  });

  test("refuses a duplicate overlay account", async () => {
    const root = makeTemporaryRoot();
    await addWatchlistAccount(root, {
      login: "BRT104",
      agentId: "JACESFACES",
      actor: "operator",
    });
    await expect(
      addWatchlistAccount(root, {
        login: "BRT104",
        agentId: "JACESFACES",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "account_exists" });
  });

  test("refuses to remove a built-in account", async () => {
    const root = makeTemporaryRoot();
    await expect(removeWatchlistAccount(root, "BGD101")).rejects.toMatchObject({
      code: "account_read_only",
    });
  });

  test("removing an unknown account is account_not_found", async () => {
    const root = makeTemporaryRoot();
    await expect(removeWatchlistAccount(root, "NOPE999")).rejects.toMatchObject(
      { code: "account_not_found" },
    );
  });

  test("refuses an invalid login and an unknown category", async () => {
    const root = makeTemporaryRoot();
    await expect(
      addWatchlistAccount(root, {
        login: "bad login!",
        agentId: "AGENT",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "account_invalid" });
    await expect(
      addWatchlistAccount(root, {
        login: "BRT104",
        agentId: "AGENT",
        sourceCategory: "NOT_A_CATEGORY",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "account_invalid" });
  });
});

/* -------------------------------------------------------------------------- */
/* registry merge + engine wiring                                             */
/* -------------------------------------------------------------------------- */

describe("watchlist account overlay: registry merge", () => {
  test("appends overlay entries after the base registry and marks them", async () => {
    const root = makeTemporaryRoot();
    await addWatchlistAccount(root, {
      login: "BRT104",
      agentId: "JACESFACES",
      actor: "operator",
      now: new Date("2026-11-05T01:00:00.000Z"),
    });
    const overlay = await loadWatchlistAccountOverlay(root);
    const base = getUnifiedWatchlistRegistry();
    const merged = mergeWatchlistRegistry(base, overlay.accounts);
    expect(merged).toHaveLength(base.length + 1);
    const entry = merged[merged.length - 1];
    expect(entry?.customerLogin).toBe("BRT104");
    expect(entry?.agentId).toBe("JACESFACES");
    expect(entry?.sourceCategory).toBe("INTERNAL_F402_SHARP");
    expect(entry?.masterAgentId).toBe("OPERATOR_OVERLAY");
    expect(entry?.gsLivePlayerId).toBe("player_BRT104");
  });

  test("an overlay login overrides a duplicate base login", () => {
    const base = getUnifiedWatchlistRegistry();
    const merged = mergeWatchlistRegistry(base, [
      {
        login: "BGD101",
        agentId: "OVERLAY_AGENT",
        sourceCategory: "INTERNAL_F402_SHARP",
        archetype: "overlay override",
        addedAt: "2026-11-05T01:00:00.000Z",
        addedBy: "operator",
        note: "",
      },
    ]);
    const entry = merged.find((row) => row.customerLogin === "BGD101");
    expect(entry?.agentId).toBe("OVERLAY_AGENT");
    expect(merged).toHaveLength(base.length);
  });

  test("loadAutobetSignals reports the merged account counts", async () => {
    const root = makeTemporaryRoot();
    writeConfig(root);
    await addWatchlistAccount(root, {
      login: "BRT104",
      agentId: "JACESFACES",
      actor: "operator",
    });
    const config = await loadAutobetConfig(root);
    const snapshot = await loadAutobetSignals(
      root,
      config,
      new Date("2026-11-05T01:00:00.000Z"),
    );
    expect(snapshot.accounts).toEqual({
      base: getUnifiedWatchlistRegistry().length,
      overlay: 1,
      total: getUnifiedWatchlistRegistry().length + 1,
    });
    expect(
      snapshot.registry.some((entry) => entry.customerLogin === "BRT104"),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* CLI contract                                                               */
/* -------------------------------------------------------------------------- */

describe("watchlist account overlay: CLI", () => {
  test("accounts add/list/remove round-trips and writes the overlay file", async () => {
    const root = makeTemporaryRoot();
    const add = runCli(root, [
      "accounts",
      "add",
      "BRT104",
      "--agent",
      "JACESFACES",
      "--category",
      "INTERNAL_F402_SHARP",
      "--note",
      "top live risk",
      "--actor",
      "operator",
    ]);
    expect(add.code).toBe(0);
    expect(add.body["success"]).toBe(true);
    expect(add.body["action"]).toBe("add");
    expect(add.body["path"]).toBe(WATCHLIST_ACCOUNT_OVERLAY_REL_PATH);

    const list = runCli(root, ["accounts", "list"]);
    expect(list.code).toBe(0);
    const rowsOut = rows(list.body);
    const added = rowsOut.find((row) => row["login"] === "BRT104");
    expect(added?.["inBase"]).toBe(false);
    expect(added?.["addedBy"]).toBe("operator");

    const remove = runCli(root, [
      "accounts",
      "remove",
      "BRT104",
      "--actor",
      "operator",
    ]);
    expect(remove.code).toBe(0);
    expect(remove.body["action"]).toBe("remove");
    expect(remove.body["counts"]).toMatchObject({ overlay: 0 });
  });

  test("duplicate add exits 3 with account_exists", () => {
    const root = makeTemporaryRoot();
    expect(
      runCli(root, [
        "accounts",
        "add",
        "BRT104",
        "--agent",
        "JACESFACES",
        "--actor",
        "operator",
      ]).code,
    ).toBe(0);
    const duplicate = runCli(root, [
      "accounts",
      "add",
      "BRT104",
      "--agent",
      "JACESFACES",
      "--actor",
      "operator",
    ]);
    expect(duplicate.code).toBe(3);
    expect(record(duplicate.body["error"])["code"]).toBe("account_exists");
  });

  test("removing a built-in account exits 3 with account_read_only", () => {
    const root = makeTemporaryRoot();
    const result = runCli(root, [
      "accounts",
      "remove",
      "BGD101",
      "--actor",
      "operator",
    ]);
    expect(result.code).toBe(3);
    expect(record(result.body["error"])["code"]).toBe("account_read_only");
  });

  test("add requires --agent", () => {
    const root = makeTemporaryRoot();
    const result = runCli(root, ["accounts", "add", "BRT104"]);
    expect(result.code).toBe(2);
    expect(record(result.body["error"])["code"]).toBe("usage_error");
  });

  test("status reports the overlay counts", async () => {
    const root = makeTemporaryRoot();
    writeConfig(root);
    await addWatchlistAccount(root, {
      login: "BRT104",
      agentId: "JACESFACES",
      actor: "operator",
    });
    const status = runCli(root, ["status"]);
    expect(status.code).toBe(0);
    const accounts = record(status.body["accounts"]);
    expect(accounts["overlay"]).toBe(1);
    expect(accounts["total"]).toBe(getUnifiedWatchlistRegistry().length + 1);
  });
});
