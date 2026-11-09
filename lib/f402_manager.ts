/**
 * @file f402_manager.ts
 * @description Fantasy402 Manager Mutation Dispatch Worker & Rate-Paced Player Clamps (DOD6 v5.5).
 *
 * ARCHITECTURAL PARTITION INVARIANTS:
 * 1. Fantasy402 Mutations: All writes (Manager/updateByColumn, Manager/vigSetupInsert) route
 *    strictly to cloud.fantasy402.com. GSLive (Partner 118) has NO mutation API; mutations must
 *    never target sportswidgets.pro.
 * 2. Token-Bucket Pacing: Enforces 20 req/s rate-limiting with burst capacity of 20 to prevent
 *    tripping Fantasy402 endpoint guards.
 * 3. Identity Resolution: Resolves customer logins to CustomerSpineEntry yielding strict 11-char
 *    right-space-padded PaddedCustomerId and leaf agentID, never master BILLY666. Raw GSLive
 *    M.G<id> tokens are rejected at the boundary.
 */

import {
  type PaddedCustomerId,
  type AgentIdentifier,
  padCustomerIdCanonical,
  agentIdentifier,
} from "../design/domain-branded-types.ts";

const F402_SCHEME = "https://";
const F402_DOMAIN = "cloud.fantasy402.com";
export const F402_CANONICAL_MUTATION_URL =
  `${F402_SCHEME}${F402_DOMAIN}/cloud/api/Manager/updateByColumn` as const;
export const F402_CANONICAL_VIG_URL =
  `${F402_SCHEME}${F402_DOMAIN}/cloud/api/Manager/vigSetupInsert` as const;

export const DEFAULT_DISPATCH_RATE_PER_SEC = 20;
export const DEFAULT_DISPATCH_BURST_CAPACITY = 20;

export type LiveDelaySeconds = "10" | "11" | "12" | 10 | 11 | 12;

export interface CustomerSpineEntry {
  readonly rowIndex: number;
  readonly customerId: string;
  readonly paddedCustomerId: PaddedCustomerId;
  readonly leafAgentId: AgentIdentifier;
  readonly masterAgentId?: string;
  readonly currentDelaySeconds?: number;
  readonly isShieldedVip?: boolean;
}

/** Error thrown when an invalid identifier or GSLive token is submitted to Fantasy402 mutation dispatch. */
export class InvalidFantasy402IdentifierError extends Error {
  constructor(message: string) {
    super(`[InvalidFantasy402IdentifierError] ${message}`);
    this.name = "InvalidFantasy402IdentifierError";
  }
}

/** Error thrown when a mutation target violates the strict cloud.fantasy402.com boundary. */
export class MutationTargetPartitionError extends Error {
  constructor(targetUrl: string) {
    super(
      `[MutationTargetPartitionError] Mutation dispatch attempted against invalid endpoint '${targetUrl}'. Fantasy402 mutations must strictly target cloud.fantasy402.com, never GSLive.`,
    );
    this.name = "MutationTargetPartitionError";
  }
}

/**
 * Token bucket rate limiter for pacing outbound mutations.
 * Enforces ratePerSec (e.g. 20 req/s) with burst capacity.
 */
export class TokenBucketLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    readonly ratePerSec: number = DEFAULT_DISPATCH_RATE_PER_SEC,
    readonly burstCapacity: number = DEFAULT_DISPATCH_BURST_CAPACITY,
  ) {
    this.tokens = burstCapacity;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = Math.max(0, now - this.lastRefillMs);
    const addedTokens = (elapsedMs * this.ratePerSec) / 1000;
    this.tokens = Math.min(this.burstCapacity, this.tokens + addedTokens);
    this.lastRefillMs = now;
  }

  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }

  async acquire(tokensNeeded: number = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= tokensNeeded) {
        this.tokens -= tokensNeeded;
        return;
      }
      const deficit = tokensNeeded - this.tokens;
      const waitMs = Math.ceil((deficit * 1000) / this.ratePerSec);
      await Bun.sleep(Math.max(5, waitMs));
    }
  }

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
    return `${bold("TokenBucketLimiter")}(${cyan("available=")}${this.availableTokens.toFixed(1)}/${this.burstCapacity}, ${cyan("rate=")}${this.ratePerSec}req/s)`;
  }
}

/**
 * Validates that an outbound mutation URL strictly points to Fantasy402 and not GSLive.
 */
export function validateMutationTargetUrl(url: string): string {
  const normalized = url.trim().toLowerCase();
  if (
    normalized.includes("sportswidgets.pro") ||
    normalized.includes("gslive") ||
    normalized.includes("manager-tools")
  ) {
    throw new MutationTargetPartitionError(url);
  }
  if (!normalized.includes("fantasy402.com")) {
    throw new MutationTargetPartitionError(url);
  }
  return url;
}

/**
 * Resolves customer identifier and enforces boundaries:
 * - Rejects GSLive internal betGroup tokens (M.G...)
 * - Rejects empty or over-length logins
 * - Pads to 11-char PaddedCustomerId
 */
export function resolveCustomerMutationTarget(
  customerLogin: string,
  leafAgent: string,
): {
  readonly customerId: string;
  readonly paddedCustomerId: PaddedCustomerId;
  readonly leafAgentId: AgentIdentifier;
} {
  const trimmed = customerLogin.trim();
  if (/^M\.G\d+/i.test(trimmed)) {
    throw new InvalidFantasy402IdentifierError(
      `Cannot pass GSLive BetGroupIdentifier '${trimmed}' to Fantasy402 Manager mutation. Resolve customer login from CustomerSpineColumnStore first.`,
    );
  }
  if (trimmed.length === 0 || trimmed.length > 11) {
    throw new InvalidFantasy402IdentifierError(
      `Customer identifier '${trimmed}' must be between 1 and 11 characters (got length ${trimmed.length})`,
    );
  }

  const cleanAgent = leafAgent.trim().toUpperCase();
  if (cleanAgent === "BILLY666") {
    throw new InvalidFantasy402IdentifierError(
      "Master agent 'BILLY666' cannot be passed as owning agent on player mutations; direct leaf agent required.",
    );
  }

  return {
    customerId: trimmed.toUpperCase(),
    paddedCustomerId: padCustomerIdCanonical(trimmed),
    leafAgentId: agentIdentifier(cleanAgent),
  };
}

export interface PlayerClampParams {
  readonly customerId: string;
  readonly agentOwner: string;
  readonly column: string;
  readonly value: string | number;
  readonly targetUrl?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface PlayerClampResult {
  readonly success: boolean;
  readonly isCommitted: boolean;
  readonly customerId: PaddedCustomerId;
  readonly agentOwner: AgentIdentifier;
  readonly column: string;
  readonly value: string | number;
  readonly durationMs: number;
  readonly rawResponse?: unknown;
  readonly targetUrl?: string | undefined;
  readonly delayApplied?: string | undefined;
}

export interface VigSetupParams {
  readonly customerId: string;
  readonly sportType: string;
  readonly vigSpread?: string | undefined;
  readonly vigTotal?: string | undefined;
  readonly vigDerivative?: string | undefined;
  readonly targetUrl?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface VigSetupResult {
  readonly success: boolean;
  readonly customerId: PaddedCustomerId;
  readonly sportType: string;
  readonly vigSpread: string;
  readonly vigDerivative: string;
  readonly durationMs: number;
}

/**
 * Verified half-point hook syndicate accounts and their leaf agent owners.
 */
export const HALF_POINT_HOOK_SYNDICATE_ROSTER: ReadonlyArray<{
  readonly customerId: string;
  readonly leafAgentId: string;
}> = [
  { customerId: "GP301", leafAgentId: "GPRO50RSK" },
  { customerId: "BRT5229", leafAgentId: "BARRETT" },
  { customerId: "BRT5235", leafAgentId: "BARRETT" },
  { customerId: "CCC88412", leafAgentId: "FATSNOBOT" },
  { customerId: "MJ107", leafAgentId: "MJ2026" },
] as const;

/**
 * Football sport sub-types requiring +25c/+30c key-number vig shading (`College`, `NFL`).
 */
export const HOOK_REPRICING_SPORT_TYPES = ["College", "NFL"] as const;

/**
 * Fantasy402 Manager Mutation Dispatch Worker.
 * Manages token-bucket rate limiting, strictly targets cloud.fantasy402.com,
 * and executes defensive player clamps.
 */
export class Fantasy402ManagerWorker {
  readonly limiter: TokenBucketLimiter;
  readonly defaultBaseUrl: string;

  constructor(
    options: {
      readonly ratePerSec?: number;
      readonly burstCapacity?: number;
      readonly baseUrl?: string;
    } = {},
  ) {
    this.limiter = new TokenBucketLimiter(
      options.ratePerSec ?? DEFAULT_DISPATCH_RATE_PER_SEC,
      options.burstCapacity ?? DEFAULT_DISPATCH_BURST_CAPACITY,
    );
    this.defaultBaseUrl = options.baseUrl ?? F402_CANONICAL_MUTATION_URL;
  }

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
    return `${bold("Fantasy402ManagerWorker")}(${cyan("target=")}"cloud.fantasy402.com", ${cyan("limiter=")}${Bun.inspect(this.limiter, options)})`;
  }

  /**
   * Executes a defensive live delay clamp (10s, 11s, or 12s) via updateByColumn.
   */
  async clampLiveDelay(
    customerId: string,
    agentOwner: string,
    delaySeconds: LiveDelaySeconds,
    headers?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<PlayerClampResult> {
    const delayVal = String(delaySeconds);
    if (delayVal !== "10" && delayVal !== "11" && delayVal !== "12") {
      throw new RangeError(
        `Live delay clamp value must be '10', '11', or '12' (got: ${delayVal})`,
      );
    }
    return this.dispatchPlayerColumnMutation({
      customerId,
      agentOwner,
      column: "confirmationDelaySeconds",
      value: delayVal,
      headers,
      fetchImpl,
    });
  }

  /**
   * Clamps maximum wager stake (MaxBet) for a customer.
   */
  async clampMaxBet(
    customerId: string,
    agentOwner: string,
    maxBetAmount: number | string,
    headers?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<PlayerClampResult> {
    return this.dispatchPlayerColumnMutation({
      customerId,
      agentOwner,
      column: "MaxBet",
      value: String(maxBetAmount),
      headers,
      fetchImpl,
    });
  }

  /**
   * Clamps maximum parlay stake (ParlayMaxBet).
   */
  async clampParlayMaxBet(
    customerId: string,
    agentOwner: string,
    parlayMaxBetAmount: number | string,
    headers?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<PlayerClampResult> {
    return this.dispatchPlayerColumnMutation({
      customerId,
      agentOwner,
      column: "ParlayMaxBet",
      value: String(parlayMaxBetAmount),
      headers,
      fetchImpl,
    });
  }

  /**
   * Toggles Allow1H2HQtr permission.
   */
  async clampAllow1H2HQtr(
    customerId: string,
    agentOwner: string,
    allow: "Y" | "N",
    headers?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<PlayerClampResult> {
    return this.dispatchPlayerColumnMutation({
      customerId,
      agentOwner,
      column: "Allow1H2HQtr",
      value: allow,
      headers,
      fetchImpl,
    });
  }

  /**
   * Dispatches a player column update with rate limiting and partition validation.
   */
  async dispatchPlayerColumnMutation(
    params: PlayerClampParams,
  ): Promise<PlayerClampResult> {
    const targetUrl = validateMutationTargetUrl(
      params.targetUrl ?? this.defaultBaseUrl,
    );
    const { paddedCustomerId, leafAgentId } = resolveCustomerMutationTarget(
      params.customerId,
      params.agentOwner,
    );

    // Rate pacing
    await this.limiter.acquire(1);

    const start = Date.now();
    const bodyParams = new URLSearchParams({
      operation: "updateByColumn",
      customerID: paddedCustomerId,
      agentID: leafAgentId,
      agentOwner: leafAgentId,
      column: params.column,
      value: String(params.value),
      RRO: "0",
    });

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      ...params.headers,
    };

    const fetchFn = params.fetchImpl ?? fetch;
    const response = await fetchFn(targetUrl, {
      method: "POST",
      headers: reqHeaders,
      body: bodyParams.toString(),
      signal: AbortSignal.timeout(8000),
      referrerPolicy: "no-referrer",
    });

    const durationMs = Date.now() - start;
    const isDelay =
      params.column === "Delay" || params.column === "confirmationDelaySeconds";

    if (!response.ok) {
      return {
        success: false,
        isCommitted: false,
        customerId: paddedCustomerId,
        agentOwner: leafAgentId,
        column: params.column,
        value: params.value,
        durationMs,
        targetUrl,
        delayApplied: isDelay ? String(params.value) : undefined,
      };
    }

    const json: unknown = await response.json().catch(() => ({}));
    const rawResult =
      (json as { Result?: { Result?: unknown } })?.Result?.Result ??
      (json as { Result?: unknown })?.Result;
    const isCommitted = rawResult === 1 || rawResult === "1";

    return {
      success: isCommitted,
      isCommitted,
      customerId: paddedCustomerId,
      agentOwner: leafAgentId,
      column: params.column,
      value: params.value,
      durationMs,
      targetUrl,
      delayApplied: isDelay ? String(params.value) : undefined,
      rawResponse: json,
    };
  }

  /**
   * Inserts shaded sport vig setup (+15c/+20c/+25c) via vigSetupInsert.
   */
  async dispatchVigSetupInsert(
    params: VigSetupParams,
  ): Promise<VigSetupResult> {
    const targetUrl = validateMutationTargetUrl(
      params.targetUrl ?? F402_CANONICAL_VIG_URL,
    );
    const { paddedCustomerId } = resolveCustomerMutationTarget(
      params.customerId,
      "LEAF_AGENT",
    );

    await this.limiter.acquire(1);

    const start = Date.now();
    const paddedSport = params.sportType.padEnd(20, " ");
    const vigSpread = params.vigSpread ?? "15";
    const vigTotal = params.vigTotal ?? "15";
    const vigDerivative = params.vigDerivative ?? "20";

    const payload = {
      operation: "vigSetupInsert",
      sportType: paddedSport,
      allPlayers: "off",
      agentProfile: 0,
      player: paddedCustomerId,
      flagVig: "Y",
      flagDiscount: "N",
      VigSpread: vigSpread,
      VigTotal: vigTotal,
      VigDerivative: vigDerivative,
      VigDiscountPercent: "0",
      RRO: "1",
    };

    const reqHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json",
      ...params.headers,
    };

    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(targetUrl, {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
      referrerPolicy: "no-referrer",
    });

    const durationMs = Date.now() - start;
    if (!res.ok) {
      return {
        success: false,
        customerId: paddedCustomerId,
        sportType: paddedSport,
        vigSpread,
        vigDerivative,
        durationMs,
      };
    }

    const json: unknown = await res.json().catch(() => ({}));
    const rawResult =
      (json as { Result?: { Result?: unknown } })?.Result?.Result ??
      (json as { Result?: unknown })?.Result;
    const isCommitted = rawResult === 1 || rawResult === "1";

    return {
      success: isCommitted,
      customerId: paddedCustomerId,
      sportType: paddedSport,
      vigSpread,
      vigDerivative,
      durationMs,
    };
  }

  /**
   * Dispatches +25c spread / +25c derivative vig shading across CFB (`"College             "`)
   * and NFL (`"NFL                 "`) for the 5 half-point hook syndicate accounts.
   */
  async dispatchHookSyndicateVigSetup(options?: {
    readonly vigSpread?: string;
    readonly vigTotal?: string;
    readonly vigDerivative?: string;
    readonly targetUrl?: string;
    readonly headers?: Record<string, string>;
    readonly fetchImpl?: typeof fetch;
  }): Promise<readonly VigSetupResult[]> {
    const results: VigSetupResult[] = [];
    for (const member of HALF_POINT_HOOK_SYNDICATE_ROSTER) {
      for (const sportType of HOOK_REPRICING_SPORT_TYPES) {
        const res = await this.dispatchVigSetupInsert({
          customerId: member.customerId,
          sportType,
          vigSpread: options?.vigSpread ?? "25",
          vigTotal: options?.vigTotal ?? "15",
          vigDerivative: options?.vigDerivative ?? "25",
          ...(options?.targetUrl !== undefined
            ? { targetUrl: options.targetUrl }
            : {}),
          ...(options?.headers !== undefined
            ? { headers: options.headers }
            : {}),
          ...(options?.fetchImpl !== undefined
            ? { fetchImpl: options.fetchImpl }
            : {}),
        });
        results.push(res);
      }
    }
    return results;
  }
}
