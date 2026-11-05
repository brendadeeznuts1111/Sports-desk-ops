import {
  encodeCustomerKeyAndSlotsIntoRange,
  fillLoginRadixSlots16Range,
  loginBoundsInto,
} from "../lib/dod6_v54_login_key.ts";

const path = "data/sportsdesk_unified_baseline_v54.dodbin";
const bytes = await Bun.file(path).bytes();
const header = new Uint32Array(bytes.buffer, bytes.byteOffset, 512);
const rows = header[3]!;
const sectionOffset = (index: number): number => header[16 + index * 3]!;
const u32At = (offset: number, length: number): Uint32Array =>
  new Uint32Array(bytes.buffer, bytes.byteOffset + offset, length);
const i32At = (offset: number, length: number): Int32Array =>
  new Int32Array(bytes.buffer, bytes.byteOffset + offset, length);

const head = i32At(sectionOffset(1), 65_536);
const keyWords = u32At(sectionOffset(2), rows * 2);
const next = i32At(sectionOffset(8), rows);
const net = i32At(sectionOffset(6), rows * 2);
const roi = i32At(sectionOffset(15), rows);
const clvLegs = u32At(sectionOffset(16), rows);
const avgClv = i32At(sectionOffset(17), rows);

const DIGIT_TO_CHAR = (digit: number): string => {
  if (digit >= 1 && digit <= 10) return String.fromCharCode(48 + digit - 1);
  if (digit >= 11 && digit <= 36) return String.fromCharCode(65 + digit - 11);
  if (digit === 37) return "_";
  if (digit === 38) return "-";
  return ".";
};

const decoded: string[] = [];
for (let row = 0; row < rows; row += 1) {
  const lo = keyWords[row * 2]!;
  const hi = keyWords[row * 2 + 1]!;
  if (hi >>> 30 !== 1) continue;
  let payload = (BigInt(hi & 0x3fffffff) << 32n) | BigInt(lo);
  let text = "";
  while (payload > 0n) {
    text = DIGIT_TO_CHAR(Number(payload % 40n)) + text;
    payload /= 40n;
  }
  decoded.push(text);
}
console.log("decoded base40 logins", decoded.length);

const keys = new Uint32Array(2);
const slots = new Uint32Array(4);
const bounds = new Int32Array(2);
const hitLogins: string[] = [];
for (const login of decoded) {
  loginBoundsInto(login, bounds);
  encodeCustomerKeyAndSlotsIntoRange(login, keys, slots, bounds[0]!, bounds[1]!);
  const lo = keys[0]!;
  const hi = keys[1]!;
  let found = false;
  for (let s = 0; s < 4 && !found; s += 1) {
    let cur = head[slots[s]!]!;
    while (cur !== -1) {
      const word = cur * 2;
      if (keyWords[word] === lo && keyWords[word + 1] === hi) {
        found = true;
        break;
      }
      cur = next[cur]!;
    }
  }
  if (found) hitLogins.push(login);
}
console.log("verified hits", hitLogins.length);

const lineOf = (offset: number): number => Math.floor(offset / 64);
interface CacheResult {
  readonly capacityKiB: number;
  readonly headMisses: number;
  readonly chainMisses: number;
  readonly fieldMisses: number;
  readonly accesses: number;
}
function simulate(capacityKiB: number, lookups: number): CacheResult {
  const cache = new Map<number, true>();
  const maxLines = (capacityKiB * 1024) / 64;
  let headMisses = 0;
  let chainMisses = 0;
  let fieldMisses = 0;
  let accesses = 0;
  const touch = (line: number, category: "head" | "chain" | "field"): void => {
    accesses += 1;
    if (cache.has(line)) {
      cache.delete(line);
      cache.set(line, true);
      return;
    }
    if (category === "head") headMisses += 1;
    else if (category === "chain") chainMisses += 1;
    else fieldMisses += 1;
    cache.set(line, true);
    if (cache.size > maxLines) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };
  for (let i = 0; i < lookups; i += 1) {
    const login = hitLogins[i % hitLogins.length]!;
    loginBoundsInto(login, bounds);
    encodeCustomerKeyAndSlotsIntoRange(login, keys, slots, bounds[0]!, bounds[1]!);
    const lo = keys[0]!;
    const hi = keys[1]!;
    for (let s = 0; s < 4; s += 1) {
      const slot = slots[s]!;
      touch(lineOf(sectionOffset(1) + slot * 4), "head");
      let cur = head[slot]!;
      while (cur !== -1) {
        const word = cur * 2;
        touch(lineOf(sectionOffset(2) + cur * 8), "chain");
        touch(lineOf(sectionOffset(8) + cur * 4), "chain");
        if (keyWords[word] === lo && keyWords[word + 1] === hi) {
          touch(lineOf(sectionOffset(6) + cur * 8), "field");
          touch(lineOf(sectionOffset(15) + cur * 4), "field");
          touch(lineOf(sectionOffset(16) + cur * 4), "field");
          touch(lineOf(sectionOffset(17) + cur * 4), "field");
          break;
        }
        cur = next[cur]!;
      }
    }
  }
  return { capacityKiB, headMisses, chainMisses, fieldMisses, accesses };
}

const LOOKUPS = 200_000;
for (const capacity of [16, 32, 64, 128, 256, 512, 1024, 4096]) {
  const result = simulate(capacity, LOOKUPS);
  const misses = result.headMisses + result.chainMisses + result.fieldMisses;
  console.log(
    JSON.stringify({
      ...result,
      headShare: misses === 0 ? 0 : Number(((result.headMisses / misses) * 100).toFixed(1)),
      missPerLookup: Number((misses / LOOKUPS).toFixed(3)),
    }),
  );
}


// Pure head-table and pure row-field microbenchmarks (precomputed slots/rows).
const slotsForAll = new Uint32Array(hitLogins.length * 4);
const rowsForAll = new Int32Array(hitLogins.length);
for (let h = 0; h < hitLogins.length; h += 1) {
  const login = hitLogins[h]!;
  loginBoundsInto(login, bounds);
  fillLoginRadixSlots16Range(login, slots, bounds[0]!, bounds[1]!);
  slotsForAll.set(slots, h * 4);
  rowsForAll[h] = head[slots[0]!]!;
}
const N = 1_000_000;
let sum = 0;
let t = Bun.nanoseconds();
for (let i = 0; i < N; i += 1) {
  const base = (i % hitLogins.length) * 4;
  sum += head[slotsForAll[base]!]! + head[slotsForAll[base + 1]!]! +
    head[slotsForAll[base + 2]!]! + head[slotsForAll[base + 3]!]!;
}
console.log(JSON.stringify({ headOnlyNs: Number(((Bun.nanoseconds() - t) / N).toFixed(1)), sum }));
t = Bun.nanoseconds();
for (let i = 0; i < N; i += 1) {
  const row = rowsForAll[i % hitLogins.length]!;
  sum += roi[row]! + clvLegs[row]! + avgClv[row]! + net[row * 2]!;
}
console.log(JSON.stringify({ fieldsOnlyNs: Number(((Bun.nanoseconds() - t) / N).toFixed(1)), sum }));
