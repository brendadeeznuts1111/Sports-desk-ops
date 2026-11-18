import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  embedImageProvenance,
  embedPngProvenance,
  embedWebpProvenance,
  readImageProvenance,
  verifyImageProvenance,
} from "../lib/image_provenance.ts";

const MERKLE = "ab".repeat(32);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffff_ffff;
  for (const byte of bytes) {
    c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function textChunk(keyword: string, value: string): Uint8Array {
  return pngChunk(
    "tEXt",
    new Uint8Array([
      ...new TextEncoder().encode(keyword),
      0,
      ...new TextEncoder().encode(value),
    ]),
  );
}

function itxtChunk(keyword: string, value: string): Uint8Array {
  return pngChunk(
    "iTXt",
    new Uint8Array([
      ...new TextEncoder().encode(keyword),
      0, // keyword terminator
      0, // compression flag
      0, // compression method
      0, // language tag terminator
      0, // translated keyword terminator
      ...new TextEncoder().encode(value),
    ]),
  );
}

/** The legacy header shape this repo's generator wrote: keyword NUL + 3 zeros. */
function legacyItxtChunk(keyword: string, value: string): Uint8Array {
  return pngChunk(
    "iTXt",
    new Uint8Array([
      ...new TextEncoder().encode(keyword),
      0,
      0,
      0,
      0,
      ...new TextEncoder().encode(value),
    ]),
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** A valid 1×1 truecolour PNG; extra chunks are inserted after IHDR. */
function makePng(extra: readonly Uint8Array[] = []): Uint8Array {
  const ihdr = pngChunk(
    "IHDR",
    Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0),
  );
  const idat = pngChunk("IDAT", deflateSync(Uint8Array.of(0, 255, 0, 0)));
  const iend = pngChunk("IEND", new Uint8Array(0));
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    ihdr,
    ...extra,
    idat,
    iend,
  ]);
}

describe("R2 image provenance (header-only WebP/PNG metadata)", () => {
  test("reads direct PNG tEXt provenance and reports the channel", async () => {
    const png = embedPngProvenance(makePng(), {
      streamId: "gslive-tally",
      genU32: 1042,
      merkleRoot: MERKLE,
    });
    const report = await readImageProvenance(png);
    expect(report.available).toBe(true);
    expect(report.format).toBe("png");
    expect(report.width).toBe(1);
    expect(report.height).toBe(1);
    expect(report.byteLength).toBe(png.length);
    expect(report.channels).toEqual(["png-text"]);
    expect(report.fields).toEqual({
      streamId: "gslive-tally",
      genU32: 1042,
      merkleRoot: MERKLE,
    });
    expect(report.raw["sportsdesk:gen_u32"]).toBe("1042");
    expect(report.issues).toEqual([]);
  });

  test("reads XMP properties out of a PNG iTXt packet, decoding entities", async () => {
    const xmp = `<?xpacket begin="\uFEFF"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:sportsdesk="https://example.invalid/ns/1.0/">
      <sportsdesk:stream_id>f402-weblog</sportsdesk:stream_id>
      <sportsdesk:gen_u32>7</sportsdesk:gen_u32>
      <sportsdesk:merkle_root>${MERKLE}</sportsdesk:merkle_root>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`;
    const png = makePng([
      itxtChunk("XML:com.adobe.xmp", xmp),
      textChunk("Title", "Report &amp; chart"),
    ]);
    const report = await readImageProvenance(png);
    expect(report.channels).toEqual(["png-xmp"]);
    expect(report.fields).toEqual({
      streamId: "f402-weblog",
      genU32: 7,
      merkleRoot: MERKLE,
    });
    expect(report.issues).toEqual([]);
  });

  test("tolerates the legacy 4-byte iTXt header and records the issue", async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:sportsdesk="https://example.invalid/ns/1.0/"><sportsdesk:stream_id>gslive-tally</sportsdesk:stream_id></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const report = await readImageProvenance(
      makePng([legacyItxtChunk("XML:com.adobe.xmp", xmp)]),
    );
    expect(report.channels).toEqual(["png-xmp"]);
    expect(report.fields.streamId).toBe("gslive-tally");
    expect(report.issues).toContain("tolerated:png_itxt_header");
  });

  test("counts an XMP channel that carries other sportsdesk properties", async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:sportsdesk="https://example.invalid/ns/1.0/"><sportsdesk:modesCovered>1,2,3</sportsdesk:modesCovered></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const report = await readImageProvenance(
      makePng([itxtChunk("XML:com.adobe.xmp", xmp)]),
    );
    expect(report.channels).toEqual(["png-xmp"]);
    expect(report.fields.streamId).toBeNull();
    expect(report.issues).toContain("missing:sportsdesk:stream_id");
    // The packet did carry sportsdesk metadata; only our three keys are absent.
    expect(report.issues).not.toContain("no_sportsdesk_metadata");
  });

  test("WebP round-trips the provenance through an XMP RIFF chunk", async () => {
    const webp = new Uint8Array(
      await new Bun.Image(makePng()).webp({ quality: 82 }).bytes(),
    );
    const annotated = embedWebpProvenance(webp, {
      streamId: "wagers-by-state",
      genU32: 4_294_967_295,
      merkleRoot: `0x${MERKLE}`,
    });
    const report = await readImageProvenance(annotated);
    expect(report.available).toBe(true);
    expect(report.format).toBe("webp");
    expect(report.channels).toEqual(["webp-xmp"]);
    expect(report.fields.genU32).toBe(4_294_967_295);
    expect(report.fields.merkleRoot).toBe(MERKLE);
    expect(report.issues).toEqual([]);

    // Re-embedding replaces the chunk instead of appending a second one.
    const reembedded = embedWebpProvenance(annotated, {
      streamId: "gslive-tally",
      genU32: 1,
      merkleRoot: MERKLE,
    });
    const reread = await readImageProvenance(reembedded);
    expect(reread.fields.streamId).toBe("gslive-tally");
    expect(reembedded.length).toBeLessThan(annotated.length + 400);
  });

  test("flags invalid gen_u32 / merkle_root instead of coercing them", async () => {
    const png = makePng([
      textChunk("sportsdesk:stream_id", "gslive-tally"),
      textChunk("sportsdesk:gen_u32", "4294967296"),
      textChunk("sportsdesk:merkle_root", "not-hex"),
    ]);
    const report = await readImageProvenance(png);
    expect(report.fields.genU32).toBeNull();
    expect(report.fields.merkleRoot).toBeNull();
    expect(report.issues).toContain("invalid:sportsdesk:gen_u32");
    expect(report.issues).toContain("invalid:sportsdesk:merkle_root");
    expect(report.issues).not.toContain("missing:sportsdesk:gen_u32");
  });

  test("reports a conflict when text and XMP disagree, and keeps the first channel", async () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:sportsdesk="https://example.invalid/ns/1.0/"><sportsdesk:gen_u32>1043</sportsdesk:gen_u32></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const png = makePng([
      textChunk("sportsdesk:gen_u32", "1042"),
      itxtChunk("XML:com.adobe.xmp", xmp),
    ]);
    const report = await readImageProvenance(png);
    expect(report.fields.genU32).toBe(1042);
    expect(report.issues).toContain("conflict:sportsdesk:gen_u32");
  });

  test("a different-cased SportsDesk: keyword is not our namespace", async () => {
    const report = await readImageProvenance(
      makePng([
        textChunk("SportsDesk:PipelineSpecJson", '{"@type":"ImageObject"}'),
      ]),
    );
    expect(report.channels).toEqual([]);
    expect(report.fields.streamId).toBeNull();
    expect(report.issues).toContain("no_sportsdesk_metadata");
  });

  test("missing metadata is reported, never invented", async () => {
    const report = await readImageProvenance(makePng());
    expect(report.available).toBe(true);
    expect(report.fields).toEqual({
      streamId: null,
      genU32: null,
      merkleRoot: null,
    });
    expect(report.channels).toEqual([]);
    expect(report.issues).toContain("no_sportsdesk_metadata");
    expect(report.issues).toContain("missing:sportsdesk:stream_id");
  });

  test("non-image bytes are unavailable with a Bun.Image error code", async () => {
    const report = await readImageProvenance(Uint8Array.of(1, 2, 3, 4));
    expect(report.available).toBe(false);
    expect(report.format).toBeNull();
    expect(report.errorCode).toBeDefined();
    expect(report.issues).toContain("image_unavailable");
  });

  test("embed dispatch refuses unknown containers", () => {
    expect(() =>
      embedImageProvenance(Uint8Array.of(1, 2, 3), { streamId: "x" }),
    ).toThrow(/unsupported container/);
  });

  test("verify compares only supplied expectations", async () => {
    const report = await readImageProvenance(
      embedPngProvenance(makePng(), {
        streamId: "gslive-tally",
        genU32: 1042,
        merkleRoot: MERKLE,
      }),
    );
    expect(
      verifyImageProvenance(report, {
        streamId: "gslive-tally",
        merkleRoot: `0x${MERKLE}`,
      }),
    ).toEqual({ ok: true, mismatches: [] });
    expect(verifyImageProvenance(report, { genU32: 1043 }).mismatches).toEqual([
      "gen_u32:1042",
    ]);
    expect(verifyImageProvenance(report, { streamId: "f402-weblog" }).ok).toBe(
      false,
    );
  });
});
