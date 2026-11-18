import { describe, expect, test } from "bun:test";

import {
  prefetchDns,
  readDnsCacheStats,
  warmCaptureNetwork,
} from "./preflight.ts";

describe("preflight dns warm", () => {
  test("prefetchDns and warmCaptureNetwork do not throw for fantasy402", () => {
    expect(() => prefetchDns("fantasy402.com", 443)).not.toThrow();
    const warmed = warmCaptureNetwork("https://www.fantasy402.com");
    expect(warmed.host).toBe("www.fantasy402.com");
    expect(warmed.port).toBe(443);
  });

  test("readDnsCacheStats returns object or undefined", () => {
    prefetchDns("example.com", 443);
    const stats = readDnsCacheStats();
    if (stats !== undefined) {
      expect(typeof stats).toBe("object");
    }
  });

  test("prefetchDns skips ports Bun.dns.prefetch would reject", () => {
    // Bun.dns.prefetch throws RangeError for these (measured on 1.4.4); the
    // prefetch is best-effort, so the wrapper must not propagate it.
    for (const port of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      443.5,
      0,
      -1,
      65536,
    ]) {
      expect(() => prefetchDns("localhost", port)).not.toThrow();
    }
    expect(() => prefetchDns("localhost", 65535)).not.toThrow();
    expect(() => prefetchDns("   ", 70000)).not.toThrow();
  });
});
