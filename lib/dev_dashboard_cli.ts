/**
 * @file lib/dev_dashboard_cli.ts
 * @description Pure CLI flag parser and canonical launch-URL builder for `scripts/dev_dashboard.ts`.
 *
 * Kept separate from HTML/React entrypoint imports so `cli/sportsdesk_cli.ts dev --help`
 * and `--print-url` execute without bundling `src/dashboard/index.html`.
 */

import {
  DASHBOARD_TAB_IDS,
  DASHBOARD_TAB_SPECS,
  isDashboardTabId,
  type DashboardTabId,
} from "../packages/ui/src/types.ts";
import {
  buildDashboardSearch,
  DASHBOARD_SECTION_TABS,
  DEFAULT_DASHBOARD_URL_STATE,
} from "../packages/ui/src/url_state.ts";

export interface DevDashboardCliFlags {
  readonly port: number;
  readonly hostname: string;
  readonly companionOrigin: string;
  readonly tab: DashboardTabId | null;
  readonly matrix: boolean;
  readonly open: boolean;
  readonly printUrl: boolean;
  readonly apiOnly: boolean;
  readonly noDev: boolean;
  readonly noHmr: boolean;
  readonly noConsole: boolean;
  readonly noWatch: boolean;
  readonly mcpStateless: boolean;
  readonly help: boolean;
}

export type DevDashboardCliParseResult =
  | { readonly ok: true; readonly flags: DevDashboardCliFlags }
  | { readonly ok: false; readonly error: string };

const DEFAULT_PORT = 4022;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_COMPANION = "http://127.0.0.1:4020";

export function devDashboardHelpText(): string {
  const validTabs = DASHBOARD_TAB_IDS.join(", ");
  const validHashes = Object.keys(DASHBOARD_SECTION_TABS).join(", ");
  return `SportsDesk Enhanced Dashboard Dev Server

Usage:
  ./bin/dx dev [options]
  bun run dev -- [options]
  bun run cli dev [options]

Options:
  -p, --port <N>          HTTP listen port (0..65535, default: PORT env or 4022)
  --host, --hostname <H>  Bind hostname (default: 127.0.0.1)
  --companion <ORIGIN>    Companion API daemon origin (default: SPORTSDESK_API_ORIGIN or http://127.0.0.1:4020)
  --tab, --view <TAB>     Initial dashboard view (${validTabs}; or hashes: ${validHashes})
  --matrix                Include ?matrix=1 build matrix & Houdini palette overlay in launch URL
  --open                  Open resolved launch URL in the default browser after startup
  --print-url             Print the resolved launch URL and exit 0 without starting the server
  --api-only              Serve API & WebSocket routes without HTML bundle or UI file watchers
  --no-dev, --prod        Disable Bun development overlay and file watchers
  --no-hmr                Disable Hot Module Reloading in dev mode
  --no-console            Disable browser console forwarding in dev mode
  --no-watch              Disable filesystem watchers while keeping Bun dev overlay active
  --stateless             Run embedded MCP HTTP handler in stateless mode (--mcp-stateless alias)
  -h, --help              Show this help and exit

Examples:
  ./bin/dx dev --port 4024 --tab risk-overview --matrix --print-url
  ./bin/dx dev --port 4024 --tab risk-overview --matrix --open
  bun run dev -- --port 4024 --companion http://127.0.0.1:4020
  bun run dev -- --api-only --no-watch`;
}

export function resolveExplicitDashboardTab(
  raw: string,
): DashboardTabId | null {
  const cleaned = raw
    .trim()
    .replace(/^[#/]+/, "")
    .toLowerCase();
  if (!cleaned) return null;

  const sectionTarget = DASHBOARD_SECTION_TABS[cleaned];
  if (sectionTarget !== undefined) return sectionTarget;

  if (isDashboardTabId(cleaned)) return cleaned;

  for (const id of DASHBOARD_TAB_IDS) {
    const spec = DASHBOARD_TAB_SPECS[id];
    if (spec.aliases.includes(cleaned)) {
      return id;
    }
  }
  return null;
}

function normalizeHttpOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  return parsed.origin;
}

function defaultPortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
    return parsed;
  }
  return DEFAULT_PORT;
}

function defaultCompanionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env.SPORTSDESK_API_ORIGIN?.trim();
  if (!raw) return DEFAULT_COMPANION;
  return normalizeHttpOrigin(raw) ?? DEFAULT_COMPANION;
}

export function parseDevDashboardCliArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): DevDashboardCliParseResult {
  let port = defaultPortFromEnv(env);
  let hostname = DEFAULT_HOST;
  let companionOrigin = defaultCompanionFromEnv(env);
  let tab: DashboardTabId | null = null;
  let matrix = false;
  let open = false;
  let printUrl = false;
  let apiOnly = false;
  let noDev = false;
  let noHmr = false;
  let noConsole = false;
  let noWatch = false;
  let mcpStateless = false;
  let help = false;

  const takeValue = (
    index: number,
    inline: string | undefined,
    flag: string,
  ):
    | { readonly ok: true; readonly value: string; readonly nextIndex: number }
    | { readonly ok: false; readonly error: string } => {
    if (inline !== undefined) {
      return { ok: true, value: inline, nextIndex: index };
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      return {
        ok: false,
        error: `dev_dashboard: ${flag} expects a value (see '--help')`,
      };
    }
    return { ok: true, value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const eqIdx = raw.startsWith("--") ? raw.indexOf("=") : -1;
    const flag = eqIdx === -1 ? raw : raw.slice(0, eqIdx);
    const inline = eqIdx === -1 ? undefined : raw.slice(eqIdx + 1);

    if (flag === "-h" || flag === "--help") {
      help = true;
      continue;
    }
    if (flag === "-p" || flag === "--port") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const parsed = Number(taken.value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        return {
          ok: false,
          error: `dev_dashboard: --port expects an integer 0..65535, got "${taken.value}"`,
        };
      }
      port = parsed;
      continue;
    }
    if (flag === "--host" || flag === "--hostname") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const trimmed = taken.value.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: `dev_dashboard: ${flag} must be a non-empty hostname`,
        };
      }
      hostname = trimmed;
      continue;
    }
    if (flag === "--companion" || flag === "--companion-origin") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const normalized = normalizeHttpOrigin(taken.value);
      if (!normalized) {
        return {
          ok: false,
          error: `dev_dashboard: ${flag} expects an http(s) origin without credentials, got "${taken.value}"`,
        };
      }
      companionOrigin = normalized;
      continue;
    }
    if (flag === "--tab" || flag === "--view") {
      const taken = takeValue(i, inline, flag);
      if (!taken.ok) return taken;
      i = taken.nextIndex;
      const resolved = resolveExplicitDashboardTab(taken.value);
      if (!resolved) {
        return {
          ok: false,
          error: `dev_dashboard: unknown tab "${taken.value}". Expected one of: ${DASHBOARD_TAB_IDS.join(", ")} (or hashes: ${Object.keys(DASHBOARD_SECTION_TABS).join(", ")})`,
        };
      }
      tab = resolved;
      continue;
    }
    if (flag === "--matrix") {
      matrix = true;
      continue;
    }
    if (flag === "--open") {
      open = true;
      continue;
    }
    if (flag === "--print-url") {
      printUrl = true;
      continue;
    }
    if (flag === "--api-only") {
      apiOnly = true;
      continue;
    }
    if (flag === "--no-dev" || flag === "--prod") {
      noDev = true;
      continue;
    }
    if (flag === "--no-hmr") {
      noHmr = true;
      continue;
    }
    if (flag === "--no-console") {
      noConsole = true;
      continue;
    }
    if (flag === "--no-watch") {
      noWatch = true;
      continue;
    }
    if (flag === "--stateless" || flag === "--mcp-stateless") {
      mcpStateless = true;
      continue;
    }

    return {
      ok: false,
      error: `dev_dashboard: unknown argument "${raw}". Run with '--help' for supported flags.`,
    };
  }

  if (!help && open && apiOnly) {
    return {
      ok: false,
      error: "dev_dashboard: --open cannot be combined with --api-only.",
    };
  }

  return {
    ok: true,
    flags: {
      port,
      hostname,
      companionOrigin,
      tab,
      matrix,
      open,
      printUrl,
      apiOnly,
      noDev,
      noHmr,
      noConsole,
      noWatch,
      mcpStateless,
      help,
    },
  };
}

export function buildDashboardLaunchUrl(
  baseUrl: string | URL,
  opts: {
    readonly tab?: DashboardTabId | null | undefined;
    readonly matrix?: boolean | undefined;
  } = {},
): string {
  const url = new URL(baseUrl instanceof URL ? baseUrl.href : baseUrl);
  const targetTab = opts.tab ?? null;
  const sectionHash =
    targetTab !== null
      ? (Object.entries(DASHBOARD_SECTION_TABS).find(
          ([, mappedTab]) => mappedTab === targetTab,
        )?.[0] ?? null)
      : null;

  const search = buildDashboardSearch(
    {
      ...DEFAULT_DASHBOARD_URL_STATE,
      tab:
        sectionHash !== null
          ? DEFAULT_DASHBOARD_URL_STATE.tab
          : (targetTab ?? DEFAULT_DASHBOARD_URL_STATE.tab),
      matrix: Boolean(opts.matrix),
    },
    "",
    "/",
  );
  url.pathname = "/";
  url.search = search ? `?${search}` : "";
  url.hash = sectionHash ? `#${sectionHash}` : "";
  return url.toString();
}

export function browserOpenCommandForPlatform(
  url: string,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export function openUrlInBrowser(
  url: string,
  spawnImpl: typeof Bun.spawn = Bun.spawn,
  platform: NodeJS.Platform = process.platform,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const cmd = browserOpenCommandForPlatform(url, platform);
  try {
    const proc = spawnImpl([...cmd], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    proc.unref();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to launch browser for ${url} via ${cmd[0]}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
