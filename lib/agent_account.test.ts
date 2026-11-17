import { describe, expect, test } from "bun:test";
import {
  projectAccountInfoOwner,
  projectWebReportsConfig,
  projectWebReportsPendingConfig,
  projectAccountAdminConfig,
} from "./agent_account.ts";

describe("account config projection", () => {
  test("drops the JWT, passwords, names and trims padding", () => {
    const projected = projectAccountInfoOwner({
      accountInfo: {
        customerID: "BILLY666  ",
        AgentID: "BILLY666                                          ",
        Office: "NOLAROSE",
        Store: "PPHINSIDER          ",
        AgentType: "M",
        TimeZone: 1,
        showPassword: "on",
        Password: "secret",
        PasswordFix: "‡",
        NameFirst: "Fake",
        NameLast: "Person",
        code: "fake.header.payload",
      },
      SERVER: { date: "2026-11-16 19:04:08.687" },
      preferenceDate: [{ BettingMode: "advance" }],
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.store).toBe("PPHINSIDER");
    expect(projected.office).toBe("NOLAROSE");
    expect(projected.displayFlags.showPassword).toBe("on");
    expect(projected.serverDate).toBe("2026-11-16 19:04:08.687");
    expect(JSON.stringify(projected)).not.toContain("fake.header.payload");
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(JSON.stringify(projected)).not.toContain("Fake");
  });

  test("refuses a response without accountInfo", () => {
    expect(() => projectAccountInfoOwner({ INFO: {} })).toThrow("accountInfo");
  });
});

describe("web-reports config projection", () => {
  test("trims AgentID and keeps only display flags plus weeklyScroll", () => {
    const projected = projectWebReportsConfig({
      INFO: {
        AgentID: "BILLY666                                          ",
        Config: "",
        showPassword: "on",
        showPending: "on",
        adds: { AgentID: "BILLY666  ", weeklyScroll: "off" },
        Password: "should-not-survive",
      },
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.displayFlags.showPassword).toBe("on");
    expect(projected.displayFlags.showPending).toBe("on");
    expect(projected.weeklyScroll).toBe("off");
    expect(JSON.stringify(projected)).not.toContain("should-not-survive");
  });
});

describe("pending web-reports config projection", () => {
  test("keeps column flags and trims the AgentID", () => {
    const projected = projectWebReportsPendingConfig({
      INFO: {
        AgentID: "BILLY666                                          ",
        CustomerIDF: "on",
        PasswordF: "off",
        NameF: "on",
        AgentF: "on",
        Config: "",
      },
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.columnFlags).toEqual({
      CustomerIDF: "on",
      PasswordF: "off",
      NameF: "on",
      AgentF: "on",
    });
  });
});

describe("account projection boundaries", () => {
  test("scrubs nested sensitive keys and preserves preferences", () => {
    const projected = projectAccountInfoOwner({
      accountInfo: {
        customerID: "C1",
        extra: {
          code: "nested-token",
          Password: "nested-password",
          NameFirst: "Nested",
        },
      },
      preferenceDate: [{ BettingMode: "advance" }],
    });
    const text = JSON.stringify(projected);
    expect(text).not.toContain("nested-token");
    expect(text).not.toContain("nested-password");
    expect(text).not.toContain("Nested");
    expect(projected.preferences).toEqual([{ BettingMode: "advance" }]);
  });

  test("a blank AgentID becomes null, not an empty string", () => {
    const projected = projectAccountInfoOwner({
      accountInfo: { AgentID: "          ", Office: "NOLAROSE" },
    });
    expect(projected.agentId).toBeNull();
    expect(projected.office).toBe("NOLAROSE");
  });

  test("web-reports config refuses a response without INFO", () => {
    expect(() => projectWebReportsConfig({})).toThrow("INFO");
  });

  test("pending web-reports config refuses a response without INFO", () => {
    expect(() => projectWebReportsPendingConfig({})).toThrow("INFO");
  });

  test("pending config ignores non-flag keys and non-string values", () => {
    const projected = projectWebReportsPendingConfig({
      INFO: { AgentID: "A1", NameF: 1, Weird: "x", AgentF: "on" },
    });
    expect(projected.columnFlags).toEqual({ AgentF: "on" });
  });
});

describe("admin account config projection", () => {
  test("keeps the master link and week-start fields, trimmed", () => {
    const projected = projectAccountAdminConfig({
      INFO: {
        CustomerID: "BILLY666  ",
        AgentID: "BILLY666                                          ",
        MasterAgentID: "CSLEVEL2                                          ",
        MasterLogin: "CSLEVEL2",
        StartOfWeek: 1,
        DistributionStartOfWeek: 1,
        IsOffice: 0,
        Password: "should-not-survive",
      },
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.masterAgentId).toBe("CSLEVEL2");
    expect(projected.masterLogin).toBe("CSLEVEL2");
    expect(projected.startOfWeek).toBe(1);
    expect(projected.distributionStartOfWeek).toBe(1);
    expect(projected.isOffice).toBe(0);
    expect(JSON.stringify(projected)).not.toContain("should-not-survive");
  });
});

describe("bare INFO shape", () => {
  test("web-reports accepts the INFO object without the wrapper", () => {
    const projected = projectWebReportsConfig({
      AgentID: "BILLY666  ",
      showPending: "on",
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.displayFlags).toEqual({ showPending: "on" });
  });

  test("pending web-reports accepts the bare INFO object", () => {
    const projected = projectWebReportsPendingConfig({
      AgentID: "BILLY666  ",
      NameF: "on",
      PasswordF: "off",
    });
    expect(projected.agentId).toBe("BILLY666");
    expect(projected.columnFlags).toEqual({ NameF: "on", PasswordF: "off" });
  });
});
