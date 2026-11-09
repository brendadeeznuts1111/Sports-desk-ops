/**
 * @file lib/combo_uniqueness.ts
 * @description The uniqueness property over combos: which combos are distinct within a
 * game, the gates that decide inclusion (`permissive` / `all-legs-cfb` / `full-game`),
 * and the subset invariant between them.
 *
 * The three meanings this file used to carry are now separate modules: CFB event
 * fetching and its cache live in `cfb_events.ts`, the combo construct (legs, identity,
 * attribution) in `combo_legs.ts`, wallet discovery in `combo_wallets.ts`. This module
 * composes them and decides what counts as unique.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_CACHE_TTL_HOURS,
  buildGameIndex,
  cacheTtlMs,
  loadCfbGames,
  type CfbEventsOptions,
} from "./cfb_events.ts";
import {
  looksLikeComboCondition,
  normalizeCombo,
  type NormalizedCombo,
} from "./combo_legs.ts";
import {
  seedWalletsFromLeaderboard,
  seedWalletsFromTrades,
  type WalletSeedOptions,
} from "./combo_wallets.ts";
import { asRecord, getJson, mapLimit, text } from "./json_fetch.ts";

export interface ComboUniquenessOptions
  extends CfbEventsOptions, WalletSeedOptions {
  readonly leaderboard?: boolean;
  readonly walletFile?: string;
  readonly strictFullGame?: boolean;
  /** Explicit gate; overrides `strictFullGame`. */
  readonly gate?: ComboGate;
  /** Include the per-combo audit trail in the report (default true). */
  readonly includeAudit?: boolean;
  readonly seedTrades?: boolean;
  readonly maxComboPages?: number;
}

interface CacheFile {
  readonly schemaVersion: 1;
  readonly fetchedAtIso: string;
  readonly records: readonly unknown[];
}

export interface ComboGameStats {
  readonly gameSlug: string;
  readonly title: string;
  readonly volume24hr: number;
  readonly uniqueCombos: number;
  readonly uniqueWallets: number;
  readonly fullyWithinGame: number;
  readonly samples: readonly {
    readonly comboId: string;
    readonly wallet: string;
    readonly legs: number;
    readonly games: number;
  }[];
}

export type ComboGate = "permissive" | "all-legs-cfb" | "full-game";

export type StrictDropReason =
  "UNRESOLVED_LEGS" | "CROSS_GAME" | "INELIGIBLE_LEG_TYPE";

export interface ComboAuditRow {
  readonly comboId: string;
  readonly wallet: string;
  readonly legs: number;
  readonly games: number;
  readonly allLegsCfb: boolean;
  readonly fullyWithinGame: boolean;
  readonly allCfbLegsEligible: boolean;
  /** False only under a gated mode; permissive attribution is mode-independent. */
  readonly kept: boolean;
  readonly dropReason: StrictDropReason | null;
  /** Leg keys that failed to resolve to any CFB game. */
  readonly unresolvedLegKeys: readonly string[];
}

export interface ComboUniquenessReport {
  readonly gate: ComboGate;
  /** Back-compat: true only for `full-game`. */
  readonly strictFullGame: boolean;
  readonly index: {
    readonly games: number;
    readonly activeOnly: boolean;
    readonly since: string | null;
  };
  readonly games: readonly ComboGameStats[];
  readonly global: {
    readonly gamesWithActivity: number;
    readonly sumPerGameCombos: number;
    readonly sumPerGameWallets: number;
    readonly distinctCombos: number;
    readonly distinctWallets: number;
  };
  readonly walletsScanned: number;
  readonly comboRecords: number;
  /** Distinct combos before the strict gate; `strict` is always a subset of this. */
  readonly permissiveCombos: number;
  /** Records collapsed by the `comboId|wallet` or `legKeys|wallet` dedupe passes. */
  readonly duplicatesCollapsed: number;
  readonly duplicatesCollapsedById: number;
  /** Non-zero proves the cross-indexer leg-set pass is doing work. */
  readonly duplicatesCollapsedByLegSet: number;
  /** Why the active gate dropped a combo. Sum equals `permissiveCombos - comboRecords`. */
  readonly exclusions: Readonly<Record<StrictDropReason, number>>;
  /** Kept combos that span more than one game. Admitted by `permissive` and `all-legs-cfb`. */
  readonly includedCrossGame: number;
  readonly diagnostics: {
    /** Legs with no outcome/side; such rows cannot match a sided source. */
    readonly legsWithoutSide: number;
    readonly legsWithoutStableId: number;
    readonly combosWithUnstableIdentity: number;
    /** Resolution gap: which permissive combos die on legs that match no indexed CFB game. */
    readonly unresolved: {
      readonly combos: number;
      readonly legs: number;
      readonly distinctLegKeys: number;
      /** Leg keys seen in exactly one combo (long tail). */
      readonly oneOffLegKeys: number;
      /** Leg keys seen in two or more combos (systemic). */
      readonly systemicLegKeys: number;
      readonly top: readonly {
        readonly legKey: string;
        readonly combos: number;
      }[];
    };
    /** Combos with legs that resolved to **zero** indexed games; they never reach the report. */
    readonly combosWithoutAttribution: number;
    readonly recordsWithoutLegs: number;
    /** Share of observed combos that touch an indexed CFB game. Non-CFB combos are in the denominator. */
    readonly cfbTouchRatePct: number;
    /** Unresolved leg keys shaped like zero-padded combo conditions (no CLOB market). */
    readonly suspectedComboOfComboLegKeys: number;
  };
  /** Sorted, unique wallets scanned — the input for `--dump-wallets`. */
  readonly wallets: readonly string[];
  /** Per-combo audit trail; empty under `--json` only if `includeAudit: false`. */
  readonly combos: readonly ComboAuditRow[];
  readonly cache: {
    readonly hits: number;
    readonly misses: number;
    readonly ttlHours: number;
  };
}

async function readCache(
  path: string,
  options?: ComboUniquenessOptions,
): Promise<readonly unknown[] | null> {
  if (options?.fresh === true) return null;
  try {
    const parsed = (await Bun.file(path).json()) as Partial<CacheFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records))
      return null;
    const fetchedAt = Date.parse(parsed.fetchedAtIso ?? "");
    if (!Number.isFinite(fetchedAt)) return null;
    // TTL applies in offline mode too: `offline` only switches fetch behavior (fail instead
    // of network when a page is missing), it must not turn a stale cache into a fresh hit.
    const ttl = cacheTtlMs(options);
    if (ttl === 0) return null;
    if ((options?.now ?? Date.now()) - fetchedAt > ttl) return null;
    return parsed.records;
  } catch {
    return null;
  }
}

async function fetchCombosUncached(
  wallet: string,
  options?: ComboUniquenessOptions,
): Promise<unknown[]> {
  const maxPages = Math.max(1, options?.maxComboPages ?? 3);
  const data = (options?.dataBase ?? "https://data-api.polymarket.com").replace(
    /\/$/,
    "",
  );
  const records: unknown[] = [];
  for (const path of ["/v2/activity/combos", "/v2/positions/combos"]) {
    let cursor: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const suffix =
        cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      try {
        const body = await getJson(
          `${data}${path}?user=${wallet}&limit=500${suffix}`,
          options,
        );
        const record = asRecord(body);
        const pageRows = Array.isArray(record?.data)
          ? (record.data as unknown[])
          : [];
        records.push(...pageRows);
        const next = text(asRecord(record?.pagination)?.next_cursor);
        if (pageRows.length === 0 || next === "") break;
        cursor = next;
      } catch {
        break;
      }
    }
  }
  return records;
}

async function cachedCombos(
  wallet: string,
  options: ComboUniquenessOptions | undefined,
  stats: { hits: number; misses: number },
): Promise<unknown[]> {
  const dir = options?.cacheDir ?? "scratch/cfb-combo-cache";
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${wallet}.json`);
  const cached = await readCache(path, options);
  if (cached !== null) {
    stats.hits += 1;
    return [...cached];
  }
  if (options?.offline === true) {
    throw new Error(`offline: no cached combos for ${wallet}`);
  }
  stats.misses += 1;
  const records = await fetchCombosUncached(wallet, options);
  const payload: CacheFile = {
    schemaVersion: 1,
    fetchedAtIso: new Date(options?.now ?? Date.now()).toISOString(),
    records,
  };
  await writeFile(path, `${JSON.stringify(payload)}\n`, "utf8");
  return records;
}

export async function buildComboUniquenessReport(
  options?: ComboUniquenessOptions,
): Promise<ComboUniquenessReport> {
  const games = await loadCfbGames(options);
  const index = buildGameIndex(games);

  const wallets = new Set<string>();
  if (options?.leaderboard !== false) {
    for (const wallet of await seedWalletsFromLeaderboard(options))
      wallets.add(wallet);
  }
  if (options?.seedTrades === true) {
    for (const wallet of await seedWalletsFromTrades(games, options))
      wallets.add(wallet);
  }
  if (options?.walletFile !== undefined) {
    try {
      const file = await readFile(options.walletFile, "utf8");
      for (const candidate of file.split(/\s+/)) {
        if (/^0x[0-9a-fA-F]{40}$/.test(candidate))
          wallets.add(candidate.toLowerCase());
      }
    } catch {
      // missing wallet file is not fatal
    }
  }

  const stats = { hits: 0, misses: 0 };
  let recordsWithoutLegs = 0;
  let combosWithoutAttribution = 0;
  const perWallet = await mapLimit(
    [...wallets],
    options?.concurrency ?? 6,
    async (wallet) => {
      const records = await cachedCombos(wallet, options, stats);
      const combos: NormalizedCombo[] = [];
      for (const record of records) {
        const result = normalizeCombo(record, wallet, index);
        if (result.ok) {
          combos.push(result.combo);
        } else if (result.reason === "NO_ATTRIBUTION") {
          combosWithoutAttribution += 1;
        } else {
          recordsWithoutLegs += 1;
        }
      }
      return combos;
    },
  );

  const gate: ComboGate =
    options?.gate ??
    (options?.strictFullGame === true ? "full-game" : "permissive");
  const strict = gate === "full-game";

  // Two dedupe passes, in order of certainty:
  //   1. `comboId|wallet` — the upstream identity when it exists.
  //   2. `legKeys|wallet` — cross-indexer fallback: the same combo surfaced by two endpoints
  //      can carry different ids, but its resolved leg set and wallet are the same.
  const seenIds = new Set<string>();
  const seenLegSets = new Set<string>();
  const dedupedAll: NormalizedCombo[] = [];
  let duplicatesCollapsedById = 0;
  let duplicatesCollapsedByLegSet = 0;
  for (const combo of perWallet.flat()) {
    const idKey = `${combo.comboId}|${combo.wallet}`;
    const legKey = `${combo.legSignatures.join(";")}|${combo.wallet}`;
    if (seenIds.has(idKey)) {
      duplicatesCollapsedById += 1;
      continue;
    }
    if (seenLegSets.has(legKey)) {
      duplicatesCollapsedByLegSet += 1;
      continue;
    }
    seenIds.add(idKey);
    seenLegSets.add(legKey);
    dedupedAll.push(combo);
  }
  const duplicatesCollapsed =
    duplicatesCollapsedById + duplicatesCollapsedByLegSet;
  const unresolvedByKey = new Map<string, number>();
  let unresolvedCombos = 0;
  let unresolvedLegs = 0;
  for (const combo of dedupedAll) {
    if (combo.unresolvedLegKeys.length === 0) continue;
    unresolvedCombos += 1;
    unresolvedLegs += combo.unresolvedLegKeys.length;
    for (const key of new Set(combo.unresolvedLegKeys)) {
      unresolvedByKey.set(key, (unresolvedByKey.get(key) ?? 0) + 1);
    }
  }
  const unresolvedTop = [...unresolvedByKey.entries()]
    .map(([legKey, combos]) => ({ legKey, combos }))
    .sort((a, b) => b.combos - a.combos || a.legKey.localeCompare(b.legKey))
    .slice(0, 10);
  const diagnostics = {
    legsWithoutSide: dedupedAll.reduce(
      (sum, combo) => sum + combo.legsWithoutSide,
      0,
    ),
    legsWithoutStableId: dedupedAll.reduce(
      (sum, combo) => sum + combo.unstableLegs,
      0,
    ),
    combosWithUnstableIdentity: dedupedAll.filter(
      (combo) => combo.unstableLegs > 0,
    ).length,
    unresolved: {
      combos: unresolvedCombos,
      legs: unresolvedLegs,
      distinctLegKeys: unresolvedByKey.size,
      oneOffLegKeys: [...unresolvedByKey.values()].filter(
        (count) => count === 1,
      ).length,
      systemicLegKeys: [...unresolvedByKey.values()].filter(
        (count) => count >= 2,
      ).length,
      top: unresolvedTop,
    },
    combosWithoutAttribution,
    recordsWithoutLegs,
    cfbTouchRatePct:
      dedupedAll.length + combosWithoutAttribution > 0
        ? Math.round(
            (dedupedAll.length /
              (dedupedAll.length + combosWithoutAttribution)) *
              10_000,
          ) / 100
        : 0,
    suspectedComboOfComboLegKeys: [...unresolvedByKey.keys()].filter(
      looksLikeComboCondition,
    ).length,
  };

  // Attribution above is mode-independent. Each gate is a pure filter applied afterwards, so a
  // stricter gate is always a subset of a looser one and `fullyWithinGame` is monotonic.
  // `eligible` is exactly `market_sport_type ∈ {moneyline, spreads, totals}` (ELIGIBLE_LEG_TYPES),
  // the same predicate `full-game` uses.
  const exclusions: Record<StrictDropReason, number> = {
    UNRESOLVED_LEGS: 0,
    CROSS_GAME: 0,
    INELIGIBLE_LEG_TYPE: 0,
  };
  const dropReasonOf = (combo: NormalizedCombo): StrictDropReason | null => {
    if (gate === "permissive") return null;
    if (!combo.allLegsCfb) return "UNRESOLVED_LEGS";
    if (gate === "full-game" && !combo.fullyWithinGame) return "CROSS_GAME";
    if (!combo.allCfbLegsEligible) return "INELIGIBLE_LEG_TYPE";
    return null;
  };
  const kept: NormalizedCombo[] = [];
  const audit: ComboAuditRow[] = [];
  for (const combo of dedupedAll) {
    const dropReason = dropReasonOf(combo);
    if (dropReason === null) kept.push(combo);
    else exclusions[dropReason] += 1;
    if (options?.includeAudit !== false) {
      audit.push({
        comboId: combo.comboId,
        wallet: combo.wallet,
        legs: combo.legKeys.length,
        games: combo.gameSlugs.size,
        allLegsCfb: combo.allLegsCfb,
        fullyWithinGame: combo.fullyWithinGame,
        allCfbLegsEligible: combo.allCfbLegsEligible,
        kept: dropReason === null,
        dropReason,
        unresolvedLegKeys: combo.unresolvedLegKeys,
      });
    }
  }
  const normalized = kept;
  const deduped = normalized;
  const includedCrossGame = normalized.filter(
    (combo) => !combo.fullyWithinGame,
  ).length;

  const byGame = new Map<
    string,
    {
      combos: Set<string>;
      wallets: Set<string>;
      full: number;
      samples: NormalizedCombo[];
    }
  >();
  for (const game of games) {
    byGame.set(game.slug, {
      combos: new Set(),
      wallets: new Set(),
      full: 0,
      samples: [],
    });
  }
  for (const combo of deduped) {
    for (const slug of combo.gameSlugs) {
      const bucket = byGame.get(slug);
      if (bucket === undefined) continue;
      bucket.combos.add(combo.comboId);
      bucket.wallets.add(combo.wallet);
      if (combo.fullyWithinGame) bucket.full += 1;
      if (bucket.samples.length < 3) bucket.samples.push(combo);
    }
  }

  const gamesReport: ComboGameStats[] = games
    .map((game) => {
      const bucket = byGame.get(game.slug)!;
      return {
        gameSlug: game.slug,
        title: game.title,
        volume24hr: game.volume24hr,
        uniqueCombos: bucket.combos.size,
        uniqueWallets: bucket.wallets.size,
        fullyWithinGame: bucket.full,
        samples: bucket.samples.map((combo) => ({
          comboId: combo.comboId,
          wallet: combo.wallet,
          legs: combo.legKeys.length,
          games: combo.gameSlugs.size,
        })),
      };
    })
    .sort(
      (a, b) =>
        b.volume24hr - a.volume24hr || a.gameSlug.localeCompare(b.gameSlug),
    );

  const globalCombos = new Set(deduped.map((combo) => combo.comboId));
  const globalWallets = new Set(deduped.map((combo) => combo.wallet));
  const sumCombos = gamesReport.reduce(
    (sum, game) => sum + game.uniqueCombos,
    0,
  );
  const sumWallets = gamesReport.reduce(
    (sum, game) => sum + game.uniqueWallets,
    0,
  );

  return {
    gate,
    strictFullGame: strict,
    index: {
      games: games.length,
      activeOnly: options?.includeClosedGames === false,
      since: options?.since ?? null,
    },
    games: gamesReport,
    global: {
      gamesWithActivity: gamesReport.filter((game) => game.uniqueCombos > 0)
        .length,
      sumPerGameCombos: sumCombos,
      sumPerGameWallets: sumWallets,
      distinctCombos: globalCombos.size,
      distinctWallets: globalWallets.size,
    },
    walletsScanned: wallets.size,
    comboRecords: normalized.length,
    permissiveCombos: dedupedAll.length,
    duplicatesCollapsed,
    duplicatesCollapsedById,
    duplicatesCollapsedByLegSet,
    exclusions,
    includedCrossGame,
    diagnostics,
    wallets: [...wallets].sort(),
    combos: audit,
    cache: {
      ...stats,
      ttlHours: options?.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS,
    },
  };
}

/**
 * Sorted `comboId|wallet` lines for **kept** combos only.
 *
 * There is deliberately no "include dropped" option: a subset check is only meaningful against
 * kept sets, and an ambiguous boolean here previously widened a gated reference back to the audit
 * population.
 */

export function comboIdLines(report: ComboUniquenessReport): string[] {
  return report.combos
    .filter((row) => row.kept)
    .map((row) => `${row.comboId}|${row.wallet}`)
    .sort();
}

/** Sorted unique wallets, one per line — the `--dump-wallets` input. */

export function walletLines(report: ComboUniquenessReport): string[] {
  return [...report.wallets].sort();
}

/** Join lines for file emission; an empty set writes an empty file, never a blank line. */

export function linesToText(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface ComboSubsetCheck {
  readonly referenceGate: ComboGate;
  readonly treatmentGate: ComboGate;
  readonly reference: number;
  readonly treatment: number;
  readonly leaks: readonly string[];
  /** True when the treatment set is empty: an empty diff proves nothing. */
  readonly vacuous: boolean;
}

/**
 * Empirical subset proof: every treatment combo must exist in the reference set.
 * An empty treatment set is reported as `vacuous` rather than as a pass.
 */

export function checkComboSubset(
  reference: ComboUniquenessReport,
  treatment: ComboUniquenessReport,
): ComboSubsetCheck {
  // Kept-only on both sides. Using all audit rows for the reference would silently widen a
  // gated reference (e.g. all-legs-cfb) back to the permissive population.
  const referenceIds = new Set(comboIdLines(reference));
  const treatmentIds = comboIdLines(treatment);
  const leaks = treatmentIds.filter((line) => !referenceIds.has(line));
  return {
    referenceGate: reference.gate,
    treatmentGate: treatment.gate,
    reference: referenceIds.size,
    treatment: treatmentIds.length,
    leaks,
    vacuous: treatmentIds.length === 0,
  };
}
