import { expectTypeOf, test } from "bun:test";
import type {
  AssertAtMostOnePk,
  AssertExactlyOnePk,
  AssertIndexColsExist,
  AssertShaPairs,
  TableInvariants,
} from "../lib/invariants.ts";

type Good = {
  id: { readonly kind: "integer_pk" };
  name: { readonly kind: "text" };
};
type NoPk = { name: { readonly kind: "text" } };
type TwoPk = {
  a: { readonly kind: "integer_pk" };
  b: { readonly kind: "integer_pk" };
};

test("exactly one integer_pk is accepted", () => {
  expectTypeOf<AssertExactlyOnePk<Good>>().toEqualTypeOf<unknown>();
});

test("zero integer_pk returns the got:0 error", () => {
  expectTypeOf<AssertExactlyOnePk<NoPk>>().toEqualTypeOf<{
    readonly __error: "table must have exactly one integer_pk column";
    got: 0;
  }>();
});

test("two integer_pk columns return the cols error", () => {
  expectTypeOf<AssertExactlyOnePk<TwoPk>>().toEqualTypeOf<{
    readonly __error: "table must have exactly one integer_pk column";
    readonly cols: "a" | "b";
  }>();
});

test("at most one pk allows zero", () => {
  expectTypeOf<AssertAtMostOnePk<NoPk>>().toEqualTypeOf<unknown>();
});

test("at most one pk rejects two", () => {
  expectTypeOf<AssertAtMostOnePk<TwoPk>>().toEqualTypeOf<{
    readonly __error: "at most one integer_pk column";
    readonly cols: "a" | "b";
  }>();
});

test("index columns must exist", () => {
  expectTypeOf<AssertIndexColsExist<Good, ["id"]>>().toEqualTypeOf<unknown>();
  expectTypeOf<AssertIndexColsExist<Good, ["nope"]>>().toEqualTypeOf<{
    readonly __error: "index references unknown column";
    readonly column: "nope";
  }>();
});

test("sha siblings must sit on a text_json column", () => {
  type ShaGood = {
    payload: { readonly kind: "text_json" };
    payload_sha256: { readonly kind: "text" };
  };
  type ShaBad = {
    payload: { readonly kind: "text" };
    payload_sha256: { readonly kind: "text" };
  };
  expectTypeOf<AssertShaPairs<ShaGood>>().toEqualTypeOf<unknown>();
  expectTypeOf<AssertShaPairs<ShaBad>>().toEqualTypeOf<{
    readonly __error: "json sibling has wrong kind";
    readonly column: "payload";
  }>();
});

test("TableInvariants combines the checks", () => {
  expectTypeOf<
    TableInvariants<Good, { idx: { columns: ["name"] } }>
  >().toEqualTypeOf<unknown>();
  expectTypeOf<TableInvariants<TwoPk, {}>>().toMatchTypeOf<{
    readonly __error: "table must have exactly one integer_pk column";
  }>();
});
