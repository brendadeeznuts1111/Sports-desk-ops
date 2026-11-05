/**
 * Resolve the latest f402-weblog rollup: local pointer/rollup first, then the R2 public pointer.
 *
 * Boundary — this module owns the repo's ONE network-capable weblog read. The fraud/security CLI
 * (`cli/sportsdesk_fraud_cli.ts` via `lib/fraud_logs.ts`) deliberately reads local rollups only and
 * reports a missing source instead: that keeps its answers offline-reproducible and auditable. Do
 * not import this resolver into the fraud path; an R2 pull belongs in a documented sync step that
 * materializes the artifact locally first.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_PUBLIC_BASE =
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev";
const DEFAULT_R2_LATEST = `${DEFAULT_PUBLIC_BASE}/f402-weblog/latest.json`;

export interface WeblogLatestSuccess {
  readonly status: "ok";
  readonly source: "local" | "r2";
  readonly rollup: Record<string, unknown>;
}
export interface WeblogLatestFailure {
  readonly status: "unavailable";
  readonly reason: string;
}
export type WeblogLatest = WeblogLatestSuccess | WeblogLatestFailure;

/**
 * Local-only resolution, for callers that must not touch the network.
 *
 * The dashboard summary is derived on every SSE tick, so it needs the rollup path and the
 * record without an R2 fallback that could hang the request. `loadWeblogLatest` keeps the
 * network chain for the reporting panel; this is the same local discovery without it.
 */
export interface WeblogLocalSuccess {
  readonly status: "ok";
  readonly source: "local";
  /** Absolute path to the rollup file that answered, so the caller can report mtime/relative path. */
  readonly path: string;
  readonly rollup: Record<string, unknown>;
}
export interface WeblogLocalFailure {
  readonly status: "unavailable";
  readonly reason: string;
}
export type WeblogLocal = WeblogLocalSuccess | WeblogLocalFailure;

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRollup(value: Record<string, unknown> | null): boolean {
  return (
    value !== null &&
    value.kind === "f402-weblog" &&
    typeof value.rows === "object"
  );
}

/**
 * Probe order for a local rollup: the two pointer files first, then `scratch/weblog/*.json`
 * newest-name-first. Shared by the resolver and by {@link findWeblogLatestLocalPath}, so a
 * fingerprint and the value it guards cannot disagree about which file is "latest".
 */
function localCandidates(root: string): string[] {
  const candidates = [
    join(root, "scratch/weblog/latest.json"),
    join(root, "f402-weblog/latest.json"),
  ];
  try {
    const dir = join(root, "scratch/weblog");
    if (existsSync(dir)) {
      candidates.push(
        ...readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .reverse()
          .map((name) => join(dir, name)),
      );
    }
  } catch {
    /* ignore unreadable dirs */
  }
  return candidates;
}

interface LocalEntry {
  readonly path: string;
  readonly rollup: Record<string, unknown>;
}

function resolveLocalEntry(root: string): LocalEntry | null {
  for (const path of localCandidates(root)) {
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (parsed !== null && isRollup(parsed)) return { path, rollup: parsed };
    const key = parsed?.key;
    if (typeof key === "string") {
      const target = resolve(root, key);
      const rollup = readJson(target);
      if (rollup !== null && isRollup(rollup)) return { path: target, rollup };
    }
  }
  return null;
}

/**
 * The local rollup path a fingerprint can stat, without parsing the file.
 *
 * This is discovery only: an existing pointer may still fail validation in
 * {@link loadWeblogLatestLocal}. It exists so the 5s SSE fingerprint stays a stat call.
 */
export function findWeblogLatestLocalPath(
  root: string = process.cwd(),
): string | null {
  for (const path of localCandidates(root)) {
    if (existsSync(path)) return path;
  }
  return null;
}

/** Local rollup or an explicit unavailable result. Never performs network I/O. */
export function loadWeblogLatestLocal(
  root: string = process.cwd(),
): WeblogLocal {
  const entry = resolveLocalEntry(root);
  return entry === null
    ? {
        status: "unavailable",
        reason: "no local f402-weblog rollup under scratch/weblog/",
      }
    : { status: "ok", source: "local", path: entry.path, rollup: entry.rollup };
}

export async function loadWeblogLatest(
  options: {
    readonly root?: string;
    readonly fetchImpl?: (url: string) => Promise<Response>;
    readonly r2LatestUrl?: string;
  } = {},
): Promise<WeblogLatest> {
  const local = resolveLocalEntry(options.root ?? process.cwd());
  if (local !== null)
    return { status: "ok", source: "local", rollup: local.rollup };
  const fetchImpl = options.fetchImpl ?? fetch;
  const latestUrl = options.r2LatestUrl ?? DEFAULT_R2_LATEST;
  try {
    const pointerRes = await fetchImpl(latestUrl);
    if (!pointerRes.ok)
      return {
        status: "unavailable",
        reason: `R2 pointer HTTP ${pointerRes.status}`,
      };
    const pointer = (await pointerRes.json()) as { key?: unknown };
    if (typeof pointer.key !== "string")
      return { status: "unavailable", reason: "R2 pointer has no key" };
    const url = new URL(
      pointer.key.startsWith("http") ? pointer.key : `/${pointer.key}`,
      latestUrl,
    ).toString();
    const rollupRes = await fetchImpl(url);
    if (!rollupRes.ok)
      return {
        status: "unavailable",
        reason: `R2 rollup HTTP ${rollupRes.status}`,
      };
    const rollup = (await rollupRes.json()) as Record<string, unknown>;
    if (!isRollup(rollup))
      return {
        status: "unavailable",
        reason: "R2 object is not an f402-weblog rollup",
      };
    return { status: "ok", source: "r2", rollup };
  } catch (error) {
    return {
      status: "unavailable",
      reason: `R2 unavailable: ${String(error).slice(0, 120)}`,
    };
  }
}
