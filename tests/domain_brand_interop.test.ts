import { describe, expect, test } from "bun:test";
import {
  asBitSet32,
  asBridgeChannelPackedWord32,
  asComboPackedKey15,
  asCustomerPackedHandle32,
  asCustomerPackedHandle64,
  asCustomerPackedKey64,
  asDurationMilliseconds,
  asEpochDays,
  asLifetimeCents,
  asLineHundredths,
  asSettledCents,
  asTransportBridgeBitMask32,
  assertCents as assertDesignCents,
  isCents as isDesignCents,
  isPaddedCustomerId,
  jsonText,
  padCustomerIdCanonical,
  parseAsCents as designCents,
  rotationNumber,
  sqlCol,
  sqlDomain,
  sqlIndex,
  sqlTable,
  type Cents as DesignCents,
  type JsonText,
  type PaddedCustomerId,
  type RotationNumber as DesignRotation,
  type SqlTableName,
} from "../design/domain-branded-types.ts";
import {
  sqlTable as brandSqlTable,
  type SqlTableName as BrandSqlTableName,
} from "../lib/brand.ts";
import {
  asCents as bridgeCents,
  type Cents as BridgeCents,
  type RotationNumber as BridgeRotation,
} from "../lib/bridge_and_channel_router.ts";
import {
  createPaddedCustomerId,
  parseAsCents as serviceCents,
  type Cents as ServiceCents,
} from "../services/simulate_bettor_churn_suite.ts";
import type { Cents as PassCents } from "../services/agent_onepass_plugin.ts";

/**
 * One brand engine, three modules.
 *
 * `design/domain-branded-types.ts` declared `const __brand = Symbol("brand")` and the two
 * services declared their own `declare const __brand: unique symbol`. Three nominal identities
 * for one concept: `Cents` from any one of them was not assignable to `Cents` from another, so
 * every cross-module call needed a cast — which is the thing the brand exists to prevent.
 *
 * The assignments below are the guard. They contain no casts, and `bun run typecheck` compiles
 * this file, so re-declaring `__brand` in any of the three modules fails the build rather than
 * failing silently at a call site months later.
 */

describe("brand engine is shared across modules", () => {
  test("a Cents branded in one module is a Cents in the others", () => {
    const fromDesign: DesignCents = designCents(1234);
    const asService: ServiceCents = fromDesign;
    const asPass: PassCents = asService;
    const backToDesign: DesignCents = asPass;

    // expect() is generic over the received value, so a branded value needs a plain comparator.
    expect(Number(backToDesign)).toBe(1234);
    // Runtime is a bare number, so the identity is compile-time only — but the guards from a
    // different module must still accept it.
    expect(isDesignCents(asService)).toBe(true);
    expect(isDesignCents(serviceCents(99))).toBe(true);
    assertDesignCents(asPass);
  });

  test("the bridge router shares the design brands", () => {
    const fromDesign: DesignCents = designCents(1234);
    const asBridge: BridgeCents = fromDesign;
    const back: DesignCents = asBridge;
    expect(Number(back)).toBe(1234);

    const rotation: DesignRotation = rotationNumber(100);
    const bridgeRotation: BridgeRotation = rotation;
    const backRotation: DesignRotation = bridgeRotation;
    expect(Number(backRotation)).toBe(100);

    expect(isDesignCents(bridgeCents(99))).toBe(true);
  });

  test("transport/binary constructors truncate and mask", () => {
    expect(Number(asSettledCents(12.9))).toBe(12);
    expect(Number(asLifetimeCents(-3.2))).toBe(-3);
    expect(Number(asLineHundredths(-4.2))).toBe(-4);
    expect(Number(asEpochDays(2.9))).toBe(2);
    expect(Number(asDurationMilliseconds(9.9))).toBe(9);
    expect(Number(asBitSet32(-1))).toBe(0xffffffff);
    expect(Number(asTransportBridgeBitMask32(-2))).toBe(0xfffffffe);
    expect(Number(asBridgeChannelPackedWord32(-1))).toBe(0xffffffff);
    expect(Number(asCustomerPackedHandle32(-1))).toBe(0xffffffff);
    expect(Number(asComboPackedKey15(0xffff))).toBe(0x7fff);
    expect(BigInt(asCustomerPackedHandle64(-1n))).toBe(0xffffffffffffffffn);
    expect(BigInt(asCustomerPackedKey64(0x1_0000_0000_0000_0001n))).toBe(1n);
  });

  test("schema and JSON brands re-export the shared engine", () => {
    const table: SqlTableName = sqlTable("match_evaluations");
    const same: BrandSqlTableName = table;
    expect(same).toBe(brandSqlTable("match_evaluations"));
    expect(String(sqlCol("run_id"))).toBe("run_id");
    expect(String(sqlIndex("idx_match_eval_run_at"))).toBe(
      "idx_match_eval_run_at",
    );
    expect(String(sqlDomain("candidate overlay audit"))).toBe(
      "candidate overlay audit",
    );
    const json: JsonText = jsonText('{"a":1}');
    expect(String(json)).toBe('{"a":1}');
    expect(() => jsonText("")).toThrow(/non-empty/);
  });

  test("the brand still rejects an unbranded primitive", () => {
    // @ts-expect-error a bare number is not Cents: the brand has not collapsed into `number`
    const notBranded: DesignCents = 5;
    expect(typeof notBranded).toBe("number");
  });
});

/**
 * Sharing one brand means sharing one invariant.
 *
 * `PaddedCustomerId` is now the same type in both modules, so the two constructors must agree
 * about what it means. They did not: `createPaddedCustomerId("")` returned eleven spaces and a
 * 12-character login came back as a 12-character "padded" id, both branded PaddedCustomerId and
 * both rejected by the domain's own isPaddedCustomerId guard. Before the brand unification those
 * values could not cross modules; after it, they could.
 */
describe("PaddedCustomerId constructors agree", () => {
  const accepted = ["A", "AB", "ABCDEFGHIJK", " ab ", "abcdefghijk"];
  const refused = ["", " ", "   ", "ABCDEFGHIJKL"];

  test("both accept and produce a value the domain guard accepts", () => {
    for (const raw of accepted) {
      const viaService = createPaddedCustomerId(raw);
      const viaDomain = padCustomerIdCanonical(raw);
      expect(viaService).toBe(viaDomain);
      expect(isPaddedCustomerId(viaService)).toBe(true);
      expect(viaService).toHaveLength(11);
    }
  });

  test("both refuse input that cannot become an 11-character id", () => {
    for (const raw of refused) {
      expect(() => createPaddedCustomerId(raw)).toThrow(RangeError);
      expect(() => padCustomerIdCanonical(raw)).toThrow(RangeError);
    }
  });

  test("a services-branded value satisfies the domain type", () => {
    const fromService: PaddedCustomerId = createPaddedCustomerId("rg2003");
    expect(String(fromService)).toBe("RG2003     ");
  });
});
