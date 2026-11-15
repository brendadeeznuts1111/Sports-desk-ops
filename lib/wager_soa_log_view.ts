/**
 * @file wager_soa_log_view.ts
 * @description DLP-safe logging wrapper: never dumps column payloads in inspect/JSON.
 */

import type { WagerSoATableLayout } from "./wager_soa.ts";

export class WagerSoALogView {
  public readonly layout: WagerSoATableLayout;

  public constructor(layout: WagerSoATableLayout) {
    this.layout = layout;
  }

  [Bun.inspect.custom](): string {
    const { capacity, spreadCol, totalCol, oddsCol } = this.layout;
    const slabBytes: number =
      spreadCol.byteLength + totalCol.byteLength + oddsCol.byteLength;
    return (
      `WagerSoATable { capacity: ${capacity}, columns: spread|total|odds, ` +
      `slabBytes: ${slabBytes}, data: [REDACTED] }`
    );
  }

  toJSON(): { readonly kind: "WagerSoATable"; readonly capacity: number } {
    return { kind: "WagerSoATable", capacity: this.layout.capacity };
  }
}

/** High-frequency log sites: wrap the table so `Bun.inspect` never materializes odds/spread rows. */
export function wagerSoAForLog(layout: WagerSoATableLayout): WagerSoALogView {
  return new WagerSoALogView(layout);
}
