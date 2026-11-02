/**
 * Parse Manager `getConfigWebReportsCustomerAdmin` responses (`{ INFO: { … } }`).
 * Values are mostly column visibility flags (`"on "` / `"off       "`) for the
 * customer-admin web reports grid—not credential fields.
 */

import {
  normalizeOnOffFlag,
  trimFlag as trimConfigFlag,
} from "./f402_flag_values.ts";

export interface ConfigWebReportsCustomerAdminInfo {
  readonly showSportsbookStatus?: string;
  readonly showCasinoStatus?: string;
  readonly showHorsesStatus?: string;
  readonly showSettleFigure?: string;
  readonly showTemporaryCredit?: string | null;
  readonly showCreditLimit?: string;
  readonly showWagerLimit?: string;
  readonly Available?: string;
  readonly Name?: string;
  readonly Pending?: string;
  readonly Balance?: string;
  readonly Password?: string;
  readonly Enabled?: string;
  readonly ReadOnly?: string;
  readonly FreePlay?: string;
  readonly ParlayMaxBet?: string;
  readonly ParlayMaxPayout?: string;
  readonly TeaserMaxBet?: string;
  readonly ContestMaxBet?: string;
  readonly MaxContestPrice?: string;
  readonly MaxPropPayout?: string;
  readonly MaxSoccerBet?: string;
  readonly MaxMoneyLine?: string;
  readonly sortCustom?: string;
  readonly ShowEmail?: string;
  readonly ShowPhone?: string;
  readonly PlayerNotes?: string;
  readonly [key: string]: unknown;
}

export interface ConfigWebReportsCustomerAdminEnvelope {
  readonly INFO: ConfigWebReportsCustomerAdminInfo;
}

/**
 * The trim rule lives in `f402_flag_values.ts` now — the bet-ticker config needed the same one.
 * These re-exports keep this module's public surface unchanged.
 */
export {
  normalizeOnOffFlag,
  trimFlag as trimConfigFlag,
} from "./f402_flag_values.ts";

export function parseConfigWebReportsCustomerAdminEnvelope(
  raw: unknown,
): ConfigWebReportsCustomerAdminEnvelope {
  if (typeof raw !== "object" || raw === null)
    throw new Error(
      "getConfigWebReportsCustomerAdmin envelope must be an object",
    );
  const info = (raw as { INFO?: unknown }).INFO;
  if (typeof info !== "object" || info === null)
    throw new Error("INFO must be an object");
  return { INFO: info as ConfigWebReportsCustomerAdminInfo };
}

export interface ConfigWebReportsCustomerAdminSummary {
  readonly columnFlagsOn: string[];
  readonly columnFlagsOff: string[];
  readonly showSectionOn: string[];
  readonly sortCustom: string | null;
}

const SHOW_PREFIX = "show";

export function summarizeConfigWebReportsCustomerAdmin(
  envelope: ConfigWebReportsCustomerAdminEnvelope,
): ConfigWebReportsCustomerAdminSummary {
  const info = envelope.INFO;
  const columnFlagsOn: string[] = [];
  const columnFlagsOff: string[] = [];
  const showSectionOn: string[] = [];

  for (const [key, val] of Object.entries(info)) {
    if (key === "sortCustom") continue;
    if (typeof val !== "string" && val !== null) continue;
    const norm = normalizeOnOffFlag(typeof val === "string" ? val : null);
    if (key.startsWith(SHOW_PREFIX)) {
      if (norm === "on") showSectionOn.push(key);
      continue;
    }
    if (norm === "on") columnFlagsOn.push(key);
    else if (norm === "off") columnFlagsOff.push(key);
  }

  columnFlagsOn.sort();
  columnFlagsOff.sort();
  showSectionOn.sort();

  const sortRaw = info.sortCustom;
  return {
    columnFlagsOn,
    columnFlagsOff,
    showSectionOn,
    sortCustom:
      sortRaw === undefined || sortRaw === null
        ? null
        : trimConfigFlag(String(sortRaw)),
  };
}
