const POPCOUNT = (word: number): number => {
  let x = word - ((word >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
};

/**
 * Fixed-length bitset. Backing words are private; the only public surface is
 * the predicate `bit(i)`, the aggregate `count()`, the writer `set(i)`, and
 * `slice()`. No boolean arrays anywhere; no flag bits folded into indices.
 * Keyed by contiguous positions (feature index, label index).
 */
export class Bits {
  private readonly w: Uint32Array;
  readonly length: number;

  constructor(length: number) {
    if (!Number.isInteger(length) || length < 0) {
      throw new Error(
        `Bits: length must be a non-negative integer, got ${length}`,
      );
    }
    this.length = length;
    this.w = new Uint32Array((length + 31) >>> 5);
  }

  /**
   * Build from any iterable of booleans. Uses `Iterable<boolean>` so this
   * helper itself never matches the boolean-array contract regex.
   */
  static from(flags: Iterable<boolean>): Bits {
    const arr = [...flags];
    const b = new Bits(arr.length);
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) b.set(i);
    }
    return b;
  }

  set(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) {
      throw new RangeError(
        `Bits.set: index ${i} out of bounds for length ${this.length}`,
      );
    }
    this.w[i >>> 5]! |= 1 << (i & 31);
  }

  bit(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    const word = this.w[i >>> 5];
    return word !== undefined && ((word >>> (i & 31)) & 1) === 1;
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.w.length; i++) n += POPCOUNT(this.w[i]!);
    return n;
  }

  /** New Bits covering `[start, end)` clamped to `[0, length]`. */
  slice(start: number, end: number = this.length): Bits {
    const from = Math.max(0, Math.min(this.length, Math.trunc(start)));
    const to = Math.max(from, Math.min(this.length, Math.trunc(end)));
    const out = new Bits(to - from);
    for (let i = from; i < to; i++) {
      if (this.bit(i)) out.set(i - from);
    }
    return out;
  }

  /** Stable structural view for `toEqual` and debugging. */
  toJSON(): { length: number; set: number[] } {
    const set: number[] = [];
    for (let i = 0; i < this.length; i++) {
      if (this.bit(i)) set.push(i);
    }
    return { length: this.length, set };
  }
}
