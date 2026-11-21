import { describe, expect, test } from "bun:test";

import {
  maskIpByRole,
  maskSorLabelByRole,
  redactDiagnosticSurface,
  runWithInspectVisibility,
} from "../lib/inspect_redactor.ts";

describe("maskIpByRole IPv6 /64", () => {
  test("RISK_MANAGER keeps a normalized /64 and collapses equivalent forms", () => {
    const visibility = "RISK_MANAGER" as const;
    const prefix = "2001:db8:0:0::/64";
    expect(maskIpByRole("2001:db8::1", visibility)).toBe(prefix);
    expect(maskIpByRole("2001:0DB8:0:0::2", visibility)).toBe(prefix);
    expect(maskIpByRole("2001:db8:0:0:ffff::1", visibility)).toBe(prefix);
    expect(maskIpByRole("2001:db8:1::1", visibility)).toBe("2001:db8:1:0::/64");
    expect(maskIpByRole("::1", visibility)).toBe("0:0:0:0::/64");
    expect(maskIpByRole("::ffff:192.0.2.4", visibility)).toBe("0:0:0:0::/64");
    expect(maskIpByRole("198.51.100.42", visibility)).toBe("198.51.100.0/24");
  });

  test("AUDITOR_SANITIZED fully redacts addresses and OWNER_ADMIN leaves them", () => {
    expect(maskIpByRole("2001:db8::1", "AUDITOR_SANITIZED")).toBe(
      "[REDACTED_IP]",
    );
    expect(maskIpByRole("::ffff:192.0.2.4", "AUDITOR_SANITIZED")).toBe(
      "[REDACTED_IP]",
    );
    expect(maskIpByRole("2001:db8::1", "OWNER_ADMIN")).toBe("2001:db8::1");
    expect(maskIpByRole("not-an-ip", "RISK_MANAGER")).toBe("not-an-ip");
    expect(maskIpByRole("", "RISK_MANAGER")).toBe("");
  });

  test("redactDiagnosticSurface applies /64 masking inside free text", () => {
    const raw = "peer 2001:db8::1 and 2001:0DB8:0:0::2";
    const manager = redactDiagnosticSurface(raw, "RISK_MANAGER");
    expect(manager).toContain("2001:db8:0:0::/64");
    expect(manager).not.toContain("2001:db8::1");
    expect(redactDiagnosticSurface(raw, "AUDITOR_SANITIZED")).toBe(
      "peer [REDACTED_IP] and [REDACTED_IP]",
    );
  });
});

describe("SOR label inspect gate", () => {
  test("auditors lose ORIGIN_LEADER and BRIDGE_RELAY; the risk plane keeps them", () => {
    expect(maskSorLabelByRole("ORIGIN_LEADER", "AUDITOR_SANITIZED")).toBe(
      "[REDACTED_ROLE]",
    );
    expect(maskSorLabelByRole("BRIDGE_RELAY", "AUDITOR_SANITIZED")).toBe(
      "[REDACTED_ROLE]",
    );
    expect(maskSorLabelByRole("COPY_FOLLOWER", "AUDITOR_SANITIZED")).toBe(
      "COPY_FOLLOWER",
    );
    expect(maskSorLabelByRole("ORIGIN_LEADER", "RISK_MANAGER")).toBe(
      "ORIGIN_LEADER",
    );
    expect(maskSorLabelByRole("BRIDGE_RELAY", "OWNER_ADMIN")).toBe(
      "BRIDGE_RELAY",
    );
  });

  test("fail-closed ambient visibility redacts SOR labels in diagnostic text", () => {
    const raw =
      "ring role=ORIGIN_LEADER via BRIDGE_RELAY; follower=COPY_FOLLOWER";
    expect(redactDiagnosticSurface(raw, "AUDITOR_SANITIZED")).toBe(
      "ring role=[REDACTED_ROLE] via [REDACTED_ROLE]; follower=COPY_FOLLOWER",
    );
    expect(
      runWithInspectVisibility("AUDITOR_SANITIZED", () =>
        redactDiagnosticSurface(raw),
      ),
    ).not.toContain("ORIGIN_LEADER");
    expect(redactDiagnosticSurface(raw, "RISK_MANAGER")).toContain(
      "ORIGIN_LEADER",
    );
  });
});
