/** Auto-mint the GSLive GSID from keychain credentials; no secret is logged or printed. */
import { readFileSync, writeFileSync } from "node:fs";
import {
  bootstrapGanchrowSession,
  GSID_SECRET,
  SIGNIN_URL,
  USER_AGENT,
} from "../scripts/fetch-bet-tally.ts";

export const GSLIVE_AJAX =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";
let cachedGsid: string | null = null;
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
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `GSLive rejected the keychain credentials (HTTP ${res.status}); update ` +
        "GSLIVE_USERNAME/GSLIVE_PASSWORD or provision GSLIVE_SESSION_ID",
    );
  }
  if (!res.ok) {
    throw new Error(`GSLive signin returned HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  let body: { GSID?: unknown; gsid?: unknown } = {};
  if (contentType.includes("json")) {
    try {
      body = (await res.json()) as { GSID?: unknown; gsid?: unknown };
    } catch {
      body = {};
    }
  }
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie") ?? ""];
  let gsid = "";
  for (const cookie of cookies) {
    const m = /(?:^|;\s*)GSID=([^;]+)/i.exec(cookie);
    if (m !== null) {
      gsid = decodeURIComponent(m[1] as string);
      break;
    }
  }
  if (gsid === "") gsid = String(body.GSID ?? body.gsid ?? "");
  if (gsid === "") {
    throw new Error("GSLive signin succeeded without a GSID cookie");
  }
  let gate: string;
  try {
    gate = await bootstrapGanchrowSession({
      cookieHeader: `GSID=${gsid}`,
      fetchImpl,
    });
  } catch {
    throw new Error(
      "GSLive signin did not establish a session; the keychain credentials were rejected " +
        "or the pre-auth session is missing. Update GSLIVE_USERNAME/GSLIVE_PASSWORD or " +
        "provision GSLIVE_SESSION_ID",
    );
  }
  if (!(await probe(gsid, fetchImpl, gate))) {
    throw new Error(
      "GSLive signin returned a GSID that did not verify against ajax.php",
    );
  }
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
  writeSessionFile(gsid);
  return gsid;
}
export async function ensureGsid(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const existing = await getGsid();
  if (existing !== null && existing !== "") {
    try {
      const gate = await bootstrapGanchrowSession({
        cookieHeader: `GSID=${existing}`,
        fetchImpl,
      });
      if (await probe(existing, fetchImpl, gate)) return existing;
    } catch {
      // Expired or gate-less: fall through to a credential login.
    }
  }
  return mintGsid(fetchImpl);
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
