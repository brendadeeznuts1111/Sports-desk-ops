/**
 * Kalshi live **order** adapter for the paper-by-default execution engine.
 *
 * This is the only module in the checkout that can place a real Kalshi order, and it is built so
 * that the default path here cannot: there are no Kalshi credentials in this checkout, so
 * {@link kalshiLiveReady} returns `{ready:false, reason:"api_key_id_missing"}` and every call to
 * {@link placeKalshiOrder} refuses before a network request. Live placement additionally needs a
 * caller-supplied non-paper, unblocked decision; a planning pass never places orders.
 *
 * Contract (`Scratch/graph-dashboard-contract.md` → "Kalshi live adapter"):
 * - RSA-PSS / SHA-256 over the exact string `${timestampMs}${METHOD}${pathWithoutQuery}` with
 *   `saltLength = RSA_PSS_SALTLEN_DIGEST`, sent base64 in `KALSHI-ACCESS-SIGNATURE` alongside
 *   `KALSHI-ACCESS-KEY` and `KALSHI-ACCESS-TIMESTAMP` (epoch milliseconds).
 * - `POST /trade-api/v2/portfolio/orders` with integer-cent prices; `post_only:true` is the maker
 *   guarantee (Kalshi's order `type` stays `"limit"`).
 * - Credentials from env `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY_PATH` (PEM file), or the
 *   canonical keychain service `com.bookdeskops.sportsdesk` names `kalshi-api-key-id` and
 *   `kalshi-private-key-pem`.
 *
 * Safety rules enforced here:
 * - `paper:true` decisions and blocked decisions are refused, never sent.
 * - Missing/invalid/malformed key material is a refusal with a precise reason; absence never
 *   throws. No credential, signature or request header is logged or echoed into an error string
 *   (error details are redacted and length-capped).
 * - Nothing in this module logs. It returns data.
 *
 * Tests are offline: they generate an RSA keypair, inject credentials through
 * `options.credentials` / `options.resolveCredentials`, and capture the request with
 * `options.fetchImpl`. `now` makes the signed timestamp deterministic.
 */
import {
  constants as cryptoConstants,
  createPrivateKey,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { CANONICAL_SECRETS_SERVICE, readSecretOrNull } from "./secrets.ts";

/** Production host, same one the read-only client uses. */
export const KALSHI_API_BASE_URL = "https://api.elections.kalshi.com";
/** Order endpoint pinned by the v4 contract; also the path in the signed message. */
export const KALSHI_PORTFOLIO_ORDERS_PATH = "/trade-api/v2/portfolio/orders";
/** Hard cap on one HTTP order request, per the contract (10s). */
export const KALSHI_REQUEST_TIMEOUT_MS = 10_000;
/** Env names for the operator credential pair. */
export const KALSHI_API_KEY_ID_ENV = "KALSHI_API_KEY_ID";
export const KALSHI_PRIVATE_KEY_PATH_ENV = "KALSHI_PRIVATE_KEY_PATH";
/** Canonical keychain entry names under `com.bookdeskops.sportsdesk`. */
export const KALSHI_API_KEY_ID_SECRET = "kalshi-api-key-id";
export const KALSHI_PRIVATE_KEY_PEM_SECRET = "kalshi-private-key-pem";

const TICKER_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const CLIENT_ORDER_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PEM_BLOCK_RE =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
/** Also strips an armor block truncated by a length cap (no END line in the text). */
const PEM_TRUNCATED_RE = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*/g;

/** The credential pair needed to sign one request. Never log this object. */
export interface KalshiCredentialMaterial {
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
}

/** Where each half of the credential pair was read from (diagnostics only, never the value). */
export interface KalshiCredentialSource {
  readonly apiKeyId: "env" | "bun_secrets";
  readonly privateKey: "env_file" | "bun_secrets";
}

/** Result of resolving credentials. `credentials` is present only when `ready`. */
export interface KalshiCredentialsResolution {
  readonly ready: boolean;
  readonly reason: string;
  readonly credentials?: KalshiCredentialMaterial;
  readonly source?: KalshiCredentialSource;
  readonly detail?: string;
}

export interface KalshiLiveReady {
  readonly ready: boolean;
  readonly reason: string;
}

export interface KalshiLiveReadyOptions {
  /** Test/offline seam; production callers omit it and let the resolver read env/keychain. */
  readonly credentials?: KalshiCredentialMaterial;
  /** Test seam for the default resolver. */
  readonly resolveCredentials?: () => Promise<KalshiCredentialsResolution>;
}

export interface ResolveKalshiCredentialsOptions {
  /** Env view, injectable for tests. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** PEM read, injectable for tests. Defaults to `node:fs/promises` readFile as UTF-8. */
  readonly readFile?: (path: string) => Promise<string>;
  /** Keychain read by secret name, injectable for tests. Defaults to the canonical service. */
  readonly getSecret?: (name: string) => Promise<string | null>;
}

export interface KalshiSignInput {
  readonly apiKeyId: string;
  readonly privateKeyPem: string;
  readonly method: string;
  /** Full path or path+query; the query string is not part of the signed message. */
  readonly path: string;
  readonly timestampMs: number;
}

export interface KalshiAuthHeaders {
  readonly "KALSHI-ACCESS-KEY": string;
  readonly "KALSHI-ACCESS-SIGNATURE": string;
  readonly "KALSHI-ACCESS-TIMESTAMP": string;
}

export type KalshiOrderSide = "yes" | "no";
export type KalshiOrderAction = "buy" | "sell";

export interface KalshiOrderBody {
  readonly ticker: string;
  readonly client_order_id: string;
  readonly side: KalshiOrderSide;
  readonly action: KalshiOrderAction;
  readonly type: "limit";
  readonly count: number;
  readonly yes_price?: number;
  readonly no_price?: number;
  readonly post_only?: true;
}

export interface KalshiOrderRequest {
  readonly method: "POST";
  readonly path: string;
  readonly body: KalshiOrderBody;
}

/**
 * The decision fields this adapter consumes. Structurally compatible with the engine's
 * `ExecutionDecision` (all fields optional here because this is a boundary: the engine's type has
 * nullable venue/style, and every value is re-validated at runtime before an order is built).
 */
export interface KalshiDecisionInput {
  readonly id?: string | undefined;
  readonly venue?: string | null | undefined;
  readonly style?: "taker" | "maker" | null | undefined;
  readonly position?: "yes" | "no" | null | undefined;
  readonly orderAction?: "buy" | "sell" | undefined;
  readonly tickerToken?: string | null | undefined;
  readonly ticker?: string | null | undefined;
  readonly limitPrice?: number | null | undefined;
  readonly contracts?: number | null | undefined;
  readonly paper?: boolean | undefined;
  readonly blocked?: boolean | undefined;
  readonly blockReason?: string | null | undefined;
  readonly clientOrderId?: string | undefined;
}

export type KalshiInvalidDecisionReason =
  | "venue_not_kalshi"
  | "invalid_style"
  | "invalid_position"
  | "invalid_order_action"
  | "invalid_ticker"
  | "invalid_limit_price"
  | "invalid_contracts"
  | "invalid_client_order_id";

/** A decision that cannot become a well-formed Kalshi order. Nothing is sent. */
export class KalshiOrderValidationError extends Error {
  readonly reason: KalshiInvalidDecisionReason;

  constructor(reason: KalshiInvalidDecisionReason, message: string) {
    super(message);
    this.name = "KalshiOrderValidationError";
    this.reason = reason;
  }
}

/** Narrow fetch surface; `fetch` itself satisfies it. */
export type KalshiFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PlaceKalshiOrderOptions {
  readonly decision: KalshiDecisionInput;
  /** Test seam. Defaults to the global `fetch`. */
  readonly fetchImpl?: KalshiFetch;
  /** Injected clock, for a deterministic signed timestamp. */
  readonly now?: number | Date | (() => number);
  /** Test/offline seam; production callers omit it so env/keychain are the only source. */
  readonly credentials?: KalshiCredentialMaterial;
  /** Test seam around the default credential resolver. */
  readonly resolveCredentials?: () => Promise<KalshiCredentialsResolution>;
  /** Defaults to {@link KALSHI_API_BASE_URL}. */
  readonly baseUrl?: string;
  /** Defaults to {@link KALSHI_REQUEST_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/**
 * Flat, JSON-friendly placement result. Refusals and failures are `ok:false` with a `reason` and
 * a redacted `detail`; the required normalized order fields are always present.
 */
export interface PlaceKalshiOrderResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly detail: string | null;
  readonly venueOrderId: string | null;
  readonly status: string | null;
  readonly filledCount: number;
  readonly avgPriceUsd: number | null;
  readonly raw?: unknown;
}

/** The exact message Kalshi expects to be signed. */
export function kalshiSigningMessage(
  timestampMs: number,
  method: string,
  path: string,
): string {
  const pathWithoutQuery = path.split("?")[0] ?? path;
  return `${Math.trunc(timestampMs)}${method.toUpperCase()}${pathWithoutQuery}`;
}

/**
 * Sign one Kalshi request. Throws only for a non-finite timestamp or empty key id; signing
 * failures propagate without echoing the private key. Never logs and never returns the PEM.
 */
export function signKalshiRequest(input: KalshiSignInput): KalshiAuthHeaders {
  if (input.apiKeyId.trim() === "") {
    throw new Error("Kalshi apiKeyId is required for request signing");
  }
  if (!Number.isFinite(input.timestampMs)) {
    throw new Error(
      "Kalshi timestampMs must be a finite epoch-milliseconds number",
    );
  }
  const timestampMs = Math.trunc(input.timestampMs);
  const message = kalshiSigningMessage(timestampMs, input.method, input.path);
  const signature = cryptoSign("sha256", Buffer.from(message, "utf8"), {
    key: input.privateKeyPem,
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  });
  return {
    "KALSHI-ACCESS-KEY": input.apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": String(timestampMs),
  };
}

/**
 * Map an engine decision to the exact Kalshi order request. Pure: no credentials, no network.
 * Throws {@link KalshiOrderValidationError} rather than emitting a malformed order.
 */
export function buildKalshiOrder(
  decision: KalshiDecisionInput,
): KalshiOrderRequest {
  if (decision.venue !== "kalshi") {
    throw new KalshiOrderValidationError(
      "venue_not_kalshi",
      'decision venue must be "kalshi" for a Kalshi order',
    );
  }
  const ticker = firstNonEmpty(decision.tickerToken, decision.ticker);
  if (ticker === null || !TICKER_RE.test(ticker)) {
    throw new KalshiOrderValidationError(
      "invalid_ticker",
      "decision must carry a Kalshi market ticker (tickerToken/ticker)",
    );
  }
  if (decision.style !== "taker" && decision.style !== "maker") {
    throw new KalshiOrderValidationError(
      "invalid_style",
      'decision style must be "taker" or "maker"',
    );
  }
  if (decision.position !== "yes" && decision.position !== "no") {
    throw new KalshiOrderValidationError(
      "invalid_position",
      'live order position must be "yes" or "no"',
    );
  }
  if (decision.orderAction !== "buy" && decision.orderAction !== "sell") {
    throw new KalshiOrderValidationError(
      "invalid_order_action",
      'decision orderAction must be "buy" or "sell"',
    );
  }
  const limitPrice = decision.limitPrice;
  if (
    typeof limitPrice !== "number" ||
    !Number.isFinite(limitPrice) ||
    limitPrice < 0 ||
    limitPrice > 1
  ) {
    throw new KalshiOrderValidationError(
      "invalid_limit_price",
      "decision limitPrice must be a probability in [0,1]",
    );
  }
  const contracts = decision.contracts;
  if (
    typeof contracts !== "number" ||
    !Number.isSafeInteger(contracts) ||
    contracts < 1
  ) {
    throw new KalshiOrderValidationError(
      "invalid_contracts",
      "decision contracts must be a positive integer",
    );
  }
  // Kalshi quotes integer cents; a 0 or 100 round is clamped to the tradeable 1..99 band.
  const cents = Math.min(99, Math.max(1, Math.round(limitPrice * 100)));
  const body: KalshiOrderBody = {
    ticker,
    client_order_id: resolveClientOrderId(decision),
    side: decision.position,
    action: decision.orderAction,
    type: "limit",
    count: contracts,
    ...(decision.position === "yes"
      ? { yes_price: cents }
      : { no_price: cents }),
    ...(decision.style === "maker" ? { post_only: true as const } : {}),
  };
  return { method: "POST", path: KALSHI_PORTFOLIO_ORDERS_PATH, body };
}

/**
 * Resolve the Kalshi credential pair without ever throwing for absence. Env wins per field, then
 * the canonical keychain service. A file that exists but does not parse is reported precisely.
 */
export async function resolveKalshiCredentials(
  options: ResolveKalshiCredentialsOptions = {},
): Promise<KalshiCredentialsResolution> {
  const env = options.env ?? process.env;
  const readPemFile = options.readFile ?? defaultReadFile;
  const getSecret = options.getSecret ?? defaultGetSecret;

  let apiKeyId = nonEmpty(env[KALSHI_API_KEY_ID_ENV]);
  let apiKeySource: KalshiCredentialSource["apiKeyId"] = "env";
  if (apiKeyId === null) {
    apiKeyId = await safeSecret(getSecret, KALSHI_API_KEY_ID_SECRET);
    if (apiKeyId === null) {
      return unavailable(
        "api_key_id_missing",
        `set ${KALSHI_API_KEY_ID_ENV} or keychain ${CANONICAL_SECRETS_SERVICE}/${KALSHI_API_KEY_ID_SECRET}`,
      );
    }
    apiKeySource = "bun_secrets";
  }

  const envKeyPath = nonEmpty(env[KALSHI_PRIVATE_KEY_PATH_ENV]);
  let privateKeyPem: string | null = null;
  let privateKeySource: KalshiCredentialSource["privateKey"] = "env_file";
  if (envKeyPath !== null) {
    let rawPem: string;
    try {
      rawPem = await readPemFile(envKeyPath);
    } catch {
      return unavailable(
        "private_key_path_unreadable",
        `${KALSHI_PRIVATE_KEY_PATH_ENV} is set but its PEM file could not be read`,
      );
    }
    privateKeyPem = nonEmpty(rawPem);
    if (privateKeyPem === null) {
      return unavailable(
        "private_key_file_empty",
        `${KALSHI_PRIVATE_KEY_PATH_ENV} points at an empty file`,
      );
    }
  } else {
    privateKeyPem = await safeSecret(getSecret, KALSHI_PRIVATE_KEY_PEM_SECRET);
    if (privateKeyPem === null) {
      return unavailable(
        "private_key_missing",
        `set ${KALSHI_PRIVATE_KEY_PATH_ENV} or keychain ${CANONICAL_SECRETS_SERVICE}/${KALSHI_PRIVATE_KEY_PEM_SECRET}`,
      );
    }
    privateKeySource = "bun_secrets";
  }

  const credentials: KalshiCredentialMaterial = {
    apiKeyId,
    privateKeyPem,
  };
  const problem = credentialProblem(credentials);
  if (problem !== null) return unavailable(problem.reason, problem.detail);
  return {
    ready: true,
    reason: "ready",
    credentials,
    source: { apiKeyId: apiKeySource, privateKey: privateKeySource },
  };
}

/**
 * Venue live-readiness for the execution engine. Async because the keychain read is async; callers
 * must `await` it. No credentials in a checkout is a `ready:false` answer, not an error.
 */
export async function kalshiLiveReady(
  options: KalshiLiveReadyOptions = {},
): Promise<KalshiLiveReady> {
  const resolution = await materializeCredentials(
    options.credentials,
    options.resolveCredentials,
  );
  return { ready: resolution.ready, reason: resolution.reason };
}

/**
 * Place one Kalshi limit order. Refuses paper decisions, blocked decisions and any credentials
 * that are not ready; otherwise signs and POSTs with a hard 10s timeout and returns a normalized
 * result. Never throws and never logs key material.
 */
export async function placeKalshiOrder(
  options: PlaceKalshiOrderOptions,
): Promise<PlaceKalshiOrderResult> {
  try {
    return await placeKalshiOrderInner(options);
  } catch (error) {
    return refused(
      "unexpected_error",
      redactSecrets(safeErrorMessage(error), []),
    );
  }
}

async function placeKalshiOrderInner(
  options: PlaceKalshiOrderOptions,
): Promise<PlaceKalshiOrderResult> {
  const { decision } = options;
  // The contract refuses unless paper is explicitly false: an absent flag is not live consent.
  if (decision.paper !== false) {
    return decision.paper === true
      ? refused("paper_mode", "paper decisions never place live orders")
      : refused(
          "paper_mode",
          "decision.paper must be false to place a live order",
        );
  }
  if (decision.blocked === true) {
    return refused(
      "blocked",
      nonEmpty(decision.blockReason) ?? "decision is blocked by the risk gates",
    );
  }

  let request: KalshiOrderRequest;
  try {
    request = buildKalshiOrder(decision);
  } catch (error) {
    if (error instanceof KalshiOrderValidationError) {
      return refused(error.reason, error.message);
    }
    return refused(
      "invalid_decision",
      redactSecrets(safeErrorMessage(error), []),
    );
  }

  const resolution = await materializeCredentials(
    options.credentials,
    options.resolveCredentials,
  );
  if (!resolution.ready || resolution.credentials === undefined) {
    return refused(
      resolution.reason,
      "Kalshi credentials are not ready; no order was sent",
    );
  }
  const credentials = resolution.credentials;
  const timestampMs = resolveTimestampMs(options.now);
  if (timestampMs === null) {
    return refused(
      "invalid_clock",
      "now did not resolve to a finite epoch-milliseconds timestamp",
    );
  }

  let signedHeaders: KalshiAuthHeaders;
  try {
    signedHeaders = signKalshiRequest({
      apiKeyId: credentials.apiKeyId,
      privateKeyPem: credentials.privateKeyPem,
      method: request.method,
      path: request.path,
      timestampMs,
    });
  } catch (error) {
    return refused(
      "signing_failed",
      `Kalshi order signing failed: ${redactSecrets(safeErrorMessage(error), [])}`,
    );
  }

  const secrets = [
    credentials.privateKeyPem,
    signedHeaders["KALSHI-ACCESS-SIGNATURE"],
  ];
  const baseUrl = trimTrailingSlash(options.baseUrl ?? KALSHI_API_BASE_URL);
  const timeoutMs = options.timeoutMs ?? KALSHI_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? defaultFetch)(
      `${baseUrl}${request.path}`,
      {
        method: request.method,
        headers: {
          ...signedHeaders,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (error) {
    const reason = isTimeoutError(error) ? "timeout" : "network_error";
    return refused(reason, redactSecrets(safeErrorMessage(error), secrets));
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    return refused(
      "response_read_failed",
      redactSecrets(safeErrorMessage(error), secrets),
    );
  }
  if (!response.ok) {
    const apiMessage = extractApiErrorMessage(responseText);
    return refused(
      "http_error",
      redactSecrets(
        `Kalshi HTTP ${response.status}: ${apiMessage ?? "order request rejected"}`,
        secrets,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return refused(
      "unparseable_response",
      "Kalshi returned a non-JSON order response",
    );
  }
  if (!isRecord(parsed)) {
    return refused(
      "unparseable_response",
      "Kalshi returned a non-object order response",
    );
  }
  const normalized = normalizeKalshiOrder(parsed);
  if (normalized === null) {
    return refused(
      "missing_order_id",
      "Kalshi order response did not include an order id",
    );
  }
  return {
    ok: true,
    reason: null,
    detail: null,
    venueOrderId: normalized.venueOrderId,
    status: normalized.status,
    filledCount: normalized.filledCount,
    avgPriceUsd: normalized.avgPriceUsd,
    raw: parsed,
  };
}

interface NormalizedKalshiOrder {
  readonly venueOrderId: string;
  readonly status: string | null;
  readonly filledCount: number;
  readonly avgPriceUsd: number | null;
}

/**
 * Read a Kalshi order payload defensively: `{order:{order_id,...}}` is the documented shape, but a
 * top-level `order_id` (and numeric strings) is accepted so a field rename cannot turn a placed
 * order into an exception.
 */
function normalizeKalshiOrder(raw: unknown): NormalizedKalshiOrder | null {
  if (!isRecord(raw)) return null;
  const nested = isRecord(raw["order"]) ? raw["order"] : null;
  const fields = nested ?? raw;
  const venueOrderId =
    firstString(fields, ["order_id", "orderId"]) ??
    (nested === null ? null : firstString(raw, ["order_id", "orderId"]));
  if (venueOrderId === null) return null;

  const status = firstString(fields, ["status"]);
  const fillCount = firstNumber(fields, [
    "fill_count",
    "filled_count",
    "fillCount",
  ]);
  let filledCount = 0;
  if (fillCount !== null) {
    filledCount = Math.max(0, Math.trunc(fillCount));
  } else {
    const count = firstNumber(fields, [
      "count",
      "initial_count",
      "initialCount",
    ]);
    const remaining = firstNumber(fields, [
      "remaining_count",
      "remainingCount",
    ]);
    if (count !== null && remaining !== null) {
      filledCount = Math.max(0, Math.trunc(count - remaining));
    }
  }
  const avgPriceUsd = parseAveragePrice(
    firstNumber(fields, [
      "avg_price",
      "average_price",
      "avg_fill_price",
      "avgPrice",
    ]),
  );
  return { venueOrderId, status, filledCount, avgPriceUsd };
}

/**
 * Kalshi order payloads quote integer cents; an interface that returns a fractional dollar string
 * is accepted too. Any value >= 1 can only be cents for a contract (max 99c), so it is divided.
 */
function parseAveragePrice(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value < 1) return value;
  const dollars = value / 100;
  return dollars < 1 ? dollars : null;
}

function extractApiErrorMessage(bodyText: string): string | null {
  const trimmed = bodyText.trim();
  if (trimmed === "") return null;
  // Bound the parse input; a PEM the body echoes is redacted by the caller either way.
  const bounded = trimmed.length > 8_192 ? trimmed.slice(0, 8_192) : trimmed;
  try {
    const parsed: unknown = JSON.parse(bounded);
    if (isRecord(parsed)) {
      const error = parsed["error"];
      if (isRecord(error)) {
        const message = firstString(error, ["message", "detail", "code"]);
        if (message !== null) return message;
      }
      const message = firstString(parsed, ["message", "detail"]);
      if (message !== null) return message;
    }
  } catch {
    // Not JSON: fall back to the raw text below.
  }
  return bounded;
}

async function materializeCredentials(
  credentials: KalshiCredentialMaterial | undefined,
  resolveCredentials: (() => Promise<KalshiCredentialsResolution>) | undefined,
): Promise<KalshiCredentialsResolution> {
  if (credentials !== undefined) {
    const problem = credentialProblem(credentials);
    if (problem !== null) return unavailable(problem.reason, problem.detail);
    return { ready: true, reason: "ready", credentials };
  }
  let resolution: KalshiCredentialsResolution;
  try {
    resolution =
      resolveCredentials === undefined
        ? await resolveKalshiCredentials()
        : await resolveCredentials();
  } catch {
    return unavailable(
      "credentials_resolution_failed",
      "the credential resolver threw; check the configured Kalshi credential source",
    );
  }
  if (!resolution.ready) return resolution;
  if (resolution.credentials === undefined) {
    return unavailable(
      "credentials_unavailable",
      "credential resolver reported ready without credential material",
    );
  }
  const problem = credentialProblem(resolution.credentials);
  if (problem !== null) return unavailable(problem.reason, problem.detail);
  return resolution;
}

function credentialProblem(
  material: KalshiCredentialMaterial,
): { readonly reason: string; readonly detail?: string } | null {
  if (material.apiKeyId.trim() === "") {
    return { reason: "api_key_id_missing", detail: "apiKeyId is empty" };
  }
  const pem = material.privateKeyPem.trim();
  if (pem === "") {
    return { reason: "private_key_missing", detail: "privateKeyPem is empty" };
  }
  if (!pem.includes("-----BEGIN") || !pem.includes("-----END")) {
    return { reason: "private_key_invalid_pem" };
  }
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey({ key: pem, format: "pem" }).asymmetricKeyType;
  } catch {
    return { reason: "private_key_invalid_pem" };
  }
  if (keyType !== "rsa" && keyType !== "rsa-pss") {
    return {
      reason: "private_key_not_rsa",
      detail: `key type is ${keyType ?? "unknown"}, RSA-PSS requires an RSA key`,
    };
  }
  return null;
}

function resolveClientOrderId(decision: KalshiDecisionInput): string {
  const explicit = nonEmpty(decision.clientOrderId);
  if (explicit !== null) {
    if (!CLIENT_ORDER_ID_RE.test(explicit)) {
      throw new KalshiOrderValidationError(
        "invalid_client_order_id",
        "clientOrderId must be 1-64 chars of [A-Za-z0-9._:-]",
      );
    }
    return explicit;
  }
  const decisionId = nonEmpty(decision.id);
  if (decisionId !== null && UUID_RE.test(decisionId)) return decisionId;
  return randomUUID();
}

function resolveTimestampMs(
  now: PlaceKalshiOrderOptions["now"],
): number | null {
  const value =
    typeof now === "function"
      ? now()
      : now instanceof Date
        ? now.getTime()
        : (now ?? Date.now());
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function refused(reason: string, detail: string): PlaceKalshiOrderResult {
  return {
    ok: false,
    reason,
    detail,
    venueOrderId: null,
    status: null,
    filledCount: 0,
    avgPriceUsd: null,
  };
}

function unavailable(
  reason: string,
  detail?: string,
): KalshiCredentialsResolution {
  return detail === undefined
    ? { ready: false, reason }
    : { ready: false, reason, detail };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Strip the generated PEM block and the exact signature before any string leaves this module. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 8)
      redacted = redacted.split(secret).join("[redacted]");
  }
  redacted = redacted.replace(PEM_BLOCK_RE, "[redacted]");
  // A length-capped message may carry only the armor header of the key; strip to the end.
  redacted = redacted.replace(PEM_TRUNCATED_RE, "[redacted]");
  return redacted.slice(0, 300);
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

function firstNonEmpty(
  ...values: readonly (string | null | undefined)[]
): string | null {
  for (const value of values) {
    const trimmed = nonEmpty(value);
    if (trimmed !== null) return trimmed;
  }
  return null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function defaultReadFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function defaultGetSecret(name: string): Promise<string | null> {
  return readSecretOrNull(CANONICAL_SECRETS_SERVICE, name);
}

function defaultFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, init);
}

async function safeSecret(
  getSecret: (name: string) => Promise<string | null>,
  name: string,
): Promise<string | null> {
  try {
    return nonEmpty(await getSecret(name));
  } catch {
    return null;
  }
}
