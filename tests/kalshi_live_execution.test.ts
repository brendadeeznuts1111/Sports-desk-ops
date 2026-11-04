import { describe, expect, test } from "bun:test";
import {
  constants as cryptoConstants,
  generateKeyPairSync,
  verify as cryptoVerify,
} from "node:crypto";
import {
  buildKalshiOrder,
  KALSHI_API_BASE_URL,
  KALSHI_PORTFOLIO_ORDERS_PATH,
  KalshiOrderValidationError,
  kalshiLiveReady,
  kalshiSigningMessage,
  placeKalshiOrder,
  resolveKalshiCredentials,
  signKalshiRequest,
} from "../lib/kalshi_live_execution.ts";
import type {
  KalshiDecisionInput,
  KalshiFetch,
  KalshiOrderBody,
  PlaceKalshiOrderResult,
} from "../lib/kalshi_live_execution.ts";

/**
 * Offline proof of the Kalshi live adapter: a locally generated RSA keypair, credentials injected
 * through the module's seams, and a fake fetch that captures the request. Nothing here reaches the
 * keychain, the environment, or the network — and no assertion prints key material.
 */

const TICKER = "KXNBAGAME-26NOV04ATLWAS-ATL";
const DECISION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const NOW = 1_790_000_000_000;

const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLIC_KEY_PEM = keyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const PRIVATE_KEY_PEM = keyPair.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const EC_KEY_PAIR = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_PRIVATE_KEY_PEM = EC_KEY_PAIR.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const CREDENTIALS = {
  apiKeyId: "kalshi-test-key-id",
  privateKeyPem: PRIVATE_KEY_PEM,
};

const SUCCESS_ORDER = {
  order: {
    order_id: "kalshi-order-1",
    status: "resting",
    fill_count: 0,
    remaining_count: 10,
  },
};

const TAKER_BODY: KalshiOrderBody = {
  ticker: TICKER,
  client_order_id: DECISION_ID,
  side: "yes",
  action: "buy",
  type: "limit",
  count: 10,
  yes_price: 55,
};

function decision(
  overrides: Partial<KalshiDecisionInput> = {},
): KalshiDecisionInput {
  return {
    id: DECISION_ID,
    venue: "kalshi",
    style: "taker",
    position: "yes",
    orderAction: "buy",
    tickerToken: TICKER,
    limitPrice: 0.55,
    contracts: 10,
    paper: false,
    blocked: false,
    blockReason: null,
    ...overrides,
  };
}

function verifyKalshiSignature(
  message: string,
  signatureBase64: string,
): boolean {
  return cryptoVerify(
    "sha256",
    Buffer.from(message, "utf8"),
    {
      key: PUBLIC_KEY_PEM,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    },
    Buffer.from(signatureBase64, "base64"),
  );
}

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

interface CapturedFetch {
  readonly fetchImpl: KalshiFetch;
  readonly requests: CapturedRequest[];
}

function captureFetch(
  respond: (request: CapturedRequest) => Response | Promise<Response>,
): CapturedFetch {
  const requests: CapturedRequest[] = [];
  const fetchImpl: KalshiFetch = async (url, init) => {
    const request = { url, init };
    requests.push(request);
    return respond(request);
  };
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function headerValue(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function onlyRequest(captured: CapturedFetch): CapturedRequest {
  const request = captured.requests[0];
  if (request === undefined) throw new Error("expected one Kalshi request");
  return request;
}

function requestBody(init: RequestInit): KalshiOrderBody {
  const raw = init.body;
  if (typeof raw !== "string") throw new Error("request body was not a string");
  return JSON.parse(raw) as KalshiOrderBody;
}

function validationReasonOf(attempt: () => unknown): string | null {
  try {
    attempt();
    return null;
  } catch (error) {
    if (error instanceof KalshiOrderValidationError) return error.reason;
    return `unexpected error: ${String(error)}`;
  }
}

function expectRefused(result: PlaceKalshiOrderResult, reason: string): void {
  expect(result.ok).toBe(false);
  expect(result.reason).toBe(reason);
  expect(result.venueOrderId).toBeNull();
  expect(result.status).toBeNull();
  expect(result.avgPriceUsd).toBeNull();
}

describe("Kalshi request signing", () => {
  test("signs `${timestampMs}${METHOD}${pathWithoutQuery}` with RSA-PSS SHA-256", () => {
    const headers = signKalshiRequest({
      apiKeyId: CREDENTIALS.apiKeyId,
      privateKeyPem: CREDENTIALS.privateKeyPem,
      method: "post",
      path: `${KALSHI_PORTFOLIO_ORDERS_PATH}?ignored=1`,
      timestampMs: NOW,
    });
    expect(headers["KALSHI-ACCESS-KEY"]).toBe(CREDENTIALS.apiKeyId);
    expect(headers["KALSHI-ACCESS-TIMESTAMP"]).toBe(String(NOW));
    const signature = headers["KALSHI-ACCESS-SIGNATURE"];
    expect(signature.length).toBeGreaterThan(0);
    expect(Buffer.from(signature, "base64").length).toBe(256);
    // The query string is not part of the signed message; the method is uppercased.
    expect(
      verifyKalshiSignature(
        `${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}`,
        signature,
      ),
    ).toBe(true);
    expect(
      verifyKalshiSignature(
        `${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}?ignored=1`,
        signature,
      ),
    ).toBe(false);
  });

  test("kalshiSigningMessage uppercases the method and strips the query", () => {
    expect(
      kalshiSigningMessage(
        NOW,
        "GET",
        `${KALSHI_PORTFOLIO_ORDERS_PATH}?x=1&y=2`,
      ),
    ).toBe(`${NOW}GET${KALSHI_PORTFOLIO_ORDERS_PATH}`);
    expect(
      kalshiSigningMessage(NOW, "post", KALSHI_PORTFOLIO_ORDERS_PATH),
    ).toBe(`${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}`);
  });
});

describe("buildKalshiOrder", () => {
  test("maps a taker YES buy to an integer-cent limit order body", () => {
    const request = buildKalshiOrder(decision());
    expect(request).toEqual({
      method: "POST",
      path: KALSHI_PORTFOLIO_ORDERS_PATH,
      body: TAKER_BODY,
    });
  });

  test("maps a maker NO sell with post_only and no_price", () => {
    const request = buildKalshiOrder(
      decision({
        style: "maker",
        position: "no",
        orderAction: "sell",
        limitPrice: 0.4,
      }),
    );
    expect(request.body).toEqual({
      ticker: TICKER,
      client_order_id: DECISION_ID,
      side: "no",
      action: "sell",
      type: "limit",
      count: 10,
      no_price: 40,
      post_only: true,
    });
    expect("yes_price" in request.body).toBe(false);
  });

  test("rounds the limit probability to cents and clamps to 1..99", () => {
    const centsFor = (limitPrice: number): number | undefined =>
      buildKalshiOrder(decision({ limitPrice })).body.yes_price;
    expect(centsFor(0)).toBe(1);
    expect(centsFor(0.001)).toBe(1);
    expect(centsFor(0.547)).toBe(55);
    expect(centsFor(0.999)).toBe(99);
    expect(centsFor(1)).toBe(99);
  });

  test("reuses a UUID decision id as client_order_id and generates one otherwise", () => {
    expect(buildKalshiOrder(decision()).body.client_order_id).toBe(DECISION_ID);
    const generated = buildKalshiOrder(decision({ id: "exec-1" }));
    expect(generated.body.client_order_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(generated.body.client_order_id).not.toBe("exec-1");
    expect(
      buildKalshiOrder(decision({ clientOrderId: "retry-42" })).body
        .client_order_id,
    ).toBe("retry-42");
  });

  test("rejects invalid decisions with a typed reason instead of building an order", () => {
    expect(
      validationReasonOf(() =>
        buildKalshiOrder(decision({ venue: "polymarket" })),
      ),
    ).toBe("venue_not_kalshi");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ venue: null }))),
    ).toBe("venue_not_kalshi");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ position: null }))),
    ).toBe("invalid_position");
    expect(
      validationReasonOf(() =>
        buildKalshiOrder(decision({ tickerToken: "", ticker: null })),
      ),
    ).toBe("invalid_ticker");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ contracts: 0 }))),
    ).toBe("invalid_contracts");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ contracts: 1.5 }))),
    ).toBe("invalid_contracts");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ contracts: null }))),
    ).toBe("invalid_contracts");
    expect(
      validationReasonOf(() => buildKalshiOrder(decision({ limitPrice: 1.5 }))),
    ).toBe("invalid_limit_price");
    expect(
      validationReasonOf(() =>
        buildKalshiOrder(decision({ limitPrice: Number.NaN })),
      ),
    ).toBe("invalid_limit_price");
    expect(
      validationReasonOf(() =>
        buildKalshiOrder(decision({ limitPrice: null })),
      ),
    ).toBe("invalid_limit_price");
    const invalidStyle = {
      ...decision(),
      style: "market",
    } as unknown as KalshiDecisionInput;
    expect(validationReasonOf(() => buildKalshiOrder(invalidStyle))).toBe(
      "invalid_style",
    );
    const invalidAction = {
      ...decision(),
      orderAction: "hold",
    } as unknown as KalshiDecisionInput;
    expect(validationReasonOf(() => buildKalshiOrder(invalidAction))).toBe(
      "invalid_order_action",
    );
    expect(
      validationReasonOf(() =>
        buildKalshiOrder(decision({ clientOrderId: "x".repeat(65) })),
      ),
    ).toBe("invalid_client_order_id");
  });
});

describe("resolveKalshiCredentials", () => {
  test("reports a missing api key id without throwing", async () => {
    const resolution = await resolveKalshiCredentials({
      env: {},
      getSecret: async () => null,
    });
    expect(resolution.ready).toBe(false);
    expect(resolution.reason).toBe("api_key_id_missing");
    expect(resolution.credentials).toBeUndefined();
  });

  test("reads and validates the PEM named by KALSHI_PRIVATE_KEY_PATH", async () => {
    const resolution = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/tmp/generated-kalshi-key.pem",
      },
      readFile: async (path) => {
        expect(path).toBe("/tmp/generated-kalshi-key.pem");
        return PRIVATE_KEY_PEM;
      },
      getSecret: async () => null,
    });
    expect(resolution.ready).toBe(true);
    expect(resolution.reason).toBe("ready");
    expect(resolution.credentials?.apiKeyId).toBe("env-key-id");
    expect(resolution.credentials?.privateKeyPem).toContain(
      "BEGIN PRIVATE KEY",
    );
    expect(resolution.source).toEqual({
      apiKeyId: "env",
      privateKey: "env_file",
    });
  });

  test("falls back to the keychain for each field independently", async () => {
    const resolution = await resolveKalshiCredentials({
      env: { KALSHI_API_KEY_ID: "env-key-id" },
      getSecret: async (name) =>
        name === "kalshi-private-key-pem" ? PRIVATE_KEY_PEM : null,
    });
    expect(resolution.ready).toBe(true);
    expect(resolution.credentials?.apiKeyId).toBe("env-key-id");
    expect(resolution.source).toEqual({
      apiKeyId: "env",
      privateKey: "bun_secrets",
    });

    const keychainOnly = await resolveKalshiCredentials({
      env: {},
      getSecret: async (name) =>
        name === "kalshi-api-key-id"
          ? "keychain-key-id"
          : name === "kalshi-private-key-pem"
            ? PRIVATE_KEY_PEM
            : null,
    });
    expect(keychainOnly.ready).toBe(true);
    expect(keychainOnly.credentials?.apiKeyId).toBe("keychain-key-id");
    expect(keychainOnly.source).toEqual({
      apiKeyId: "bun_secrets",
      privateKey: "bun_secrets",
    });
  });

  test("reports a missing private key when only the api key is configured", async () => {
    const resolution = await resolveKalshiCredentials({
      env: { KALSHI_API_KEY_ID: "env-key-id" },
      getSecret: async () => null,
    });
    expect(resolution.ready).toBe(false);
    expect(resolution.reason).toBe("private_key_missing");
  });

  test("reports unreadable and empty PEM files precisely", async () => {
    const unreadable = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/missing.pem",
      },
      readFile: async () => {
        throw new Error("ENOENT: no such file");
      },
    });
    expect(unreadable.reason).toBe("private_key_path_unreadable");

    const empty = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/empty.pem",
      },
      readFile: async () => "   \n",
    });
    expect(empty.reason).toBe("private_key_file_empty");
  });

  test("rejects malformed PEM and non-RSA keys with distinct reasons", async () => {
    const notPem = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/not-a-key.pem",
      },
      readFile: async () => "this is not a pem",
    });
    expect(notPem.reason).toBe("private_key_invalid_pem");

    const publicKey = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/public-key.pem",
      },
      readFile: async () => PUBLIC_KEY_PEM,
    });
    expect(publicKey.reason).toBe("private_key_invalid_pem");

    const nonRsa = await resolveKalshiCredentials({
      env: {
        KALSHI_API_KEY_ID: "env-key-id",
        KALSHI_PRIVATE_KEY_PATH: "/ec-key.pem",
      },
      readFile: async () => EC_PRIVATE_KEY_PEM,
    });
    expect(nonRsa.reason).toBe("private_key_not_rsa");
  });

  test("a throwing keychain is absence, not an exception", async () => {
    const resolution = await resolveKalshiCredentials({
      env: {},
      getSecret: async () => {
        throw new Error("keychain locked");
      },
    });
    expect(resolution.ready).toBe(false);
    expect(resolution.reason).toBe("api_key_id_missing");
  });
});

describe("kalshiLiveReady", () => {
  test("reports ready for valid injected credentials", async () => {
    await expect(
      kalshiLiveReady({ credentials: CREDENTIALS }),
    ).resolves.toEqual({ ready: true, reason: "ready" });
  });

  test("passes the resolver reason through when credentials are absent", async () => {
    await expect(
      kalshiLiveReady({
        resolveCredentials: async () => ({
          ready: false,
          reason: "private_key_missing",
        }),
      }),
    ).resolves.toEqual({ ready: false, reason: "private_key_missing" });
  });

  test("rejects malformed injected key material without throwing", async () => {
    await expect(
      kalshiLiveReady({
        credentials: { apiKeyId: "k", privateKeyPem: "not-a-pem" },
      }),
    ).resolves.toEqual({ ready: false, reason: "private_key_invalid_pem" });
  });

  test("a throwing resolver is a not-ready answer, not a rejection", async () => {
    await expect(
      kalshiLiveReady({
        resolveCredentials: async () => {
          throw new Error("keychain exploded");
        },
      }),
    ).resolves.toEqual({
      ready: false,
      reason: "credentials_resolution_failed",
    });
  });
});

describe("placeKalshiOrder", () => {
  test("signs and POSTs a taker order, then normalizes the response", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.detail).toBeNull();
    expect(result.venueOrderId).toBe("kalshi-order-1");
    expect(result.status).toBe("resting");
    expect(result.filledCount).toBe(0);
    expect(result.avgPriceUsd).toBeNull();
    expect(result.raw).toEqual(SUCCESS_ORDER);

    const request = onlyRequest(captured);
    expect(request.url).toBe(
      `${KALSHI_API_BASE_URL}${KALSHI_PORTFOLIO_ORDERS_PATH}`,
    );
    expect(request.url).toBe(
      "https://api.elections.kalshi.com/trade-api/v2/portfolio/orders",
    );
    expect(request.init.method).toBe("POST");
    expect(headerValue(request.init, "KALSHI-ACCESS-KEY")).toBe(
      CREDENTIALS.apiKeyId,
    );
    expect(headerValue(request.init, "KALSHI-ACCESS-TIMESTAMP")).toBe(
      String(NOW),
    );
    expect(headerValue(request.init, "Content-Type")).toBe("application/json");
    expect(headerValue(request.init, "Accept")).toBe("application/json");
    const signature = headerValue(request.init, "KALSHI-ACCESS-SIGNATURE");
    expect(signature).not.toBeNull();
    expect(
      verifyKalshiSignature(
        `${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}`,
        signature ?? "",
      ),
    ).toBe(true);
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody(request.init)).toEqual(TAKER_BODY);
  });

  test("uses the injected resolver on the production path", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision(),
      resolveCredentials: async () => ({
        ready: true,
        reason: "ready",
        credentials: CREDENTIALS,
      }),
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const signature = headerValue(
      onlyRequest(captured).init,
      "KALSHI-ACCESS-SIGNATURE",
    );
    expect(
      verifyKalshiSignature(
        `${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}`,
        signature ?? "",
      ),
    ).toBe(true);
  });

  test("refuses a paper decision before any resolver or network call", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    let resolverCalls = 0;
    const result = await placeKalshiOrder({
      decision: decision({ paper: true }),
      resolveCredentials: async () => {
        resolverCalls += 1;
        return { ready: true, reason: "ready", credentials: CREDENTIALS };
      },
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "paper_mode");
    expect(result.detail).toBe("paper decisions never place live orders");
    expect(resolverCalls).toBe(0);
    expect(captured.requests).toHaveLength(0);
  });

  test("refuses a decision whose paper flag is absent, not explicitly false", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision({ paper: undefined }),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "paper_mode");
    expect(result.detail).toBe(
      "decision.paper must be false to place a live order",
    );
    expect(captured.requests).toHaveLength(0);
  });

  test("maps a throwing credential resolver to a refusal, not an exception", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision(),
      resolveCredentials: async () => {
        throw new Error("keychain exploded");
      },
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "credentials_resolution_failed");
    expect(result.detail).not.toContain("keychain exploded");
    expect(captured.requests).toHaveLength(0);
  });

  test("refuses a blocked decision with its block reason", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision({ blocked: true, blockReason: "duplicate_recent" }),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "blocked");
    expect(result.detail).toBe("duplicate_recent");
    expect(captured.requests).toHaveLength(0);
  });

  test("refuses when credentials are not ready, using the resolver reason", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision(),
      resolveCredentials: async () => ({
        ready: false,
        reason: "api_key_id_missing",
      }),
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "api_key_id_missing");
    expect(result.detail).not.toContain("PRIVATE KEY");
    expect(captured.requests).toHaveLength(0);
  });

  test("refuses malformed injected key material", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: { apiKeyId: "k", privateKeyPem: "not-a-pem" },
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "private_key_invalid_pem");
    expect(captured.requests).toHaveLength(0);
  });

  test("refuses an unbuildable decision instead of sending a malformed order", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    const result = await placeKalshiOrder({
      decision: decision({ contracts: 0 }),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "invalid_contracts");
    expect(captured.requests).toHaveLength(0);
  });

  test("accepts a top-level order_id and parses fill count and a cent average price", async () => {
    const captured = captureFetch(() =>
      jsonResponse({
        order_id: "kalshi-order-2",
        status: "executed",
        fill_count: "3",
        avg_price: 52,
      }),
    );
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.venueOrderId).toBe("kalshi-order-2");
    expect(result.status).toBe("executed");
    expect(result.filledCount).toBe(3);
    expect(result.avgPriceUsd).toBeCloseTo(0.52, 10);
  });

  test("derives a fill count and reads a dollar average price defensively", async () => {
    const captured = captureFetch(() =>
      jsonResponse({
        order: {
          order_id: "kalshi-order-3",
          status: "executed",
          count: 10,
          remaining_count: 4,
          avg_price: 0.48,
        },
      }),
    );
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result.filledCount).toBe(6);
    expect(result.avgPriceUsd).toBeCloseTo(0.48, 10);
  });

  test("maps a 4xx rejection to http_error with the API message", async () => {
    const captured = captureFetch(() =>
      jsonResponse(
        { error: { code: "invalid_signature", message: "signature rejected" } },
        401,
      ),
    );
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "http_error");
    expect(result.detail).toContain("401");
    expect(result.detail).toContain("signature rejected");
    expect(captured.requests).toHaveLength(1);
  });

  test("redacts the private key and the signature from error details", async () => {
    const captured = captureFetch((request) => {
      const signature =
        headerValue(request.init, "KALSHI-ACCESS-SIGNATURE") ?? "";
      return jsonResponse(
        {
          error: {
            message: `bad key ${PRIVATE_KEY_PEM} signature ${signature}`,
          },
        },
        500,
      );
    });
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    const detail = result.detail ?? "";
    const sentSignature =
      headerValue(onlyRequest(captured).init, "KALSHI-ACCESS-SIGNATURE") ?? "";
    expectRefused(result, "http_error");
    expect(sentSignature.length).toBeGreaterThan(0);
    expect(detail).not.toContain("PRIVATE KEY");
    expect(detail).not.toContain(PUBLIC_KEY_PEM);
    expect(detail).not.toContain(sentSignature);
    expect(detail).toContain("[redacted]");
    expect(detail.length).toBeLessThanOrEqual(300);
  });

  test("redacts the private key from network error details", async () => {
    const captured = captureFetch(() => {
      throw new TypeError(`fetch failed with key ${PRIVATE_KEY_PEM}`);
    });
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
    });
    expectRefused(result, "network_error");
    expect(result.detail).not.toContain("PRIVATE KEY");
    expect(result.detail).toContain("fetch failed");
  });

  test("maps an abort to timeout", async () => {
    const captured = captureFetch(() => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    });
    const result = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
      timeoutMs: 25,
    });
    expectRefused(result, "timeout");
  });

  test("maps malformed success responses explicitly", async () => {
    const notJson = captureFetch(
      () => new Response("<html>bad gateway</html>", { status: 200 }),
    );
    const unparseable = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: notJson.fetchImpl,
      now: NOW,
    });
    expectRefused(unparseable, "unparseable_response");

    const noOrderId = captureFetch(() => jsonResponse({ status: "ok" }));
    const missing = await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: noOrderId.fetchImpl,
      now: NOW,
    });
    expectRefused(missing, "missing_order_id");
  });

  test("accepts a Date or a clock function for the signed timestamp", async () => {
    const fromDate = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: fromDate.fetchImpl,
      now: new Date(NOW),
    });
    expect(
      headerValue(onlyRequest(fromDate).init, "KALSHI-ACCESS-TIMESTAMP"),
    ).toBe(String(NOW));

    const fromClock = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: fromClock.fetchImpl,
      now: () => NOW,
    });
    expect(
      headerValue(onlyRequest(fromClock).init, "KALSHI-ACCESS-TIMESTAMP"),
    ).toBe(String(NOW));
  });

  test("honors a base-url override but keeps the signed path", async () => {
    const captured = captureFetch(() => jsonResponse(SUCCESS_ORDER));
    await placeKalshiOrder({
      decision: decision(),
      credentials: CREDENTIALS,
      fetchImpl: captured.fetchImpl,
      now: NOW,
      baseUrl: "https://kalshi.test/",
    });
    const request = onlyRequest(captured);
    expect(request.url).toBe(
      `https://kalshi.test${KALSHI_PORTFOLIO_ORDERS_PATH}`,
    );
    const signature = headerValue(request.init, "KALSHI-ACCESS-SIGNATURE");
    expect(
      verifyKalshiSignature(
        `${NOW}POST${KALSHI_PORTFOLIO_ORDERS_PATH}`,
        signature ?? "",
      ),
    ).toBe(true);
  });
});
