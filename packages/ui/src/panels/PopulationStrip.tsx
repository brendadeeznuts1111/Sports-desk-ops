import type React from "react";
import summary from "../data/rankings-summary.json";

/**
 * The population behind the rankings artifact, beside the data it qualifies.
 *
 * Both the summary-book count (57,633 of 70,869 rows) and the digest are here because a lift quoted
 * without its population is ambiguous once more than one population has existed (#242): the same
 * artifact generation reports 53.7x over all graded rows and 44.7x over the summary book.
 *
 * Fed by scripts/project_rankings_summary.ts, which projects an allowlist of fields — the artifact
 * itself carries 6,228 customer rows and cannot be served to a browser.
 */
export function PopulationStrip(): React.ReactElement {
  const { population, sourceSha256 } = summary;
  const n = (value: number): string => value.toLocaleString("en-US");

  return (
    <div
      style={{
        fontSize: 12,
        lineHeight: 1.5,
        opacity: 0.8,
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "baseline",
      }}
      title={population.rule}
    >
      <strong>Population</strong>
      <span>
        {n(population.gradedRowsAfter)} of {n(population.gradedRowsBefore)}{" "}
        graded rows
      </span>
      <span aria-hidden="true">·</span>
      <span>{n(population.summaryCustomerCount)} summary-book customers</span>
      <span aria-hidden="true">·</span>
      <span>{n(population.droppedCustomers)} outside the book, excluded</span>
      <span aria-hidden="true">·</span>
      <code>digest {sourceSha256.slice(0, 12)}…</code>
    </div>
  );
}
