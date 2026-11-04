import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { looksBinary, scanText } from "../lib/secret_scan.ts";

/**
 * The check exists because a HAR with "redacted" in its name shipped 311-character `cf_clearance`
 * and 199-character `__cf_bm` values while the sweep it was certified by said violationCount 0.
 * The sweep matched a raw `Cookie:` header line and never looked at a HAR's
 * {"name":"cookie","value":"…"} shape.
 */

const CLEARANCE = `cf_clearance=${"C".repeat(311)}`;
const BOT_MGMT = `__cf_bm=${"b".repeat(199)}`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${"p".repeat(40)}.${"s".repeat(43)}`;

describe("scanText", () => {
  test("finds the four shapes that matter", () => {
    const kinds = scanText(
      [
        CLEARANCE,
        BOT_MGMT,
        `Authorization: Bearer ${JWT}`,
        // Built at runtime: the literal would make this file fail its own scan once it is
        // tracked, which is exactly what happened the first time this test was committed.
        `-----BEGIN ${"RSA "}PRIVATE KEY-----`,
      ].join("\n"),
    ).map((finding) => finding.kind);
    expect(kinds).toContain("cloudflare-clearance");
    expect(kinds).toContain("cloudflare-bot-management");
    expect(kinds).toContain("jwt");
    expect(kinds).toContain("bearer-token");
    expect(kinds).toContain("private-key");
  });

  test("reports the line and never the value", () => {
    const [finding] = scanText(`first line\n${CLEARANCE}`);
    expect(finding?.line).toBe(2);
    expect(finding?.masked).toContain("311 chars");
    expect(finding?.masked).not.toContain("C".repeat(20));
  });

  test("short test values are not credentials", () => {
    expect(scanText("cf_clearance=live123")).toEqual([]);
    expect(scanText("__cf_bm=abc")).toEqual([]);
    expect(scanText("Bearer abcdefghijkl")).toEqual([]);
  });

  test("the documented placeholder is not a credential", () => {
    expect(scanText("Bearer <SPORTSDESK_ADMIN_TOKEN>")).toEqual([]);
    expect(scanText("Authorization: Bearer ${TOKEN}")).toEqual([]);
  });

  test("a published example token is allowed, its neighbours are not", () => {
    const publicSample =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(scanText(publicSample)).toEqual([]);
    // One character different is a different token.
    expect(scanText(publicSample.slice(0, -1) + "X").length).toBe(1);
  });

  test("a clean file has no findings", () => {
    expect(
      scanText("const token = process.env.SPORTSDESK_ADMIN_TOKEN;"),
    ).toEqual([]);
  });
});

describe("the scanner's own fixtures", () => {
  test("no tracked file carries the shapes it looks for", () => {
    // The pattern is assembled in the private-key case above so this file can be scanned like
    // any other; this assertion is the regression guard for that.
    const source = readFileSync(import.meta.path, "utf8");
    expect(scanText(source)).toEqual([]);
  });
});

describe("looksBinary", () => {
  test("a NUL byte marks a file as binary", () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x00]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });
});
