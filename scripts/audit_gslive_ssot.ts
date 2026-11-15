/**
 * @file scripts/audit_gslive_ssot.ts
 * @description Audits the observed 42-sport GSLive numeric catalog against the
 * ingestion SSOT. Run: bun run scripts/audit_gslive_ssot.ts
 *
 * The arrays below are observed audit inputs, not a second registry. The SSOT
 * check looks for a `gsliveSportId` field on INGESTION_CHANNELS; if the field
 * does not exist, the entire mapping is absent and the script exits non-zero.
 */
import { INGESTION_CHANNELS } from "../design/domain-branded-types.ts";

const SIDEBAR_OBSERVED = [
  999994, 999995, 3, 999996, 999997, 9999910, 999996632, 220, 5, 2, 8, 1, 86, 4,
  13, 27, 218, 7, 114, 88, 9, 93, 6, 103, 104, 94, 95, 98, 105, 90, 121, 87,
  124, 118, 113,
] as const;

const CONFIG_ONLY = [89, 116, 120, 163, 179, 999998, 99999473] as const;

const ALL_GSLIVE_IDS: readonly number[] = [...SIDEBAR_OBSERVED, ...CONFIG_ONLY];
const ALL_GSLIVE_ID_SET = new Set<number>(ALL_GSLIVE_IDS);

const ssotSportIds = new Set<number>();
let hasSportIdAxis = false;

for (const entry of INGESTION_CHANNELS) {
  if (entry === null || typeof entry !== "object") continue;
  // The axis is intentionally absent from the interface; reflect to detect a future field.
  const record = entry as unknown as Record<string, unknown>;
  if (!("gsliveSportId" in record)) continue;
  hasSportIdAxis = true;
  const value = record["gsliveSportId"];
  if (typeof value === "number" && Number.isInteger(value)) {
    ssotSportIds.add(value);
  }
}

const missing = ALL_GSLIVE_IDS.filter((id) => !ssotSportIds.has(id));
const extra = [...ssotSportIds].filter((id) => !ALL_GSLIVE_ID_SET.has(id));

console.log(
  JSON.stringify(
    {
      expected: ALL_GSLIVE_IDS.length,
      ssotEntries: INGESTION_CHANNELS.length,
      ssotSportIds: ssotSportIds.size,
      hasSportIdAxis,
      missing,
      extra,
    },
    null,
    2,
  ),
);

if (!hasSportIdAxis) {
  console.error(
    "\nNo gsliveSportId axis in INGESTION_CHANNELS. The 42-ID mapping is a new field, not a parallel registry. Do not add one until the base-vs-featured identity decision is made.",
  );
  process.exit(1);
}

if (missing.length > 0) {
  console.error(
    "\nMISSING FROM SSOT (fix in INGESTION_CHANNELS, do not add a parallel registry):",
  );
  for (const id of missing) {
    const where = (SIDEBAR_OBSERVED as readonly number[]).includes(id)
      ? "sidebar"
      : "config-only";
    console.error(`  ${id}  (${where})`);
  }
  process.exit(1);
}

console.log(
  `All ${ALL_GSLIVE_IDS.length} observed GSLive IDs are present in the SSOT.`,
);
