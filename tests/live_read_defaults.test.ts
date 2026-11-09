/**
 * The live-read defaults documented in `.env.example` and the live-desk runbook must equal the
 * constants the daemon actually resolves (`lib/live_read_defaults.ts`). The docs cannot import
 * TypeScript at runtime, so this test derives the comparison instead of trusting two prose copies.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
  LIVE_PENDING_DEFAULT_TIMEOUT_MS,
  LIVE_PENDING_DEFAULT_TTL_MS,
  LIVE_PENDING_MAX_MAX_CUSTOMERS,
  LIVE_PENDING_MAX_TIMEOUT_MS,
  LIVE_PENDING_MAX_TTL_MS,
  LIVE_PERSIST_DEFAULT_THROTTLE_MS,
  LIVE_REFRESH_DEFAULT_MS,
  LIVE_TICKER_DEFAULT_TIMEOUT_MS,
  LIVE_TICKER_DEFAULT_TTL_MS,
  LIVE_TICKER_MAX_TIMEOUT_MS,
  LIVE_TICKER_MAX_TTL_MS,
} from "../lib/live_read_defaults.ts";

const ROOT = join(import.meta.dir, "..");

/** env name → the documented default and the documented clamp range where one is rendered. */
const DOCUMENTED = {
  SPORTSDESK_LIVE_TICKER: null,
  SPORTSDESK_LIVE_TICKER_TTL_MS: {
    value: LIVE_TICKER_DEFAULT_TTL_MS,
    clamp: [0, LIVE_TICKER_MAX_TTL_MS] as const,
  },
  SPORTSDESK_LIVE_TICKER_TIMEOUT_MS: {
    value: LIVE_TICKER_DEFAULT_TIMEOUT_MS,
    clamp: [250, LIVE_TICKER_MAX_TIMEOUT_MS] as const,
  },
  SPORTSDESK_LIVE_PENDING: null,
  SPORTSDESK_LIVE_PENDING_CUSTOMERS: null,
  SPORTSDESK_LIVE_PENDING_MAX_CUSTOMERS: {
    value: LIVE_PENDING_DEFAULT_MAX_CUSTOMERS,
    clamp: [1, LIVE_PENDING_MAX_MAX_CUSTOMERS] as const,
  },
  SPORTSDESK_LIVE_PENDING_TTL_MS: {
    value: LIVE_PENDING_DEFAULT_TTL_MS,
    clamp: [0, LIVE_PENDING_MAX_TTL_MS] as const,
  },
  SPORTSDESK_LIVE_PENDING_TIMEOUT_MS: {
    value: LIVE_PENDING_DEFAULT_TIMEOUT_MS,
    clamp: [250, LIVE_PENDING_MAX_TIMEOUT_MS] as const,
  },
  SPORTSDESK_LIVE_PERSIST: null,
  // The throttle and refresh rows do not render a clamp range; only the value is documented.
  SPORTSDESK_LIVE_PERSIST_MS: {
    value: LIVE_PERSIST_DEFAULT_THROTTLE_MS,
    clamp: null,
  },
  SPORTSDESK_LIVE_PERSIST_ROOT: null,
  SPORTSDESK_LIVE_REFRESH_MS: {
    value: LIVE_REFRESH_DEFAULT_MS,
    clamp: null,
  },
} as const;

function envExampleDefaults(): Map<string, number> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  const defaults = new Map<string, number>();
  // Commented defaults only: "# SPORTSDESK_FOO=123" documents a numeric default; a bare
  // assignment is an operator override. Toggles without a number are checked separately.
  for (const match of text.matchAll(
    /^#\s*(SPORTSDESK_[A-Z0-9_]+)=([0-9]+)\s*$/gm,
  )) {
    defaults.set(match[1] as string, Number(match[2]));
  }
  return defaults;
}

function runbookDefaults(): {
  defaults: Map<string, number>;
  clamps: Map<string, readonly [number, number]>;
} {
  const text = readFileSync(
    join(ROOT, "docs/runbooks/live_desk_reads_runbook.md"),
    "utf8",
  );
  const defaults = new Map<string, number>();
  const clamps = new Map<string, readonly [number, number]>();
  for (const line of text.split("\n")) {
    const row =
      /^\|\s*`(SPORTSDESK_[A-Z0-9_]+)`\s*\|\s*`([0-9]+)`\s*\|(.*)\|/.exec(line);
    if (row === null) continue;
    defaults.set(row[1] as string, Number(row[2]));
    const clamp = /\(([0-9]+)–([0-9]+)\)/.exec(row[3] ?? "");
    if (clamp !== null) {
      clamps.set(row[1] as string, [Number(clamp[1]), Number(clamp[2])]);
    }
  }
  return { defaults, clamps };
}

describe("live-read defaults are derived from the daemon constants", () => {
  const envDefaults = envExampleDefaults();
  const runbook = runbookDefaults();

  test("every numeric default is documented with the constant's value", () => {
    for (const [name, documented] of Object.entries(DOCUMENTED)) {
      if (documented === null) continue;
      expect({ name, env: envDefaults.get(name) }).toEqual({
        name,
        env: documented.value,
      });
      expect({ name, runbook: runbook.defaults.get(name) }).toEqual({
        name,
        runbook: documented.value,
      });
    }
  });

  test("every documented clamp matches the constants the daemon enforces", () => {
    for (const [name, documented] of Object.entries(DOCUMENTED)) {
      if (documented === null || documented.clamp === null) continue;
      expect({ name, clamp: runbook.clamps.get(name) }).toEqual({
        name,
        clamp: documented.clamp,
      });
    }
  });

  test("the toggles are documented as commented defaults, not silent", () => {
    const text = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const name of ["SPORTSDESK_LIVE_TICKER", "SPORTSDESK_LIVE_PENDING"]) {
      expect(text).toContain(`# ${name}=1`);
    }
    expect(text).toContain("# SPORTSDESK_LIVE_PERSIST=1");
  });
});
