// @see https://bun.com/docs/test/index#run-tests
import { describe, expect, test } from "bun:test";
import {
  INGESTION_CHANNELS,
  type ColorHexInt,
} from "../design/domain-branded-types.ts";
import {
  NULL_BRIDGE_CHANNEL_WORD32,
  asCents,
  encodeBridgeChannelPackedWord32,
  resolveSeparatedBridgeAndChannelEnvelope,
} from "../lib/bridge_and_channel_router.ts";
import { OriginDomainWireId, WriterLaneWireId } from "../lib/domain-enums.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  WRITER_LANE_REGISTRY,
  resolveOriginDomainForWriter,
  resolveVenueIdForOrigin,
  resolveWriterLaneId,
  type OriginDomainId,
  type VenueId,
  type WriterLaneId,
} from "../lib/domain_venue_registry.ts";
import {
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_MAGIC,
  NSH_FRAME_VERSION,
  NSH_MESSAGE_TYPE,
  NshFrameCodecError,
  NshFrameWriter,
  broadcastFrame,
  createNshFrameTarget,
  packNshBinaryFrame,
  readNshBinaryFrame,
  readNshBinaryFrameFromArrayBuffer,
  readNshBinaryFrameInto,
  resumeNshSubscriber,
  sendNshFrameToSubscriber,
  type NshMatchFrameInput,
  type NshSubscriberSocket,
} from "../lib/nsh_frame_codec.ts";
import {
  BridgeOrdinal,
  ChannelOrdinal,
  NSH_FRAME_LAYOUT,
  NSH_FRAME_SIZE_CHECK_64,
  NSH_MAGIC_BYTE,
  NSH_VERSION,
  TOKENS_SSOT_ARTIFACT_CITATION,
  assertValidFrozenArtifactCitation,
  auditNamingConstitutionCompliance,
  channelOrdinalFromFrame,
  decodeBridgeChannelPackedWord32,
  packChannelHandle32,
  packChannelHandleFromRouteWord32,
  packNshFrameToArrayBuffer,
  packRouteEnvelopeToNshFrame,
  resolveRouteWordChannelAndSla,
  unpackChannelHandle32,
} from "../lib/nsh_frame_schema.ts";
import {
  PROVENANCE_CHANNEL_CODES,
  PROVENANCE_COLORS,
  PROVENANCE_CSS,
  provenanceCodeForColor,
  provenanceCssForColor,
} from "../lib/provenance_palette.ts";
import { auditSourceCodeNamingCompliance } from "../lib/specification_naming_police.ts";

/** Brand the literal in assertions; the codec exports branded ColorHexInt. */
const asColor = (value: number): ColorHexInt => value as ColorHexInt;

const BASE_FRAME: NshMatchFrameInput = {
  channelId: 3,
  slaDivide10Ms: 50,
  rowIndex: 0xabcde,
  betGroupId: 42,
  stakeUsdc: 1250.5,
  bookOdds: 1.85,
  polyAvgPrice: 0.52,
  liabilityDelta: -120.25,
  originDomainWireId: OriginDomainWireId.GSLIVE_118,
  writerLaneWireId: WriterLaneWireId.GSLIVE,
  flags: 0b101,
  slippageBps: 12,
  timestampMs: 1_700_000_000_000,
};

describe("provenance palette", () => {
  test("is built from the generated ingestion registry, not a second TOML read", () => {
    expect(PROVENANCE_CHANNEL_CODES.length).toBe(INGESTION_CHANNELS.length);
    expect(PROVENANCE_CHANNEL_CODES.length).toBeGreaterThan(0);
    for (const code of PROVENANCE_CHANNEL_CODES) {
      expect(PROVENANCE_COLORS[code]).toBeGreaterThanOrEqual(0);
      expect(PROVENANCE_CSS[code]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  test("packs the real token hexes as 24-bit ColorHexInt and keeps CSS precomputed", () => {
    expect(PROVENANCE_COLORS.GSLIVE).toBe(asColor(0x4ade80));
    expect(PROVENANCE_COLORS.ALERT).toBe(asColor(0xff7878));
    expect(PROVENANCE_COLORS.Internet).toBe(asColor(0x29b6f6));
    expect(PROVENANCE_CSS.GSLIVE).toBe("#4ade80");
    expect(PROVENANCE_CSS.ALERT).toBe("#ff7878");
    expect(provenanceCodeForColor(PROVENANCE_COLORS.GSLIVE)).toBe("GSLIVE");
    expect(provenanceCssForColor(PROVENANCE_COLORS.GSLIVE)).toBe("#4ade80");
  });

  test("unknown colors still produce a valid hex without a palette cache", () => {
    expect(provenanceCssForColor(asColor(0x010203))).toBe("#010203");
    expect(provenanceCssForColor(asColor(0))).toBe("#000000");
    expect(provenanceCodeForColor(asColor(0x010203))).toBeNull();
  });
});

describe("NSH 64-byte frame", () => {
  test("round-trips every field", () => {
    const bytes = packNshBinaryFrame(BASE_FRAME);
    expect(bytes.byteLength).toBe(NSH_FRAME_BYTE_LENGTH);

    const frame = readNshBinaryFrame(bytes);
    expect(frame.messageType).toBe(NSH_MESSAGE_TYPE.TICKER_MATCH);
    expect(frame.channelId).toBe(3);
    expect(frame.slaDivide10Ms).toBe(50);
    expect(frame.rowIndex).toBe(0xabcde);
    expect(frame.betGroupId).toBe(42n);
    expect(frame.stakeUsdc).toBe(1250.5);
    expect(frame.bookOdds).toBe(1.85);
    expect(frame.polyAvgPrice).toBe(0.52);
    expect(frame.liabilityDelta).toBe(-120.25);
    expect(frame.timestampMs).toBe(1_700_000_000_000);
    expect(frame.originDomainWireId).toBe(OriginDomainWireId.GSLIVE_118);
    expect(frame.originDomainId).toBe("ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118");
    expect(frame.writerLaneWireId).toBe(WriterLaneWireId.GSLIVE);
    expect(frame.writerLaneId).toBe("gslive");
    expect(frame.flags).toBe(0b101);
    expect(frame.slippageBps).toBe(12);
  });

  test("writes the header, handle, and origin/writer/reserved bytes at strict layout offsets", () => {
    const bytes = packNshBinaryFrame(BASE_FRAME);

    expect(bytes[0]).toBe(NSH_FRAME_MAGIC);
    expect(bytes[1]).toBe(NSH_FRAME_VERSION);
    expect(bytes[2]).toBe(NSH_MESSAGE_TYPE.TICKER_MATCH);
    expect(bytes[3]).toBe(0);

    const handle =
      ((3 & 0xf) << 28) | ((50 & 0xff) << 20) | (0xabcde & 0xfffff);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(handle >>> 0);

    expect([bytes[56], bytes[57], bytes[58]]).toEqual([
      OriginDomainWireId.GSLIVE_118,
      WriterLaneWireId.GSLIVE,
      0,
    ]);
    expect(view.getUint16(59, true)).toBe(0b101);
    expect(bytes[61]).toBe(12);
    expect(view.getUint16(62, true)).toBe(0x0000);
  });

  test("the writer reuses one buffer and never leaks an uninitialized byte", () => {
    const writer = new NshFrameWriter();
    writer.bytes.fill(0xff);

    const first = writer.write(BASE_FRAME);
    expect(writer.bytes[3]).toBe(0);
    expect(writer.bytes[62]).toBe(0);
    expect(writer.bytes[63]).toBe(0);
    expect(writer.bytes.some((byte) => byte === 0xff)).toBe(false);

    const second = writer.write(BASE_FRAME);
    expect(second).toBe(first);
  });

  test("accepts a full u64 bet group id without a numeric round-trip", () => {
    const bytes = packNshBinaryFrame({
      ...BASE_FRAME,
      betGroupId: 0xffffffffffffffffn,
    });

    expect(readNshBinaryFrame(bytes).betGroupId).toBe(0xffffffffffffffffn);
  });

  test("packs the all-ones bounds", () => {
    const frame = readNshBinaryFrame(
      packNshBinaryFrame({
        ...BASE_FRAME,
        channelId: 0xf,
        slaDivide10Ms: 0xff,
        rowIndex: 0xfffff,
        flags: 0xffff,
        slippageBps: 0xff,
      }),
    );

    expect(frame.channelId).toBe(0xf);
    expect(frame.slaDivide10Ms).toBe(0xff);
    expect(frame.rowIndex).toBe(0xfffff);
    expect(frame.flags).toBe(0xffff);
    expect(frame.slippageBps).toBe(0xff);
  });

  test("reads an ArrayBuffer payload as a view, not a copy", () => {
    const bytes = packNshBinaryFrame(BASE_FRAME);
    const frame = readNshBinaryFrameFromArrayBuffer(
      bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    );

    expect(frame.writerLaneId).toBe("gslive");
  });

  test("rejects out-of-range inputs at the write boundary", () => {
    const writer = new NshFrameWriter();

    expect(() => writer.write({ ...BASE_FRAME, messageType: 256 })).toThrow(
      NshFrameCodecError,
    );
    expect(() => writer.write({ ...BASE_FRAME, channelId: 16 })).toThrow(
      NshFrameCodecError,
    );
    expect(() => writer.write({ ...BASE_FRAME, slaDivide10Ms: 256 })).toThrow(
      NshFrameCodecError,
    );
    expect(() => writer.write({ ...BASE_FRAME, rowIndex: 0x100000 })).toThrow(
      NshFrameCodecError,
    );
    expect(() => writer.write({ ...BASE_FRAME, flags: 0x10000 })).toThrow(
      NshFrameCodecError,
    );
    expect(() => writer.write({ ...BASE_FRAME, slippageBps: 256 })).toThrow(
      NshFrameCodecError,
    );
    expect(() =>
      writer.write({ ...BASE_FRAME, stakeUsdc: Number.NaN }),
    ).toThrow("ERR_FRAME_INVALID_FINANCIAL_DATA");
    expect(() =>
      writer.write({ ...BASE_FRAME, bookOdds: Number.POSITIVE_INFINITY }),
    ).toThrow("ERR_FRAME_INVALID_FINANCIAL_DATA");
    expect(() =>
      writer.write({ ...BASE_FRAME, polyAvgPrice: Number.NEGATIVE_INFINITY }),
    ).toThrow("ERR_FRAME_INVALID_FINANCIAL_DATA");
    expect(() =>
      writer.write({ ...BASE_FRAME, liabilityDelta: Number.NaN }),
    ).toThrow("ERR_FRAME_INVALID_FINANCIAL_DATA");
    expect(() => writer.write({ ...BASE_FRAME, betGroupId: -1 })).toThrow(
      NshFrameCodecError,
    );
    expect(() =>
      writer.write({ ...BASE_FRAME, betGroupId: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow(NshFrameCodecError);
    expect(() => writer.write({ ...BASE_FRAME, timestampMs: -1 })).toThrow(
      NshFrameCodecError,
    );
    expect(() =>
      writer.write({
        ...BASE_FRAME,
        originDomainWireId: 99 as OriginDomainWireId,
      }),
    ).toThrow(NshFrameCodecError);
    expect(() =>
      writer.write({
        ...BASE_FRAME,
        writerLaneWireId: 99 as WriterLaneWireId,
      }),
    ).toThrow(NshFrameCodecError);
  });

  test("rejects malformed frames and non-finite financial floats at the read boundary without mutating target", () => {
    expect(() => readNshBinaryFrame(new Uint8Array(63))).toThrow(
      NshFrameCodecError,
    );

    const badMagic = packNshBinaryFrame(BASE_FRAME);
    badMagic[0] = 0;
    expect(() => readNshBinaryFrame(badMagic)).toThrow(NshFrameCodecError);

    const badVersion = packNshBinaryFrame(BASE_FRAME);
    badVersion[1] = 7;
    expect(() => readNshBinaryFrame(badVersion)).toThrow(NshFrameCodecError);

    const deprecatedV5 = packNshBinaryFrame(BASE_FRAME);
    deprecatedV5[1] = 5;
    expect(() => readNshBinaryFrame(deprecatedV5)).toThrow(
      "ERR_FRAME_V5_DEPRECATED",
    );

    const badReserved = packNshBinaryFrame(BASE_FRAME);
    badReserved[63] = 1;
    expect(() => readNshBinaryFrame(badReserved)).toThrow(NshFrameCodecError);

    const badPaddingLow = packNshBinaryFrame(BASE_FRAME);
    badPaddingLow[62] = 1;
    expect(() => readNshBinaryFrame(badPaddingLow)).toThrow(NshFrameCodecError);

    const badTimestamp = packNshBinaryFrame(BASE_FRAME);
    new DataView(
      badTimestamp.buffer,
      badTimestamp.byteOffset,
      badTimestamp.byteLength,
    ).setUint32(52, 0x200000, true);
    expect(() => readNshBinaryFrame(badTimestamp)).toThrow(NshFrameCodecError);

    const floatSlots: ReadonlyArray<[number, number]> = [
      [16, Number.NaN],
      [24, Number.POSITIVE_INFINITY],
      [32, Number.NEGATIVE_INFINITY],
      [40, Number.NaN],
    ];
    for (const [offset, nonFiniteValue] of floatSlots) {
      const corrupt = packNshBinaryFrame(BASE_FRAME);
      new DataView(
        corrupt.buffer,
        corrupt.byteOffset,
        corrupt.byteLength,
      ).setFloat64(offset, nonFiniteValue, true);

      const target = createNshFrameTarget();
      target.rowIndex = 777;
      try {
        readNshBinaryFrameInto(corrupt, target);
        throw new Error(`expected offset ${offset} to fail`);
      } catch (error) {
        expect(error).toBeInstanceOf(NshFrameCodecError);
        expect((error as NshFrameCodecError).code).toBe("invalid_number");
        expect((error as NshFrameCodecError).message).toContain(
          "ERR_FRAME_INVALID_FINANCIAL_DATA",
        );
      }
      expect(target.rowIndex).toBe(777);
    }
  });

  test("surfaces the error code, not just a message", () => {
    try {
      readNshBinaryFrame(new Uint8Array(1));
      throw new Error("expected readNshBinaryFrame to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NshFrameCodecError);
      expect((error as NshFrameCodecError).code).toBe("short_frame");
    }
  });
});

describe("NSH frame origin/writer wire ids", () => {
  test("channel ordinal 15 does not bleed into the SLA field", () => {
    const frame = readNshBinaryFrame(
      packNshBinaryFrame({
        ...BASE_FRAME,
        channelId: 15,
        slaDivide10Ms: 0,
        rowIndex: 0xfffff,
      }),
    );
    expect(frame.channelId).toBe(15);
    expect(frame.slaDivide10Ms).toBe(0);
    expect(frame.rowIndex).toBe(0xfffff);
  });

  test("reserved byte 58 is zeroed by the writer and rejected when dirty", () => {
    const bytes = packNshBinaryFrame(BASE_FRAME);
    expect(bytes[NSH_FRAME_LAYOUT.RESERVED_8.offset]).toBe(0);

    const dirty = packNshBinaryFrame(BASE_FRAME);
    dirty[NSH_FRAME_LAYOUT.RESERVED_8.offset] = 1;
    expect(() => readNshBinaryFrame(dirty)).toThrow(NshFrameCodecError);
  });

  test("unknown origin domain or writer lane byte fails closed", () => {
    const badOrigin = packNshBinaryFrame(BASE_FRAME);
    badOrigin[NSH_FRAME_LAYOUT.ORIGIN_DOMAIN_8.offset] = 99;
    try {
      readNshBinaryFrame(badOrigin);
      throw new Error("expected invalid_origin_domain");
    } catch (error) {
      expect((error as NshFrameCodecError).code).toBe("invalid_origin_domain");
    }

    const badLane = packNshBinaryFrame(BASE_FRAME);
    badLane[NSH_FRAME_LAYOUT.WRITER_LANE_8.offset] = 99;
    try {
      readNshBinaryFrame(badLane);
      throw new Error("expected invalid_writer_lane");
    } catch (error) {
      expect((error as NshFrameCodecError).code).toBe("invalid_writer_lane");
    }
  });

  test("channelOrdinalFromFrame decodes bits 28..31 of the packed handle", () => {
    expect(channelOrdinalFromFrame(packChannelHandle32(15, 0, 0))).toBe(15);
    expect(channelOrdinalFromFrame(packChannelHandle32(0, 255, 0xfffff))).toBe(
      0,
    );
  });
});

describe("NSH frame schema & BridgeChannelPackedWord32 integration", () => {
  test("exports spec constants and message types (TICKER_MATCH, LIABILITY_UPDATE, ORDERBOOK_DELTA)", () => {
    expect(NSH_MAGIC_BYTE).toBe(0x4e);
    expect(NSH_VERSION).toBe(0x06);
    expect(NSH_MESSAGE_TYPE.TICKER_MATCH).toBe(0x01);
    expect(NSH_MESSAGE_TYPE.LIABILITY_UPDATE).toBe(0x02);
    expect(NSH_MESSAGE_TYPE.ORDERBOOK_DELTA).toBe(0x03);
  });

  test("packs and unpacks ChannelPackedHandle32 losslessly with explicit bit-width fields", () => {
    const handle32 = packChannelHandle32(5, 50, 0x76543);
    expect(unpackChannelHandle32(handle32)).toEqual({
      channelId4: 5,
      slaDivide10Ms8: 50,
      rowIndex20: 0x76543,
      channelId: 5,
      slaDivide10Ms: 50,
      rowIndex: 0x76543,
    });
  });

  test("bridges BridgeChannelPackedWord32 with explicit source-bridge provenance (PARTNER_118 vs FANTASY_402)", () => {
    const partner118GsliveWord32 = encodeBridgeChannelPackedWord32(
      "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
      "GSLIVE",
    );
    expect(decodeBridgeChannelPackedWord32(partner118GsliveWord32)).toEqual({
      bridgeOrdinal4: 3,
      channelOrdinal5: 5,
      channelBehaviorFlagsBitSet5: 2,
      channelBehaviorFlags5: 2,
    });
    expect(resolveRouteWordChannelAndSla(partner118GsliveWord32)).toEqual({
      channelId4: 5,
      slaDivide10Ms8: 50,
      channelId: 5,
      slaDivide10Ms: 50,
      provenance: "GSLIVE",
      sourceBridgePrefix: "PARTNER_118",
      bridgeQualifiedChannelCode: "PARTNER_118_GSLIVE",
      originDomainId: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
      venueId: "gslive_partner118",
      originBrandColorHex: "#28a745",
    });
    expect(
      unpackChannelHandle32(
        packChannelHandleFromRouteWord32(partner118GsliveWord32, 42),
      ),
    ).toEqual({
      channelId4: 5,
      slaDivide10Ms8: 50,
      rowIndex20: 42,
      channelId: 5,
      slaDivide10Ms: 50,
      rowIndex: 42,
    });

    const fantasy402GsliveWord32 = encodeBridgeChannelPackedWord32(
      "BRIDGE_01_F402_BET_TICKER_STREAM",
      "GSLIVE",
    );
    expect(
      resolveRouteWordChannelAndSla(fantasy402GsliveWord32)
        .bridgeQualifiedChannelCode,
    ).toBe("FANTASY_402_GSLIVE");

    const alertWord32 = encodeBridgeChannelPackedWord32(
      "BRIDGE_01_F402_BET_TICKER_STREAM",
      "ALERT",
    );
    expect(resolveRouteWordChannelAndSla(alertWord32)).toEqual({
      channelId4: 3,
      slaDivide10Ms8: 25,
      channelId: 3,
      slaDivide10Ms: 25,
      provenance: "ALERT",
      sourceBridgePrefix: "FANTASY_402",
      bridgeQualifiedChannelCode: "FANTASY_402_ALERT",
      originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
      venueId: "f402",
      originBrandColorHex: "#1d84b5",
    });

    const internetWord32 = encodeBridgeChannelPackedWord32(
      "BRIDGE_01_F402_BET_TICKER_STREAM",
      "Internet",
    );
    expect(resolveRouteWordChannelAndSla(internetWord32)).toEqual({
      channelId4: 4,
      slaDivide10Ms8: 150,
      channelId: 4,
      slaDivide10Ms: 150,
      provenance: "Internet",
      sourceBridgePrefix: "FANTASY_402",
      bridgeQualifiedChannelCode: "FANTASY_402_INTERNET",
      originDomainId: "ORIGIN_SPORTSBOOK_FANTASY402",
      venueId: "f402",
      originBrandColorHex: "#1d84b5",
    });

    expect(() =>
      decodeBridgeChannelPackedWord32(NULL_BRIDGE_CHANNEL_WORD32),
    ).toThrow(NshFrameCodecError);
  });

  test("Bridge mask throws on cross-contamination", () => {
    expect(() => {
      packChannelHandleFromRouteWord32({
        bridgeOrdinal4: BridgeOrdinal.FANTASY_402,
        channelOrdinal5: ChannelOrdinal.PARTNER_118_GSLIVE,
      });
    }).toThrow("ERR_BRIDGE_CHANNEL_MISMATCH");

    expect(() => {
      packChannelHandleFromRouteWord32({
        bridgeOrdinal4: BridgeOrdinal.PARTNER_118,
        channelOrdinal5: ChannelOrdinal.ALERT,
      });
    }).toThrow("ERR_BRIDGE_CHANNEL_MISMATCH");
  });

  test("Frame is strictly 64 bytes and padding is zeroed", () => {
    const frame = packNshFrameToArrayBuffer(BASE_FRAME);
    expect(frame.byteLength).toBe(64);
    expect(NSH_FRAME_SIZE_CHECK_64).toBe(64);

    const view = new DataView(frame);
    expect(
      view.getUint16(NSH_FRAME_LAYOUT.RESERVED_PADDING_16.offset, true),
    ).toBe(0x0000);
  });

  test("Frozen artifact citation validates without mutating oracle", () => {
    const citation = TOKENS_SSOT_ARTIFACT_CITATION;
    const snapshot = { ...citation };
    expect(assertValidFrozenArtifactCitation(citation)).toBe(true);
    expect(citation).toEqual(snapshot);
    expect(Object.isFrozen(citation)).toBe(true);
  });

  test("enforces Frozen Rule (name, commitOrTag, dateIso) and Evergreen Rule", () => {
    expect(() =>
      assertValidFrozenArtifactCitation(TOKENS_SSOT_ARTIFACT_CITATION),
    ).not.toThrow();
    expect(() =>
      assertValidFrozenArtifactCitation({
        name: "design/tokens.toml",
        commitOrTag: "",
        dateIso: "2026-11-10",
      }),
    ).toThrow(NshFrameCodecError);
    expect(() =>
      auditNamingConstitutionCompliance("const x = 1;", "sample.ts"),
    ).not.toThrow();
    expect(() =>
      auditNamingConstitutionCompliance(
        ["const", "ver = 'DOD" + "6';"].join(" "),
        "sample.ts",
      ),
    ).toThrow(NshFrameCodecError);
  });

  test("packs a SeparatedBridgeChannelEnvelope directly into a 64-byte frame", () => {
    const envelope = resolveSeparatedBridgeAndChannelEnvelope({
      transportBridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
      ticketWriterToken: "GSLIVE",
      wagerTypeCode: "S",
      shortDescriptionPrefix: "M",
      ticketLegCount: 1,
      rawBoardRotationNumber: 501,
      amountWageredCents: asCents(250_000),
    });

    const writer = new NshFrameWriter();
    const bytes = packRouteEnvelopeToNshFrame(
      envelope,
      {
        messageType: NSH_MESSAGE_TYPE.LIABILITY_UPDATE,
        rowIndex: 1024,
        betGroupId: 9001n,
        stakeUsdc: 2500,
        bookOdds: 1.91,
        polyAvgPrice: 0.51,
        liabilityDelta: -2275,
        flags: 0x0001,
        slippageBps: 18,
        timestampMs: 1_700_000_123_456,
      },
      writer,
    );

    const unpacked = readNshBinaryFrame(bytes);
    expect(unpacked.messageType).toBe(NSH_MESSAGE_TYPE.LIABILITY_UPDATE);
    expect(unpacked.channelId).toBe(5);
    expect(unpacked.slaDivide10Ms).toBe(50);
    expect(unpacked.rowIndex).toBe(1024);
    expect(unpacked.betGroupId).toBe(9001n);
    expect(unpacked.originDomainWireId).toBe(OriginDomainWireId.GSLIVE_118);
    expect(unpacked.originDomainId).toBe("ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118");
    expect(unpacked.writerLaneWireId).toBe(WriterLaneWireId.GSLIVE);
    expect(unpacked.slippageBps).toBe(18);
  });

  test("packNshFrameToArrayBuffer returns a 64-byte ArrayBuffer readable by DataView and readNshBinaryFrameFromArrayBuffer", () => {
    const ab = packNshFrameToArrayBuffer({
      ...BASE_FRAME,
      messageType: NSH_MESSAGE_TYPE.ORDERBOOK_DELTA,
    });
    expect(ab.byteLength).toBe(64);
    const frame = readNshBinaryFrameFromArrayBuffer(ab);
    expect(frame.messageType).toBe(NSH_MESSAGE_TYPE.ORDERBOOK_DELTA);
    expect(frame.originDomainId).toBe("ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118");
    expect(frame.writerLaneId).toBe("gslive");
  });

  test("broadcastFrame handles PUBLISHED, BACKPRESSURED (-1), and DROPPED (0)", () => {
    const frame = packNshBinaryFrame(BASE_FRAME);
    const calls: Array<{
      topic: string;
      len: number;
      compress: boolean | undefined;
    }> = [];

    const okResult = broadcastFrame(
      {
        publish(topic, data, compress) {
          calls.push({ topic, len: data.byteLength, compress });
          return 64;
        },
      },
      frame,
    );
    expect(okResult).toEqual({ disposition: "PUBLISHED", bytesOrStatus: 64 });
    expect(calls[0]).toEqual({
      topic: "nsh_blotter",
      len: 64,
      compress: false,
    });

    const bpResult = broadcastFrame(
      {
        publish() {
          return -1;
        },
      },
      frame,
    );
    expect(bpResult).toEqual({
      disposition: "BACKPRESSURED",
      bytesOrStatus: -1,
    });

    const dropResult = broadcastFrame(
      {
        publish() {
          return 0;
        },
      },
      frame,
    );
    expect(dropResult).toEqual({ disposition: "DROPPED", bytesOrStatus: 0 });
  });

  test("passes NAMING-GATE-04 and Naming Constitution Evergreen Rule static policing", async () => {
    const [codecSource, schemaSource, paletteSource, registrySource] =
      await Promise.all([
        Bun.file(new URL("../lib/nsh_frame_codec.ts", import.meta.url)).text(),
        Bun.file(new URL("../lib/nsh_frame_schema.ts", import.meta.url)).text(),
        Bun.file(
          new URL("../lib/provenance_palette.ts", import.meta.url),
        ).text(),
        Bun.file(
          new URL("../lib/domain_venue_registry.ts", import.meta.url),
        ).text(),
      ]);
    auditSourceCodeNamingCompliance(codecSource, "nsh_frame_codec.ts");
    auditSourceCodeNamingCompliance(schemaSource, "nsh_frame_schema.ts");
    auditSourceCodeNamingCompliance(paletteSource, "provenance_palette.ts");
    auditSourceCodeNamingCompliance(registrySource, "domain_venue_registry.ts");
    auditNamingConstitutionCompliance(codecSource, "nsh_frame_codec.ts");
    auditNamingConstitutionCompliance(schemaSource, "nsh_frame_schema.ts");
    auditNamingConstitutionCompliance(paletteSource, "provenance_palette.ts");
    auditNamingConstitutionCompliance(
      registrySource,
      "domain_venue_registry.ts",
    );
  });

  test("unifies OriginDomainId, WriterLaneId, and VenueId across domain_venue_registry", () => {
    const inetLane: WriterLaneId = resolveWriterLaneId("Internet");
    expect(inetLane).toBe("internet");
    expect(resolveWriterLaneId("GSLIVE")).toBe("gslive");
    expect(resolveOriginDomainForWriter("inet")).toBe(
      "ORIGIN_SPORTSBOOK_FANTASY402",
    );
    expect(resolveOriginDomainForWriter("gslive")).toBe(
      "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    );
    const f402Origin: OriginDomainId = "ORIGIN_SPORTSBOOK_FANTASY402";
    const f402Venue: VenueId = resolveVenueIdForOrigin(f402Origin);
    expect(f402Venue).toBe("f402");
    expect(ORIGIN_DOMAIN_REGISTRY[f402Origin].venueId).toBe("f402");
    expect(WRITER_LANE_REGISTRY.gslive.venueId).toBe("gslive_partner118");
  });
});

describe("NSH subscriber flow control", () => {
  test("pauses subscriber socket on backpressure (-1) and resumes on drain", () => {
    const frame = packNshBinaryFrame(BASE_FRAME);
    let nextReturn = -1;
    let pauses = 0;
    let resumes = 0;
    let lastCompress: boolean | undefined;
    const ws: NshSubscriberSocket = {
      send: (_data, compress) => {
        lastCompress = compress;
        return nextReturn;
      },
      pause: () => {
        pauses += 1;
      },
      resume: () => {
        resumes += 1;
      },
    };

    expect(sendNshFrameToSubscriber(ws, frame)).toEqual({
      disposition: "BACKPRESSURED",
      bytesOrStatus: -1,
    });
    expect(lastCompress).toBe(false);
    expect(pauses).toBe(1);

    nextReturn = 0;
    expect(sendNshFrameToSubscriber(ws, frame)).toEqual({
      disposition: "DROPPED",
      bytesOrStatus: 0,
    });
    expect(pauses).toBe(1);

    nextReturn = 64;
    expect(sendNshFrameToSubscriber(ws, frame)).toEqual({
      disposition: "PUBLISHED",
      bytesOrStatus: 64,
    });
    expect(pauses).toBe(1);

    resumeNshSubscriber(ws);
    expect(resumes).toBe(1);
  });
});
