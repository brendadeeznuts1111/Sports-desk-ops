/**
 * DOD6 v5.4 customer login packing + 16-bit radix probing (frozen spec; matches turbo-cap spine).
 *
 * The 64-bit key layout is fixed by the on-disk `02_LIFETIME_SOA` column:
 *   bits 62-63 = mode (1 = base40 exact, 2 = fnv1a64 for long ids)
 *   bits 0-61  = payload (base40 digits or the FNV-1a hash), little-endian on disk.
 *
 * Hot-path contract: `encodeCustomerPackedKeyPartsInto` and `fillLoginRadixSlots16` write into
 * caller-owned scratch and allocate nothing, so a per-login spine lookup creates no BigInt, no
 * array and no tuple. The BigInt wrapper (`encodeCustomerPackedKey64`) and the tuple wrapper
 * (`computeLoginRadixSlots16`) remain for ordinary callers and are value-identical to the
 * allocation-free path (see tests/dod6_binary_spine.test.ts).
 */

export type CustomerPackedKey64 = bigint;

/** Little-endian 32-bit halves of a packed key: value = hi * 2^32 + lo. */
export interface PackedKeyParts {
  readonly hi: number;
  readonly lo: number;
}

export const KEY64_MODE_SHIFT = 62n;
export const KEY64_PAYLOAD_MASK = (1n << 62n) - 1n;
export const KEY64_MODE_BASE40_EXACT_12 = 1n;
export const KEY64_MODE_FNV1A64_LONG = 2n;

/** `0x3fff_ffff` — the 30 high bits of the 62-bit payload. */
const PAYLOAD_HI_MASK = 0x3fffffff;
/** 2^32 as a float; used only to split an exactly-representable double. */
const TWO32 = 4294967296;

export interface LoginBounds {
  readonly start: number;
  readonly end: number;
}

/**
 * Trim + suffix-normalize bounds shared by the key and radix encoders.
 *
 * The rules are frozen by the spine spec: strip leading/trailing control-or-space characters,
 * strip trailing dots (except the final character), then strip a `_N` suffix that follows a
 * digit (`AB12_3` -> `AB12`).
 */
export function loginBounds(rawCustomerId: string): LoginBounds {
  const out = new Int32Array(2);
  loginBoundsInto(rawCustomerId, out);
  return { start: out[0]!, end: out[1]! };
}

/**
 * Allocation-free bounds writer for the hot path. `out` must have length >= 2 and receives
 * `[start, end]` after the frozen trim/suffix rules above.
 */
export function loginBoundsInto(rawCustomerId: string, out: Int32Array): void {
  let start = 0;
  let end = rawCustomerId.length;
  while (start < end && rawCustomerId.charCodeAt(start) <= 32) start++;
  while (end > start && rawCustomerId.charCodeAt(end - 1) <= 32) end--;
  while (end > start + 1 && rawCustomerId.charCodeAt(end - 1) === 46) end--;
  if (
    end - start > 3 &&
    rawCustomerId.charCodeAt(end - 3) >= 48 &&
    rawCustomerId.charCodeAt(end - 3) <= 57 &&
    rawCustomerId.charCodeAt(end - 2) === 95 &&
    rawCustomerId.charCodeAt(end - 1) >= 48 &&
    rawCustomerId.charCodeAt(end - 1) <= 57
  ) {
    end -= 2;
  }
  out[0] = start;
  out[1] = end;
}

/** Base-40 digit for a character code (digits 1..10, A-Z and a-z 11..36, `_` 37, `-` 38, `.` 39, else 39). */
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
 * Encode the packed key into caller-owned scratch `out` as `[lo, hi]` unsigned 32-bit halves.
 * Allocates nothing. `out` must have length >= 2; the reader reuses one instance per reader.
 *
 * The 62-bit base-40 payload is accumulated modulo 2^62, which is exactly what the frozen
 * BigInt encoder did with its final `payload & KEY64_PAYLOAD_MASK`; truncating each step is
 * safe because discarded bits can only carry into bits >= 62. FNV-1a uses the identity
 * `prime = 0x100000001b3 = 2^40 + 0x1b3`, so the 64-bit multiply needs no BigInt.
 *
 * @param rawCustomerId raw desk login
 * @param out `[lo, hi]` scratch, length >= 2
 */
export function encodeCustomerPackedKeyPartsInto(
  rawCustomerId: string,
  out: Uint32Array,
): void {
  const { start, end } = loginBounds(rawCustomerId);
  encodeCustomerPackedKeyPartsIntoRange(rawCustomerId, out, start, end);
}

/** Range-taking variant for callers that already computed `loginBoundsInto`. */
export function encodeCustomerPackedKeyPartsIntoRange(
  rawCustomerId: string,
  out: Uint32Array,
  start: number,
  end: number,
): void {
  const len = end - start;
  if (len <= 12) {
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i += 1) {
      const digit = base40Digit(rawCustomerId.charCodeAt(i));
      const product = lo * 40 + digit; // < 2^38, exact in a double
      lo = product >>> 0;
      const carry = Math.floor(product / TWO32);
      hi = (hi * 40 + carry) & PAYLOAD_HI_MASK;
    }
    out[0] = lo;
    out[1] = (0x40000000 | hi) >>> 0; // mode 1 occupies bits 62-63 -> high word bits 30-31
    return;
  }

  // FNV-1a 64 over the uppercased login, maintained as two 32-bit halves.
  let lo = 0x84222325 | 0; // low half of the 0xcbf29ce484222325 offset basis
  let hi = 0xcbf29ce4 | 0;
  for (let i = start; i < end; i += 1) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    lo = (lo ^ c) >>> 0;
    // h *= 0x100000001b3 = 2^40 + 0x1b3  (mod 2^64)
    const lowTimes = lo * 0x1b3; // < 2^41, exact
    const loA = lowTimes >>> 0;
    const carryA = Math.floor(lowTimes / TWO32);
    const highTimes = hi * 0x1b3 + carryA; // < 2^41, exact
    const hiA = highTimes >>> 0;
    const shiftedHi = (lo << 8) >>> 0; // (h << 40) mod 2^64 lands only in the high half
    lo = loA;
    hi = (hiA + shiftedHi) >>> 0;
  }
  out[0] = lo;
  out[1] = (0x80000000 | (hi & PAYLOAD_HI_MASK)) >>> 0; // mode 2
}

/**
 * Packed key as a small object. Intended for tests and ordinary callers; the lookup hot path
 * uses `encodeCustomerPackedKeyPartsInto` with scratch instead.
 */
export function encodeCustomerPackedKeyParts(
  rawCustomerId: string,
): PackedKeyParts {
  const out = new Uint32Array(2);
  encodeCustomerPackedKeyPartsInto(rawCustomerId, out);
  return { hi: out[1]!, lo: out[0]! };
}

/** BigInt view of the packed key (frozen public API). Exactly the value of the parts. */
export function encodeCustomerPackedKey64(
  rawCustomerId: string,
): CustomerPackedKey64 {
  const parts = encodeCustomerPackedKeyParts(rawCustomerId);
  return (BigInt(parts.hi) << 32n) | BigInt(parts.lo);
}

export function murmur3AvalancheFinalizer32(h: number): number {
  let x = h | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0 || 1;
}

/**
 * Fill `out` with the four 16-bit radix slots (in probe order) for a raw login.
 * Allocates nothing; `out` must have length >= 4.
 *
 * Slot 2 is bumped by one when it collides with slot 1 (frozen spec); the bump wraps in 16
 * bits so the slot domain cannot be escaped.
 *
 * @param rawCustomerId raw desk login
 * @param out 4-slot scratch
 */
function writeRadixSlotsFromHashes(
  h1: number,
  h2: number,
  out: Uint32Array,
): void {
  const f1 = murmur3AvalancheFinalizer32(h1);
  const f2 = murmur3AvalancheFinalizer32(h2);
  const slot1 = f1 & 0xffff;
  const rawSlot2 = f2 & 0xffff;
  out[0] = slot1;
  out[1] = rawSlot2 === slot1 ? (slot1 + 1) & 0xffff : rawSlot2;
  out[2] = (f1 >>> 16) & 0xffff;
  out[3] = (f2 >>> 16) & 0xffff;
}

export function fillLoginRadixSlots16(
  rawCustomerId: string,
  out: Uint32Array,
): void {
  const { start, end } = loginBounds(rawCustomerId);
  fillLoginRadixSlots16Range(rawCustomerId, out, start, end);
}

/** Range-taking variant for callers that already computed `loginBoundsInto`. */
export function fillLoginRadixSlots16Range(
  rawCustomerId: string,
  out: Uint32Array,
  start: number,
  end: number,
): void {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let i = start; i < end; i++) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i - start + 1) * 0x85ebca6b;
    h2 = Math.imul(h2, 0xc2b2ae35);
  }
  writeRadixSlotsFromHashes(h1, h2, out);
}

/**
 * One character pass that produces BOTH the packed key halves and the four radix slots.
 *
 * The reader looks up a login by key and by hash; running the two encoders separately scans and
 * trims the same string twice (the profile attributed ~30% of lookup self time to `loginBounds`
 * alone before this). The loops are byte-identical to `encodeCustomerPackedKeyPartsInto` and
 * `fillLoginRadixSlots16`; only the iteration is shared. Allocates nothing.
 *
 * @param rawCustomerId raw desk login
 * @param keyOut `[lo, hi]` scratch, length >= 2
 * @param slotsOut 4-slot scratch, length >= 4
 */
export function encodeCustomerKeyAndSlotsInto(
  rawCustomerId: string,
  keyOut: Uint32Array,
  slotsOut: Uint32Array,
): void {
  const { start, end } = loginBounds(rawCustomerId);
  encodeCustomerKeyAndSlotsIntoRange(
    rawCustomerId,
    keyOut,
    slotsOut,
    start,
    end,
  );
}

/** Range-taking variant for callers that already computed `loginBoundsInto`. */
export function encodeCustomerKeyAndSlotsIntoRange(
  rawCustomerId: string,
  keyOut: Uint32Array,
  slotsOut: Uint32Array,
  start: number,
  end: number,
): void {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  if (end - start <= 12) {
    let lo = 0;
    let hi = 0;
    for (let i = start; i < end; i += 1) {
      const code = rawCustomerId.charCodeAt(i);
      const digit = base40Digit(code);
      const product = lo * 40 + digit;
      lo = product >>> 0;
      const carry = Math.floor(product / TWO32);
      hi = (hi * 40 + carry) & PAYLOAD_HI_MASK;
      let c = code;
      if (c >= 97 && c <= 122) c -= 32;
      h1 ^= c;
      h1 = Math.imul(h1, 0x01000193);
      h2 ^= c + (i - start + 1) * 0x85ebca6b;
      h2 = Math.imul(h2, 0xc2b2ae35);
    }
    keyOut[0] = lo;
    keyOut[1] = (0x40000000 | hi) >>> 0;
    writeRadixSlotsFromHashes(h1, h2, slotsOut);
    return;
  }

  let lo = 0x84222325 | 0;
  let hi = 0xcbf29ce4 | 0;
  for (let i = start; i < end; i += 1) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    lo = (lo ^ c) >>> 0;
    const lowTimes = lo * 0x1b3;
    const loA = lowTimes >>> 0;
    const carryA = Math.floor(lowTimes / TWO32);
    const highTimes = hi * 0x1b3 + carryA;
    const hiA = highTimes >>> 0;
    const shiftedHi = (lo << 8) >>> 0;
    lo = loA;
    hi = (hiA + shiftedHi) >>> 0;
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i - start + 1) * 0x85ebca6b;
    h2 = Math.imul(h2, 0xc2b2ae35);
  }
  keyOut[0] = lo;
  keyOut[1] = (0x80000000 | (hi & PAYLOAD_HI_MASK)) >>> 0;
  writeRadixSlotsFromHashes(h1, h2, slotsOut);
}

/** Tuple wrapper over `fillLoginRadixSlots16` for ordinary callers. */
export function computeLoginRadixSlots16(
  rawCustomerId: string,
): readonly [number, number, number, number] {
  const out = new Uint32Array(4);
  fillLoginRadixSlots16(rawCustomerId, out);
  return [out[0]!, out[1]!, out[2]!, out[3]!];
}
