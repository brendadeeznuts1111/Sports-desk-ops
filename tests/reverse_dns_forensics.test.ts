import { describe, expect, test } from "bun:test";
import type { ReverseDnsClassification } from "../lib/bun_dns.ts";
import {
  buildReverseDnsForensicsView,
  formatReverseDnsForensicsAnsi,
  formatReverseDnsForensicsPlain,
} from "../lib/reverse_dns_forensics.ts";

const cloudflare: ReverseDnsClassification = {
  ipAddress: "1.1.1.1",
  hostnames: ["one.one.one.one"],
  primaryHostname: "one.one.one.one",
  isDatacenterOrCloud: true,
  isVpnOrProxySuspicious: false,
  organization: "Cloudflare Edge",
};

describe("reverse DNS forensics formatting", () => {
  test("1.1.1.1 matches terminal-style plaintext block", () => {
    const view = buildReverseDnsForensicsView(cloudflare);
    const plain = formatReverseDnsForensicsPlain(view).join("\n");
    expect(plain).toContain("Reverse DNS Forensics: 1.1.1.1");
    expect(plain).toContain("DATACENTER / VPN");
    expect(plain).toContain("HIGH RISK");
    expect(plain).toContain("one.one.one.one");
    expect(plain).toContain("Cloudflare Edge");
    expect(plain).toContain("Suspicious Proxy  : NO");
    expect(plain).toContain("Desk note");
  });

  test("ANSI formatter preserves colored block", () => {
    const ansi = formatReverseDnsForensicsAnsi(
      buildReverseDnsForensicsView(cloudflare),
    );
    expect(ansi).toContain("Reverse DNS Forensics: 1.1.1.1");
    expect(ansi).toContain("\x1b[");
  });
});
