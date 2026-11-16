import type React from "react";
import type { ReverseDnsForensicsView } from "../../../../lib/reverse_dns_forensics.ts";
import { formatReverseDnsForensicsPlain } from "../../../../lib/reverse_dns_forensics.ts";

export interface ReverseDnsForensicsCardProps {
  readonly view: ReverseDnsForensicsView;
}

export function ReverseDnsForensicsCard({
  view,
}: ReverseDnsForensicsCardProps): React.ReactElement {
  const lines = formatReverseDnsForensicsPlain(view);
  const highRisk = view.riskEmphasis === "HIGH_RISK";

  return (
    <div
      data-reverse-dns-forensics="true"
      data-ip={view.ipAddress}
      data-egress={view.egressCategory}
      style={{
        marginTop: "8px",
        padding: "10px 12px",
        borderRadius: "8px",
        border: `1px solid ${highRisk ? "rgba(248, 113, 113, 0.45)" : "rgba(74, 222, 128, 0.35)"}`,
        backgroundColor: highRisk
          ? "rgba(127, 29, 29, 0.25)"
          : "rgba(6, 78, 59, 0.2)",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        lineHeight: 1.55,
        color: "#e2e8f0",
        whiteSpace: "pre-wrap",
      }}
    >
      {lines.map((line, idx) => {
        if (idx === 0) {
          return (
            <div key={line} style={{ fontWeight: 700, color: "#38bdf8" }}>
              {line}
            </div>
          );
        }
        if (line.includes("Classification")) {
          return (
            <div key={line} style={{ color: highRisk ? "#fca5a5" : "#86efac" }}>
              {line}
            </div>
          );
        }
        if (line.includes("Desk note")) {
          return (
            <div key={line} style={{ color: "#94a3b8", marginTop: "4px" }}>
              {line}
            </div>
          );
        }
        return <div key={line}>{line}</div>;
      })}
    </div>
  );
}
