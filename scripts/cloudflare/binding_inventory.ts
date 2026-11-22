/**
 * Read-only, value-free Cloudflare Worker binding inventory for the local dx MCP.
 * This deliberately uses a separate read-only audit token, not deployment credentials.
 * The inventory is a deployment snapshot, not a claim about runtime route behavior.
 */
export interface BindingSummary {
  readonly name: string;
  readonly type: string;
  /** Only non-secret resource labels; never a variable or secret value. */
  readonly target?: string;
}
export interface WorkerBindingSummary {
  readonly name: string;
  readonly bindings: readonly BindingSummary[];
}
export interface BindingInventory {
  /** Complete account-level listing; independent of settings reads. */
  readonly discoveredWorkers: readonly string[];
  readonly workers: readonly WorkerBindingSummary[];
  /** A settings read failure is unknown, not proof the binding is missing. */
  readonly failures: readonly { worker: string; reason: string }[];
}
export interface ModuleBindingRequirement {
  readonly module: string;
  readonly worker: string;
  readonly binding: string;
  readonly type: string;
  readonly required: boolean;
  /** Source contract or previously observed deployment (not the same evidence). */
  readonly basis: "source" | "deployment_snapshot";
  /** Route observed in source; absence of its backing binding may disable a feature. */
  readonly api?: string;
}
/**
 * Contract anchors from deployed Worker settings (Nov 21, 2026), with the
 * BookDeskOps optional ops-proxy feature from its source. These are not a
 * complete enumeration of the Workers' API endpoints or dependencies.
 */
export const MODULE_BINDING_REQUIREMENTS = [
  { module: "sportsdesk.mcp-limit", worker: "sports-ops-desk", binding: "MCP_LIMITER", type: "durable_object_namespace", required: true, basis: "deployment_snapshot" },
  { module: "sportsdesk.signals", worker: "sports-ops-desk", binding: "SIGNAL_STORE", type: "durable_object_namespace", required: true, basis: "deployment_snapshot" },
  { module: "sportsdesk.archive", worker: "sports-ops-desk", binding: "DESK_ARCHIVE", type: "r2_bucket", required: true, basis: "deployment_snapshot" },
  { module: "fantasy402.ingestion", worker: "fantasy402-ingestion", binding: "RAW_ARCHIVE", type: "r2_bucket", required: true, basis: "deployment_snapshot" },
  { module: "fantasy402.auth-cache", worker: "fantasy402-ingestion", binding: "AUTH_CACHE", type: "kv_namespace", required: true, basis: "deployment_snapshot" },
  { module: "fantasy402.session", worker: "fantasy402-ingestion", binding: "SESSION_KV", type: "kv_namespace", required: true, basis: "deployment_snapshot" },
  { module: "fantasy402.ticker", worker: "bet-ticker-worker", binding: "BET_TICKER", type: "durable_object_namespace", required: true, basis: "deployment_snapshot" },
  { module: "fantasy402.ticker-cache", worker: "bet-ticker-worker", binding: "BET_TICKER_CACHE", type: "r2_bucket", required: true, basis: "deployment_snapshot" },
  { module: "bookdeskops.api", worker: "bookdeskops", binding: "PUBLIC_ORIGIN", type: "plain_text", required: true, basis: "source", api: "GET /api/v1" },
  { module: "bookdeskops.staging-api", worker: "bookdeskops-staging", binding: "PUBLIC_ORIGIN", type: "plain_text", required: true, basis: "source", api: "GET /api/v1" },
  { module: "bookdeskops.ops-proxy", worker: "bookdeskops", binding: "OPS_ORIGIN", type: "plain_text", required: false, basis: "source", api: "GET/POST /api/v1/ops/weekly-reports and /api/v1/ops/bank/payments" },
  { module: "bookdeskops.staging-ops-proxy", worker: "bookdeskops-staging", binding: "OPS_ORIGIN", type: "plain_text", required: false, basis: "source", api: "GET/POST /api/v1/ops/weekly-reports and /api/v1/ops/bank/payments" },
] as const satisfies readonly ModuleBindingRequirement[];

export type BindingCheckStatus =
  | "bound" | "missing" | "wrong_type" | "inactive" | "not_deployed" | "unverified";
export interface BindingCheck extends ModuleBindingRequirement {
  readonly status: BindingCheckStatus;
}
export function auditModuleBindings(
  inventory: BindingInventory,
  worker?: string,
  requirements: readonly ModuleBindingRequirement[] = MODULE_BINDING_REQUIREMENTS,
): BindingCheck[] {
  const byName = new Map(inventory.workers.map((item) => [item.name, item]));
  const failed = new Set(inventory.failures.map((item) => item.worker));
  return requirements.filter((item) => worker === undefined || item.worker === worker)
    .map((item) => {
      const current = byName.get(item.worker);
      const binding = current?.bindings.find((b) => b.name === item.binding);
      let status: BindingCheckStatus;
      if (failed.has(item.worker)) {
        status = "unverified";
      } else if (!current) {
        status = inventory.discoveredWorkers.includes(item.worker)
          ? "unverified" : "not_deployed";
      } else if (!binding) {
        status = item.required ? "missing" : "inactive";
      } else {
        status = binding.type === item.type ? "bound" : "wrong_type";
      }
      return { ...item, status };
    });
}
interface CloudflareEnvelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly result_info?: { readonly total_pages?: number };
}
interface ScriptItem { readonly id: string }
interface WorkerSettings { readonly bindings: readonly Record<string, unknown>[] }

/** Allow only explicit resource-name fields; values of plain_text/secret_text are never copied. */
export function summarizeBindings(input: unknown): BindingSummary[] {
  if (!Array.isArray(input)) throw new Error("Worker settings missing bindings list");
  const result: BindingSummary[] = [];
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.name !== "string" ||
      !/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(raw.name) ||
      typeof raw.type !== "string" ||
      !/^[a-z_]{1,64}$/.test(raw.type)
    ) {
      throw new Error("Malformed Worker binding metadata");
    }
    if (result.some((binding) => binding.name === raw.name)) {
      throw new Error("Duplicate Worker binding metadata");
    }
    const field =
      raw.type === "r2_bucket" ? "bucket_name" :
      raw.type === "durable_object_namespace" ? "class_name" :
      raw.type === "service" ? "service" :
      raw.type === "queue" ? "queue_name" : undefined;
    const target = field === undefined ? undefined : raw[field];
    result.push({
      name: raw.name, type: raw.type,
      ...(typeof target === "string" ? { target } : {}),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
/** Read only Worker names and binding metadata; no KV values, D1 queries or secret reads. */
export async function fetchCloudflareBindingInventory(
  accountId: string,
  token: string,
  worker?: string,
  fetcher: typeof fetch = fetch,
): Promise<BindingInventory> {
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !token) {
    throw new Error("Cloudflare read-only account ID or audit token is not configured");
  }
  if (worker !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(worker)) {
    throw new Error("Invalid Worker name");
  }
  const registered = new Set<string>(
    MODULE_BINDING_REQUIREMENTS.map((entry) => entry.worker),
  );
  if (worker !== undefined && !registered.has(worker)) {
    throw new Error("Worker is not in the module registry");
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  async function get<T>(path: string): Promise<CloudflareEnvelope<T>> {
    const response = await fetcher(`${base}${path}`, {
      method: "GET", headers, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as CloudflareEnvelope<T>;
    if (typeof body !== "object" || body === null || body.success !== true || !("result" in body)) {
      throw new Error("Invalid Cloudflare response");
    }
    return body;
  }
  const scriptIds: string[] = [];
  let discoveryComplete = false;
  for (let page = 1; page <= 20; page++) {
    const listing = await get<ScriptItem[]>(`/workers/scripts?per_page=100&page=${page}`);
    if (!Array.isArray(listing.result)) throw new Error("Invalid Worker list");
    for (const entry of listing.result) {
      if (!entry || typeof entry.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id)) {
        throw new Error("Malformed Worker list entry");
      }
      scriptIds.push(entry.id);
    }
    const totalPages = listing.result_info?.total_pages;
    if (totalPages !== undefined) {
      if (!Number.isInteger(totalPages) || totalPages < 0 ||
        totalPages > 20 || (totalPages !== 0 && page > totalPages)) {
        throw new Error("Invalid Worker pagination metadata");
      }
      // Explicit pagination metadata wins over short-page heuristics.
      discoveryComplete = page >= totalPages;
    } else {
      discoveryComplete = listing.result.length < 100;
    }
    if (discoveryComplete) break;
  }
  if (!discoveryComplete) {
    throw new Error("Cloudflare Worker list exceeded pagination limit");
  }
  const names = [...new Set(scriptIds)].sort();
  // A tool intended to map our modules must not enumerate settings for
  // unrelated account Workers by default.
  const discoveredWorkers = names.filter((name) => registered.has(name));
  const wanted = worker === undefined
    ? discoveredWorkers
    : discoveredWorkers.includes(worker) ? [worker] : [];
  const workers: WorkerBindingSummary[] = [];
  const failures: { worker: string; reason: string }[] = [];
  // Bound concurrent metadata reads to avoid API rate spikes.
  for (let i = 0; i < wanted.length; i += 4) {
    await Promise.all(wanted.slice(i, i + 4).map(async (name) => {
      try {
        const item = await get<WorkerSettings>(`/workers/scripts/${encodeURIComponent(name)}/settings`);
        workers.push({ name, bindings: summarizeBindings(item.result?.bindings) });
      } catch (error) {
        // Never copy response bodies, headers, URLs or token values into MCP results.
        const code = error instanceof Error && /^HTTP \d{3}$/.test(error.message)
          ? error.message : "metadata unavailable";
        failures.push({ worker: name, reason: code });
      }
    }));
  }
  return {
    discoveredWorkers,
    workers: workers.sort((a, b) => a.name.localeCompare(b.name)),
    failures: failures.sort((a, b) => a.worker.localeCompare(b.worker)),
  };
}
