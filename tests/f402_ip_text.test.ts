import { describe, expect, test } from "bun:test";

import {
  isIpv6Candidate,
  replaceIpsInText,
  textContainsIp,
} from "../lib/f402_ip_text.ts";

describe("f402 ip text", () => {
  test("replaces every IPv4 and IPv6 occurrence, not just the first", () => {
    const text =
      "from 10.1.2.3 then 10.9.8.7, later 2600:380::1 and 2607:fb90:1:2:3:4:5:6";
    const seen: string[] = [];
    const out = replaceIpsInText(text, (ip, family) => {
      seen.push(`${family}:${ip}`);
      return "<ip>";
    });
    expect(out).toBe("from <ip> then <ip>, later <ip> and <ip>");
    expect(seen).toEqual([
      "ipv4:10.1.2.3",
      "ipv4:10.9.8.7",
      "ipv6:2600:380::1",
      "ipv6:2607:fb90:1:2:3:4:5:6",
    ]);
    expect(textContainsIp(out)).toBe(false);
  });

  test("is stateless across repeated calls", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(textContainsIp("a 203.0.113.9 b")).toBe(true);
      expect(textContainsIp("a 203.0.113.9 b 198.51.100.1")).toBe(true);
    }
  });

  test("clock times, ISO timestamps and scope operators stay text", () => {
    for (const text of [
      "10:00:00",
      "2026-11-01T10:00:00.000Z",
      "2026-11-01 10:00:00",
      "Manager::getPending",
      "ip:0123456789abcdef",
    ]) {
      expect(textContainsIp(text)).toBe(false);
      expect(replaceIpsInText(text, () => "<ip>")).toBe(text);
    }
    expect(isIpv6Candidate("::")).toBe(false);
    expect(isIpv6Candidate("fe80::1")).toBe(true);
  });

  test("an IPv6 next to a timestamp is still found", () => {
    const text = "2026-11-01T10:00:00Z login from 2600:380::1";
    expect(textContainsIp(text)).toBe(true);
    expect(replaceIpsInText(text, () => "<ip>")).toBe(
      "2026-11-01T10:00:00Z login from <ip>",
    );
  });
});
