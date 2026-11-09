/**
 * CLI input resolution for `scripts/f402_weblog_bridge.ts` (fetch + rollup).
 */

import {
  fetchAndPersistWebLog,
  resolveF402BearerTokenDetailed,
  type WebLogMode,
  type WebLogRequest,
} from "./f402_weblog_fetch.ts";
import type { ResolveF402BearerOptions } from "./f402_pending_fetch.ts";
import { readF402Session } from "./f402_session.ts";

export const WEBLOG_BRIDGE_USAGE_HINT = [
  "weblog: --from required (or --fetch-mode to capture first)",
  "  fetch+rollup: bun run weblog:rollup --fetch-mode A",
  "  rollup only:  bun run weblog:rollup --from out/f402/weblog/11-08-2026.jsonl",
  "  (Mode B/I shared-IP audit is not activity weblog — not supported here)",
].join("\n");

export const WEBLOG_ROLLUP_UNSUPPORTED_FETCH_MODES = new Set<WebLogMode>([
  "B",
  "I",
]);

export function weblogFetchModeUnsupportedMessage(mode: WebLogMode): string {
  if (mode === "B") {
    return (
      "weblog:rollup --fetch-mode B is not supported. " +
      "Mode B returns {LoginID, IPAddress} shared-IP audit rows, not weblog activity rows. " +
      "Use --fetch-mode A or C for activity data."
    );
  }
  if (mode === "I") {
    return (
      "weblog:rollup --fetch-mode I is not supported. " +
      "Mode I is accounts-by-IP audit, not the activity stream this rollup expects. " +
      "Use --fetch-mode A or C."
    );
  }
  return `weblog:rollup --fetch-mode ${mode} is not supported for activity rollup.`;
}

const FETCH_MODES = new Set<WebLogMode>(["A", "B", "C", "I"]);

export function parseWeblogFetchMode(raw: string): WebLogMode {
  const mode = raw.trim().toUpperCase() as WebLogMode;
  if (!FETCH_MODES.has(mode)) {
    throw new Error(
      `--fetch-mode must be A, B, C, or I (got "${raw.trim()}")`,
    );
  }
  return mode;
}

/** `2026-11-08` → `out/f402/weblog/11-08-2026.jsonl` (staging convention). */
export function defaultWeblogCapturePath(deskDateYmd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deskDateYmd)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${deskDateYmd}"`);
  }
  const [year, month, day] = deskDateYmd.split("-");
  return `out/f402/weblog/${month}-${day}-${year}.jsonl`;
}

export function defaultDeskDateYmd(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface WeblogBridgeCliValues {
  readonly from?: string;
  readonly "fetch-mode"?: string;
  readonly date?: string;
  readonly "customer-id"?: string;
  readonly ip?: string;
  readonly "save-capture"?: string;
  readonly "bearer-token"?: string;
}

export type WeblogCorpusResolution =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly exitCode: 1 | 2; readonly message: string };

export interface WeblogCorpusResolverDeps {
  readonly resolveToken?: (
    options: ResolveF402BearerOptions,
  ) => ReturnType<typeof resolveF402BearerTokenDetailed>;
  readonly fetchAndPersist?: typeof fetchAndPersistWebLog;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export async function resolveWeblogCorpusPaths(
  values: WeblogBridgeCliValues,
  deps: WeblogCorpusResolverDeps = {},
): Promise<WeblogCorpusResolution> {
  const resolveToken = deps.resolveToken ?? resolveF402BearerTokenDetailed;
  const fetchAndPersist = deps.fetchAndPersist ?? fetchAndPersistWebLog;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  const fetchModeRaw = values["fetch-mode"]?.trim();
  if (fetchModeRaw !== undefined && fetchModeRaw !== "") {
    let mode: WebLogMode;
    try {
      mode = parseWeblogFetchMode(fetchModeRaw);
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (WEBLOG_ROLLUP_UNSUPPORTED_FETCH_MODES.has(mode)) {
      return {
        ok: false,
        exitCode: 1,
        message: weblogFetchModeUnsupportedMessage(mode),
      };
    }

    const deskDate = (values.date ?? "").trim() || defaultDeskDateYmd(now());
    let token: string;
    try {
      const resolved = resolveToken({
        cliToken: values["bearer-token"],
      });
      token = resolved.token;
      log(`weblog: bearer source=${resolved.source}`);
    } catch {
      return {
        ok: false,
        exitCode: 1,
        message:
          "weblog: --fetch-mode needs F402_BEARER_TOKEN, F402_TOKEN_FILE, --bearer-token, or session:login",
      };
    }

    const capturePath =
      (values["save-capture"] ?? "").trim() ||
      defaultWeblogCapturePath(deskDate);

    const request: WebLogRequest = {
      mode,
      date: deskDate,
      ...(values["customer-id"] !== undefined
        ? { customerId: values["customer-id"] }
        : {}),
      ...(values.ip !== undefined ? { ip: values.ip } : {}),
    };

    const session = readF402Session();
    const cookieHeader = session?.cookieHeader?.trim();

    try {
      await fetchAndPersist({
        token,
        request,
        capturePath,
        ...(cookieHeader !== undefined && cookieHeader !== ""
          ? { cookieHeader }
          : {}),
      });
    } catch (error) {
      return {
        ok: false,
        exitCode: 1,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    log(`weblog: captured ${capturePath}`);
    return { ok: true, paths: [capturePath] };
  }

  const fromRaw = values.from?.trim();
  if (fromRaw === undefined || fromRaw === "") {
    return {
      ok: false,
      exitCode: 2,
      message: WEBLOG_BRIDGE_USAGE_HINT,
    };
  }

  const paths = fromRaw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (paths.length === 0) {
    return {
      ok: false,
      exitCode: 2,
      message: WEBLOG_BRIDGE_USAGE_HINT,
    };
  }
  return { ok: true, paths };
}
