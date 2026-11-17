import { describe, expect, test } from "bun:test";

import { resolveDbChannelBinding, resolveDbTlsConfig } from "../lib/db.ts";

const FP_COMPACT = "ab".repeat(32);
const FP_COLON = (FP_COMPACT.match(/.{2}/g) ?? []).join(":").toUpperCase();

describe("resolveDbChannelBinding", () => {
  test("is unset when the env is absent or empty", () => {
    expect(resolveDbChannelBinding({})).toBeUndefined();
    expect(
      resolveDbChannelBinding({ SPORTSDESK_DB_CHANNEL_BINDING: " " }),
    ).toBeUndefined();
  });

  test("accepts the three PostgreSQL modes", () => {
    for (const mode of ["disable", "prefer", "require"] as const) {
      expect(
        resolveDbChannelBinding({ SPORTSDESK_DB_CHANNEL_BINDING: mode }),
      ).toBe(mode);
      expect(
        resolveDbChannelBinding({
          SPORTSDESK_DB_CHANNEL_BINDING: mode.toUpperCase(),
        }),
      ).toBe(mode);
    }
  });

  test("rejects anything else", () => {
    expect(() =>
      resolveDbChannelBinding({ SPORTSDESK_DB_CHANNEL_BINDING: "sometimes" }),
    ).toThrow(/disable, prefer or require/);
  });
});

describe("resolveDbTlsConfig", () => {
  test("localhost stays plaintext without SPORTSDESK_DB_TLS", () => {
    expect(resolveDbTlsConfig({}, { local: true, forceTls: false })).toBe(
      false,
    );
  });

  test("remote hosts default to rejectUnauthorized", () => {
    expect(resolveDbTlsConfig({}, { local: false, forceTls: false })).toEqual({
      rejectUnauthorized: true,
    });
  });

  test("force TLS enables it for localhost", () => {
    expect(resolveDbTlsConfig({}, { local: true, forceTls: true })).toEqual({
      rejectUnauthorized: true,
    });
  });

  test("pins a colon-separated SHA-256 fingerprint", () => {
    const config = resolveDbTlsConfig(
      { SPORTSDESK_DB_CERT_FINGERPRINT: FP_COLON },
      { local: false, forceTls: false },
    );
    if (config === false) throw new Error("expected TLS config");
    const check = config.checkServerIdentity;
    expect(check).toBeDefined();
    if (check === undefined) throw new Error("expected checkServerIdentity");

    const mismatch = {
      fingerprint256: "00".repeat(32),
    } as unknown as Parameters<typeof check>[1];
    const error = check("db.example.com", mismatch);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("fingerprint mismatch");
  });

  test("accepts a bare fingerprint", () => {
    const config = resolveDbTlsConfig(
      { SPORTSDESK_DB_CERT_FINGERPRINT: FP_COMPACT },
      { local: false, forceTls: false },
    );
    expect(config).not.toBe(false);
  });

  test("rejects a malformed pin instead of silently disabling it", () => {
    expect(() =>
      resolveDbTlsConfig(
        { SPORTSDESK_DB_CERT_FINGERPRINT: "not-a-fingerprint" },
        { local: false, forceTls: false },
      ),
    ).toThrow(/SHA-256 fingerprint/);
  });
});
