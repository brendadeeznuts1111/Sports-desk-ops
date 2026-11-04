#!/usr/bin/env bun
/**
 * @file dx_iptracker.ts
 * `./bin/dx iptracker` — per-office and cross-office bet-ticker <-> IP-tracker clusters.
 * Extracted verbatim from the inline `bun -e` block in bin/dx so it is typechecked and testable.
 */
import {
  PER_OFFICE_IP_TRACKER_CLUSTERS,
  buildPerOfficeIpMatcherPayload,
} from "../lib/bet_ticker_ip_tracker_bridge.ts";

export function printIpTracker(): void {
  console.log(
    "================================================================================================================",
  );
  console.log(
    "  🌐 BET-TICKER <-> IP-TRACKER (getWebLog Modes A/B/C/I) PER-OFFICE & CROSS-OFFICE MATCH REPORT",
  );
  console.log(
    "================================================================================================================",
  );
  for (const c of PER_OFFICE_IP_TRACKER_CLUSTERS) {
    const payload = buildPerOfficeIpMatcherPayload({
      officeAgentId: c.officeAgentId,
    });
    const cross = c.crossOfficeLogins.length
      ? " | Cross-Office: " +
        c.crossOfficeLogins
          .map((x) => x.officeAgentId + "/" + x.loginId)
          .join(", ")
      : "";
    console.log(
      `  • Office: ${c.officeAgentId.padEnd(10)} [Mode B customerID="${payload.customerID}"] | ${c.matchClassification.padEnd(32)} | IP: ${c.sharedIpOrSubnet.padEnd(28)} | Dwell: ${c.modeASessionDwellSeconds}s | MFCS: ${c.mfcsCompositeScore}/100 | Logins: ${c.matchedLoginsInOffice.join(", ")}${cross}`,
    );
  }
  console.log(
    "================================================================================================================",
  );
}

if (import.meta.main) printIpTracker();
