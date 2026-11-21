import { describe, expect, test } from "bun:test";

import {
  ipv6GroupStrings,
  ipv6Prefix64,
  parseIpv6Hextets,
  replaceIpv6InText,
} from "../lib/ipv6.ts";

describe("IPv6 expand /64 helper", () => {
  test("expands compressed forms of the same /64 to one prefix", () => {
    const same = "2001:db8:0:0";
    expect(ipv6Prefix64("2001:db8::1")).toBe(same);
    expect(ipv6Prefix64("2001:0DB8:0:0::2")).toBe(same);
    expect(ipv6Prefix64("2001:db8:0:0:ffff::1")).toBe(same);
    expect(ipv6Prefix64("2001:db8:1::1")).toBe("2001:db8:1:0");
  });

  test("handles loopback, IPv4-mapped addresses, zone ids, and brackets", () => {
    expect(ipv6GroupStrings("::1")).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "0",
      "1",
    ]);
    expect(ipv6Prefix64("::1")).toBe("0:0:0:0");
    expect(ipv6Prefix64("::ffff:192.0.2.4")).toBe("0:0:0:0");
    expect(ipv6GroupStrings("::ffff:192.0.2.4")).toEqual([
      "0",
      "0",
      "0",
      "0",
      "0",
      "ffff",
      "c000",
      "204",
    ]);
    expect(ipv6Prefix64("fe80::1%eth0")).toBe("fe80:0:0:0");
    expect(ipv6Prefix64("[2001:db8::1]")).toBe("2001:db8:0:0");
  });

  test("invalid input returns null", () => {
    expect(parseIpv6Hextets("")).toBeNull();
    expect(parseIpv6Hextets("not-an-ip")).toBeNull();
    expect(parseIpv6Hextets("192.0.2.1")).toBeNull();
    expect(parseIpv6Hextets("2001:db8::1::2")).toBeNull();
    expect(ipv6Prefix64("gggg::1")).toBeNull();
  });

  test("replaceIpv6InText only rewrites validated literals", () => {
    const out = replaceIpv6InText(
      "peer 2001:db8::1 at 10:00:00 plus ::ffff:192.0.2.4",
      () => "<v6>",
    );
    expect(out).toBe("peer <v6> at 10:00:00 plus <v6>");
  });
});
