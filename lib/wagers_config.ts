/**
 * Data-driven configuration loader for wagers-by-state reports.
 *
 * Loads `config/wagers.json`, validates it with zod, and exposes typed
 * accessors so the report scripts never hardcode column indices, state
 * names, or output layout.
 */

import { z } from "zod";

/** ------------------------------------------------------------------ */
/* Config schema                                                        */
/** ------------------------------------------------------------------ */

const stateDefSchema = z.object({
  label: z.string(),
  sortOrder: z.number().int().nonnegative(),
});

export type StateDef = z.infer<typeof stateDefSchema>;

const columnMapSchema = z.object({
  ticket: z.number().int().nonnegative(),
  betGroup: z.number().int().nonnegative(),
  state: z.number().int().nonnegative(),
  risk: z.number().int().nonnegative(),
  toWin: z.number().int().nonnegative(),
  result: z.number().int().nonnegative(),
  betTime: z.number().int().nonnegative(),
  player: z.number().int().nonnegative(),
  agent: z.number().int().nonnegative(),
  eventDetails: z.number().int().nonnegative(),
});

export type ColumnMap = z.infer<typeof columnMapSchema>;

const outputColumnSchema = z.object({
  key: z.string(),
  label: z.string(),
  align: z.enum(["left", "right"]),
  width: z.number().int().nonnegative(),
});

export type OutputColumn = z.infer<typeof outputColumnSchema>;

const outputSortSchema = z.object({
  key: z.string(),
  direction: z.enum(["asc", "desc"]),
});

export type OutputSort = z.infer<typeof outputSortSchema>;

const outputSchema = z.object({
  columns: z.array(outputColumnSchema),
  sort: outputSortSchema,
  unknownStateLabel: z.string(),
  formats: z.array(
    z.enum(["table", "json", "csv", "summary", "inspect", "columns", "grid"]),
  ),
  csvDelimiter: z.string().default(","),
});

export type OutputSpec = z.infer<typeof outputSchema>;

export type FilterField = "stateFilter" | "wagerNumberFilter" | "legsFilter";

const filterDefSchema = z.object({
  arg: z.string(),
  description: z.string(),
  type: z.enum(["string", "number"]),
  field: z.enum(["stateFilter", "wagerNumberFilter", "legsFilter"]),
});

export type FilterDef = z.infer<typeof filterDefSchema>;

const filtersSchema = z.record(z.string(), filterDefSchema);

export type Filters = z.infer<typeof filtersSchema>;

const retrySchema = z.object({
  attempts: z.number().int().min(1).max(10),
  baseMs: z.number().int().min(0).max(60_000),
});

export type RetrySpec = z.infer<typeof retrySchema>;

const liveSchema = z.object({
  url: z.string().url(),
  action: z.string(),
  dateFilterBy: z.string(),
  fromTime: z.number().int().nonnegative(),
  toTime: z.number().int().nonnegative(),
  retry: retrySchema.default({ attempts: 4, baseMs: 500 }),
});

export type LiveSpec = z.infer<typeof liveSchema>;

const groupDefSchema = z.object({
  label: z.string(),
  field: z.enum(["state", "day", "event", "player", "agent"]),
  sort: z.enum(["config-order", "risk-desc", "count-desc", "key-asc"]),
});

export type GroupDef = z.infer<typeof groupDefSchema>;

const groupsSchema = z.object({
  state: groupDefSchema,
  day: groupDefSchema,
  event: groupDefSchema,
  player: groupDefSchema,
  agent: groupDefSchema,
});

export type Groups = z.infer<typeof groupsSchema>;
export type GroupKey = keyof Groups;

const configSchema = z.object({
  version: z.number().int().nonnegative(),
  description: z.string().optional(),
  default: z.object({
    days: z.number().int().positive(),
    csvPath: z.string(),
    format: z
      .enum(["table", "json", "csv", "summary", "inspect", "columns", "grid"])
      .default("table"),
    groupBy: z
      .enum(["state", "day", "event", "player", "agent"])
      .default("state"),
  }),
  columns: columnMapSchema,
  states: z.record(z.string(), stateDefSchema),
  dateFormats: z.object({
    betTime: z.string(),
    cli: z.array(z.string()),
  }),
  live: liveSchema,
  groups: groupsSchema,
  output: outputSchema,
  filters: filtersSchema,
});

export type WagersConfig = z.infer<typeof configSchema>;

/** ------------------------------------------------------------------ */
/* Loader                                                               */
/** ------------------------------------------------------------------ */

const DEFAULT_CONFIG_PATH = "config/wagers.json";

let _config: WagersConfig | null = null;

/** Load and validate config. Cached after first read. */
export async function loadConfig(
  path = DEFAULT_CONFIG_PATH,
): Promise<WagersConfig> {
  if (_config) return _config;
  const raw: unknown = await Bun.file(path).json();
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join(", ");
    throw new Error(`wagers config validation failed at ${path}: ${issues}`);
  }
  _config = parsed.data;
  return _config;
}

/** Reset cache (mainly for tests). */
export function resetConfig(): void {
  _config = null;
}

/** ------------------------------------------------------------------ */
/* Typed accessors                                                      */
/** ------------------------------------------------------------------ */

export function getColumnMap(cfg: WagersConfig): ColumnMap {
  return cfg.columns;
}

export function getStateDefs(cfg: WagersConfig): Record<string, StateDef> {
  return cfg.states;
}

export function getKnownStates(cfg: WagersConfig): string[] {
  return Object.keys(cfg.states).sort(
    (a, b) => (cfg.states[a]?.sortOrder ?? 0) - (cfg.states[b]?.sortOrder ?? 0),
  );
}

export function getOutputSpec(cfg: WagersConfig): OutputSpec {
  return cfg.output;
}

export function getFilters(cfg: WagersConfig): Filters {
  return cfg.filters;
}

export function getDefaultDays(cfg: WagersConfig): number {
  return cfg.default.days;
}

export function getDefaultCsvPath(cfg: WagersConfig): string {
  return cfg.default.csvPath;
}

export function getUnknownStateLabel(cfg: WagersConfig): string {
  return cfg.output.unknownStateLabel;
}

/** ------------------------------------------------------------------ */
/* Pure helpers derived from config                                     */
/** ------------------------------------------------------------------ */

/** Sort states by config sortOrder, unknown last. */
export function sortStatesByConfig(
  states: string[],
  cfg: WagersConfig,
): string[] {
  const defs = cfg.states;
  return [...states].sort((a, b) => {
    const aDef = defs[a];
    const bDef = defs[b];
    const aOrder = aDef ? aDef.sortOrder : Number.MAX_SAFE_INTEGER;
    const bOrder = bDef ? bDef.sortOrder : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}
