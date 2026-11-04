/**
 * Catalog diff report: exit classification + PR-ready markdown.
 */

import type {
  CatalogProvenance,
  CatalogSportDiff,
  Fantasy402SportCatalog,
} from "./fantasy402_sport_catalog.ts";
import {
  allExpectedEmptyPaths,
  computeCatalogProvenance,
  deriveCollisionsFromSports,
  diffEmptySubSportNameAnalysis,
  diffFantasy402SportCatalogs,
  emptyNameQualityRegression,
  liveSportSurfaceChanged,
  uniquePeriodTemplateKeys,
} from "./fantasy402_sport_catalog.ts";

export type CatalogDiffTableRow = {
  category: string;
  before: string;
  after: string;
  detail: string;
};

export type CatalogDiffReport = {
  exitCode: number;
  exitReason: string;
  rows: CatalogDiffTableRow[];
  sportDetails: string[];
  fixtureProvenance: CatalogProvenance;
  probeProvenance: CatalogProvenance;
  sportChanges: CatalogSportDiff[];
};

function digestShort(hex: string): string {
  return `${hex.slice(0, 8)}…`;
}

function formatSportChangeDetail(ch: CatalogSportDiff): string {
  const parts: string[] = [];
  if (ch.subSportsAdded.length) {
    parts.push(
      `+${ch.subSportsAdded.length} events (${ch.subSportsAdded.map((s) => s.code).join(", ")})`,
    );
  }
  if (ch.subSportsRemoved.length) {
    parts.push(
      `-${ch.subSportsRemoved.length} events (${ch.subSportsRemoved.map((s) => s.code).join(", ")})`,
    );
  }
  if (ch.subSportNameChanges.length) {
    parts.push(
      ch.subSportNameChanges
        .map((n) => `${n.code}: "${n.fixtureName}"→"${n.probeName}"`)
        .join("; "),
    );
  }
  if (ch.periodsChanged) {
    parts.push(
      `periods: ${ch.fixturePeriodTemplate || "—"} → ${ch.probePeriodTemplate}`,
    );
  }
  return parts.join(" · ") || "—";
}

function collisionSetSize(catalog: Fantasy402SportCatalog): number {
  return deriveCollisionsFromSports(catalog.sports).length;
}

function diffObservedCollisionDetail(
  fixture: Fantasy402SportCatalog,
  probe: Fantasy402SportCatalog,
): string {
  const f = deriveCollisionsFromSports(fixture.sports);
  const p = deriveCollisionsFromSports(probe.sports);
  const fCodes = new Set(f.map((c) => c.code));
  const pCodes = new Set(p.map((c) => c.code));
  const added = p.filter((c) => !fCodes.has(c.code));
  const removed = f.filter((c) => !pCodes.has(c.code));
  const changed = p.filter((c) => {
    const prev = f.find((x) => x.code === c.code);
    return prev && prev.sports.join("\0") !== c.sports.join("\0");
  });
  const parts: string[] = [];
  for (const c of added) {
    parts.push(`+${c.code} (${c.sports.join(", ")})`);
  }
  for (const c of changed) {
    parts.push(`~${c.code} (${c.sports.join(", ")})`);
  }
  for (const c of removed) {
    parts.push(`-${c.code}`);
  }
  return parts.length > 0 ? parts.join("; ") : "unchanged";
}

function hasStructuralChange(
  diff: ReturnType<typeof diffFantasy402SportCatalogs>,
  collisionChanged: boolean,
): boolean {
  if (collisionChanged) return false;
  if (diff.sportsAdded.length > 0 || diff.sportsRemoved.length > 0) {
    return true;
  }
  for (const ch of diff.sportChanges) {
    if (
      ch.subSportsAdded.length > 0 ||
      ch.subSportsRemoved.length > 0 ||
      ch.subSportNameChanges.length > 0 ||
      ch.periodsChanged
    ) {
      return true;
    }
  }
  return diff.subSportTreeChanged || diff.periodMenusChanged;
}

function migrationRiskWarnings(
  fixture: Fantasy402SportCatalog,
  probe: Fantasy402SportCatalog,
): string | null {
  if (!liveSportSurfaceChanged(fixture, probe)) return null;

  const risks = fixture.migrationRisks ?? probe.migrationRisks ?? [];
  const liveRisk = risks.find(
    (r) => r.code === "LIVE" || r.kind === "pseudo-sport",
  );
  if (!liveRisk) {
    return "LIVE subSports changed (not timestamp-only) — check link_id migration";
  }
  return `LIVE subSports changed: ${liveRisk.note}`;
}

function shortTemplateLabel(template: string): string {
  if (template === "0:Game") return "Game-only";
  if (template.includes("Innings")) return "Baseball";
  if (template.includes("Quarter")) return "Quarters";
  if (template.includes("Period")) return "Hockey";
  if (template.includes("1st Half")) return "Halves";
  return template.slice(0, 24);
}

export function buildCatalogDiffReport(
  fixture: Fantasy402SportCatalog,
  probe: Fantasy402SportCatalog,
): CatalogDiffReport {
  const diff = diffFantasy402SportCatalogs(fixture, probe);
  const fixtureProvenance = computeCatalogProvenance(fixture);
  const probeProvenance = computeCatalogProvenance(probe);

  const collisionChanged =
    fixtureProvenance.digests.observedCollisionSetSha256Hex !==
    probeProvenance.digests.observedCollisionSetSha256Hex;

  const emptyRegression = emptyNameQualityRegression(
    fixtureProvenance.metrics.emptyNames,
    probeProvenance.metrics.emptyNames,
  );
  const emptyDetail = diffEmptySubSportNameAnalysis(
    fixtureProvenance.metrics.emptyNames,
    probeProvenance.metrics.emptyNames,
  );

  const structural = hasStructuralChange(diff, collisionChanged);

  let exitCode = 0;
  let exitReason = "match";
  if (collisionChanged) {
    exitCode = 3;
    exitReason = "collision_set_changed";
  } else if (emptyRegression) {
    exitCode = 4;
    exitReason = "empty_name_quality_regression";
  } else if (structural) {
    exitCode = 2;
    exitReason = "structural_delta";
  }

  const fTemplates = uniquePeriodTemplateKeys(fixture);
  const pTemplates = uniquePeriodTemplateKeys(probe);
  const templatesAdded = pTemplates.filter((t) => !fTemplates.includes(t));
  const templatesRemoved = fTemplates.filter((t) => !pTemplates.includes(t));

  let periodDetail = "unchanged";
  if (templatesAdded.length || templatesRemoved.length) {
    const bits: string[] = [];
    if (templatesAdded.length) {
      bits.push(
        `+${templatesAdded.length} template(s) (${templatesAdded.map(shortTemplateLabel).join(", ")})`,
      );
    }
    if (templatesRemoved.length) {
      bits.push(`-${templatesRemoved.length} template(s)`);
    }
    periodDetail = bits.join("; ");
  }

  const sportsDetail =
    diff.sportsAdded.length || diff.sportsRemoved.length
      ? [
          diff.sportsAdded.length
            ? `+${diff.sportsAdded.length}: ${diff.sportsAdded.map((s) => `"${s}"`).join(", ")}`
            : "",
          diff.sportsRemoved.length
            ? `-${diff.sportsRemoved.length}: ${diff.sportsRemoved.map((s) => `"${s}"`).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("; ")
      : "unchanged";

  const eventsDelta =
    probeProvenance.metrics.computedCounts.subSportCount -
    fixtureProvenance.metrics.computedCounts.subSportCount;
  let eventsDetail = "unchanged";
  if (eventsDelta !== 0) {
    const bySport = diff.sportChanges
      .filter(
        (c) =>
          c.subSportsAdded.length > 0 ||
          c.subSportsRemoved.length > 0 ||
          c.subSportNameChanges.length > 0,
      )
      .map((c) => `**${c.sport}** — ${formatSportChangeDetail(c)}`);
    eventsDetail =
      bySport.length > 0
        ? `${eventsDelta > 0 ? "+" : ""}${eventsDelta}; ${bySport.join("; ")}`
        : `${eventsDelta > 0 ? "+" : ""}${eventsDelta}`;
  }

  const rows: CatalogDiffTableRow[] = [
    {
      category: "Sports",
      before: String(fixtureProvenance.metrics.computedCounts.sportCount),
      after: String(probeProvenance.metrics.computedCounts.sportCount),
      detail: sportsDetail,
    },
    {
      category: "Events",
      before: String(fixtureProvenance.metrics.computedCounts.subSportCount),
      after: String(probeProvenance.metrics.computedCounts.subSportCount),
      detail: eventsDetail,
    },
    {
      category: "Periods",
      before: String(fixtureProvenance.metrics.computedCounts.sportPeriodCount),
      after: String(probeProvenance.metrics.computedCounts.sportPeriodCount),
      detail: periodDetail,
    },
    {
      category: "Collisions (observed)",
      before: String(collisionSetSize(fixture)),
      after: String(collisionSetSize(probe)),
      detail: collisionChanged
        ? diffObservedCollisionDetail(fixture, probe)
        : "unchanged",
    },
    {
      category: "Empty (expected)",
      before: String(
        fixtureProvenance.metrics.emptyNames.expectedEmptySubSportNameCount,
      ),
      after: String(
        probeProvenance.metrics.emptyNames.expectedEmptySubSportNameCount,
      ),
      detail:
        fixtureProvenance.metrics.emptyNames.expectedEmptySubSportNameCount ===
        probeProvenance.metrics.emptyNames.expectedEmptySubSportNameCount
          ? "unchanged"
          : diffEmptySubSportNameAnalysis(
              fixtureProvenance.metrics.emptyNames,
              probeProvenance.metrics.emptyNames,
            ),
    },
    {
      category: "Empty (unexpected)",
      before: String(
        fixtureProvenance.metrics.emptyNames.unexpectedEmptySubSportNameCount,
      ),
      after: String(
        probeProvenance.metrics.emptyNames.unexpectedEmptySubSportNameCount,
      ),
      detail: emptyDetail,
    },
    {
      category: "subSport digest",
      before: digestShort(fixtureProvenance.digests.subSportTreeSha256Hex),
      after: digestShort(probeProvenance.digests.subSportTreeSha256Hex),
      detail: diff.subSportTreeChanged ? "CHANGED" : "unchanged",
    },
    {
      category: "period digest",
      before: digestShort(fixtureProvenance.digests.periodMenusSha256Hex),
      after: digestShort(probeProvenance.digests.periodMenusSha256Hex),
      detail: diff.periodMenusChanged ? "CHANGED" : "unchanged",
    },
    {
      category: "collision digest (observed)",
      before: digestShort(
        fixtureProvenance.digests.observedCollisionSetSha256Hex,
      ),
      after: digestShort(probeProvenance.digests.observedCollisionSetSha256Hex),
      detail: collisionChanged ? "CHANGED" : "unchanged",
    },
  ];

  const sportDetails = diff.sportChanges.map(
    (ch) => `**${ch.sport}** — ${formatSportChangeDetail(ch)}`,
  );

  const migrationDetail = migrationRiskWarnings(fixture, probe);
  if (migrationDetail) {
    rows.push({
      category: "Migration risks",
      before: "—",
      after: "—",
      detail: migrationDetail,
    });
  }

  const pathsChanged = !Bun.deepEquals(
    allExpectedEmptyPaths(fixture.expectedEmptySubSportPaths).sort(),
    allExpectedEmptyPaths(probe.expectedEmptySubSportPaths).sort(),
    true,
  );
  if (pathsChanged) {
    rows.push({
      category: "Expected empty paths",
      before: String(
        allExpectedEmptyPaths(fixture.expectedEmptySubSportPaths).length,
      ),
      after: String(
        allExpectedEmptyPaths(probe.expectedEmptySubSportPaths).length,
      ),
      detail: "expectedEmptySubSportPaths set changed — reviewer sign-off",
    });
  }

  return {
    exitCode,
    exitReason,
    rows,
    sportDetails,
    fixtureProvenance,
    probeProvenance,
    sportChanges: diff.sportChanges,
  };
}

export function renderCatalogDiffMarkdown(report: CatalogDiffReport): string {
  const lines: string[] = [
    "| Category | Before | After | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const row of report.rows) {
    const detail = row.detail.replace(/\|/g, "\\|");
    lines.push(
      `| ${row.category} | ${row.before} | ${row.after} | ${detail} |`,
    );
  }
  if (report.sportDetails.length > 0) {
    lines.push("");
    lines.push("### Per-sport detail");
    lines.push("");
    for (const d of report.sportDetails) {
      lines.push(`- ${d}`);
    }
  }
  lines.push("");
  lines.push(`exit: ${report.exitCode} (${report.exitReason})`);
  return lines.join("\n");
}
