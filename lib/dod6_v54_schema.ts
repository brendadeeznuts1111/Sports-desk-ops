/**
 * Pinned DOD6 v5.4 schema constants.
 *
 * The writer lives in the external turbo-cap checkout. This file is the repo-local projection of
 * `schema/dod6-v54.schema.json`; the test suite asserts the constants below match that vendored
 * JSON, and `createDod6V54LifetimeReader` checks magic/version/capacity at open. Do not redefine
 * these values in a reader.
 */
export const DOD6_SCHEMA_PATH = "schema/dod6-v54.schema.json" as const;
/** SHA-256 of the vendored JSON bytes; the byte-level pin for this checkout. */
export const DOD6_SCHEMA_SHA256 =
  "c68c87fa9cb371d865a8e0e6df0b2e2f9bbcd0dbe67a35ff4a5163ff630bb3f8" as const;

export const DOD6_MAGIC = 0x444f4436;
export const DOD6_MAGIC_ASCII = "DOD6";
export const DOD6_VERSION = 54;
export const DOD6_SUPPORTED_VERSIONS: readonly number[] = [54];
export const DOD6_HEADER_BYTE_LENGTH = 2048;
export const DOD6_HEADER_UINT32_SLOTS = 512;
export const DOD6_SECTION_COUNT = 88;
export const DOD6_ALIGNMENT_BYTES = 64;

/** 15-bit row field. Row index 0x7fff is reserved: it is the row field of the all-ones null
 * handle 0xFFFFFFFF. The writer's `maxCustomerRows32` (32,766) is the maximum valid row
 * *index*, so capacity = 32,767 rows. */
export const DOD6_HANDLE32_ROW_SHIFT = 0;
export const DOD6_HANDLE32_ROW_BITS = 15;
export const DOD6_HANDLE32_ROW_MASK = 0x7fff;
export const DOD6_HANDLE32_GENERATION_SHIFT = 15;
export const DOD6_HANDLE32_GENERATION_BITS = 2;
export const DOD6_HANDLE32_GENERATION_MASK = 0x3;
export const DOD6_HANDLE32_GENERATION_WRAP = 4;
export const DOD6_MAX_ROW_INDEX_32 = 32_766;
export const DOD6_RESERVED_ROW_INDEX_32 = 32_767;
export const DOD6_MAX_ROWS_32 = 32_767;

/** 64-bit path precondition: row 20 bits, generation 8 bits, must be read as two u32 lanes. */
export const DOD6_HANDLE64_ROW_BITS = 20;
export const DOD6_HANDLE64_GENERATION_SHIFT = 20;
export const DOD6_HANDLE64_GENERATION_BITS = 8;
export const DOD6_HANDLE64_GENERATION_MASK = 0xff;
export const DOD6_HANDLE64_GENERATION_WRAP = 256;
/** 20-bit row field. Row index 0xFFFFF is reserved: it is the row field of the all-ones null
 * handle 0xFFFFFFFFFFFFFFFF. The writer's `maxCustomerRows64` (1,048,574) is the maximum valid
 * row *index*, so capacity is 1,048,575 rows. Not wired in this reader. */
export const DOD6_MAX_ROW_INDEX_64 = 1_048_574;
export const DOD6_RESERVED_ROW_INDEX_64 = 1_048_575;
export const DOD6_MAX_ROWS_64 = 1_048_575;

export const DOD6_RADIX_SLOT_COUNT = 65_536;
export const DOD6_NULL_CLV_SENTINEL = -2_147_483_648;

export function isSupportedDod6Version(version: number): boolean {
  return DOD6_SUPPORTED_VERSIONS.includes(version);
}

/** Word 0 is the magic and word 1 the format version; row capacity is checked separately. */
export function isValidDod6Header(header: Uint32Array): boolean {
  return (
    header[0] === DOD6_MAGIC && isSupportedDod6Version(header[1] ?? Number.NaN)
  );
}

/** A 32-bit handle's row field is only sound when the row table fits it. */
export function isValidDod6RowCapacity(rowCapacity: number): boolean {
  return (
    Number.isInteger(rowCapacity) &&
    rowCapacity > 0 &&
    rowCapacity <= DOD6_MAX_ROWS_32
  );
}
