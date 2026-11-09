/**
 * @file lib/json_fetch.ts
 * @description JSON fetch + small parsing helpers shared by the CFB event index, the wallet
 * seeder and the combo reader. Not a domain module: nothing here knows what a CFB
 * event or a combo is.
 */

export interface JsonFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const text = (value: unknown): string =>
  typeof value === "string"
    ? value.trim()
    : typeof value === "number"
      ? String(value)
      : "";

export function jsonArray(value: unknown): string[] {
  if (Array.isArray(value))
    return value.map((entry) => text(entry)).filter(Boolean);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((entry) => text(entry)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // eslint-disable-next-line unicorn/no-new-array -- dense preallocation filled by index
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length || 1) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        out[index] = await fn(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/** Loads CFB events and indexes their condition IDs, slugs and CLOB token IDs. */

export async function getJson(
  url: string,
  options?: JsonFetchOptions,
): Promise<unknown> {
  const response = await (options?.fetchImpl ?? fetch)(url, {
    proxy: false,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 15_000),
  } as RequestInit);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}
