import { resolve } from "node:path";

const path = resolve("data/sportsdesk_unified_baseline_v54.dodbin");
const size = Bun.file(path).size;
const headerBytes = await Bun.file(path).slice(0, 2048).bytes();
const header = new Uint32Array(
  headerBytes.buffer,
  headerBytes.byteOffset,
  headerBytes.byteLength >>> 2,
);
const sectionCount = header[9]!;
const totalFileBytes = header[8]!;

interface Section {
  index: number;
  offset: number;
  width: number;
  third: number;
  nextOffset: number;
  padding: number;
}
const sections: Section[] = [];
for (let index = 0; index < sectionCount; index += 1) {
  const base = 16 + index * 3;
  sections.push({
    index,
    offset: header[base]!,
    width: header[base + 1]!,
    third: header[base + 2]!,
    nextOffset: size,
    padding: 0,
  });
}
for (let index = 0; index < sections.length; index += 1) {
  const current = sections[index]!;
  const next = sections[index + 1];
  current.nextOffset = next?.offset ?? size;
  current.padding = current.nextOffset - (current.offset + current.width);
}

const problems: string[] = [];
for (const section of sections) {
  if (section.offset < 2048) problems.push(`section ${section.index}: offset < header`);
  if (section.offset % 64 !== 0) problems.push(`section ${section.index}: offset ${section.offset} not 64-aligned`);
  if (section.width <= 0) problems.push(`section ${section.index}: width ${section.width}`);
  if (section.offset + section.width > size) problems.push(`section ${section.index}: overruns file`);
  if (section.padding < 0) problems.push(`section ${section.index}: overlaps next section`);
  if (section.padding > 63) problems.push(`section ${section.index}: gap ${section.padding} > 63`);
}

console.log({
  size,
  totalFileBytes,
  sectionCount,
  firstOffset: sections[0]?.offset,
  lastOffset: sections.at(-1)?.offset,
  lastEnd: sections.at(-1)!.offset + sections.at(-1)!.width,
  lastPadding: sections.at(-1)!.padding,
  maxPadding: Math.max(...sections.map((s) => s.padding)),
  problems,
});

for (const section of sections.slice(0, 20)) {
  console.log(
    `sec ${String(section.index).padStart(2)} offset=${String(section.offset).padStart(8)} width=${String(section.width).padStart(7)} next=${String(section.nextOffset).padStart(8)} pad=${String(section.padding).padStart(3)} align64=${section.offset % 64 === 0}`,
  );
}
