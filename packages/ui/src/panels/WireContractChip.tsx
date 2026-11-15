import type React from "react";
import type { WagersWireContractSummary } from "../types.ts";

export interface WireContractChipProps {
  readonly summary: WagersWireContractSummary | null;
  /** Feed or registry error; wins over a stale clean summary. */
  readonly error: string | null;
}

/**
 * Vendor wire-contract badge for the wagers tab header.
 *
 * The chip is a `<details>` so the evidence is one click away without a modal
 * or extra state: the summary answers "is the feed conformant", the panel lists
 * the capture it was checked against, how many rows were skipped as sentinel
 * noise, and every violation with rendered examples.
 */
export function WireContractChip({
  summary,
  error,
}: WireContractChipProps): React.ReactElement | null {
  if (summary === null && error === null) return null;

  const ok = summary !== null && error === null && summary.ok;
  const label = error
    ? "⚠ wire: unavailable"
    : ok && summary
      ? `✓ wire: ${summary.rows} rows`
      : summary && summary.violations.length > 0
        ? `⚠ wire: ${summary.violations.length} issue(s)`
        : // ok:false with no parseable violations is an invalid summary, not a
          // clean one: never render "0 issue(s)".
          "⚠ wire: invalid summary";

  const title = error
    ? `Wire contract unavailable: ${error}`
    : summary && ok
      ? `${summary.fields_checked.join(", ")} checked against ${summary.capture} (sha ${summary.capture_sha256.slice(0, 12)}…, enum_source=${summary.enum_source}); ${summary.skipped_rows} sentinel row(s) skipped`
      : (summary?.violations ?? [])
          .map(
            (v) =>
              `${v.field}: ${v.kind} ×${v.count} (${v.examples.join(", ")})`,
          )
          .join(" · ");

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <details style={{ display: "inline-flex" }}>
        <summary
          title={`${title} — click for contract details`}
          style={{
            listStyle: "none",
            cursor: "pointer",
            fontSize: "10px",
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: "999px",
            color: ok ? "#6ee7b7" : "#fca5a5",
            backgroundColor: ok
              ? "rgba(16, 185, 129, 0.14)"
              : "rgba(239, 68, 68, 0.16)",
            border: `1px solid ${
              ok ? "rgba(52, 211, 153, 0.4)" : "rgba(248, 113, 113, 0.45)"
            }`,
          }}
        >
          {label}
        </summary>

        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 40,
            width: "min(520px, 88vw)",
            padding: "10px 12px",
            borderRadius: "8px",
            backgroundColor: "#0b1220",
            border: "1px solid #1e293b",
            boxShadow: "0 12px 28px rgba(2, 6, 23, 0.55)",
            fontSize: "11px",
            color: "#cbd5e1",
            lineHeight: 1.5,
          }}
        >
          {error ? (
            <div style={{ color: "#fca5a5", fontWeight: 700 }}>
              Contract unavailable: {error}
            </div>
          ) : null}

          {/* A stale summary is suppressed on error: only the failure is shown. */}
          {summary && error === null ? (
            <>
              <div style={{ color: "#94a3b8" }}>
                <b style={{ color: "#e2e8f0" }}>{summary.capture}</b>
                {" · sha "}
                {summary.capture_sha256.slice(0, 16)}…{" · enum_source "}
                {summary.enum_source}
              </div>
              <div style={{ color: "#94a3b8", marginTop: "2px" }}>
                {summary.rows} row(s) checked · {summary.skipped_rows} sentinel
                row(s) skipped · fields: {summary.fields_checked.join(", ")}
              </div>

              {summary.violations.length > 0 ? (
                <ul style={{ margin: "6px 0 0", paddingLeft: "16px" }}>
                  {summary.violations.map((v) => (
                    <li
                      key={`${v.field}:${v.kind}`}
                      style={{ color: "#fca5a5" }}
                    >
                      <b>{v.field}</b> · {v.kind} ×{v.count}
                      {v.examples.length > 0 ? (
                        <span style={{ color: "#94a3b8" }}>
                          {" "}
                          ({v.examples.join(", ")})
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div style={{ color: "#6ee7b7", marginTop: "4px" }}>
                  No type or nullability violations.
                </div>
              )}

              {summary.enum_source === "observed" ? (
                <div style={{ color: "#64748b", marginTop: "6px" }}>
                  Enum differences are not violations: the candidate set is
                  observed from the capture window, not declared by the vendor.
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </details>
    </span>
  );
}
