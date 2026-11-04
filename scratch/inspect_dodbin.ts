import { resolve } from "node:path";

const path = resolve("data/sportsdesk_unified_baseline_v54.dodbin");
const file = Bun.file(path);
const size = file.size;
const headerBytes = await file.slice(0, 2048).bytes();
const header = new Uint32Array(
  headerBytes.buffer,
  headerBytes.byteOffset,
  headerBytes.byteLength >>> 2,
);

console.log({ size, magic: header[0]!.toString(16), version: header[1] });
console.log({
  customerCount: header[2],
  rowCapacity: header[3],
  slot4: header[4],
  slot5: header[5],
  slot6: header[6],
  asOfEpochDays: header[7],
  totalFileBytes: header[8],
  sectionCount: header[9],
});

for (let section = 0; section < 20; section += 1) {
  const base = 16 + section * 3;
  const offset = header[base]!;
  const length = header[base + 1]!;
  const stride = header[base + 2]!;
  console.log(
    `section ${String(section).padStart(2)} offset=${offset} length=${length} third=${stride} align4=${offset % 4} align8=${offset % 8}`,
  );
}
