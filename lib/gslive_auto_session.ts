/** Auto-mint the GSLive GSID from keychain credentials; no secret is logged or printed. */
import { readFileSync, writeFileSync } from "node:fs";
import {
  type GsliveSessionMeta,
  writeGsliveSessionMeta,
} from "./gslive_session_meta.ts";
import {
  resolveManagerSessionGate,
  writeManagerSessionGate,
} from "./manager_session.ts";
import {
  bootstrapGanchrowSession,
  GSID_SECRET,
  SIGNIN_URL,
  USER_AGENT,
} from "../scripts/fetch-bet-tally.ts";

export const GSLIVE_AJAX =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";
/** Prefix on the error thrown after repeated credential mint failures. */
export const GSLIVE_MINT_LOOP_PREFIX = "GSLive_MINT_LOOP:";
/** Automated credential login is blocked (Cloudflare bot management). */
export const GSLIVE_CLOUDFLARE_BLOCKED_PREFIX = "CLOUDFLARE_BLOCKED:";
export const GSLIVE_MANUAL_GSID_ACTION =
  "printf '%s' '<GSID>' | bun run secrets:gslive set";
export const GSLIVE_MANUAL_GATE_ACTION =
  "printf '%s' '<ganchrowSessionId>' | bun run secrets:gslive set-gate";
export const GSLIVE_MANUAL_DUAL_AUTH_ACTION = `${GSLIVE_MANUAL_GSID_ACTION}; ${GSLIVE_MANUAL_GATE_ACTION}`;

export function gsliveCloudflareBlockedError(): Error {
  return new Error(
    `${GSLIVE_CLOUDFLARE_BLOCKED_PREFIX} GSLive automated login is blocked by Cloudflare. ` +
      "You must manually extract the GSID from your browser and run: " +
      GSLIVE_MANUAL_GSID_ACTION,
  );
}

export function isGsliveCloudflareBlockedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(GSLIVE_CLOUDFLARE_BLOCKED_PREFIX)
  );
}

function isCloudflareBlockedSignin(res: Response, text: string): boolean {
  const trimmed = text.trim();
  if (/cf-challenge|cf-mitigated|__cf_bm/i.test(text)) return true;
  if (trimmed.startsWith("<") && /cloudflare/i.test(text)) return true;
  if (res.status === 200 && trimmed === "") return true;
  if (res.status === 403) {
    if (/username or password are incorrect/i.test(text)) return false;
    return true;
  }
  return false;
}
let cachedGsid: string | null = null;
let onGsidRotated: (() => void) | null = null;
/** Consecutive {@link mintGsid} failures from {@link ensureGsid} (reset on success). */
let consecutiveMintFailures = 0;

export function gsliveConsecutiveMintFailures(): number {
  return consecutiveMintFailures;
}

/** Test-only reset for mint-failure streak accounting. */
export function resetGsliveMintFailureStreakForTests(): void {
  consecutiveMintFailures = 0;
}

/** Register a callback when a fresh GSID is persisted (e.g. clear daemon probe cache). */
export function registerGsidRotationHook(fn: () => void): void {
  onGsidRotated = fn;
}

/** Drop the in-process GSID memo (daemon cache after keychain rotation). */
export function resetGsliveAutoSessionCache(): void {
  cachedGsid = null;
}

function notifyGsidRotated(): void {
  onGsidRotated?.();
}
const SESSION_FILE = () => (Bun.env.GSLIVE_SESSION_FILE ?? "").trim();
function readSessionFile(): string | null {
  const path = SESSION_FILE();
  if (path === "") return null;
  try {
    const value = readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}
function writeSessionFile(value: string): void {
  const path = SESSION_FILE();
  if (path === "") return;
  try {
    writeFileSync(path, value, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}
async function secret(name: string): Promise<string | null> {
  try {
    return await Bun.secrets.get({
      service: "com.bookdeskops.sportsdesk",
      name,
    });
  } catch {
    return null;
  }
}
export async function getGsid(): Promise<string | null> {
  if (cachedGsid !== null) return cachedGsid;
  const fromKeychain =
    (await secret(GSID_SECRET.name)) ?? (await secret("GSID"));
  if (fromKeychain !== null && fromKeychain !== "") return fromKeychain;
  return readSessionFile();
}
/** Injectable credential reader so tests never touch the real keychain. */
export interface GsliveCredentialReader {
  get(name: "GSLIVE_USERNAME" | "GSLIVE_PASSWORD"): Promise<string | null>;
}

const keychainCredentialReader: GsliveCredentialReader = {
  get: (name) => secret(name),
};

async function probe(
  gsid: string,
  fetchImpl: typeof fetch,
  sessionGate = "",
): Promise<boolean> {
  const headers: Record<string, string> = {
    cookie: `GSID=${gsid}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  // The SPA sends the bootstrap id as `x-gs-session`; ajax.php can reject a valid GSID without it.
  if (sessionGate !== "") headers["x-gs-session"] = sessionGate;
  try {
    const res = await fetchImpl(GSLIVE_AJAX, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        action: "getBetLog",
        betId: "0",
        partnerId: "118",
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) return false;
    const text = await res.text();
    return (
      res.ok &&
      text.trim().startsWith("{") &&
      !/login|unauthor|forbidden/i.test(text.slice(0, 400))
    );
  } catch {
    return false;
  }
}

interface SigninWirePayload {
  readonly gsid: string;
  readonly sessionGate: string;
  readonly meta: GsliveSessionMeta | null;
}

function gsidFromSetCookie(res: Response): string {
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  for (const cookie of cookies) {
    const m = /(?:^|;\s*)GSID=([^;]+)/i.exec(cookie);
    if (m !== null) return decodeURIComponent(m[1] as string);
  }
  return "";
}

function metaFromSigninJson(json: Record<string, unknown>): GsliveSessionMeta | null {
  const adminUserName = json.adminUserName;
  if (typeof adminUserName !== "string" || adminUserName.trim() === "") {
    return null;
  }
  const partner = json.partner;
  return {
    adminUserName: adminUserName.trim(),
    updatedAt: new Date().toISOString(),
    ...(typeof json.agentName === "string" && json.agentName.trim() !== ""
      ? { agentName: json.agentName.trim() }
      : {}),
    ...(typeof partner === "string" || typeof partner === "number"
      ? { partner }
      : {}),
    ...(typeof json.tickerUrl === "string" && json.tickerUrl.trim() !== ""
      ? { tickerUrl: json.tickerUrl.trim() }
      : {}),
  };
}

function parseCredentialSigninResponse(
  res: Response,
  text: string,
): SigninWirePayload {
  let gsid = gsidFromSetCookie(res);
  let sessionGate = "";
  let meta: GsliveSessionMeta | null = null;
  const trimmed = text.trim();
  if (trimmed === "") {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: empty sign-in body (HTTP ${res.status})`,
      );
    }
    return { gsid, sessionGate, meta };
  }
  if (trimmed.startsWith("<") || trimmed.startsWith("<!")) {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: sign-in returned HTML (HTTP ${res.status})`,
      );
    }
    return { gsid, sessionGate, meta };
  }
  try {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    const gate = json.ganchrowSessionId;
    if (typeof gate === "string" && gate.trim() !== "") {
      sessionGate = gate.trim();
    }
    if (gsid === "") {
      const fromBody = json.GSID ?? json.gsid ?? json.ganchrowSessionId;
      if (fromBody !== undefined && fromBody !== null) {
        gsid = String(fromBody).trim();
      }
    }
    meta = metaFromSigninJson(json);
  } catch {
    if (gsid === "") {
      throw new Error(
        `GSLive auth failed: invalid response (HTTP ${res.status})`,
      );
    }
  }
  return { gsid, sessionGate, meta };
}

async function verifyMintedGsid(
  fetchImpl: typeof fetch,
  gsid: string,
  sessionGate: string,
  options?: { readonly signinEmptyBody?: boolean },
): Promise<{ gsid: string; gate: string }> {
  if (sessionGate !== "") {
    if (await probe(gsid, fetchImpl, sessionGate)) {
      return { gsid, gate: sessionGate };
    }
    if (gsid !== sessionGate && (await probe(sessionGate, fetchImpl, sessionGate))) {
      return { gsid: sessionGate, gate: sessionGate };
    }
    throw new Error(
      "GSLive signin returned a session that did not verify against ajax.php",
    );
  }
  if (await probe(gsid, fetchImpl, "")) {
    return { gsid, gate: "" };
  }
  try {
    const gate = await bootstrapGanchrowSession({
      cookieHeader: `GSID=${gsid}`,
      fetchImpl,
    });
    if (await probe(gsid, fetchImpl, gate)) {
      return { gsid, gate };
    }
  } catch {
    /* credential JSON should have carried ganchrowSessionId; bootstrap is legacy */
  }
  if (options?.signinEmptyBody === true && sessionGate === "") {
    throw gsliveCloudflareBlockedError();
  }
  throw new Error(
    "GSLive signin did not establish a verifiable session; provision GSID manually: " +
      GSLIVE_MANUAL_GSID_ACTION,
  );
}

export async function mintGsid(
  fetchImpl: typeof fetch = fetch,
  credentials: GsliveCredentialReader = keychainCredentialReader,
): Promise<string> {
  const username = await credentials.get("GSLIVE_USERNAME");
  const password = await credentials.get("GSLIVE_PASSWORD");
  if (
    username === null ||
    username === "" ||
    password === null ||
    password === ""
  ) {
    throw new Error(
      "GSLive username/password are not in Bun.secrets (service com.bookdeskops.sportsdesk)",
    );
  }
  // The SPA logs in with JSON `{username,password}` to the signin endpoint. The older
  // `ajax.php action=login` path returned a pre-auth GSID that failed every getBetReport call.
  const res = await fetchImpl(SIGNIN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      referer: "https://plive.sportswidgets.pro/manager-tools/",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify({ username, password }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(
      `GSLive rejected the keychain credentials (HTTP ${res.status}); update ` +
        "GSLIVE_USERNAME/GSLIVE_PASSWORD or provision GSLIVE_SESSION_ID",
    );
  }
  if (!res.ok) {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(`GSLive signin returned HTTP ${res.status}`);
  }
  const parsed = parseCredentialSigninResponse(res, text);
  if (parsed.gsid === "") {
    if (isCloudflareBlockedSignin(res, text)) {
      throw gsliveCloudflareBlockedError();
    }
    throw new Error(
      "GSLive auth failed: no GSID in headers or JSON body. Check credentials.",
    );
  }
  const verified = await verifyMintedGsid(
    fetchImpl,
    parsed.gsid,
    parsed.sessionGate,
    { signinEmptyBody: text.trim() === "" },
  );
  const gsid = verified.gsid;
  // Persist only after verification, so a failed login never overwrites a usable session.
  cachedGsid = gsid;
  try {
    await Bun.secrets.set({
      service: "com.bookdeskops.sportsdesk",
      name: GSID_SECRET.name,
      value: gsid,
      persist: "local",
    } as never);
  } catch {
    // Best effort: keychain writes are denied (ERR_SECRETS_PLATFORM_ERROR) in some sandboxes.
  }
  if (parsed.meta !== null) {
    await writeGsliveSessionMeta(parsed.meta).catch(() => {
      /* observability only */
    });
  }
  if (verified.gate !== "") {
    await writeManagerSessionGate(verified.gate);
  }
  writeSessionFile(gsid);
  notifyGsidRotated();
  return gsid;
}
export async function ensureGsid(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const existing = await getGsid();
  if (existing !== null && existing !== "") {
    const storedGate = await resolveManagerSessionGate();
    if (
      storedGate !== "" &&
      (await probe(existing, fetchImpl, storedGate))
    ) {
      consecutiveMintFailures = 0;
      return existing;
    }
    try {
      const gate = await bootstrapGanchrowSession({
        cookieHeader: `GSID=${existing}`,
        fetchImpl,
      });
      if (await probe(existing, fetchImpl, gate)) {
        await writeManagerSessionGate(gate);
        consecutiveMintFailures = 0;
        return existing;
      }
    } catch {
      // Expired or gate-less: fall through to a credential login.
    }
  }
  try {
    const gsid = await mintGsid(fetchImpl);
    consecutiveMintFailures = 0;
    return gsid;
  } catch (err) {
    if (isGsliveCloudflareBlockedError(err)) {
      throw err;
    }
    consecutiveMintFailures += 1;
    if (consecutiveMintFailures >= 3) {
      throw new Error(
        `${GSLIVE_MINT_LOOP_PREFIX} Credentials rejected by portal. Rotate password.`,
      );
    }
    throw err;
  }
}
export async function fetchBetLog(
  betId: string,
  gsid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(GSLIVE_AJAX, {
    method: "POST",
    headers: {
      cookie: `GSID=${gsid}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action: "getBetLog",
      betId,
      partnerId: "118",
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}
export async function fetchEventLog(
  betId: string,
  eventId: string,
  logTime: string,
  gsid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(GSLIVE_AJAX, {
    method: "POST",
    headers: {
      cookie: `GSID=${gsid}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action: "getEventLog",
      betId,
      eventId,
      logTime,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json();
}
