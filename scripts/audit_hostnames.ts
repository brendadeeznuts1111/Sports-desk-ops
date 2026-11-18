#!/usr/bin/env bun
/**
 * @file scripts/audit_hostnames.ts
 * @description Scan runtime files and `AUDITED_ENDPOINTS_CACHE` for external hostnames,
 * normalize them via Bun's WHATWG `URL` parser, and classify each against `EndpointRole`,
 * `OriginDomainId`, and `VenueId`.
 *
 *   bun scripts/audit_hostnames.ts
 *   bun scripts/audit_hostnames.ts --role source
 *   bun scripts/audit_hostnames.ts --json
 */

import { resolve } from "node:path";
import {
  flagValue,
  hasFlag,
  parseCliArgs,
  printHelp,
  wantsHelp,
} from "../lib/cli_args.ts";
import type { OriginDomainId, VenueId } from "../lib/domain_venue_registry.ts";
import {
  AUDITED_ENDPOINTS_CACHE,
  type EndpointRole,
} from "../lib/hostname_surface_audit.ts";
import {
  bump,
  collect,
  extractFromText,
  FILE_TLDS,
  isIp,
  normalizeHost,
  URL_RE,
  type HostHitSummary,
} from "../lib/hostname_extract.ts";

export {
  bump,
  collect,
  extractFromText,
  FILE_TLDS,
  isIp,
  normalizeHost,
  URL_RE,
  type HostHitSummary,
};

export type ClassifiedHostRole =
  EndpointRole | "vendor" | "local" | "unclassified";

export interface HostClassification {
  readonly role: ClassifiedHostRole;
  readonly originDomainId: OriginDomainId | null;
  readonly venueId: VenueId | null;
  readonly category: string;
}

export interface AuditedHostnameRow extends HostClassification {
  readonly host: string;
  readonly count: number;
  readonly sources: readonly string[];
}

const DEFAULT_SCAN_ROOTS = [
  "lib",
  "src",
  "services",
  "workers",
  "scripts",
  "packages",
  "config",
] as const;

const TEST_OR_FIXTURE_PATH_RE =
  /(?:\.test\.[jt]sx?$|\.spec\.[jt]sx?$|\/__tests__\/|^config\/fraud-research\.json$)/i;

const PLACEHOLDER_HOST_RE =
  /^(?:example\.(?:com|org|net|test)|.*\.example|.*\.invalid|.*\.test|host|mcp\.test|dashboard\.local|local|sportsdesk\.internal|schemas\.xmlsoap\.org|schema\.org|www\.w3\.org|ns\.adobe\.com|purl\.org|no-color\.org|https)$/i;

const HELP = `
audit_hostnames — extract, normalize, and classify external hostnames in the repo

Usage:
  bun scripts/audit_hostnames.ts [options]

Options:
  --root <dir>        Checkout root to scan (default: repo root)
  --role <role>       Filter by role: source | sink | doc | vendor | local | unclassified
  --max-sources <n>   Sample source paths stored per host (default: 5)
  --include-tests     Include *.test.* / *.spec.* files in scan
  --json              Emit machine-readable JSON
  -h, --help          This text
`.trim();

export function classifyHostname(host: string): HostClassification {
  const h = host.toLowerCase();

  if (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "[::1]" ||
    h === "sportsdesk_backend"
  ) {
    return {
      role: "local",
      originDomainId: "ORIGIN_HOST_NSH_DESK_LOCAL",
      venueId: "desk",
      category: "Loopback / Local Runtime",
    };
  }

  if (h === "fantasy402.com" || h === "www.fantasy402.com") {
    return {
      role: "source",
      originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
      venueId: "f402",
      category: "Fantasy402 Agent & Player API",
    };
  }

  if (
    h === "plive.sportswidgets.pro" ||
    h === "live.sportswidgets.pro" ||
    h === "ppm.sportswidgets.pro"
  ) {
    return {
      role: "source",
      originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      venueId: "gslive_partner118",
      category: "GSLive Partner 118",
    };
  }

  if (h === "spandora.ganchrow.com") {
    return {
      role: "source",
      originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      venueId: "gslive_partner118",
      category: "Ganchrow PPM Push Feed",
    };
  }

  if (h === "polymarket.com" || h.endsWith(".polymarket.com")) {
    return {
      role: "source",
      originDomainId: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
      venueId: "polymarket",
      category: "Polymarket CTF / Exchange",
    };
  }

  if (h === "api.elections.kalshi.com" || h === "trading-api.kalshi.com") {
    return {
      role: "source",
      originDomainId: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
      venueId: "kalshi",
      category: "Kalshi Regulated Exchange",
    };
  }

  if (h.endsWith(".r2.cloudflarestorage.com") || h.endsWith(".r2.dev")) {
    return {
      role: "sink",
      originDomainId: "ORIGIN_STORAGE_R2_LAKEHOUSE",
      venueId: "lakehouse",
      category: "Cloudflare R2 Storage / Gateway",
    };
  }

  if (
    h === "api.cloudflare.com" ||
    h === "api.telegram.org" ||
    h === "api.github.com"
  ) {
    return {
      role: "sink",
      originDomainId: null,
      venueId: null,
      category: "Ops Control / Alerting API",
    };
  }

  if (
    h === "desk.bookdeskops.com" ||
    h === "app.bookdeskops.com" ||
    h === "ops.bookdeskops.com" ||
    h === "docs.bookdeskops.com" ||
    h === "fantasy402-docs-4ay.pages.dev" ||
    h === "cdn.fastassets.io" ||
    h === "cdn.jsdelivr.net" ||
    h === "maps.googleapis.com" ||
    h === "captcha.sportswidgets.pro" ||
    h === "ezws.sportswidgets.pro" ||
    h === "ticketwriter1.com" ||
    h === "ticketwriter2.com" ||
    h === "ticketwriter3.com" ||
    h.endsWith(".vipclub.lv") ||
    h === "cashier.dealersportsbook.com" ||
    h === "telegram.org" ||
    h === "web.telegram.org" ||
    h === "t.me" ||
    h === "core.telegram.org" ||
    h === "polygonscan.com"
  ) {
    return {
      role: "vendor",
      originDomainId: null,
      venueId: null,
      category: "Link-Only / Hosted UI / Vendor CDN",
    };
  }

  if (
    h === "bun.sh" ||
    h === "bun.com" ||
    h === "github.com" ||
    h === "wicg.github.io" ||
    h === "nsh.dev" ||
    h === "docs.google.com" ||
    h === "code.claude.com" ||
    h === "registry.npmjs.org"
  ) {
    return {
      role: "doc",
      originDomainId: null,
      venueId: null,
      category: "Docs / Reference / Tooling",
    };
  }

  return {
    role: "unclassified",
    originDomainId: null,
    venueId: null,
    category: "Unclassified",
  };
}

export async function auditRepositoryHostnames(options: {
  readonly root: string;
  readonly maxSources?: number;
  readonly includeTests?: boolean;
}): Promise<readonly AuditedHostnameRow[]> {
  const maxSources = options.maxSources ?? 5;
  const includeTests = options.includeTests ?? false;
  const collected = new Map<string, HostHitSummary>();

  const glob = new Bun.Glob("**/*.{ts,tsx,js,mjs,json,toml,sh}");
  for (const dir of DEFAULT_SCAN_ROOTS) {
    const dirAbs = resolve(options.root, dir);
    for await (const relFile of glob.scan({ cwd: dirAbs, onlyFiles: true })) {
      const repoRel = `${dir}/${relFile}`;
      if (repoRel.includes("/node_modules/") || repoRel.includes("/dist/")) {
        continue;
      }
      if (!includeTests && TEST_OR_FIXTURE_PATH_RE.test(repoRel)) {
        continue;
      }
      const text = await Bun.file(resolve(options.root, repoRel)).text();
      collect(collected, text, repoRel, maxSources);
    }
  }

  // Fold in dynamically constructed hosts from lib/hostname_surface_audit.ts
  for (const ep of AUDITED_ENDPOINTS_CACHE) {
    if (ep.whatwgHostname !== "") {
      bump(
        collected,
        ep.whatwgHostname,
        `lib/hostname_surface_audit.ts#${ep.endpointId}`,
        maxSources,
      );
    }
  }

  const rows: AuditedHostnameRow[] = [];
  for (const [host, summary] of collected.entries()) {
    if (PLACEHOLDER_HOST_RE.test(host)) continue;
    const classification = classifyHostname(host);
    rows.push({
      host,
      count: summary.count,
      sources: summary.sources,
      ...classification,
    });
  }

  const roleRank: Record<ClassifiedHostRole, number> = {
    source: 0,
    sink: 1,
    vendor: 2,
    doc: 3,
    local: 4,
    unclassified: 5,
  };

  rows.sort(
    (a, b) =>
      roleRank[a.role] - roleRank[b.role] ||
      b.count - a.count ||
      a.host.localeCompare(b.host),
  );
  return rows;
}

if (import.meta.main) {
  const parsed = parseCliArgs(process.argv.slice(2), {
    valueFlags: ["--root", "--role", "--max-sources"],
  });
  if (wantsHelp(parsed)) {
    printHelp(HELP);
    process.exit(0);
  }

  const root = flagValue(parsed, "--root", resolve(import.meta.dir, ".."));
  const roleFilter = flagValue(parsed, "--role", "").trim().toLowerCase();
  const maxSourcesRaw = Number(flagValue(parsed, "--max-sources", "5"));
  const maxSources = Number.isFinite(maxSourcesRaw)
    ? Math.max(1, Math.trunc(maxSourcesRaw))
    : 5;
  const includeTests = hasFlag(parsed, "--include-tests");
  const asJson = hasFlag(parsed, "--json");

  const allRows = await auditRepositoryHostnames({
    root,
    maxSources,
    includeTests,
  });
  const rows =
    roleFilter === ""
      ? allRows
      : allRows.filter((row) => row.role === roleFilter);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          totalHosts: rows.length,
          rows,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log(
    `Audited ${rows.length} hostnames across ${DEFAULT_SCAN_ROOTS.join(", ")} + AUDITED_ENDPOINTS_CACHE:\n`,
  );
  for (const row of rows) {
    const origin = row.originDomainId ?? "—";
    const venue = row.venueId ?? "—";
    console.log(
      `[${row.role.padEnd(12)}] ${row.host.padEnd(56)} hits=${String(row.count).padStart(3)} | venue=${venue.padEnd(17)} | origin=${origin} (${row.sources[0] ?? ""})`,
    );
  }
}
