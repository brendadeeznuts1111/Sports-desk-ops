import { describe, expect, test } from "bun:test";
import {
  buildWeblogRollup,
  classifyIp,
  parseOperation,
} from "../lib/f402_weblog.ts";

const event = (
  accessMs: number,
  loginId: string,
  ip: string,
  operation: string,
) => ({
  accessMs,
  loginId,
  ip,
  ip32: null,
  ipv6Prefix64: null,
  operation,
  ...parseOperation(operation),
});

describe("f402 weblog bridge", () => {
  test("decomposes UI and plain Operation strings", () => {
    const ui = parseOperation(
      " (M)  Login successful  (M)  [ v1.0.280 | www.fire22.ag ]",
    );
    expect(ui.deviceClass).toBe("M");
    expect(ui.clientVersion).toBe("1.0.280");
    expect(ui.skinDomain).toBe("www.fire22.ag");
    expect(ui.actionKind).toBe("UI:login_successful");
    expect(parseOperation("Login successful").actionKind).toBe("LOGIN");
    expect(parseOperation("Wager Accepted by:GSLIVE").actionKind).toBe(
      "WAGER_ACCEPTED:GSLIVE",
    );
    expect(parseOperation("API LOG | PARLAY | Ticket: 1").actionKind).toBe(
      "API_LOG:parlay",
    );
  });

  test("classifies CIDR ranges with unsigned masks", () => {
    expect(classifyIp("100.64.1.2")).toBe("CGNAT");
    expect(classifyIp("172.56.1.2")).toBe("T_MOBILE");
    expect(classifyIp("174.192.1.2")).toBe("VERIZON_192");
    expect(classifyIp("146.75.146.74")).toBe("ICLOUD_RELAY");
    expect(classifyIp("140.248.1.2")).toBe("BOT_RING_140_248");
    expect(classifyIp("8.8.8.8")).toBe("OTHER");
    expect(classifyIp("2001:db8::1")).toBe("UNKNOWN");
  });

  test("causal join conserves wagers and passes the four gates", () => {
    const rows = [event(1_000, "A", "146.75.146.74", "Login successful")];
    const rollup = buildWeblogRollup(
      {
        rows,
        malformed: 0,
        total: 1,
        templates: new Set(rows.map((r) => r.template)),
      },
      [{ login: "A", insertMs: 6_000, ticket: "1" }],
      0,
      10_000,
    );
    expect(rollup.join.matched).toBe(1);
    expect(rollup.join.persistentUnmatched).toBe(0);
    expect(rollup.join.nonWebChannel).toBe(0);
    expect(rollup.join.futureJoins).toBe(0);
    expect(rollup.gates.every((g) => g.status === "pass")).toBe(true);
    expect(rollup.flags.sniperTwins).toBe(0);
  });
});
