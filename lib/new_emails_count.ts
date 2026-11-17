/**
 * @file lib/new_emails_count.ts
 * @description Project getNewEmailsCount ({ INFO: { LIST, COUNT } }).
 * A missing COUNT is null, never 0; an empty LIST with COUNT.total=0 is a measured zero.
 */

export interface ProjectedNewEmailsCount {
  readonly total: number | null;
  readonly listed: number;
  readonly projectedAt: string;
}

export function projectNewEmailsCount(raw: unknown): ProjectedNewEmailsCount {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("new-emails response must be an object");
  }
  const infoRaw = (raw as Record<string, unknown>).INFO;
  if (
    infoRaw === null ||
    typeof infoRaw !== "object" ||
    Array.isArray(infoRaw)
  ) {
    throw new Error("new-emails response lacks INFO");
  }
  const info = infoRaw as Record<string, unknown>;
  const list = Array.isArray(info.LIST) ? info.LIST : [];
  const count = info.COUNT;
  const total =
    count !== null &&
    typeof count === "object" &&
    !Array.isArray(count) &&
    typeof (count as Record<string, unknown>).total === "number"
      ? ((count as Record<string, unknown>).total as number)
      : null;
  return { total, listed: list.length, projectedAt: new Date().toISOString() };
}
