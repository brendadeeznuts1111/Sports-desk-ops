/**
 * @file fantasy402_hierarchy_cold_ingest.ts
 * @description Scaffold for the Fantasy402 hierarchy cold-ingest SoA store.
 *
 * The route slice in `services/downline_risk_route.ts` was written against a
 * module that is not in this checkout. This implementation supplies the exact
 * surface it imports, reusing the frozen DOD6 login-key packing so a 64-bit
 * lookup key is encoded into caller-owned two-word scratch without BigInt.
 *
 * Layout choices are local and documented here; replace this file with the
 * canonical cold-ingest module when it lands.
 *
 * `packedNodeWord32`: bits 0..14 row ordinal, bits 15..17 structure kind.
 *
 * FROZEN PUBLIC CONTRACT for the route (do not remove without updating the
 * handler import list): AgentRowIdx15, Fantasy402HierarchyColumnStore,
 * MAX_DOWNLINE_MATCHES_15, NODE_STRUCT_FLAGS_SHIFT, NODE_STRUCT_FLAGS_MASK,
 * STRUCT_NODE_CUSTOMER, SUBACCT_ORD_WILDCARD,
 * canonicalizeAndEncodeLoginIntoRow, findStandbyRowByLoginKeyBinarySearch.
 *
 * SCAFFOLD ASSUMPTIONS (all must be checked against canonical):
 *   - NODE_STRUCT_FLAGS_SHIFT=15, MASK=0x7, customer=0/agent=1/other=2
 *   - packed low 15 bits are the row ordinal
 *   - MAX_DOWNLINE_MATCHES_15=0x7fff and SUBACCT_ORD_WILDCARD=0xffff
 *   - canonical login is trimmed/uppercased; `agentCount` includes all rows
 *   - strict mode rejects logins longer than 12 characters
 *   - only A-Za-z0-9_.- is accepted; unknown/base-40-fallback characters are rejected
 *   - duplicate canonical keys fail build and lookup, never resolve arbitrarily
 */

import type { Brand } from "./brand.ts";
import {
  encodeCustomerPackedKeyPartsIntoRange,
  loginBoundsInto,
} from "./dod6_v54_login_key.ts";

export type AgentRowIdx15 = Brand<number, "AgentRowIdx15">;

/** 15-bit row ordinal ceiling for the downline match buffer. */
export const MAX_DOWNLINE_MATCHES_15 = 0x7fff;

export const NODE_STRUCT_FLAGS_SHIFT = 15;
export const NODE_STRUCT_FLAGS_MASK = 0x7;
export const STRUCT_NODE_CUSTOMER = 0;
export const STRUCT_NODE_AGENT = 1;
export const STRUCT_NODE_OTHER = 2;

/** `0xffff` — no sub-account ordinal filter. */
export const SUBACCT_ORD_WILDCARD = 0xffff;

export interface Fantasy402HierarchyColumnStore {
  readonly nodeCount: number;
  readonly agentCount: number;
  /** `[lo, hi]` little-endian login-key words per row. */
  readonly loginKeyWords32Col: Uint32Array;
  /** Packed row ordinal + structure flags per row. */
  readonly packedNodeWord32Col: Uint32Array;
}

export type HierarchyNodeKind = "customer" | "agent" | "other";

function structKindFor(kind: HierarchyNodeKind): number {
  if (kind === "customer") return STRUCT_NODE_CUSTOMER;
  if (kind === "agent") return STRUCT_NODE_AGENT;
  return STRUCT_NODE_OTHER;
}

/** Base-40 digit matching `dod6_v54_login_key.ts` (kept local: diagnostic limbs only). */
function base40Digit(code: number): number {
  if (code >= 48 && code <= 57) return code - 48 + 1;
  if (code >= 65 && code <= 90) return code - 65 + 11;
  if (code >= 97 && code <= 122) return code - 97 + 11;
  if (code === 95) return 37;
  if (code === 45) return 38;
  if (code === 46) return 39;
  return 39;
}

/**
 * Canonicalize one login and encode its 64-bit key into the caller's scratch.
 *
 * `keyWords32` receives `[lo, hi]`; `asciiU8`/`lenU8` receive the canonical
 * uppercase login; `limbU16` receives the first eight base-40 digits. The
 * function allocates nothing: it trims through `loginBoundsInto`, validates and
 * uppercases by code unit, and encodes straight from the source range. Throws
 * `TypeError` for an empty, oversized, unknown-character or replacement-bearing
 * login. `rowIdx` is accepted for call-site parity and is not used here.
 */
const LOGIN_BOUNDS = new Int32Array(2);

/** Base-40 alphabet plus the two hierarchy separators; anything else is rejected. */
function isAllowedLoginCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 || // _
    code === 45 || // -
    code === 46 // .
  );
}

export function canonicalizeAndEncodeLoginIntoRow(
  rawLogin: string,
  strict: boolean,
  _rowIdx: number,
  keyWords32: Uint32Array,
  asciiU8: Uint8Array,
  lenU8: Uint8Array,
  limbU16: Uint16Array,
): void {
  if (
    keyWords32.length < 2 ||
    asciiU8.length < 64 ||
    lenU8.length < 1 ||
    limbU16.length < 8
  ) {
    throw new TypeError("ERR_COLD_INGEST_SCRATCH_TOO_SMALL");
  }

  loginBoundsInto(rawLogin, LOGIN_BOUNDS);
  const start = LOGIN_BOUNDS[0]!;
  const end = LOGIN_BOUNDS[1]!;
  const length = end - start;
  if (length <= 0) throw new TypeError("ERR_INVALID_AGENT_LOGIN");
  if (length > 64 || (strict && length > 12)) {
    throw new TypeError("ERR_AGENT_LOGIN_TOO_LONG");
  }

  asciiU8.fill(0);
  limbU16.fill(0);
  for (let index = start; index < end; index += 1) {
    const code = rawLogin.charCodeAt(index);
    if (!isAllowedLoginCode(code)) {
      throw new TypeError("ERR_INVALID_AGENT_LOGIN");
    }
    const offset = index - start;
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    asciiU8[offset] = upper;
    if (offset < 8) limbU16[offset] = base40Digit(upper);
  }
  lenU8[0] = length;

  encodeCustomerPackedKeyPartsIntoRange(rawLogin, keyWords32, start, end);
}

/** Binary search the sorted row order for a `[lo, hi]` login key; -1 when absent. */
export function findStandbyRowByLoginKeyBinarySearch(
  loginKeyWords32Col: Uint32Array,
  sortedRowOrderU16: Uint16Array,
  nodeCount: number,
  keyLo: number,
  keyHi: number,
): number {
  const limit = Math.min(nodeCount, sortedRowOrderU16.length);
  let low = 0;
  let high = limit - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const row = sortedRowOrderU16[mid]!;
    const rowLo = loginKeyWords32Col[row * 2] ?? 0;
    const rowHi = loginKeyWords32Col[row * 2 + 1] ?? 0;
    if (rowHi < keyHi || (rowHi === keyHi && rowLo < keyLo)) {
      low = mid + 1;
    } else if (rowHi > keyHi || (rowHi === keyHi && rowLo > keyLo)) {
      high = mid - 1;
    } else {
      // A duplicate key makes the root ambiguous; fail closed rather than
      // returning whichever row the sort happened to place at `mid`.
      const previous = mid > 0 ? sortedRowOrderU16[mid - 1]! : -1;
      if (
        previous >= 0 &&
        (loginKeyWords32Col[previous * 2] ?? 0) === rowLo &&
        (loginKeyWords32Col[previous * 2 + 1] ?? 0) === rowHi
      ) {
        return -1;
      }
      const next = mid + 1 < limit ? sortedRowOrderU16[mid + 1]! : -1;
      if (
        next >= 0 &&
        (loginKeyWords32Col[next * 2] ?? 0) === rowLo &&
        (loginKeyWords32Col[next * 2 + 1] ?? 0) === rowHi
      ) {
        return -1;
      }
      return row;
    }
  }
  return -1;
}

export interface HierarchyNodeSpec {
  readonly login: string;
  readonly kind: HierarchyNodeKind;
}

export interface BuiltHierarchyColumnStore {
  readonly store: Fantasy402HierarchyColumnStore;
  readonly sortedRowOrderU16: Uint16Array;
}

/**
 * Build the SoA store from hierarchy nodes for tests/backfills: packs each row's
 * key, leaves the low 15 bits as the row ordinal and sets the 3-bit structure
 * flag above it, then sorts the row order by the 64-bit key.
 */
export function buildHierarchyColumnStore(
  nodes: readonly HierarchyNodeSpec[],
): BuiltHierarchyColumnStore {
  if (nodes.length > MAX_DOWNLINE_MATCHES_15 + 1) {
    throw new RangeError("ERR_HIERARCHY_STORE_CAPACITY");
  }
  const keyWords = new Uint32Array(nodes.length * 2);
  const packed = new Uint32Array(nodes.length);
  const scratchKey = new Uint32Array(2);
  const scratchAscii = new Uint8Array(64);
  const scratchLen = new Uint8Array(1);
  const scratchLimbs = new Uint16Array(8);

  for (let row = 0; row < nodes.length; row += 1) {
    const node = nodes[row]!;
    canonicalizeAndEncodeLoginIntoRow(
      node.login,
      false,
      row,
      scratchKey,
      scratchAscii,
      scratchLen,
      scratchLimbs,
    );
    keyWords[row * 2] = scratchKey[0]!;
    keyWords[row * 2 + 1] = scratchKey[1]!;
    packed[row] =
      (structKindFor(node.kind) << NODE_STRUCT_FLAGS_SHIFT) | (row & 0x7fff);
  }

  const order = new Uint16Array(nodes.length);
  for (let row = 0; row < nodes.length; row += 1) order[row] = row;
  const orderArray = Array.from(order).sort((a, b) => {
    const aHi = keyWords[a * 2 + 1] ?? 0;
    const bHi = keyWords[b * 2 + 1] ?? 0;
    if (aHi !== bHi) return aHi - bHi;
    return (keyWords[a * 2] ?? 0) - (keyWords[b * 2] ?? 0);
  });
  order.set(orderArray);

  for (let index = 1; index < order.length; index += 1) {
    const previous = order[index - 1]!;
    const current = order[index]!;
    if (
      keyWords[previous * 2] === keyWords[current * 2] &&
      keyWords[previous * 2 + 1] === keyWords[current * 2 + 1]
    ) {
      throw new TypeError("ERR_DUPLICATE_LOGIN_KEY");
    }
  }

  return {
    store: {
      nodeCount: nodes.length,
      agentCount: nodes.length,
      loginKeyWords32Col: keyWords,
      packedNodeWord32Col: packed,
    },
    sortedRowOrderU16: order,
  };
}
