import type { ReverseDnsClassification } from "./bun_dns.ts";

export type ReverseDnsEgressCategory =
  "RESIDENTIAL" | "DATACENTER_CLOUD" | "KNOWN_PUBLIC_DNS";

export interface ReverseDnsForensicsView extends ReverseDnsClassification {
  readonly egressCategory: ReverseDnsEgressCategory;
  readonly classificationLabel: string;
  readonly riskEmphasis: "HIGH_RISK" | "NORMAL" | "KNOWN_INFRA";
  readonly deskNote: string | null;
}

const PUBLIC_DNS_IPV4 = new Set([
  "1.1.1.1",
  "1.0.0.1",
  "8.8.8.8",
  "8.8.4.4",
  "9.9.9.9",
  "149.112.112.112",
]);

export function isKnownPublicDnsIp(ipAddress: string): boolean {
  return PUBLIC_DNS_IPV4.has(ipAddress.trim());
}

export function buildReverseDnsForensicsView(
  base: ReverseDnsClassification,
): ReverseDnsForensicsView {
  const knownPublic = isKnownPublicDnsIp(base.ipAddress);
  let egressCategory: ReverseDnsEgressCategory = "RESIDENTIAL";
  let classificationLabel = "RESIDENTIAL";
  let riskEmphasis: ReverseDnsForensicsView["riskEmphasis"] = "NORMAL";
  let deskNote: string | null = null;

  if (knownPublic) {
    egressCategory = "KNOWN_PUBLIC_DNS";
    classificationLabel = "DATACENTER / VPN";
    riskEmphasis = "HIGH_RISK";
    deskNote =
      "Known public DNS resolver (Cloudflare/Google/etc.) — not typical wager egress; validate against access logs.";
  } else if (base.isDatacenterOrCloud) {
    egressCategory = "DATACENTER_CLOUD";
    classificationLabel = "DATACENTER / VPN";
    riskEmphasis = "HIGH_RISK";
  }

  return {
    ...base,
    egressCategory,
    classificationLabel,
    riskEmphasis,
    deskNote,
  };
}

export function formatReverseDnsForensicsPlain(
  view: ReverseDnsForensicsView,
): readonly string[] {
  const riskTag =
    view.riskEmphasis === "HIGH_RISK"
      ? "🚨 HIGH RISK"
      : view.riskEmphasis === "KNOWN_INFRA"
        ? "ℹ️ KNOWN INFRA"
        : "🟢 NORMAL";
  const lines = [
    `🌐 Reverse DNS Forensics: ${view.ipAddress}`,
    `  Classification    :  ${view.classificationLabel}  ${riskTag}`,
    `  Resolved Hostname : ${view.primaryHostname ?? "None (NXDOMAIN)"}`,
    `  Organization      : ${view.organization}`,
    `  Suspicious Proxy  : ${view.isVpnOrProxySuspicious ? "YES" : "NO"}`,
  ];
  if (view.deskNote) {
    lines.push(`  Desk note         : ${view.deskNote}`);
  }
  return lines;
}

export function formatReverseDnsForensicsAnsi(
  view: ReverseDnsForensicsView,
): string {
  const classTag = view.isDatacenterOrCloud
    ? "\x1b[1;41;37m DATACENTER / VPN \x1b[0m \x1b[31m🚨 HIGH RISK\x1b[0m"
    : "\x1b[1;42;30m RESIDENTIAL \x1b[0m \x1b[32m🟢 NORMAL\x1b[0m";
  const lines = [
    `\x1b[1;36m🌐 Reverse DNS Forensics: ${view.ipAddress}\x1b[0m`,
    `  Classification    : ${classTag}`,
    `  Resolved Hostname : \x1b[1;33m${view.primaryHostname ?? "None (NXDOMAIN)"}\x1b[0m`,
    `  Organization      : \x1b[37m${view.organization}\x1b[0m`,
    `  Suspicious Proxy  : ${view.isVpnOrProxySuspicious ? "\x1b[31mYES\x1b[0m" : "\x1b[32mNO\x1b[0m"}`,
  ];
  if (view.deskNote) {
    lines.push(`  Desk note         : \x1b[90m${view.deskNote}\x1b[0m`);
  }
  return lines.join("\n");
}
