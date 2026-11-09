/**
 * @file lib/combo_wallets.ts
 * @description Wallet discovery for combo reads: seeds candidate wallets from public CFB trades or
 * the Polymarket leaderboard. Source access only — no combo identity, no uniqueness.
 */

import type { CfbGame } from "./cfb_events.ts";
import {
  asRecord,
  getJson,
  mapLimit,
  text,
  type JsonFetchOptions,
} from "./json_fetch.ts";

export interface WalletSeedOptions extends JsonFetchOptions {
  readonly concurrency?: number;
  readonly dataBase?: string;
  readonly maxSeedMarkets?: number;
  readonly perMarket?: number;
  readonly leaderboardLimit?: number;
}

export async function seedWalletsFromTrades(
  games: readonly CfbGame[],
  options?: WalletSeedOptions,
): Promise<Set<string>> {
  const maxMarkets = options?.maxSeedMarkets ?? 60;
  const perMarket = options?.perMarket ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  const ids = [...new Set(games.flatMap((game) => game.conditionIds))].slice(
    0,
    maxMarkets,
  );
  const wallets = new Set<string>();
  await mapLimit(ids, options?.concurrency ?? 6, async (conditionId) => {
    try {
      const body = await getJson(
        `${data}/trades?market=${encodeURIComponent(conditionId)}&limit=${perMarket}`,
        options,
      );
      if (!Array.isArray(body)) return;
      for (const raw of body) {
        const row = asRecord(raw);
        if (row === null) continue;
        const wallet =
          text(row.proxyWallet) ||
          text(row.wallet) ||
          text(row.maker) ||
          text(row.taker) ||
          text(row.user);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet))
          wallets.add(wallet.toLowerCase());
      }
    } catch {
      // a market with no trades is normal
    }
  });
  return wallets;
}

/** Seeds wallets from the v2 leaderboard (week/month/all, PnL-sorted). */

export async function seedWalletsFromLeaderboard(
  options?: WalletSeedOptions,
): Promise<Set<string>> {
  const wallets = new Set<string>();
  const limit = options?.leaderboardLimit ?? 100;
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  for (const period of ["week", "month", "all"] as const) {
    try {
      const body = await getJson(
        `${data}/v2/leaderboard?time_period=${period}&sort_by=PNL&limit=${limit}`,
        options,
      );
      const rows = Array.isArray(asRecord(body)?.data)
        ? (asRecord(body)!.data as unknown[])
        : [];
      for (const raw of rows) {
        const wallet = text(asRecord(raw)?.user_id);
        if (/^0x[0-9a-fA-F]{40}$/.test(wallet))
          wallets.add(wallet.toLowerCase());
      }
    } catch {
      // leaderboard is a best-effort seed
    }
  }
  return wallets;
}
