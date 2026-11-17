/**
 * @file lib/agent_account.ts
 * @description Project getAccountInfoOwner / getConfigWebReports into a sanitized config record.
 * The raw responses carry a JWT (`code`), passwords and names; none of those survive projection.
 */

const SENSITIVE = new Set([
  "code",
  "password",
  "passwordfix",
  "namefirst",
  "namelast",
  "playername",
  "email",
  "phone",
  "smsphonenumber",
  "commentsforcustomer",
]);

/**
 * Accept either the wrapped `{ INFO: {...} }` or the bare INFO object. A bare
 * object with no identifying/flag fields is refused, so `{}` does not become INFO.
 */
function infoOf(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} response must be an object`);
  }
  const doc = raw as Record<string, unknown>;
  const wrapped = doc.INFO;
  if (
    wrapped !== null &&
    typeof wrapped === "object" &&
    !Array.isArray(wrapped)
  ) {
    return wrapped as Record<string, unknown>;
  }
  if (
    "AgentID" in doc ||
    "CustomerID" in doc ||
    Object.keys(doc).some((key) => /^show/i.test(key) || key.endsWith("F"))
  ) {
    return doc;
  }
  throw new Error(`${label} response lacks INFO`);
}

const trim = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE.has(key.toLowerCase())) continue;
    out[key] = scrub(child);
  }
  return out;
}

export interface ProjectedAccountConfig {
  readonly schemaVersion: 1;
  readonly agentId: string | null;
  readonly office: string | null;
  readonly store: string | null;
  readonly agentType: string | null;
  readonly serverDate: string | null;
  readonly timeZone: number | null;
  readonly displayFlags: Readonly<Record<string, string>>;
  readonly preferences: readonly unknown[];
  readonly projectedAt: string;
}

export function projectAccountInfoOwner(raw: unknown): ProjectedAccountConfig {
  if (raw === null || typeof raw !== "object")
    throw new Error("account response must be an object");
  const doc = raw as Record<string, unknown>;
  const infoRaw = doc.accountInfo;
  if (
    infoRaw === null ||
    typeof infoRaw !== "object" ||
    Array.isArray(infoRaw)
  ) {
    throw new Error("account response lacks accountInfo");
  }
  const info = infoRaw as Record<string, unknown>;
  const safe = scrub(info) as Record<string, unknown>;
  const displayFlags: Record<string, string> = {};
  for (const [key, value] of Object.entries(safe)) {
    if (/^show/i.test(key) && typeof value === "string")
      displayFlags[key] = value;
  }
  const server = doc.SERVER as Record<string, unknown> | undefined;
  const prefs = Array.isArray(doc.preferenceDate)
    ? scrub(doc.preferenceDate)
    : [];
  return {
    schemaVersion: 1,
    agentId: trim(info.customerID) ?? trim(info.AgentID),
    office: trim(info.Office),
    store: trim(info.Store),
    agentType: trim(info.AgentType),
    serverDate: trim(server?.date),
    timeZone: typeof info.TimeZone === "number" ? info.TimeZone : null,
    displayFlags,
    preferences: Array.isArray(prefs) ? prefs : [],
    projectedAt: new Date().toISOString(),
  };
}

export interface ProjectedWebReportsConfig {
  readonly schemaVersion: 1;
  readonly agentId: string | null;
  readonly displayFlags: Readonly<Record<string, string>>;
  readonly weeklyScroll: string | null;
  readonly projectedAt: string;
}

/** Project getConfigWebReports ({ INFO }) without retaining arbitrary config fields. */
export function projectWebReportsConfig(
  raw: unknown,
): ProjectedWebReportsConfig {
  if (raw === null || typeof raw !== "object")
    throw new Error("web-reports response must be an object");
  const info = scrub(infoOf(raw, "web-reports")) as Record<string, unknown>;
  const displayFlags: Record<string, string> = {};
  for (const [key, value] of Object.entries(info)) {
    if (/^show/i.test(key) && typeof value === "string")
      displayFlags[key] = value;
  }
  const adds = info.adds;
  const weeklyScroll =
    adds !== null && typeof adds === "object" && !Array.isArray(adds)
      ? trim((adds as Record<string, unknown>).weeklyScroll)
      : null;
  return {
    schemaVersion: 1,
    agentId: trim(info.AgentID),
    displayFlags,
    weeklyScroll,
    projectedAt: new Date().toISOString(),
  };
}

export interface ProjectedWebReportsPendingConfig {
  readonly schemaVersion: 1;
  readonly agentId: string | null;
  readonly columnFlags: Readonly<Record<string, string>>;
  readonly projectedAt: string;
}

/** Project getConfigWebReportsPending ({ INFO }) — column visibility flags only. */
export function projectWebReportsPendingConfig(
  raw: unknown,
): ProjectedWebReportsPendingConfig {
  if (raw === null || typeof raw !== "object")
    throw new Error("pending web-reports response must be an object");
  const info = scrub(infoOf(raw, "pending web-reports")) as Record<
    string,
    unknown
  >;
  const columnFlags: Record<string, string> = {};
  for (const [key, value] of Object.entries(info)) {
    if (key !== "AgentID" && key.endsWith("F") && typeof value === "string") {
      columnFlags[key] = value;
    }
  }
  return {
    schemaVersion: 1,
    agentId: trim(info.AgentID),
    columnFlags,
    projectedAt: new Date().toISOString(),
  };
}

export interface ProjectedAccountAdminConfig {
  readonly schemaVersion: 1;
  readonly agentId: string | null;
  readonly masterAgentId: string | null;
  readonly masterLogin: string | null;
  readonly startOfWeek: number | null;
  readonly distributionStartOfWeek: number | null;
  readonly isOffice: number | null;
  readonly projectedAt: string;
}

/** Project the account-admin INFO shape (CustomerID/MasterAgentID/StartOfWeek). */
export function projectAccountAdminConfig(
  raw: unknown,
): ProjectedAccountAdminConfig {
  if (raw === null || typeof raw !== "object")
    throw new Error("admin account response must be an object");
  const infoRaw = (raw as Record<string, unknown>).INFO;
  if (
    infoRaw === null ||
    typeof infoRaw !== "object" ||
    Array.isArray(infoRaw)
  ) {
    throw new Error("admin account response lacks INFO");
  }
  const info = scrub(infoRaw) as Record<string, unknown>;
  const num = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    schemaVersion: 1,
    agentId: trim(info.CustomerID) ?? trim(info.AgentID),
    masterAgentId: trim(info.MasterAgentID),
    masterLogin: trim(info.MasterLogin),
    startOfWeek: num(info.StartOfWeek),
    distributionStartOfWeek: num(info.DistributionStartOfWeek),
    isOffice: num(info.IsOffice),
    projectedAt: new Date().toISOString(),
  };
}
