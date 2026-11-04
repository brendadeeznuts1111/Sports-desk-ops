/**
 * @file keychain_access.ts
 * @description The one boundary between this codebase and the OS keychain.
 *
 * Every real `Bun.secrets` call and every `security find-generic-password` spawn must go
 * through this module. The rule it enforces: **a test process never reaches the operator's
 * real keychain**. A macOS keychain read or write can raise an interactive consent dialog,
 * which a test or an agent cannot click — and a keychain write from an imported test helper
 * (the old `tests/support/capabilities.ts` probe) is what made `bun test` hit the keychain
 * on every run.
 *
 * The runtime context decides:
 * - `NODE_ENV=test` (set by `bun test`) or a `.test.ts`/`.spec.ts` entrypoint → deny
 * - `SPORTSDESK_KEYCHAIN_ACCESS=deny` → deny any process (sandbox, CI probe, cron dry-run)
 * - `SPORTSDESK_KEYCHAIN_ACCESS=allow` → allow even in a test process (explicit two-key
 *   opt-in for a capability probe; nothing else should set it)
 * - otherwise → allow (the production CLI/daemon path)
 *
 * Denied reads return `null` (the callers already treat a locked keychain as absent), denied
 * writes throw `KeychainAccessDeniedError` (an accidental write must be loud, not a no-op).
 * Set `SPORTSDESK_KEYCHAIN_TRACE=1` to log each distinct allowed/denied call to stderr — that
 * trace is how the boundary is verified: a full `bun test` must produce no denied lines, and a
 * production "credentials missing" can be read off the allowed lines.
 */

/** Override the runtime decision. `allow` is the only way a test process may probe. */
export const KEYCHAIN_ACCESS_ENV = "SPORTSDESK_KEYCHAIN_ACCESS";

/** `1` logs one `[keychain] denied …` line per distinct call to stderr. */
export const KEYCHAIN_TRACE_ENV = "SPORTSDESK_KEYCHAIN_TRACE";

/** Test files end here; `Bun.main` is the test file for each `bun test` worker. */
const TEST_ENTRYPOINT_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export type KeychainOperation = "get" | "set" | "delete";

export type KeychainAccessDecision =
  | { readonly allowed: true; readonly reason: "explicit-allow" | "default" }
  | { readonly allowed: false; readonly reason: string };

export interface KeychainTarget {
  readonly service: string;
  readonly name: string;
}

/** Thrown when code tries to WRITE/DELETE the keychain from a denied process. */
export class KeychainAccessDeniedError extends Error {
  readonly operation: KeychainOperation;
  readonly service: string;
  readonly entryName: string;
  readonly reason: string;

  constructor(
    operation: KeychainOperation,
    target: KeychainTarget,
    reason: string,
  ) {
    super(
      `keychain ${operation} denied for ${target.service}/${target.name} (${reason}). ` +
        `Inject a fake reader in tests, or set ${KEYCHAIN_ACCESS_ENV}=allow to opt in.`,
    );
    this.name = "KeychainAccessDeniedError";
    this.operation = operation;
    this.service = target.service;
    this.entryName = target.name;
    this.reason = reason;
  }
}

/**
 * Bun's own declaration, not a hand-written copy — the same discipline `lib/secrets.ts` uses.
 * `get`/`set`/`delete` are the three OS-store verbs the boundary guards.
 */
export type KeychainSecrets = Pick<
  typeof Bun.secrets,
  "get" | "set" | "delete"
>;

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** A test entrypoint: `.test.ts`/`.spec.ts`, or any file under a `tests/` directory. */
export function isTestEntrypoint(main: string = Bun.main): boolean {
  const normalized = main.replace(/\\/g, "/");
  if (normalized === "") return false;
  if (TEST_ENTRYPOINT_PATTERN.test(normalized)) return true;
  return /(?:^|\/)(?:tests?|__tests__)\//.test(normalized);
}

/** True when the process must not touch the real keychain. */
export function keychainAccessDecision(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  main: string = Bun.main,
): KeychainAccessDecision {
  const override = (env[KEYCHAIN_ACCESS_ENV] ?? "").trim().toLowerCase();
  if (override === "deny" || override === "0" || override === "false") {
    return { allowed: false, reason: `${KEYCHAIN_ACCESS_ENV}=deny` };
  }
  if (override === "allow" || override === "1" || override === "true") {
    return { allowed: true, reason: "explicit-allow" };
  }
  if ((env.NODE_ENV ?? "").trim() === "test") {
    return { allowed: false, reason: "NODE_ENV=test" };
  }
  if (isTestEntrypoint(main)) {
    return {
      allowed: false,
      reason: `test entrypoint ${basename(main)}`,
    };
  }
  return { allowed: true, reason: "default" };
}

const tracedCalls = new Set<string>();

/** First stack frame outside this module, e.g. `tests/foo.test.ts:12:5`. */
function callerFrame(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const line of stack.slice(1)) {
    if (line.includes("keychain_access.ts")) continue;
    const match = /\(?([^()]+:\d+:\d+)\)?\s*$/.exec(line.trim());
    if (match?.[1] !== undefined) {
      return match[1].replace(`${process.cwd()}/`, "");
    }
  }
  return "unknown";
}

/**
 * Log one distinct call (service/name/op + call site, never a value) when tracing is on.
 * Keying by call site means a second test file that attempts the same entry still shows up;
 * `allowed` lines make a production "credential missing" debuggable, not blind.
 */
function traceCall(
  verdict: "allowed" | "denied",
  operation: KeychainOperation,
  target: KeychainTarget,
  reason: string,
): void {
  if ((Bun.env[KEYCHAIN_TRACE_ENV] ?? "") !== "1") return;
  const caller = callerFrame();
  const key = `${verdict}:${operation}:${target.service}/${target.name}:${caller}`;
  if (tracedCalls.has(key)) return;
  tracedCalls.add(key);
  console.error(
    `[keychain] ${verdict} ${operation} ${target.service}/${target.name} — ${reason} at ${caller}`,
  );
}

function traceDenied(
  operation: KeychainOperation,
  target: KeychainTarget,
  reason: string,
): void {
  traceCall("denied", operation, target, reason);
}

/** Deny (silently unless tracing) and return the read result for a denied read. */
function deniedRead(target: KeychainTarget, reason: string): null {
  traceDenied("get", target, reason);
  return null;
}

/**
 * The guarded `Bun.secrets` surface. Every module takes this as its default reader/writer
 * instead of `Bun.secrets` directly, so the boundary cannot be bypassed by a new call site.
 */
export const guardedSecrets: KeychainSecrets = {
  async get(options) {
    const decision = keychainAccessDecision();
    if (!decision.allowed) {
      return deniedRead(options, decision.reason);
    }
    traceCall("allowed", "get", options, decision.reason);
    return Bun.secrets.get(options);
  },

  async set(options) {
    const decision = keychainAccessDecision();
    if (!decision.allowed) {
      traceDenied("set", options, decision.reason);
      throw new KeychainAccessDeniedError("set", options, decision.reason);
    }
    traceCall("allowed", "set", options, decision.reason);
    return Bun.secrets.set(options);
  },

  async delete(options) {
    const decision = keychainAccessDecision();
    if (!decision.allowed) {
      traceDenied("delete", options, decision.reason);
      throw new KeychainAccessDeniedError("delete", options, decision.reason);
    }
    traceCall("allowed", "delete", options, decision.reason);
    return Bun.secrets.delete(options);
  },
};

/**
 * Guard for the macOS `security` CLI fallback: a denied process must not spawn it, because
 * `security -w` can block on a keychain consent dialog with no one to click Allow.
 */
export function platformKeychainAllowed(): boolean {
  const decision = keychainAccessDecision();
  traceCall(
    decision.allowed ? "allowed" : "denied",
    "get",
    PLATFORM_TARGET,
    decision.reason,
  );
  return decision.allowed;
}

/** Sentinel target so a denied `security` spawn is still visible in the trace. */
const PLATFORM_TARGET: KeychainTarget = {
  service: "security-cli",
  name: "find-generic-password",
};

/** Human-readable one-liner for status output and tests. */
export function describeKeychainAccess(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  main: string = Bun.main,
): string {
  const decision = keychainAccessDecision(env, main);
  return decision.allowed
    ? `allowed (${decision.reason})`
    : `denied (${decision.reason})`;
}
