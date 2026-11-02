#!/usr/bin/env bun
/**
 * @file fetch_user_manual.ts
 * @description Fetches the portal user manual PDF, extracts its text, and writes a manifest.
 *
 * The manual is third-party vendor documentation, so the extracted text is written to
 * `scratch/portal-manual/` (gitignored) and never committed. What *is* committed is
 * `docs/portal-manual.md`, our own digest with the source hash so a drifted manual is visible.
 *
 * The extraction handles what this specific PDF uses:
 *  - object streams (`/ObjStm`) holding the font and page dictionaries
 *  - Identity-H subset fonts (2-byte codes + /ToUnicode CMap)
 *  - simple WinAnsi fonts (1-byte literal strings)
 *
 * Usage:
 *   bun run manual:fetch
 *   bun run manual:fetch --url https://fantasy402.com/doc/FAQ.pdf --out scratch/portal-manual
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

const DEFAULT_URL = "https://fantasy402.com/doc/FAQ.pdf";
const DEFAULT_OUT = "scratch/portal-manual";

interface Args {
  url: string;
  out: string;
  raw: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { url: DEFAULT_URL, out: DEFAULT_OUT, raw: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--url") {
      if (value === undefined) throw new Error("--url needs a value");
      args.url = value;
      i++;
    } else if (flag === "--out") {
      if (value === undefined) throw new Error("--out needs a path");
      args.out = value;
      i++;
    } else if (flag === "--raw") {
      args.raw = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(
        [
          "Usage: bun run manual:fetch [flags]",
          "",
          `  --url <url>   manual PDF (default ${DEFAULT_URL})`,
          `  --out <dir>   output directory (default ${DEFAULT_OUT})`,
          "  --raw         also print the extracted text to stdout",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`unknown flag: ${String(flag)}`);
  }
  return args;
}

/* --------------------------------------------------------------- pdf model */
interface PdfObject {
  readonly num: number;
  readonly dict: string;
  readonly stream: Uint8Array | null;
}

function parseObjects(bytes: Uint8Array): Map<number, PdfObject> {
  const latin1 = new TextDecoder("latin1").decode(bytes);
  const objects = new Map<number, PdfObject>();

  for (const match of latin1.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    const num = Number(match[1]);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const end = latin1.indexOf("endobj", bodyStart);
    if (end < 0) continue;
    const chunk = latin1.slice(bodyStart, end);
    const streamIdx = chunk.indexOf("stream");
    const dict = streamIdx >= 0 ? chunk.slice(0, streamIdx) : chunk;

    let stream: Uint8Array | null = null;
    if (streamIdx >= 0) {
      let dataStart = bodyStart + streamIdx + "stream".length;
      if (latin1[dataStart] === "\r") dataStart++;
      if (latin1[dataStart] === "\n") dataStart++;
      const eIdx = latin1.indexOf("endstream", dataStart);
      if (eIdx >= 0) {
        const raw = bytes.subarray(dataStart, eIdx);
        if (dict.includes("/FlateDecode")) {
          try {
            stream = new Uint8Array(inflateSync(raw));
          } catch {
            stream = null;
          }
        } else {
          stream = raw;
        }
      }
    }
    objects.set(num, { num, dict, stream });
  }

  // Font and page dictionaries live inside compressed object streams. Collect them first:
  // the loop below adds objects to this map.
  const objStms: PdfObject[] = [];
  for (const obj of objects.values()) {
    if (obj.stream !== null && obj.dict.includes("/ObjStm")) objStms.push(obj);
  }

  for (const obj of objStms) {
    if (obj.stream === null) continue;
    const text = new TextDecoder("latin1").decode(obj.stream);
    const n = Number(/\/N\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const first = Number(/\/First\s+(\d+)/.exec(obj.dict)?.[1] ?? 0);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const offset = header[i * 2 + 1];
      if (num === undefined || offset === undefined) continue;
      const body = text.slice(first + offset);
      const stop = body.search(/\d+\s+\d+\s+(?:obj|endobj)/);
      objects.set(num, {
        num,
        dict: stop > 0 ? body.slice(0, stop) : body,
        stream: null,
      });
    }
  }
  return objects;
}

type CodeMap = Map<number, string>;

function hexToInt(hex: string): number {
  return Number.parseInt(hex.replace(/\s+/g, ""), 16);
}

function utf16be(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 4), 16));
  }
  return out;
}

function parseCMap(text: string): CodeMap {
  const map: CodeMap = new Map();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? "").matchAll(
      /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g,
    )) {
      map.set(hexToInt(pair[1] as string), utf16be(pair[2] as string));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? "";
    for (const triple of body.matchAll(
      /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g,
    )) {
      const lo = hexToInt(triple[1] as string);
      const hi = hexToInt(triple[2] as string);
      const base = utf16be(triple[3] as string);
      if (
        !Number.isFinite(lo) ||
        !Number.isFinite(hi) ||
        hi < lo ||
        hi - lo > 8192
      ) {
        continue;
      }
      for (let code = lo; code <= hi; code++) {
        const offset = code - lo;
        const last = base.charCodeAt(base.length - 1) + offset;
        map.set(code, base.slice(0, -1) + String.fromCharCode(last));
      }
    }
    for (const triple of body.matchAll(
      /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*\[([\s\S]*?)\]/g,
    )) {
      const lo = hexToInt(triple[1] as string);
      [...(triple[3] ?? "").matchAll(/<([0-9A-Fa-f\s]+)>/g)]
        .map((m) => utf16be(m[1] as string))
        .forEach((value, index) => map.set(lo + index, value));
    }
  }
  return map;
}

interface FontInfo {
  readonly identity: boolean;
  readonly cmap: CodeMap | null;
}

function unescapeLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "(" || next === ")" || next === "\\") out += next;
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(raw[i + 1] ?? ""))
        octal += raw[++i];
      out += String.fromCharCode(Number.parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

function literalToHex(raw: string): string {
  return [...unescapeLiteral(raw)]
    .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("");
}

const OP_RE =
  /\/([A-Za-z0-9]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\()])*)\)\s*Tj|\[((?:[^\][\\]|\\.)*)\]\s*TJ|(T\*|Td|TD|ET|BT)/g;

function extractText(bytes: Uint8Array): { pages: string[]; fonts: number } {
  const objects = parseObjects(bytes);

  const cmapFor = (ref: number): CodeMap | null => {
    const obj = objects.get(ref);
    if (!obj?.stream) return null;
    return parseCMap(new TextDecoder("latin1").decode(obj.stream));
  };

  const fontsByObject = new Map<number, FontInfo>();
  for (const obj of objects.values()) {
    if (!/\/Type\s*\/Font/.test(obj.dict)) continue;
    const ref = Number(
      /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.dict)?.[1] ?? -1,
    );
    fontsByObject.set(obj.num, {
      identity: /\/Identity-H/.test(obj.dict),
      cmap: ref >= 0 ? cmapFor(ref) : null,
    });
  }

  const fontNames = new Map<string, number>();
  for (const obj of objects.values()) {
    for (const dict of obj.dict.matchAll(/\/Font\s*<<([\s\S]*?)>>/g)) {
      for (const entry of (dict[1] ?? "").matchAll(
        /\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g,
      )) {
        fontNames.set(entry[1] as string, Number(entry[2]));
      }
    }
    for (const entry of obj.dict.matchAll(
      /\/([A-Za-z0-9]+)\s+(\d+)\s+\d+\s+R/g,
    )) {
      const ref = Number(entry[2]);
      if (fontsByObject.has(ref)) fontNames.set(entry[1] as string, ref);
    }
  }

  const decode = (raw: string, font: FontInfo | undefined): string => {
    if (font?.identity === true) {
      const clean = raw.replace(/\s+/g, "");
      let out = "";
      for (let i = 0; i + 4 <= clean.length; i += 4) {
        out += font.cmap?.get(Number.parseInt(clean.slice(i, i + 4), 16)) ?? "";
      }
      return out;
    }
    let out = "";
    for (const pair of raw.replace(/\s+/g, "").match(/.{1,2}/g) ?? []) {
      const code = Number.parseInt(pair, 16);
      out += font?.cmap?.get(code) ?? String.fromCharCode(code);
    }
    return out;
  };

  const pages: string[] = [];
  for (const obj of objects.values()) {
    if (obj.stream === null) continue;
    const text = new TextDecoder("latin1").decode(obj.stream);
    if (!text.includes("BT")) continue;

    let font: FontInfo | undefined;
    let page = "";
    for (const token of text.matchAll(OP_RE)) {
      if (token[1] !== undefined) {
        const ref = fontNames.get(token[1]);
        font = ref === undefined ? undefined : fontsByObject.get(ref);
      } else if (token[2] !== undefined) {
        page += decode(token[2], font);
      } else if (token[3] !== undefined) {
        page += decode(literalToHex(token[3]), font);
      } else if (token[4] !== undefined) {
        for (const part of token[4].matchAll(
          /<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\)/g,
        )) {
          if (part[1] !== undefined) page += decode(part[1], font);
          else if (part[2] !== undefined)
            page += decode(literalToHex(part[2]), font);
        }
      } else if (token[5] !== undefined) {
        if (["T*", "Td", "TD", "ET"].includes(token[5])) page += "\n";
      }
    }

    const cleaned = page
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (cleaned.length > 20) pages.push(cleaned);
  }

  return { pages, fonts: fontsByObject.size };
}

/* --------------------------------------------------------------- main */
async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const res = await fetch(args.url, {
    headers: {
      accept: "application/pdf",
      "user-agent": "sportsdesk-ops/manual-fetch",
    },
  });
  if (!res.ok) throw new Error(`${args.url} -> HTTP ${res.status}`);

  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { pages, fonts } = extractText(bytes);
  const text = pages.join("\n\n--- page ---\n\n");

  const outDir = resolve(process.cwd(), args.out);
  mkdirSync(outDir, { recursive: true });
  const stamp = sha256.slice(0, 8);

  await Bun.write(join(outDir, `manual-${stamp}.txt`), `${text}\n`);
  await Bun.write(
    join(outDir, "manifest.json"),
    `${JSON.stringify(
      {
        source: args.url,
        retrievedAt: new Date().toISOString(),
        bytes: bytes.length,
        sha256,
        pages: pages.length,
        fonts,
        chars: text.length,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`[manual:fetch] ${args.url}`);
  console.log(`[manual:fetch] ${bytes.length} bytes, sha256 ${sha256}`);
  console.log(
    `[manual:fetch] ${pages.length} page(s), ${fonts} font(s), ${text.length} chars`,
  );
  console.log(
    `[manual:fetch] raw text -> ${args.out}/manual-${stamp}.txt (gitignored)`,
  );
  console.log(
    `[manual:fetch] if the hash differs from docs/portal-manual.md, the manual changed: review and update the digest`,
  );

  if (args.raw) console.log(`\n${text}`);
}

try {
  await main();
} catch (err) {
  console.error(
    `manual:fetch: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
