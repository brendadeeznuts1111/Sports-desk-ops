/** Section 6b of domain-branded-types.ts (transport, packed handles and binary domains). */
export const DOMAIN_BRANDED_TRANSPORT = `// ============================================================================
// 6b. TRANSPORT BRIDGE, PACKED HANDLES & BINARY DOMAIN BRANDS
// ============================================================================

export type SettledCents = Brand<number, "SettledCents">;
export type LifetimeCents = Brand<number, "LifetimeCents">;
export type LineHundredths = Brand<number, "LineHundredths">;
export type EpochDays = Brand<number, "EpochDays">;
export type DurationMilliseconds = Brand<number, "DurationMilliseconds">;
export type BitSet32 = Brand<number, "BitSet32">;
export type TransportBridgeBitMask32 = Brand<
  number,
  "TransportBridgeBitMask32"
>;
export type BridgeChannelPackedWord32 = Brand<
  number,
  "BridgeChannelPackedWord32"
>;
export type CustomerPackedHandle32 = Brand<number, "CustomerPackedHandle32">;
export type CustomerPackedHandle64 = Brand<bigint, "CustomerPackedHandle64">;
export type CustomerPackedKey64 = Brand<bigint, "CustomerPackedKey64">;
export type ComboPackedKey15 = Brand<number, "ComboPackedKey15">;

export function asSettledCents(value: number): SettledCents {
  return Math.trunc(value) as SettledCents;
}

export function asLifetimeCents(value: number): LifetimeCents {
  return Math.trunc(value) as LifetimeCents;
}

export function asLineHundredths(value: number): LineHundredths {
  return Math.trunc(value) as LineHundredths;
}

export function asEpochDays(value: number): EpochDays {
  return Math.trunc(value) as EpochDays;
}

export function asDurationMilliseconds(value: number): DurationMilliseconds {
  return Math.trunc(value) as DurationMilliseconds;
}

export function asBitSet32(value: number): BitSet32 {
  return (value >>> 0) as BitSet32;
}

export function asTransportBridgeBitMask32(
  value: number,
): TransportBridgeBitMask32 {
  return (value >>> 0) as TransportBridgeBitMask32;
}

export function asBridgeChannelPackedWord32(
  value: number,
): BridgeChannelPackedWord32 {
  return (value >>> 0) as BridgeChannelPackedWord32;
}

export function asCustomerPackedHandle32(
  value: number,
): CustomerPackedHandle32 {
  return (value >>> 0) as CustomerPackedHandle32;
}

export function asCustomerPackedHandle64(
  value: bigint,
): CustomerPackedHandle64 {
  return BigInt.asUintN(64, value) as CustomerPackedHandle64;
}

export function asCustomerPackedKey64(value: bigint): CustomerPackedKey64 {
  return BigInt.asUintN(64, value) as CustomerPackedKey64;
}

export function asComboPackedKey15(value: number): ComboPackedKey15 {
  return (value & 0x7fff) as ComboPackedKey15;
}
`;
