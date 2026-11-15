/**
 * @file wager_soa.ts
 * @description Zero-allocation Structure-of-Arrays wager columns on one slab.
 * Explicit exported types for `isolatedDeclarations` / `bun check -b`.
 */

import type { Brand } from "./brand.ts";

export type WagerSpreadColumn = Brand<Int32Array, "WagerSpreadColumn">;
export type WagerTotalColumn = Brand<Int32Array, "WagerTotalColumn">;
export type WagerOddsColumn = Brand<Int32Array, "WagerOddsColumn">;

export interface WagerSoATableLayout {
  readonly capacity: number;
  readonly spreadCol: WagerSpreadColumn;
  readonly totalCol: WagerTotalColumn;
  readonly oddsCol: WagerOddsColumn;
}

export function createWagerSoATable(capacity: number): WagerSoATableLayout {
  const bytesPerElement: number = Int32Array.BYTES_PER_ELEMENT;
  const buffer: ArrayBuffer = new ArrayBuffer(capacity * bytesPerElement * 3);
  const length: number = capacity;
  const stride: number = capacity * bytesPerElement;

  return {
    capacity,
    spreadCol: new Int32Array(buffer, 0, length) as WagerSpreadColumn,
    totalCol: new Int32Array(buffer, stride, length) as WagerTotalColumn,
    oddsCol: new Int32Array(buffer, stride * 2, length) as WagerOddsColumn,
  };
}
