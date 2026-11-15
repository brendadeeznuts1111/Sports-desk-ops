#!/usr/bin/env python3
"""Independent reference decoder for the 64-byte NSH frame.

Deliberately written from the offset table alone, without importing or reading
the TypeScript codec, so that agreement between the two is evidence rather than
a shared implementation. Reads hex frames (one per line) from stdin and writes a
JSON array of decoded objects to stdout.

Usage:
    python3 tests/fixtures/nsh_frames/reference_decoder.py < frames.hex
"""

import json
import struct
import sys

FRAME_BYTES = 64
MAGIC = 0x4E
VERSION = 6

# Wire id -> canonical registry id. Duplicated on purpose: a change here that is
# not mirrored in lib/domain-enums.ts is exactly what this decoder must catch.
ORIGIN_BY_ID = {
    0: "UNSET",
    1: "ORIGIN_SPORTSBOOK_FANTASY402",
    2: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    3: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    4: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    5: "ORIGIN_STORAGE_R2_LAKEHOUSE",
    6: "ORIGIN_HOST_NSH_DESK_LOCAL",
}
LANE_BY_ID = {
    0: "unknown",
    1: "alert",
    2: "gslive",
    3: "inet",
    4: "gsbuilder",
    5: "cslevel2",
    6: "gateway",
    7: "blocked",
}


def decode(raw: bytes) -> dict:
    if len(raw) != FRAME_BYTES:
        raise ValueError(f"short_frame: {len(raw)} bytes")
    if raw[0] != MAGIC:
        raise ValueError(f"bad magic 0x{raw[0]:02x}")
    if raw[1] != VERSION:
        raise ValueError(f"bad version {raw[1]}")

    handle = struct.unpack_from("<I", raw, 4)[0]
    timestamp_ms = struct.unpack_from("<Q", raw, 48)[0]

    origin_id = raw[56]
    lane_id = raw[57]
    if raw[58] != 0:
        raise ValueError("reserved byte 58 must be zero")
    if struct.unpack_from("<H", raw, 62)[0] != 0:
        raise ValueError("padding 62..63 must be zero")
    if origin_id not in ORIGIN_BY_ID:
        raise ValueError(f"unknown origin domain wire id {origin_id}")
    if lane_id not in LANE_BY_ID:
        raise ValueError(f"unknown writer lane wire id {lane_id}")

    return {
        "messageType": raw[2],
        "channelId": (handle >> 28) & 0xF,
        "slaDivide10Ms": (handle >> 20) & 0xFF,
        "rowIndex": handle & 0xFFFFF,
        "betGroupId": str(struct.unpack_from("<Q", raw, 8)[0]),
        "stakeUsdc": struct.unpack_from("<d", raw, 16)[0],
        "bookOdds": struct.unpack_from("<d", raw, 24)[0],
        "polyAvgPrice": struct.unpack_from("<d", raw, 32)[0],
        "liabilityDelta": struct.unpack_from("<d", raw, 40)[0],
        "timestampMs": timestamp_ms,
        "originDomainWireId": origin_id,
        "originDomainId": ORIGIN_BY_ID[origin_id],
        "writerLaneWireId": lane_id,
        "writerLaneId": LANE_BY_ID[lane_id],
        "flags": struct.unpack_from("<H", raw, 59)[0],
        "slippageBps": raw[61],
    }


def main() -> int:
    lines = [line.strip() for line in sys.stdin if line.strip()]
    out = []
    for line in lines:
        try:
            out.append(decode(bytes.fromhex(line)))
        except ValueError as error:
            out.append({"error": str(error)})
    json.dump(out, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
