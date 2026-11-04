/**
 * DOD6 v5.4 customer login packing + 16-bit radix probing (frozen spec; matches turbo-cap spine).
 */
export type CustomerPackedKey64 = bigint;

export const KEY64_MODE_SHIFT = 62n;
export const KEY64_PAYLOAD_MASK = (1n << 62n) - 1n;
export const KEY64_MODE_BASE40_EXACT_12 = 1n;
export const KEY64_MODE_FNV1A64_LONG = 2n;

const BASE40_CHARS = "\x000123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_-.";

function charToBase40(code: number): bigint {
  if (code >= 48 && code <= 57) return BigInt(code - 48 + 1);
  if (code >= 65 && code <= 90) return BigInt(code - 65 + 11);
  if (code >= 97 && code <= 122) return BigInt(code - 97 + 11);
  if (code === 95) return 37n;
  if (code === 45) return 38n;
  if (code === 46) return 39n;
  return 39n;
}

export function encodeCustomerPackedKey64(rawCustomerId: string): CustomerPackedKey64 {
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

  const len = end - start;
  if (len <= 12) {
    let payload = 0n;
    for (let i = 0; i < len; i++) {
      payload =
        payload * 40n + charToBase40(rawCustomerId.charCodeAt(start + i));
    }
    return (KEY64_MODE_BASE40_EXACT_12 << KEY64_MODE_SHIFT) | (payload & KEY64_PAYLOAD_MASK);
  }

  let h64 = 0xcbf29ce484222325n;
  for (let i = start; i < end; i++) {
    let c = rawCustomerId.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32;
    h64 ^= BigInt(c);
    h64 = BigInt.asUintN(64, h64 * 0x100000001b3n);
  }
  return (KEY64_MODE_FNV1A64_LONG << KEY64_MODE_SHIFT) | (h64 & KEY64_PAYLOAD_MASK);
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

export function computeLoginRadixSlots16(
  rawCustomerId: string,
): readonly [number, number, number, number] {
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
  const f1 = murmur3AvalancheFinalizer32(h1);
  const f2 = murmur3AvalancheFinalizer32(h2);

  const slot1 = f1 & 0xffff;
  const rawSlot2 = f2 & 0xffff;
  const slot2 = rawSlot2 === slot1 ? (slot1 + 1) & 0xffff : rawSlot2;
  const slot3 = (f1 >>> 16) & 0xffff;
  const slot4 = (f2 >>> 16) & 0xffff;
  return [slot1, slot2, slot3, slot4];
}
