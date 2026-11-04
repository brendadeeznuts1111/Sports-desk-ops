/** Resolve the latest f402-weblog rollup: local pointer/rollup first, then the R2 public pointer. */
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

function resolveLocal(root: string): Record<string, unknown> | null {
  const candidates = [
    join(root, "Scratch/weblog/latest.json"),
    join(root, "f402-weblog/latest.json"),
  ];
  try {
    const dir = join(root, "Scratch/weblog");
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
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const parsed = readJson(path);
    if (isRollup(parsed)) return parsed;
    const key = parsed?.key;
    if (typeof key === "string") {
      const target = resolve(root, key);
      const rollup = readJson(target);
      if (isRollup(rollup)) return rollup;
    }
  }
  return null;
}

export async function loadWeblogLatest(
  options: {
    readonly root?: string;
    readonly fetchImpl?: (url: string) => Promise<Response>;
    readonly r2LatestUrl?: string;
  } = {},
): Promise<WeblogLatest> {
  const local = resolveLocal(options.root ?? process.cwd());
  if (local !== null) return { status: "ok", source: "local", rollup: local };
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
