/**
 * @file fantasy402_manager_wire.test.ts
 * @description Unit tests for Fantasy402 Manager Wire Client & Mutation Engine.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  executePlayerColumnMutation,
  executeVigSetupInsert,
  queryIpTrackerWebLog,
  PlayerMutationResultCode,
  MutationClassification,
  WirePayloadError,
  WirePayloadErrorClassification,
} from "../lib/fantasy402_manager_wire.ts";

/** Test boundary: Bun's fetch type carries `preconnect`, which a mock must provide. */
function mockFetch(
  handler: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, {
    preconnect: (_url: string) => {},
  }) as typeof fetch;
}

describe("Fantasy402 Manager Wire Mutations (updateByColumn)", () => {
  it("rejects poisoned path parameter fail-fast with POISONED_PATH_DETECTED", async () => {
    await assert.rejects(
      async () => {
        await executePlayerColumnMutation({
          customerIdentifier: "CB112",
          agentOwnerIdentifier: "CUB22HR",
          column: "confirmationDelaySeconds",
          value: "5",
          // @ts-expect-error `path` is typed `never`; the runtime guard must reject it too.
          path: "/cloud/api/Manager/updateByColumn",
        });
      },
      (err: unknown) => {
        assert(err instanceof WirePayloadError);
        assert.equal(
          err.classification,
          WirePayloadErrorClassification.POISONED_PATH_DETECTED,
        );
        assert.equal(err.exitCode, 64);
        return true;
      },
    );
  });

  it("rejects customer identifier exceeding 11 characters with INVALID_IDENTIFIER_LENGTH", async () => {
    await assert.rejects(
      async () => {
        await executePlayerColumnMutation({
          customerIdentifier: "TOOLONG_LOGIN_123",
          agentOwnerIdentifier: "CUB22HR",
          column: "confirmationDelaySeconds",
          value: "5",
        });
      },
      (err: unknown) => {
        assert(err instanceof WirePayloadError);
        assert.equal(
          err.classification,
          WirePayloadErrorClassification.INVALID_IDENTIFIER_LENGTH,
        );
        assert.equal(err.exitCode, 64);
        return true;
      },
    );
  });

  it("enforces scope hierarchy rule: master agent BILLY666 returns REJECTED_SCOPE without network call", async () => {
    const result = await executePlayerColumnMutation({
      customerIdentifier: "CB112",
      agentOwnerIdentifier: "BILLY666",
      column: "confirmationDelaySeconds",
      value: "5",
    });

    assert.equal(result.classification, MutationClassification.REJECTED);
    assert.equal(result.rawResultCode, PlayerMutationResultCode.REJECTED_SCOPE);
    assert.equal(result.isCommitted, false);
    assert.equal(result.customerId, "CB112      ");
    assert.equal(result.agentOwner, "BILLY666");
  });

  it("formats wire form body with 11-char padded ID and handles Result: 1", async () => {
    // Intercept fetch with local mock
    const originalFetch = globalThis.fetch;
    try {
      let capturedBody: string | null = null;
      let capturedHeaders = new Headers();

      globalThis.fetch = mockFetch(async (_url, init) => {
        capturedBody = typeof init?.body === "string" ? init.body : null;
        capturedHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ Result: { Result: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await executePlayerColumnMutation({
        portalBaseUrl: "https://mock.fantasy402.com",
        customerIdentifier: "CB112_1",
        agentOwnerIdentifier: "CUB22HR",
        column: "confirmationDelaySeconds",
        value: 5,
        verifyReadBack: false,
      });

      assert.equal(result.classification, MutationClassification.COMMITTED);
      assert.equal(result.rawResultCode, PlayerMutationResultCode.SUCCESS);
      assert.equal(result.isCommitted, true);
      assert.equal(result.customerId, "CB112_1    ");

      assert(capturedBody !== null);
      const params = new URLSearchParams(capturedBody);
      assert.equal(params.get("operation"), "updateByColumn");
      assert.equal(params.get("customerID"), "CB112_1    ");
      assert.equal(params.get("agentID"), "CUB22HR");
      assert.equal(params.get("column"), "confirmationDelaySeconds");
      assert.equal(params.get("value"), "5");
      assert.equal(params.get("RRO"), "0");
      assert.equal(
        capturedHeaders.get("Content-Type"),
        "application/x-www-form-urlencoded; charset=UTF-8",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("discriminates Result: 0 as SILENT_NO_OP", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = mockFetch(async () => {
        return new Response(JSON.stringify({ Result: { Result: 0 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await executePlayerColumnMutation({
        portalBaseUrl: "https://mock.fantasy402.com",
        customerIdentifier: "CB112",
        agentOwnerIdentifier: "CUB22HR",
        column: "confirmationDelaySeconds",
        value: 5,
      });

      assert.equal(result.classification, MutationClassification.SILENT_NO_OP);
      assert.equal(result.rawResultCode, PlayerMutationResultCode.FAILURE);
      assert.equal(result.isCommitted, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Fantasy402 Vig Setup (vigSetupInsert)", () => {
  it("pads sportType to 20 chars and player to 11 chars in JSON body", async () => {
    const originalFetch = globalThis.fetch;
    try {
      let capturedPayload: Record<string, unknown> = {};

      globalThis.fetch = mockFetch(async (_url, init) => {
        capturedPayload = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ Result: { Result: 1 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      const result = await executeVigSetupInsert({
        portalBaseUrl: "https://mock.fantasy402.com",
        customerIdentifier: "CB112_1",
        sportType: "Football",
        vigSpread: "15",
        vigTotal: "15",
        vigDerivative: "20",
        verifyReadBack: false,
      });

      assert.equal(result.success, true);
      assert.equal(result.sportType, "Football            ");
      assert.equal(result.player, "CB112_1    ");

      assert.equal(capturedPayload.operation, "vigSetupInsert");
      assert.equal(capturedPayload.sportType, "Football            ");
      assert.equal(capturedPayload.player, "CB112_1    ");
      assert.equal(capturedPayload.allPlayers, "off");
      assert.equal(capturedPayload.flagVig, "Y");
      assert.equal(capturedPayload.VigSpread, "15");
      assert.equal(capturedPayload.VigDerivative, "20");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Fantasy402 IP Tracker (getWebLog)", () => {
  it("formats dates as YYYY-MM-DD for Mode C and MM/DD/YYYY for Mode B", async () => {
    const originalFetch = globalThis.fetch;
    try {
      const captured: { params: URLSearchParams | null } = { params: null };

      globalThis.fetch = mockFetch(async (_url, init) => {
        captured.params = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify([{ ip: "192.168.1.1", login: "CB112" }]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      });

      // Test Mode C
      await queryIpTrackerWebLog({
        portalBaseUrl: "https://mock.fantasy402.com",
        mode: "C",
        customerId: "CB112",
        startDate: "2026-10-30",
        endDate: "2026-10-30",
      });

      assert(captured.params !== null);
      assert.equal(captured.params.get("type"), "C");
      assert.equal(captured.params.get("start"), "2026-10-30");
      assert.equal(captured.params.get("customerID"), "CB112");

      // Test Mode B
      await queryIpTrackerWebLog({
        portalBaseUrl: "https://mock.fantasy402.com",
        mode: "B",
        startDate: "10/30/2026",
        endDate: "10/30/2026",
      });

      assert(captured.params !== null);
      assert.equal(captured.params.get("type"), "B");
      assert.equal(captured.params.get("start"), "10/30/2026");
      assert.equal(captured.params.get("customerID"), "0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
