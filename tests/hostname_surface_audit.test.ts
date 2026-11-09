import { describe, expect, test } from "bun:test";
import {
  AUDITED_ENDPOINTS_CACHE,
  REGISTERED_ENDPOINTS,
  ModeBit,
  DomainMask,
  type AuditedEndpointRow,
} from "../lib/hostname_surface_audit.ts";
import {
  getEndpointsForMode,
  getEndpointsForDomainMask,
  getModeEndpointPlan,
} from "../lib/forensic_diagnostic_modes_endpoints.ts";

describe("P0 — 1: UNIX Hostname Identity & WHATWG vs Legacy Parity", () => {
  test("widened isWhatwgAndLegacyHostnameIdentical to boolean | null contract", () => {
    expect(AUDITED_ENDPOINTS_CACHE.length).toBe(25);

    const unixRow = AUDITED_ENDPOINTS_CACHE.find(
      (ep) => ep.endpointId === "LOCAL-UNIX-03",
    );
    expect(unixRow).toBeDefined();
    expect(unixRow?.isWhatwgAndLegacyHostnameIdentical).toBeNull();

    const fileRow = AUDITED_ENDPOINTS_CACHE.find(
      (ep) => ep.endpointId === "LOCAL-FILE-03",
    );
    expect(fileRow).toBeDefined();
    expect(fileRow?.whatwgHostname).toBe("");
    expect(fileRow?.legacyUrlHostname).toBeNull();
    expect(fileRow?.isWhatwgAndLegacyHostnameIdentical).toBe(false);

    const remainingRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) =>
        ep.endpointId !== "LOCAL-UNIX-03" && ep.endpointId !== "LOCAL-FILE-03",
    );
    expect(remainingRows.length).toBe(23);
    for (const ep of remainingRows) {
      expect(ep.isWhatwgAndLegacyHostnameIdentical).toBe(true);
      expect(ep.whatwgHostname).toBe(ep.legacyUrlHostname!);
    }
  });
});

describe("P0 — 2: Transport Disambiguation (socketTransport & connectTransport)", () => {
  test("connectTransport and socketTransport disambiguate without conflating raw TCP", () => {
    const wssRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.connectTransport === "wss",
    );
    expect(wssRows.length).toBe(1);
    expect(wssRows[0]?.endpointId).toBe("POLY-CLOB-03");

    const wsRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.connectTransport === "ws",
    );
    expect(wsRows.length).toBe(1);
    expect(wsRows[0]?.endpointId).toBe("LOCAL-UWS-02");

    const unixRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.connectTransport === "unix",
    );
    expect(unixRows.length).toBe(1);
    expect(unixRows[0]?.endpointId).toBe("LOCAL-UNIX-03");
    expect(unixRows[0]?.socketTransport).toBe("unix");

    const fileRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.connectTransport === "none",
    );
    expect(fileRows.length).toBe(1);
    expect(fileRows[0]?.endpointId).toBe("LOCAL-FILE-03");
    expect(fileRows[0]?.socketTransport).toBe("none");

    const httpsRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.connectTransport === "https",
    );
    expect(httpsRows.length).toBe(21);
    for (const ep of httpsRows) {
      expect(ep.socketTransport).toBe("tcp");
    }
  });
});

describe("P1 — 3: Endpoint Role Classification (source / sink / doc)", () => {
  test("partitions 25 endpoints into 19 sources, 3 sinks, and 3 docs", () => {
    const sources = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => ep.role === "source",
    );
    const sinks = AUDITED_ENDPOINTS_CACHE.filter((ep) => ep.role === "sink");
    const docs = AUDITED_ENDPOINTS_CACHE.filter((ep) => ep.role === "doc");

    expect(sources.length).toBe(19);
    expect(sinks.length).toBe(3);
    expect(docs.length).toBe(3);
    expect(AUDITED_ENDPOINTS_CACHE.length).toBe(25);

    const sinkIds = new Set(sinks.map((s) => s.endpointId));
    expect(sinkIds).toEqual(
      new Set(["R2-S3-API-01", "R2-EDGE-PUB-02", "LOCAL-FILE-03"]),
    );
    for (const s of sinks) {
      expect(s.modesMask).toBe(0x07fe);
    }

    const docIds = new Set(docs.map((d) => d.endpointId));
    expect(docIds).toEqual(new Set(["BUN-DOC-01", "BUN-DOC-02", "BUN-DOC-03"]));
  });
});

describe("P1 — 4: SPA Hash Query Preservation & Effective Route", () => {
  test("preserves query in effectiveRoute while stripping spaHashRoute", () => {
    const ui01 = AUDITED_ENDPOINTS_CACHE.find(
      (ep) => ep.endpointId === "GSLIVE-UI-01",
    );
    expect(ui01).toBeDefined();
    expect(ui01?.spaHashQuery).toBe("?partnerId=118");
    expect(ui01?.spaHashRoute).toBe("#/reports/users");
    expect(ui01?.effectiveRoute).toBe(
      "/manager-tools/#/reports/users?partnerId=118",
    );

    const ui02 = AUDITED_ENDPOINTS_CACHE.find(
      (ep) => ep.endpointId === "GSLIVE-UI-02",
    );
    expect(ui02).toBeDefined();
    expect(ui02?.spaHashQuery).toBe("?partnerId=118");
    expect(ui02?.spaHashRoute).toBe("#/events/bet-history");
    expect(ui02?.effectiveRoute).toBe(
      "/manager-tools/#/events/bet-history?partnerId=118",
    );

    const otherRows = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) =>
        ep.endpointId !== "GSLIVE-UI-01" && ep.endpointId !== "GSLIVE-UI-02",
    );
    for (const ep of otherRows) {
      expect(ep.spaHashQuery).toBeNull();
      expect(ep.spaHashRoute).toBeNull();
    }
  });
});

describe("P2 — Runtime Freeze & Cross-Version Guards", () => {
  test("enforces runtime freeze and cross-version invariants with Set equality", () => {
    expect(Object.isFrozen(ModeBit)).toBe(true);
    expect(Object.isFrozen(DomainMask)).toBe(true);
    expect(Object.isFrozen(AUDITED_ENDPOINTS_CACHE)).toBe(true);
    expect(Object.isFrozen(REGISTERED_ENDPOINTS)).toBe(true);

    const fileRow = AUDITED_ENDPOINTS_CACHE.find(
      (ep) => ep.endpointId === "LOCAL-FILE-03",
    );
    expect(fileRow?.legacyUrlHostname).toBeNull();

    const mode7Endpoints = getEndpointsForMode(7);
    const mode7Ids = new Set(mode7Endpoints.map((ep) => ep.endpointId));
    const expectedMode7Ids = new Set([
      "F402-REST-02",
      "F402-REST-05",
      "GSLIVE-UI-02",
      "POLY-GAMMA-01",
      "POLY-CLOB-02",
      "POLY-CLOB-03",
      "POLY-DATA-04",
      "R2-S3-API-01",
      "R2-EDGE-PUB-02",
      "LOCAL-FILE-03",
    ]);
    expect(mode7Ids).toEqual(expectedMode7Ids);
  });
});

describe("Bridge Module: Pre-Filtered Mode & Domain Queries", () => {
  test("mode and domain queries filter by role correctly", () => {
    const allMode7 = getEndpointsForMode(7);
    expect(allMode7.length).toBe(10);

    const sourceMode7 = getEndpointsForMode(7, "source");
    expect(sourceMode7.length).toBe(7);

    const sinkMode7 = getEndpointsForMode(7, "sink");
    expect(sinkMode7.length).toBe(3);

    const crossMarketSources = getEndpointsForDomainMask(
      DomainMask.CROSS_MARKET,
      "source",
    );
    expect(crossMarketSources.length).toBe(7);

    const allModeSinks = getEndpointsForDomainMask(
      DomainMask.ALL_MODES,
      "sink",
    );
    expect(allModeSinks.length).toBe(3);
  });
});

describe("Bridge Module: Mode Endpoint Plan & Zero-Cycle Architecture", () => {
  test("produces pre-partitioned endpoint plans without cycle risk", () => {
    const plan7 = getModeEndpointPlan(7);
    expect(plan7.mode).toBe(7);
    expect(plan7.allEndpoints.length).toBe(10);
    expect(plan7.sourceEndpoints.length).toBe(7);
    expect(plan7.sinkEndpoints.length).toBe(3);
    expect(plan7.wssSourceEndpoints.length).toBe(1);
    expect(plan7.wssSourceEndpoints[0]?.endpointId).toBe("POLY-CLOB-03");
    expect(plan7.httpsSourceEndpoints.length).toBe(6);
    expect(plan7.wsSourceEndpoints.length).toBe(0);
    expect(plan7.unixSourceEndpoints.length).toBe(0);

    const plan6 = getModeEndpointPlan(6);
    expect(plan6.mode).toBe(6);
    expect(plan6.wsSourceEndpoints.length).toBe(1);
    expect(plan6.wsSourceEndpoints[0]?.endpointId).toBe("LOCAL-UWS-02");
    expect(plan6.unixSourceEndpoints.length).toBe(1);
    expect(plan6.unixSourceEndpoints[0]?.endpointId).toBe("LOCAL-UNIX-03");

    expect(Object.isFrozen(plan7)).toBe(true);
    expect(Object.isFrozen(plan6)).toBe(true);
  });
});
