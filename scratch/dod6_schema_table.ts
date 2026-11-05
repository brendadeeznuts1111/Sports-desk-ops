import { resolve } from "node:path";

const path = resolve("data/sportsdesk_unified_baseline_v54.dodbin");
const size = Bun.file(path).size;
const headerBytes = await Bun.file(path).slice(0, 2048).bytes();
const header = new Uint32Array(
  headerBytes.buffer,
  headerBytes.byteOffset,
  headerBytes.byteLength >>> 2,
);
const rowCapacity = header[3]!;
const sectionOffset = (index: number): number => header[16 + index * 3]!;
const sectionWidth = (index: number): number => header[16 + index * 3 + 1]!;
const nextSectionOffset = (index: number): number =>
  index + 1 < header[9]! ? sectionOffset(index + 1) : size;

interface Row {
  field: string;
  offset: number;
  width: number;
  alignment: number;
  endianness: string;
  frequency: string;
  pattern: string;
  storage: string;
  nextOffset: number;
  padding: number;
  align64: boolean;
}

const headerRows: Array<Omit<Row, "nextOffset" | "padding" | "align64">> = [
  { field: "magic", offset: 0, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "version", offset: 4, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "customerCount", offset: 8, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "rowCapacity", offset: 12, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "headerReserved[4..6]", offset: 16, width: 12, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "asOfEpochDays", offset: 28, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "totalFileBytes", offset: 32, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "sectionCount", offset: 36, width: 4, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
  { field: "sectionTable", offset: 64, width: 88 * 12, alignment: 4, endianness: "LE", frequency: "once", pattern: "sequential", storage: "Uint32Array" },
  { field: "headerReserved[1120..2047]", offset: 1120, width: 928, alignment: 4, endianness: "LE", frequency: "once", pattern: "scalar", storage: "Uint32Array" },
];

const sectionFields: Record<number, { field: string; alignment: number; frequency: string; pattern: string; storage: string }> = {
  0: { field: "radixDirectory", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  1: { field: "radixHeadRowCol", alignment: 4, frequency: "1–4/lookup", pattern: "random-single", storage: "Int32Array" },
  2: { field: "loginKey64Col", alignment: 8, frequency: "chain nodes", pattern: "random-single", storage: "Uint32Array[2]" },
  3: { field: "packedHandle64Col", alignment: 8, frequency: "unused", pattern: "—", storage: "Uint64Array" },
  4: { field: "lifetimeStakedCents", alignment: 8, frequency: "unused", pattern: "—", storage: "Int64Array" },
  5: { field: "settledStakedCents", alignment: 8, frequency: "unused", pattern: "—", storage: "Int64Array" },
  6: { field: "lifetimeNetProfitCents", alignment: 8, frequency: "per hit", pattern: "random-single", storage: "Int32Array[2]" },
  7: { field: "packedHandleCol", alignment: 4, frequency: "per hit (handle)", pattern: "random-single", storage: "Uint32Array" },
  8: { field: "nextInRadixBucketCol", alignment: 4, frequency: "chain nodes", pattern: "random-single", storage: "Int32Array" },
  9: { field: "lifetimeBetsCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  10: { field: "settledBetsCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  11: { field: "openBetsCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  12: { field: "winsCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  13: { field: "lossesCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  14: { field: "pushesCount", alignment: 4, frequency: "unused", pattern: "—", storage: "Uint32Array" },
  15: { field: "roiBasisPoints", alignment: 4, frequency: "per hit", pattern: "random-single", storage: "Int32Array" },
  16: { field: "clvLegsCount", alignment: 4, frequency: "per hit", pattern: "random-single", storage: "Uint32Array" },
  17: { field: "avgClvLineHundredths", alignment: 4, frequency: "per hit", pattern: "random-single", storage: "Int32Array" },
  18: { field: "section18", alignment: 2, frequency: "unused", pattern: "—", storage: "Uint16Array" },
  19: { field: "section19", alignment: 2, frequency: "unused", pattern: "—", storage: "Uint16Array" },
};

const rows: Row[] = [];
let previousNext = 0;
for (const row of headerRows) {
  rows.push({
    ...row,
    nextOffset: row.offset + row.width,
    padding: 0,
    align64: row.offset % 64 === 0,
  });
  previousNext = row.offset + row.width;
}
if (previousNext !== 2048) {
  rows.push({
    field: "headerPadding",
    offset: previousNext,
    width: 2048 - previousNext,
    alignment: 4,
    endianness: "LE",
    frequency: "once",
    pattern: "—",
    storage: "—",
    nextOffset: 2048,
    padding: 0,
    align64: previousNext % 64 === 0,
  });
}

for (let index = 0; index < 20; index += 1) {
  const descriptor = sectionFields[index]!;
  const offset = sectionOffset(index);
  const width = sectionWidth(index);
  const nextOffset = nextSectionOffset(index);
  rows.push({
    ...descriptor,
    offset,
    width,
    endianness: "LE",
    nextOffset,
    padding: nextOffset - (offset + width),
    align64: offset % 64 === 0,
  });
}

console.log(
  Bun.inspect.table(rows, [
    "field",
    "offset",
    "width",
    "alignment",
    "endianness",
    "frequency",
    "pattern",
    "storage",
    "nextOffset",
    "padding",
    "align64",
  ]),
);
