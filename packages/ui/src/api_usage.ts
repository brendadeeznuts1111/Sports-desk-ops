/**
 * @file api_usage.ts
 * @description Session-scoped API usage meter for the dashboard.
 *
 * Every dashboard request goes through `trackedFetch`, which records the endpoint
 * (method + path, dynamic ids collapsed), outcome, latency and last status. The
 * Telemetry tab renders the snapshot; nothing leaves the page and no request body
 * or customer id is stored — only the normalized route.
 */

import { useSyncExternalStore } from "react";

export interface ApiUsageRow {
  readonly key: string;
  readonly calls: number;
  readonly ok: number;
  readonly failed: number;
  readonly pending: number;
  readonly coalesced: number;
  readonly avgMs: number | null;
  readonly lastMs: number | null;
  readonly lastStatus: number | null;
  readonly lastAtMs: number | null;
}

export interface ApiUsageSnapshot {
  readonly rows: readonly ApiUsageRow[];
  readonly calls: number;
  readonly ok: number;
  readonly failed: number;
  readonly pending: number;
  readonly coalesced: number;
  readonly avgMs: number | null;
}

interface MutableRow {
  calls: number;
  ok: number;
  failed: number;
  pending: number;
  coalesced: number;
  completed: number;
  totalMs: number;
  lastMs: number | null;
  lastStatus: number | null;
  lastAtMs: number | null;
}

/** Same shapes `fetch` accepts, without relying on the DOM-only `RequestInfo` alias. */
export type ApiUsageInput = string | URL | Request;

export interface ApiCallToken {
  readonly key: string;
  readonly startedAtMs: number;
  readonly coalesced: boolean;
}

const rows = new Map<string, MutableRow>();
const listeners = new Set<() => void>();
let version = 0;
let cachedVersion = -1;
let cachedSnapshot: ApiUsageSnapshot = {
  rows: [],
  calls: 0,
  ok: 0,
  failed: 0,
  pending: 0,
  coalesced: 0,
  avgMs: null,
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOGIN_RE = /^[A-Z]{2,10}\d{2,}$/i;
const LONG_ID_RE = /^[A-Za-z0-9_-]{20,}$/;

/** Collapse a path segment that is an id, login or opaque token. */
function normalizeSegment(segment: string): string {
  if (segment === "") return segment;
  if (/^\d+$/.test(segment)) return ":id";
  if (UUID_RE.test(segment)) return ":id";
  if (LOGIN_RE.test(segment)) return ":id";
  if (LONG_ID_RE.test(segment)) return ":id";
  return segment;
}

/** `GET /api/agent/:id` — query strings and identifiers are intentionally omitted. */
export function apiUsageKey(
  input: ApiUsageInput,
  method?: string | null,
): string {
  let rawUrl: string;
  let requestMethod = method ?? "GET";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else {
    rawUrl = input.url;
    requestMethod = method ?? input.method ?? "GET";
  }

  let pathname = rawUrl;
  try {
    pathname = new URL(rawUrl, "http://dashboard.local").pathname;
  } catch {
    // Keep the raw value; a malformed URL is still useful as a usage key.
  }
  const normalized = pathname
    .split("/")
    .map(normalizeSegment)
    .join("/")
    .replace(/\/+$/, "");
  return `${requestMethod.toUpperCase()} ${normalized === "" ? "/" : normalized}`;
}

function mutableRow(key: string): MutableRow {
  let row = rows.get(key);
  if (row === undefined) {
    row = {
      calls: 0,
      ok: 0,
      failed: 0,
      pending: 0,
      coalesced: 0,
      completed: 0,
      totalMs: 0,
      lastMs: null,
      lastStatus: null,
      lastAtMs: null,
    };
    rows.set(key, row);
  }
  return row;
}

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Begin one API call; pair with {@link endApiCall}. Exported for tests. */
export function beginApiCall(key: string, coalesced = false): ApiCallToken {
  const row = mutableRow(key);
  row.calls += 1;
  row.pending += 1;
  if (coalesced) row.coalesced += 1;
  notify();
  return { key, startedAtMs: performance.now(), coalesced };
}

/** Finish one API call; `status === null` records a transport failure. */
export function endApiCall(token: ApiCallToken, status: number | null): void {
  const row = mutableRow(token.key);
  const elapsed = Math.max(0, performance.now() - token.startedAtMs);
  row.pending = Math.max(0, row.pending - 1);
  row.completed += 1;
  row.totalMs += elapsed;
  row.lastMs = Math.round(elapsed);
  row.lastStatus = status;
  row.lastAtMs = Date.now();
  if (status !== null && status >= 200 && status < 400) row.ok += 1;
  else row.failed += 1;
  notify();
}

function buildSnapshot(): ApiUsageSnapshot {
  let calls = 0;
  let ok = 0;
  let failed = 0;
  let pending = 0;
  let coalesced = 0;
  let totalMs = 0;
  let completed = 0;
  const snapshotRows: ApiUsageRow[] = [];
  for (const [key, row] of rows) {
    calls += row.calls;
    ok += row.ok;
    failed += row.failed;
    pending += row.pending;
    coalesced += row.coalesced;
    totalMs += row.totalMs;
    completed += row.completed;
    snapshotRows.push({
      key,
      calls: row.calls,
      ok: row.ok,
      failed: row.failed,
      pending: row.pending,
      coalesced: row.coalesced,
      avgMs: row.completed > 0 ? Math.round(row.totalMs / row.completed) : null,
      lastMs: row.lastMs,
      lastStatus: row.lastStatus,
      lastAtMs: row.lastAtMs,
    });
  }
  snapshotRows.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
  return {
    rows: snapshotRows,
    calls,
    ok,
    failed,
    pending,
    coalesced,
    avgMs: completed > 0 ? Math.round(totalMs / completed) : null,
  };
}

/** Cached so `useSyncExternalStore` sees a stable value between records. */
export function getApiUsageSnapshot(): ApiUsageSnapshot {
  if (cachedVersion !== version) {
    cachedSnapshot = buildSnapshot();
    cachedVersion = version;
  }
  return cachedSnapshot;
}

export function subscribeApiUsage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook used by the Telemetry API Usage card. */
export function useApiUsage(): ApiUsageSnapshot {
  return useSyncExternalStore(
    subscribeApiUsage,
    getApiUsageSnapshot,
    getApiUsageSnapshot,
  );
}

/** Clear the session meter (never touches server state). */
export function resetApiUsage(): void {
  rows.clear();
  notify();
}

/** In-flight plain GETs, keyed by absolute URL; StrictMode mounts overlap. */
const inFlightGet = new Map<
  string,
  Promise<{ readonly template: Response; readonly status: number }>
>();

/** Coalesce only plain, signal-free GETs; options/headers keep their own request. */
function coalescableGet(input: ApiUsageInput, init?: RequestInit): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false;
  if (init === undefined) return true;
  for (const key of Object.keys(init)) {
    if (key !== "method") return false;
  }
  return (init.method ?? "GET").toUpperCase() === "GET";
}

function absoluteUrl(input: ApiUsageInput): string {
  if (typeof input === "string")
    return new URL(input, "http://dashboard.local").href;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Drop-in `fetch` that records endpoint usage without changing the response.
 * Concurrent identical plain GETs share one network request and each caller
 * gets its own `Response` clone; the meter reports both calls and the reuse.
 */
export async function trackedFetch(
  input: ApiUsageInput,
  init?: RequestInit,
): Promise<Response> {
  const usageKey = apiUsageKey(input, init?.method);
  const coalescable = coalescableGet(input, init);
  const requestKey = coalescable ? `GET ${absoluteUrl(input)}` : null;
  const shared = requestKey === null ? undefined : inFlightGet.get(requestKey);
  const token = beginApiCall(usageKey, shared !== undefined);

  if (shared !== undefined) {
    try {
      const { template, status } = await shared;
      endApiCall(token, status);
      return template.clone() as unknown as Response;
    } catch (error) {
      endApiCall(token, null);
      throw error;
    }
  }

  const own = (async () => {
    // Bun's global `Response` and the undici fetch typings disagree about the
    // Headers shape; the runtime returns the same class.
    const response = (await fetch(input, init)) as unknown as Response;
    return { template: response, status: response.status };
  })();

  if (requestKey !== null) {
    inFlightGet.set(requestKey, own);
    void own
      .finally(() => {
        if (inFlightGet.get(requestKey) === own) inFlightGet.delete(requestKey);
      })
      .catch(() => {});
  }

  try {
    const { template, status } = await own;
    endApiCall(token, status);
    // The template stays unread, so every caller (including late joiners) can
    // clone it; nobody may consume the shared body.
    return (coalescable ? template.clone() : template) as unknown as Response;
  } catch (error) {
    endApiCall(token, null);
    throw error;
  }
}
