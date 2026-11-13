/**
 * @file packages/backend/src/customers.ts
 * @description Indexed customer lookup and dynamic cohort aggregation for `/api/customers*`.
 */

import { resolve } from "node:path";
import type {
  CustomersCohortsSummary,
  DashboardSourceProvenance,
} from "@sportsdesk-ops/contracts";
import { BoundedStampCache, statStamp } from "./cache.ts";

export interface GenericCustomerRow {
  readonly customer_id?: string | undefined;
}

export interface CustomerRowFinderOptions {
  readonly cwd?: string | undefined;
  readonly enrichedPaths?: readonly string[] | undefined;
  readonly profilesPath?: string | undefined;
}

/** Build a stat-cached customer row lookup function over enriched JSON corpora & profiles. */
export function createCustomerRowFinder<
  TRow extends GenericCustomerRow = GenericCustomerRow,
>(options: CustomerRowFinderOptions = {}) {
  const cwd = options.cwd ?? process.cwd();
  const candidatePaths = options.enrichedPaths ?? [
    resolve(cwd, "enriched_customers_full.json"),
    resolve(cwd, "tests/fixtures/backtest/enriched_customers_full.json"),
    resolve(cwd, "tests/fixtures/verify-load/enriched_customers_full.json"),
  ];
  const profilesPath =
    options.profilesPath ?? resolve(cwd, "data/customer-profiles.json");

  const indexCache = new BoundedStampCache<ReadonlyMap<string, TRow>>(8);

  const findCustomerRow = async (id: string): Promise<TRow | null> => {
    const normId = id.trim().toUpperCase();
    if (!normId) return null;

    for (const enrichedPath of candidatePaths) {
      const stamp = await statStamp(enrichedPath);
      if (stamp === null) continue;
      try {
        let byId = indexCache.getIfFresh(enrichedPath, stamp);
        if (!byId) {
          const rows = (await Bun.file(enrichedPath).json()) as TRow[];
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (typeof row.customer_id === "string") {
                const key = row.customer_id.trim().toUpperCase();
                if (key && !nextMap.has(key)) nextMap.set(key, row);
              }
            }
          }
          byId = nextMap;
          indexCache.set(enrichedPath, stamp, byId);
        }
        const found = byId.get(normId);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-json-candidate
      }
    }

    const profilesStamp = await statStamp(profilesPath);
    if (profilesStamp !== null) {
      try {
        let byId = indexCache.getIfFresh(profilesPath, profilesStamp);
        if (!byId) {
          const data = (await Bun.file(profilesPath).json()) as {
            profiles?: TRow[];
          };
          const nextMap = new Map<string, TRow>();
          if (Array.isArray(data?.profiles)) {
            for (const profile of data.profiles) {
              const rawId =
                typeof profile.customer_id === "string"
                  ? profile.customer_id
                  : typeof (profile as { customerId?: unknown }).customerId ===
                      "string"
                    ? String((profile as { customerId?: unknown }).customerId)
                    : "";
              const key = rawId.trim().toUpperCase();
              if (key && !nextMap.has(key)) nextMap.set(key, profile);
            }
          }
          byId = nextMap;
          indexCache.set(profilesPath, profilesStamp, byId);
        }
        const found = byId.get(normId);
        if (found) return found;
      } catch {
        // signal-honesty: intentional-fallback-invalid-profiles-json
      }
    }

    return null;
  };

  return {
    findCustomerRow,
    clearCache: () => indexCache.clear(),
  };
}

export interface CustomersCohortInput {
  readonly backtestLeaderboard: ReadonlyArray<Record<string, unknown>>;
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly keyNumberBuyerIds: Iterable<string>;
  readonly hookSyndicateIds: Iterable<string>;
  readonly localBookRows?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly provenance?: DashboardSourceProvenance | undefined;
}

export interface CustomersCohortPayload {
  readonly cohorts: CustomersCohortsSummary;
  readonly backtestTop: ReadonlyArray<Record<string, unknown>>;
  readonly fixtures: ReadonlyArray<Record<string, unknown>>;
  readonly provenance: DashboardSourceProvenance;
}

/** Dynamically compute surveillance cohort counts with zero hardcoded numbers. */
export function computeCustomersCohortPayload(
  input: CustomersCohortInput,
): CustomersCohortPayload {
  const uniqueSurveillanceIds = new Set<string>();
  const keyNumberSet = new Set<string>();
  const hookSyndicateSet = new Set<string>();

  for (const row of input.backtestLeaderboard) {
    const id = row.customer ?? row.customerId ?? row.customer_id;
    if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
  }
  for (const row of input.fixtures) {
    const id = row.customer_id ?? row.customerId;
    if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
  }
  if (input.localBookRows) {
    for (const row of input.localBookRows) {
      const id = row.customer_id ?? row.customerId;
      if (id) uniqueSurveillanceIds.add(String(id).trim().toUpperCase());
    }
  }
  for (const key of input.keyNumberBuyerIds) {
    const norm = key.trim().toUpperCase();
    if (norm) {
      keyNumberSet.add(norm);
      uniqueSurveillanceIds.add(norm);
    }
  }
  for (const key of input.hookSyndicateIds) {
    const norm = key.trim().toUpperCase();
    if (norm) {
      hookSyndicateSet.add(norm);
      uniqueSurveillanceIds.add(norm);
    }
  }

  const nowIso = new Date().toISOString();
  const hasLocalBook = Boolean(
    input.localBookRows && input.localBookRows.length > 0,
  );
  const provenance: DashboardSourceProvenance =
    input.provenance ??
    (hasLocalBook
      ? {
          kind: "capture",
          label: "Enriched Local Book + Backtest",
          sourcePath: "enriched_customers_full.json",
          observedAt: nowIso,
        }
      : input.backtestLeaderboard.length > 0 || input.fixtures.length > 0
        ? {
            kind: "fixture",
            label: "Backtest & Synthetic Fixtures",
            sourcePath: "tests/fixtures/backtest/enriched_customers_full.json",
            observedAt: nowIso,
          }
        : {
            kind: "unavailable",
            label: "No Customer Corpora Found",
            sourcePath: null,
            observedAt: nowIso,
          });

  return {
    cohorts: {
      backtestCount: input.backtestLeaderboard.length,
      keyNumberSharpsCount: keyNumberSet.size,
      hookSyndicateCount: hookSyndicateSet.size,
      fixtureCount: input.fixtures.length,
      fullBookSpecCount: hasLocalBook
        ? input.localBookRows!.length
        : input.fixtures.length,
      uniqueSurveillanceCount: uniqueSurveillanceIds.size,
    },
    backtestTop: input.backtestLeaderboard.slice(0, 20),
    fixtures: input.fixtures,
    provenance,
  };
}
