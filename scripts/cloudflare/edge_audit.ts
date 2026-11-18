/** Read-only Cloudflare DNS -> Tunnel / Worker route consistency audit. */
export type Zone = { id: string; name: string };
export type DnsRecord = { name: string; type: string; content: string };
export type Tunnel = { id: string; name: string; status: string };
export type Ingress = { hostname?: string; service?: string };
export type WorkerRoute = { pattern: string; script?: string };
export type Inventory = {
  zones: Zone[];
  dns: Record<string, DnsRecord[]>;
  tunnels: Tunnel[];
  ingress: Record<string, Ingress[]>;
  scripts: string[];
  workerSubdomain: string;
  routes: Record<string, WorkerRoute[]>;
};
export type Finding = {
  code:
    | "TUNNEL_UNKNOWN"
    | "TUNNEL_UNHEALTHY"
    | "INGRESS_MISSING"
    | "WORKER_UNKNOWN"
    | "ROUTE_DNS_MISSING";
  hostname: string;
  target: string;
  detail: string;
};

const tunnelTarget = /^([a-f0-9-]{36})\.cfargotunnel\.com\.?$/i;

export function auditInventory(data: Inventory): Finding[] {
  const findings: Finding[] = [];
  const tunnels = new Map(data.tunnels.map((t) => [t.id.toLowerCase(), t]));
  const scripts = new Set(data.scripts);
  const checked = new Set<string>();
  const allNames = new Set<string>();
  for (const zone of data.zones) {
    const records = data.dns[zone.id] ?? [];
    for (const record of records) {
      allNames.add(record.name.toLowerCase());
      if (record.type !== "CNAME") continue;
      const hostname = record.name.toLowerCase();
      const target = record.content.toLowerCase().replace(/\.$/, "");
      const key = `${hostname}|${target}`;
      if (checked.has(key)) continue;
      checked.add(key);
      const tunnelId = target.match(tunnelTarget)?.[1]?.toLowerCase();
      if (tunnelId) {
        const tunnel = tunnels.get(tunnelId);
        if (!tunnel) {
          findings.push({
            code: "TUNNEL_UNKNOWN",
            hostname,
            target,
            detail: "DNS references a tunnel absent from this Cloudflare account",
          });
          continue;
        }
        if (tunnel.status !== "healthy") {
          findings.push({
            code: "TUNNEL_UNHEALTHY",
            hostname,
            target: tunnel.name,
            detail: `Tunnel status: ${tunnel.status}`,
          });
        }
        const routes = data.ingress[tunnelId] ?? [];
        const matched = routes.some(
          (rule) =>
            rule.hostname?.toLowerCase() === hostname &&
            rule.service &&
            !rule.service.startsWith("http_status:"),
        );
        if (!matched) {
          findings.push({
            code: "INGRESS_MISSING",
            hostname,
            target: tunnel.name,
            detail: "No matching non-fallback Tunnel ingress rule",
          });
        }
        continue;
      }
      const workerSuffix = `.${data.workerSubdomain.toLowerCase()}.workers.dev`;
      if (target.endsWith(workerSuffix)) {
        const script = target.slice(0, -workerSuffix.length);
        if (script && !scripts.has(script)) {
          findings.push({
            code: "WORKER_UNKNOWN",
            hostname,
            target: script,
            detail: "Same-account workers.dev target is absent from Worker inventory",
          });
        }
      }
    }
  }
  for (const zone of data.zones) {
    for (const route of data.routes[zone.id] ?? []) {
      const hostname = route.pattern.split("/")[0]?.toLowerCase();
      if (!hostname || hostname.includes("*") || allNames.has(hostname)) {
        continue;
      }
      findings.push({
        code: "ROUTE_DNS_MISSING",
        hostname,
        target: route.script ?? "",
        detail: "Worker route hostname has no DNS record in the inspected zones",
      });
    }
  }
  return findings.sort(
    (a, b) =>
      a.hostname.localeCompare(b.hostname) || a.code.localeCompare(b.code),
  );
}

type Envelope<T> = {
  success: boolean;
  result: T;
  errors?: { message: string }[];
  result_info?: { total_pages?: number };
};
const API_BASE = "https://api.cloudflare.com/client/v4";

/** Never logs tokens, secret values, or DNS record content other than audited targets. */
export async function fetchInventory(
  accountId: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<Inventory> {
  async function get<T>(
    path: string,
    query?: Record<string, string | number>,
  ): Promise<Envelope<T>> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      url.searchParams.set(name, String(value));
    }
    const response = await fetcher(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Cloudflare read failed: ${response.status} ${path}`);
    }
    const payload = (await response.json()) as Envelope<T>;
    if (!payload.success) {
      throw new Error(
        `Cloudflare read failed: ${path}: ${payload.errors?.map((x) => x.message).join("; ") ?? "unknown API error"}`,
      );
    }
    return payload;
  }
  async function all<T>(
    path: string,
    baseQuery: Record<string, string | number> = {},
  ): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await get<T[]>(path, { ...baseQuery, page, per_page: 100 });
      values.push(...response.result);
      if (!response.result_info?.total_pages || page >= response.result_info.total_pages) {
        return values;
      }
    }
    throw new Error(`Cloudflare inventory pagination exceeded safe limit: ${path}`);
  }
  const zones = await all<Zone>("/zones", { "account.id": accountId });
  const [tunnels, workers, subdomain] = await Promise.all([
    all<Tunnel>(`/accounts/${accountId}/cfd_tunnel`, { is_deleted: "false" }),
    get<{ id: string }[]>(`/accounts/${accountId}/workers/scripts`),
    get<{ subdomain: string }>(`/accounts/${accountId}/workers/subdomain`),
  ]);
  const dns: Record<string, DnsRecord[]> = {};
  const routes: Record<string, WorkerRoute[]> = {};
  const ingress: Record<string, Ingress[]> = {};
  await Promise.all(zones.map(async (z) => {
    dns[z.id] = await all<DnsRecord>(`/zones/${z.id}/dns_records`);
    routes[z.id] = (
      await get<WorkerRoute[]>(`/zones/${z.id}/workers/routes`)
    ).result;
  }));
  await Promise.all(tunnels.map(async (t) => {
    const response = await get<{ config?: { ingress?: Ingress[] } }>(
      `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`,
    );
    ingress[t.id.toLowerCase()] = response.result.config?.ingress ?? [];
  }));
  return {
    zones,
    dns,
    routes,
    tunnels,
    ingress,
    scripts: workers.result.map((s) => s.id),
    workerSubdomain: subdomain.result.subdomain,
  };
}

if (import.meta.main) {
  const token = process.env.CLOUDFLARE_AUDIT_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId || !token) {
    console.error("Set CLOUDFLARE_ACCOUNT_ID and a read-only CLOUDFLARE_AUDIT_TOKEN.");
    process.exitCode = 2;
  } else {
    try {
      const inventory = await fetchInventory(accountId, token);
      const findings = auditInventory(inventory);
      console.log(
        JSON.stringify(
          { zoneCount: inventory.zones.length, tunnelCount: inventory.tunnels.length, findings },
          null,
          2,
        ),
      );
      if (findings.length) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  }
}
