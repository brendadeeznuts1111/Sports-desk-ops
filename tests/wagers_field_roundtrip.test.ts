import { describe, expect, test } from "bun:test";
import {
  projectLiveWagerRow,
  type ProjectedDevWagerRow,
} from "@sportsdesk-ops/backend";
import { getVendorWagerTypeInfo } from "../lib/f402_core_vendor.ts";
import { parseShortDesc } from "../lib/live_wagers.ts";

/**
 * Consumer-obligation round trip: raw `getBetTicker` rows -> projection -> wire
 * fields unchanged.
 *
 * Corpus: `tests/fixtures/live-wagers-LIST-100.json` (100 rows, observed
 * `WagerType` values P/M/S/L/C/E and both `VIP` branches). The rows are frozen
 * before the projection runs, so any write to the wire record throws instead of
 * silently editing the input the classifier later reads.
 */

const FIXTURE = "tests/fixtures/live-wagers-LIST-100.json";

interface RawRow extends Record<string, unknown> {
  readonly WagerType?: unknown;
  readonly ShortDesc?: unknown;
  readonly VolumeAmount?: unknown;
  readonly VIP?: unknown;
  readonly AmountWagered?: unknown;
}

async function loadFixture(): Promise<RawRow[]> {
  const parsed = (await Bun.file(FIXTURE).json()) as
    RawRow[] | { LIST?: RawRow[] };
  const rows = Array.isArray(parsed) ? parsed : (parsed.LIST ?? []);
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function project(rows: readonly RawRow[]): ProjectedDevWagerRow[] {
  const deps = {
    parseShortDesc,
    sharpCustomerIds: new Set<string>(),
  };
  return rows.map((row, idx) => projectLiveWagerRow(row, idx, deps));
}

describe("getBetTicker wire-field round trip (consumer obligation)", () => {
  test("projection does not mutate the raw rows it reads", async () => {
    const rows = await loadFixture();
    const pristine = structuredClone(rows);
    deepFreeze(rows);

    expect(() => project(rows)).not.toThrow();
    expect(rows).toEqual(pristine);
  });

  test("WagerType survives verbatim while the label is a declared projection", async () => {
    const rows = await loadFixture();
    deepFreeze(rows);
    const projected = project(rows);

    for (let i = 0; i < rows.length; i += 1) {
      const raw = String(rows[i]?.WagerType ?? "").trim();
      const row = projected[i]!;
      // The wire code is preserved, not rewritten.
      expect(row.wagerTypeCode).toBe(raw.toUpperCase());
      // The label is derived from the pinned vendor switch.
      const vendorLabel = getVendorWagerTypeInfo({
        WagerType: raw,
      } as { WagerType: string });
      if (row.unknownWagerType) {
        expect(row.betType.startsWith("Unknown (")).toBe(true);
      } else {
        expect(row.betType).toBe(vendorLabel);
      }
    }
  });

  test("every observed WagerType is either labelled or surfaced as unknown", async () => {
    const rows = await loadFixture();
    deepFreeze(rows);
    const observed = new Set(
      rows.map((r) =>
        String(r.WagerType ?? "")
          .trim()
          .toUpperCase(),
      ),
    );
    // The fixture carries C and E, which the 2026-10-31 capture's observed
    // enumCandidates (L,M,P,S,T) does not. Neither may be silently bucketed.
    expect(observed.has("C")).toBe(true);
    expect(observed.has("E")).toBe(true);

    for (const code of observed) {
      const label = getVendorWagerTypeInfo({ WagerType: code });
      const row = project([{ ...rows[0], WagerType: code }])[0]!;
      expect(row.wagerTypeCode).toBe(code);
      expect(row.betType).toBe(label);
      expect(row.unknownWagerType).toBe(false);
    }
  });

  test("an unlabelled wire code surfaces instead of being bucketed", () => {
    const row = project([{ WagerType: "Z", ShortDesc: "" }])[0]!;
    expect(row.wagerTypeCode).toBe("Z");
    expect(row.unknownWagerType).toBe(true);
    expect(row.betType).toBe("Unknown (Z)");
  });

  test("VIP keeps both branches and treats the padded zero as not-VIP", () => {
    const [one, zero, padded] = project([
      { VIP: "1" },
      { VIP: "0" },
      { VIP: "0         " },
    ]);
    expect(one!.vip).toBe(true);
    expect(zero!.vip).toBe(false);
    // `nullable: false` is satisfied by a constant; liveness is a separate axis.
    expect(padded!.vip).toBe(false);
  });

  test("VolumeAmount reaches the row unchanged (no scaling, no reconciliation)", async () => {
    const rows = await loadFixture();
    deepFreeze(rows);
    const projected = project(rows);
    for (let i = 0; i < rows.length; i += 1) {
      expect(projected[i]!.volumeUsd).toBe(Number(rows[i]?.VolumeAmount));
    }
  });

  test("ShortDesc is handed to the parser verbatim and stays on the raw row", async () => {
    const rows = await loadFixture();
    const pristine = structuredClone(rows);
    deepFreeze(rows);

    const seen: unknown[] = [];
    const deps = {
      parseShortDesc: (raw: unknown) => {
        seen.push(raw);
        return parseShortDesc(raw);
      },
      sharpCustomerIds: new Set<string>(),
    };
    rows.forEach((row, idx) => projectLiveWagerRow(row, idx, deps));

    expect(seen).toHaveLength(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      expect(seen[i]).toBe(rows[i]?.ShortDesc);
    }
    expect(rows).toEqual(pristine);
  });
});
