/**
 * @file tests/rsk06_telemetry_matrix.test.ts
 * @artifact ART-TEST-RSK06-TELEMETRY-MATRIX
 * @description Comprehensive invariant, purity, and property test suite for RSK-06 Telemetry Matrix (v2.3.0).
 */

import { describe, expect, it } from "bun:test";
import {
  CANONICAL_22_REGISTER_DEFS,
  CANONICAL_22_REGISTER_STATES,
  CANONICAL_SWEEP_CONTEXT,
  CATEGORY_COMPAT_SUNSET_DATE,
  RSK06_MATRIX_SCHEMA_VERSION,
  deriveCategoryCompat,
  deriveLag,
  deriveRole,
  deriveValidity,
  validateRegisterDefinition,
  validateRegisterState,
} from "../schema/rsk06_telemetry_matrix.ts";

describe("RSK-06 Telemetry Matrix Schema Contract (v2.3.0)", () => {
  it("enforces schema version pin 2.3.0 and CategoryCompat sunset date 2026-12-01", () => {
    expect(RSK06_MATRIX_SCHEMA_VERSION).toBe("2.3.0");
    expect(CATEGORY_COMPAT_SUNSET_DATE).toBe("2026-12-01");
  });

  it("verifies referential integrity: register_def and register_state share exactly the same 22 keys", () => {
    expect(CANONICAL_22_REGISTER_DEFS).toHaveLength(22);
    expect(CANONICAL_22_REGISTER_STATES).toHaveLength(22);
    for (let index = 0; index < 22; index++) {
      expect(CANONICAL_22_REGISTER_DEFS[index]!.register).toBe(
        CANONICAL_22_REGISTER_STATES[index]!.register,
      );
      expect(CANONICAL_22_REGISTER_DEFS[index]!.rowNumber).toBe(
        CANONICAL_22_REGISTER_STATES[index]!.rowNumber,
      );
    }
  });

  it("verifies all 22 static definitions satisfy legal triples with zero errors", () => {
    for (const def of CANONICAL_22_REGISTER_DEFS) {
      const result = validateRegisterDefinition(def);
      if (!result.valid) {
        console.error(
          `Row ${def.rowNumber} (${def.register}) definition failed:`,
          result.errors,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("verifies all 22 runtime states satisfy gate scoping, bound rules, and extended notes linting", () => {
    for (let index = 0; index < 22; index++) {
      const def = CANONICAL_22_REGISTER_DEFS[index]!;
      const state = CANONICAL_22_REGISTER_STATES[index]!;
      const result = validateRegisterState(def, state);
      if (!result.valid) {
        console.error(
          `Row ${state.rowNumber} (${state.register}) state failed:`,
          result.errors,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("proves deriveRole reproduces 100% of defined roles across all 22 rows", () => {
    for (const def of CANONICAL_22_REGISTER_DEFS) {
      const derived = deriveRole(def.layer, def.resourceType);
      expect(derived).toBe(def.role);
    }
  });

  it("proves deriveCategoryCompat reproduces legacy Category view on all 22 rows", () => {
    for (const def of CANONICAL_22_REGISTER_DEFS) {
      const compat = deriveCategoryCompat(
        def.layer,
        def.resourceType,
        def.register,
      );
      expect(compat).toBe(def.categoryCompat);
    }
  });

  it("proves deriveLag and deriveValidity purity: dynamically responds to SweepContext without hardcoded constants", () => {
    const row4Def = CANONICAL_22_REGISTER_DEFS.find(
      (d) => d.register === "spineEpochWatermark",
    )!;
    const row4State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.register === "spineEpochWatermark",
    )!;

    // Baseline: evalEpoch = 20765 > 20763 => lag = 2, STALE
    expect(
      deriveLag(
        row4Def,
        row4State,
        CANONICAL_SWEEP_CONTEXT,
        CANONICAL_22_REGISTER_STATES,
      ),
    ).toBe(2);
    expect(
      deriveValidity(
        row4Def,
        row4State,
        CANONICAL_SWEEP_CONTEXT,
        CANONICAL_22_REGISTER_STATES,
      ),
    ).toBe("STALE");

    // Pure dynamic response: if evalEpoch is bumped to 20763, lag becomes 0 and validity immediately flips to FRESH
    const freshContext = { ...CANONICAL_SWEEP_CONTEXT, evalEpoch: 20763 };
    expect(
      deriveLag(row4Def, row4State, freshContext, CANONICAL_22_REGISTER_STATES),
    ).toBe(0);
    expect(
      deriveValidity(
        row4Def,
        row4State,
        freshContext,
        CANONICAL_22_REGISTER_STATES,
      ),
    ).toBe("FRESH");

    // Row 13 lag calculation: row14.ID (319775995) - row13.ID (318706282) = 1,069,713
    const row13Def = CANONICAL_22_REGISTER_DEFS.find(
      (d) => d.register === "ep09RemoteR2Watermark",
    )!;
    const row13State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.register === "ep09RemoteR2Watermark",
    )!;
    expect(
      deriveLag(
        row13Def,
        row13State,
        CANONICAL_SWEEP_CONTEXT,
        CANONICAL_22_REGISTER_STATES,
      ),
    ).toBe(1069713);
    expect(
      deriveValidity(
        row13Def,
        row13State,
        CANONICAL_SWEEP_CONTEXT,
        CANONICAL_22_REGISTER_STATES,
      ),
    ).toBe("STALE");
  });

  it("enforces D1 one-rule Bound: Bound is populated iff Bound_Type != NOT_APPLICABLE and != EXACT", () => {
    for (const state of CANONICAL_22_REGISTER_STATES) {
      if (state.register === "ep04PendingLegCount") {
        expect(state.boundLimit).toBe(1040);
        expect(state.boundType).toBe("LOWER_BOUND");
      } else {
        expect(state.boundLimit).toBeNull();
        expect(state.boundType).toBe("NOT_APPLICABLE");
      }
    }
  });

  it("enforces D2 role-gating on Measurement_Confidence: populated iff Role == OBSERVATION", () => {
    for (let index = 0; index < 22; index++) {
      const def = CANONICAL_22_REGISTER_DEFS[index]!;
      const state = CANONICAL_22_REGISTER_STATES[index]!;
      if (def.role === "OBSERVATION") {
        expect(state.measurementConfidence).toBe("EXACT");
      } else {
        expect(state.measurementConfidence).toBe("NOT_APPLICABLE");
      }
    }
  });

  it("enforces D3 Monotonicity completeness across all CURSOR and EPOCH registers", () => {
    for (const def of CANONICAL_22_REGISTER_DEFS) {
      if (def.resourceType === "EPOCH" || def.resourceType === "CURSOR") {
        expect(def.monotonicity).not.toBe("NOT_APPLICABLE");
      }
    }

    const row1Def = CANONICAL_22_REGISTER_DEFS.find((d) => d.rowNumber === 1)!;
    const row4Def = CANONICAL_22_REGISTER_DEFS.find((d) => d.rowNumber === 4)!;
    const row10Def = CANONICAL_22_REGISTER_DEFS.find(
      (d) => d.rowNumber === 10,
    )!;
    const row13Def = CANONICAL_22_REGISTER_DEFS.find(
      (d) => d.rowNumber === 13,
    )!;
    const row14Def = CANONICAL_22_REGISTER_DEFS.find(
      (d) => d.rowNumber === 14,
    )!;

    expect(row1Def.monotonicity).toBe("BOUNDARY");
    expect(row4Def.monotonicity).toBe("CUMULATIVE");
    expect(row10Def.monotonicity).toBe("CUMULATIVE");
    expect(row13Def.monotonicity).toBe("CUMULATIVE");
    expect(row14Def.monotonicity).toBe("HEAD");
  });

  it("enforces D4 Divergence/Divergence_Unit and Lag/Lag_Unit pairing", () => {
    const row7State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.rowNumber === 7,
    )!;
    expect(row7State.divergenceCount).toBe(10);
    expect(row7State.divergenceUnit).toBe("COMMITS");

    const row4State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.rowNumber === 4,
    )!;
    expect(row4State.lagAmount).toBe(2);
    expect(row4State.lagUnit).toBe("EPOCH");

    const row13State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.rowNumber === 13,
    )!;
    expect(row13State.lagAmount).toBe(1069713);
    expect(row13State.lagUnit).toBe("ID");
  });

  it("enforces Mode = READ on SPINE_HEADER rows 4, 5, 6", () => {
    for (const rowNum of [4, 5, 6]) {
      const def = CANONICAL_22_REGISTER_DEFS.find(
        (d) => d.rowNumber === rowNum,
      )!;
      expect(def.mode).toBe("READ");
    }
  });

  it("enforces column-name distinctness (no column name is a strict prefix of another)", () => {
    const stateKeys = Object.keys(CANONICAL_22_REGISTER_STATES[0]!);
    for (let indexI = 0; indexI < stateKeys.length; indexI++) {
      for (let indexJ = 0; indexJ < stateKeys.length; indexJ++) {
        if (indexI === indexJ) continue;
        const keyI = stateKeys[indexI]!;
        const keyJ = stateKeys[indexJ]!;
        expect(keyJ.startsWith(keyI)).toBe(false);
      }
    }
  });

  it("verifies stream ordering and quiescence: Row 14.ID >= Row 1.ID and equality confirms quiescent state", () => {
    const row1State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.rowNumber === 1,
    )!;
    const row14State = CANONICAL_22_REGISTER_STATES.find(
      (s) => s.rowNumber === 14,
    )!;
    const id1 = Number(row1State.resourceIdentifier.replace("M.G", ""));
    const id14 = Number(row14State.resourceIdentifier.replace("M.G", ""));
    expect(id14).toBeGreaterThanOrEqual(id1);
    expect(id14 === id1).toBe(true);
  });
});
