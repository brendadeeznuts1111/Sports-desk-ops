#!/usr/bin/env bun
/**
 * @file scripts/generate_value_artifacts.ts
 * @description Produces the two static artifacts the portal serves for cross-domain value:
 *              `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json`.
 *
 * Combo gates are always recomputed (cache-backed). The bridge artifact is recomputed offline
 * unless `--bridge-json <path>` reuses a live `dx bridge value --live --json` capture.
 *
 * The CFB event index is cached next to the combo cache, so a run with `--offline` reproduces the
 * artifacts without network access once the index has been fetched at least once.
 *
 * Usage:
 *   bun run scripts/generate_value_artifacts.ts --wallet-file scratch/seed.txt \
 *     --bridge-json scratch/bridge-live-all.json --no-leaderboard
 *   bun run scripts/generate_value_artifacts.ts --offline --bridge-json scratch/bridge-live-all.json
 */

import { mkdir } from "node:fs/promises";
import {
  buildComboUniquenessReport,
  checkComboSubset,
  type ComboGate,
} from "../lib/combo_uniqueness.ts";
import {
  buildAttributionRegistry,
  buildCustomerPolyBridge,
  loadCustomerBook,
  type CustomerPolyBridgeReport,
} from "../lib/customer_poly_bridge.ts";

function flag(
  args: readonly string[],
  names: readonly string[],
  fallback: string,
): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && index + 1 < args.length) return args[index + 1]!;
  }
  return fallback;
}

const args = process.argv.slice(2);
const outDir = flag(args, ["--out-dir"], "docs");
const walletFile = flag(args, ["--wallet-file"], Bun.env.WALLET_FILE ?? "");
const bridgeJsonPath = flag(args, ["--bridge-json"], "");
const gates: readonly ComboGate[] = ["permissive", "all-legs-cfb", "full-game"];

const reports = new Map<
  ComboGate,
  Awaited<ReturnType<typeof buildComboUniquenessReport>>
>();
for (const gate of gates) {
  reports.set(
    gate,
    await buildComboUniquenessReport({
      gate,
      ...(walletFile === "" ? {} : { walletFile }),
      leaderboard: !args.includes("--no-leaderboard"),
      seedTrades: args.includes("--seed-trades"),
      includeClosedGames: !args.includes("--open-only"),
      maxComboPages: Number(flag(args, ["--max-combo-pages"], "3")),
      cacheDir: flag(args, ["--cache-dir"], "scratch/cfb-combo-cache"),
      concurrency: 6,
      cacheGames: true,
      offline: args.includes("--offline"),
    }),
  );
}
const permissive = reports.get("permissive")!;
const allCfb = reports.get("all-legs-cfb")!;
const fullGame = reports.get("full-game")!;
const chain = [
  checkComboSubset(permissive, allCfb),
  checkComboSubset(allCfb, fullGame),
];

const comboArtifact = {
  schemaVersion: 1,
  generatedAtIso: new Date().toISOString(),
  index: permissive.index,
  gates: Object.fromEntries(
    gates.map((gate) => {
      const report = reports.get(gate)!;
      return [
        gate,
        {
          kept: report.comboRecords,
          permissiveCombos: report.permissiveCombos,
          exclusions: report.exclusions,
          includedCrossGame: report.includedCrossGame,
          distinctWallets: report.global.distinctWallets,
        },
      ];
    }),
  ),
  diagnostics: permissive.diagnostics,
  dedupe: {
    collapsed: permissive.duplicatesCollapsed,
    byId: permissive.duplicatesCollapsedById,
    byLegSet: permissive.duplicatesCollapsedByLegSet,
  },
  chain: {
    edges: chain.map((check) => ({
      treatment: check.treatmentGate,
      reference: check.referenceGate,
      referenceSize: check.reference,
      treatmentSize: check.treatment,
      leaks: check.leaks.length,
      vacuous: check.vacuous,
    })),
    leaks: chain.reduce((sum, check) => sum + check.leaks.length, 0),
    vacuous: chain.some((check) => check.vacuous),
  },
  walletsScanned: permissive.walletsScanned,
};

function compactBridge(report: CustomerPolyBridgeReport) {
  return {
    schemaVersion: 1,
    generatedAtIso: report.generatedAtIso,
    evidence: report.evidence,
    coverage: report.coverage,
    value: report.value,
    leads: report.customers
      .filter((row) => row.polyBasisPnlUsd !== null)
      .slice(0, 10)
      .map((row) => ({
        customerId: row.customerId,
        agentId: row.agentId,
        wallet: row.wallet,
        deskPnlUsd: row.customerDeskPnlUsd,
        polyPnlUsd: row.polyBasisPnlUsd,
        basis: row.pnlBasis,
        verdict: row.verdict,
        priorityUsd: row.priorityUsd,
      })),
    quarantined: report.quarantined.length,
  };
}

let bridgeArtifact: ReturnType<typeof compactBridge>;
if (bridgeJsonPath !== "") {
  const parsed = (await Bun.file(
    bridgeJsonPath,
  ).json()) as CustomerPolyBridgeReport;
  const rows = Array.isArray(parsed.customers) ? parsed.customers : [];
  bridgeArtifact = compactBridge({ ...parsed, customers: rows });
} else {
  const book = await loadCustomerBook();
  bridgeArtifact = compactBridge(
    buildCustomerPolyBridge({
      customers: book,
      registry: buildAttributionRegistry(),
    }),
  );
}

await mkdir(outDir, { recursive: true });
await Bun.write(
  `${outDir}/combo-uniqueness.json`,
  `${JSON.stringify(comboArtifact, null, 2)}\n`,
);
await Bun.write(
  `${outDir}/cross-domain-bridge.json`,
  `${JSON.stringify(bridgeArtifact, null, 2)}\n`,
);

console.log(
  `value artifacts: gates ${gates.map((gate) => `${gate}=${reports.get(gate)!.comboRecords}`).join(" ")} | index ${permissive.index.games} games | chain leaks ${comboArtifact.chain.leaks}${comboArtifact.chain.vacuous ? " (vacuous)" : ""}`,
);
console.log(
  `bridge artifact: ${bridgeArtifact.evidence} | linked ${bridgeArtifact.coverage.linkedCustomers} | gross ${bridgeArtifact.value.polyGrossPnlUsd}`,
);
