import { describe, expect, test } from "bun:test";
import { constants } from "node:crypto";

import { resolveDbChannelBinding, resolveDbTlsConfig } from "../lib/db.ts";

const FP_COMPACT = "ab".repeat(32);
const FP_COLON = (FP_COMPACT.match(/.{2}/g) ?? []).join(":").toUpperCase();

describe("resolveDbChannelBinding", () => {
  test("defaults to prefer and honors PGCHANNELBINDING and the URL", () => {
    expect(resolveDbChannelBinding({})).toBe("prefer");
    expect(
      resolveDbChannelBinding({ SPORTSDESK_DB_CHANNEL_BINDING: " " }),
    ).toBe("prefer");
    expect(resolveDbChannelBinding({ PGCHANNELBINDING: "require" })).toBe(
      "require",
    );
    expect(resolveDbChannelBinding({}, "disable")).toBe("disable");
    expect(
      resolveDbChannelBinding({ PGCHANNELBINDING: "disable" }, "require"),
    ).toBe("require");
    expect(
      resolveDbChannelBinding({
        SPORTSDESK_DB_CHANNEL_BINDING: "require",
        PGCHANNELBINDING: "disable",
      }),
    ).toBe("require");
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
      secureOptions:
        constants.SSL_OP_NO_TLSv1 |
        constants.SSL_OP_NO_TLSv1_1 |
        constants.SSL_OP_NO_TLSv1_2,
    });
  });

  test("force TLS enables it for localhost", () => {
    expect(resolveDbTlsConfig({}, { local: true, forceTls: true })).toEqual({
      rejectUnauthorized: true,
      secureOptions:
        constants.SSL_OP_NO_TLSv1 |
        constants.SSL_OP_NO_TLSv1_1 |
        constants.SSL_OP_NO_TLSv1_2,
    });
  });

  test("forces TLS 1.3 by disabling 1.0, 1.1 and 1.2", () => {
    const config = resolveDbTlsConfig({}, { local: false, forceTls: false });
    if (config === false) throw new Error("expected TLS config");
    expect(config.secureOptions & constants.SSL_OP_NO_TLSv1).toBeTruthy();
    expect(config.secureOptions & constants.SSL_OP_NO_TLSv1_1).toBeTruthy();
    expect(config.secureOptions & constants.SSL_OP_NO_TLSv1_2).toBeTruthy();
  });

  test("loads an explicit CA bundle", () => {
    const config = resolveDbTlsConfig(
      { SPORTSDESK_DB_CA_FILE: "/tmp/desk-ca.pem" },
      { local: false, forceTls: false },
    );
    if (config === false) throw new Error("expected TLS config");
    expect(config.ca).toBeDefined();
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
