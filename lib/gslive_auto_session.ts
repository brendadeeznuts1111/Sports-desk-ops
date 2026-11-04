/** Auto-mint the GSLive GSID from keychain credentials; no secret is logged or printed. */
import { GSID_SECRET } from "../scripts/fetch-bet-tally.ts";

export const GSLIVE_AJAX =
  "https://plive.sportswidgets.pro/manager-tools/ajax.php";
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
  return (await secret(GSID_SECRET.name)) ?? (await secret("GSID"));
}
async function probe(gsid: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(GSLIVE_AJAX, {
      method: "POST",
      headers: {
        cookie: `GSID=${gsid}`,
        "content-type": "application/x-www-form-urlencoded",
      },
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
): Promise<string> {
  const username = await secret("GSLIVE_USERNAME");
  const password = await secret("GSLIVE_PASSWORD");
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
  const res = await fetchImpl(GSLIVE_AJAX, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "login",
      username,
      password,
    }).toString(),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
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
  if (gsid === "") {
    try {
      const body = (await res.json()) as { GSID?: unknown; gsid?: unknown };
      gsid = String(body.GSID ?? body.gsid ?? "");
    } catch {
      /* no JSON */
    }
  }
  if (gsid === "")
    throw new Error(
      `GSLive login did not return a GSID (HTTP ${res.status}); set GSID manually via bun run secrets:gslive set`,
    );
  await Bun.secrets.set({
    service: "com.bookdeskops.sportsdesk",
    name: GSID_SECRET.name,
    value: gsid,
    persist: "local",
  } as never);
  if (await probe(gsid, fetchImpl)) return gsid;
  throw new Error("minted GSID did not verify against ajax.php");
}
export async function ensureGsid(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const existing = await getGsid();
  if (
    existing !== null &&
    existing !== "" &&
    (await probe(existing, fetchImpl))
  )
    return existing;
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
