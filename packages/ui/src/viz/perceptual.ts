/**
 * @file packages/ui/src/viz/perceptual.ts
 * @description Pure staging, conservation, scale, regime, outlier, label and contrast rules for
 * dashboard charts. Browser-safe: standard Web APIs only. See docs/dashboard-perceptual-makeover.md.
 */

export const STAGING_CONTRACT = "dash-stage/1" as const;

export class StagingValueError extends Error {
  override readonly name = "StagingValueError";
  readonly key: string;
  readonly reason: string;
  constructor(key: string, reason: string, detail: string) {
    super(`[${STAGING_CONTRACT}] ${reason} for "${key}": ${detail}`);
    this.key = key;
    this.reason = reason;
  }
}

export class ConservationError extends Error {
  override readonly name = "ConservationError";
  readonly delta: number;
  readonly unit: string;
  constructor(stagedTotal: number, controlTotal: number, unit = "¢") {
    const delta = stagedTotal - controlTotal;
    super(
      `[${STAGING_CONTRACT}] staged total ${stagedTotal}${unit} != control total ${controlTotal}${unit} (delta ${delta}${unit})`,
    );
    this.delta = delta;
    this.unit = unit;
  }
}

export class ZeroBaselineError extends Error {
  override readonly name = "ZeroBaselineError";
  constructor(domain: readonly [number, number]) {
    super(
      `bar/column scale domain [${domain[0]}, ${domain[1]}] must be finite and include 0`,
    );
  }
}

export class InsufficientSeriesError extends Error {
  override readonly name = "InsufficientSeriesError";
  constructor(what: string, needed: number, got: number) {
    super(`${what} needs at least ${needed} points, got ${got}`);
  }
}

export class DayKeyError extends Error {
  override readonly name = "DayKeyError";
  constructor(day: string) {
    super(`day key "${day}" is not a valid YYYY-MM-DD calendar date`);
  }
}

export class HexColorError extends Error {
  override readonly name = "HexColorError";
  constructor(hex: string) {
    super(`"${hex}" is not a #rrggbb color`);
  }
}

const USD_TEXT_PATTERN =
  /^\s*(-)?\s*\$?\s*(-)?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{1,2}))?\s*$/;
const FOOTER_KEY_PATTERN =
  /^\s*(?:grand\s+)?(?:sub)?totals?\b|^\s*(?:sum|all|σ|Σ)\s*$/i;
const SUB_CENT_TOLERANCE = 1e-6;

export function isFooterKey(key: string): boolean {
  return FOOTER_KEY_PATTERN.test(key);
}

export function toScaledInteger(
  key: string,
  raw: number,
  unitsPerWhole: number,
): number {
  if (!Number.isFinite(raw)) {
    throw new StagingValueError(key, "non-finite", String(raw));
  }
  const scaled = raw * unitsPerWhole;
  const units = Math.round(scaled);
  if (
    Math.abs(scaled - units) >
    SUB_CENT_TOLERANCE * Math.max(1, Math.abs(scaled))
  ) {
    throw new StagingValueError(
      key,
      "sub-unit-precision",
      `${raw} at 1/${unitsPerWhole}`,
    );
  }
  if (!Number.isSafeInteger(units)) {
    throw new StagingValueError(key, "unsafe-integer", String(raw));
  }
  return units === 0 ? 0 : units;
}

export function assertScaledConservation(
  parts: readonly { readonly key: string; readonly value: number }[],
  control: number,
  unitsPerWhole: number,
  unit: string,
): number {
  let staged = 0;
  for (const part of parts)
    staged += toScaledInteger(part.key, part.value, unitsPerWhole);
  const controlUnits = toScaledInteger("control-total", control, unitsPerWhole);
  if (staged !== controlUnits) {
    throw new ConservationError(staged, controlUnits, unit);
  }
  return staged;
}

export function parseUsdCents(key: string, raw: number | string): number {
  if (typeof raw === "number") {
    return toScaledInteger(key, raw, 100);
  }
  const match = USD_TEXT_PATTERN.exec(raw);
  if (match === null) {
    throw new StagingValueError(key, "unparseable-usd", JSON.stringify(raw));
  }
  if (match[1] !== undefined && match[2] !== undefined) {
    throw new StagingValueError(key, "double-sign", JSON.stringify(raw));
  }
  const negative = match[1] !== undefined || match[2] !== undefined;
  const whole = Number((match[3] ?? "").replaceAll(",", ""));
  const fraction = Number((match[4] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents)) {
    throw new StagingValueError(key, "unsafe-integer", JSON.stringify(raw));
  }
  return negative && cents !== 0 ? -cents : cents;
}

export interface StagedPoint {
  readonly key: string;
  readonly label: string;
  readonly cents: number;
}

export interface StagedSeries {
  readonly contract: typeof STAGING_CONTRACT;
  readonly points: readonly StagedPoint[];
  readonly stagedTotalCents: number;
  readonly excludedFooterKeys: readonly string[];
}

export interface StageSpec<Row> {
  readonly key: (row: Row) => string;
  readonly label?: (row: Row) => string;
  readonly value: (row: Row) => number | string;
}

export function stageCentsSeries<Row>(
  rows: readonly Row[],
  spec: StageSpec<Row>,
): StagedSeries {
  const points: StagedPoint[] = [];
  const excludedFooterKeys: string[] = [];
  const seen = new Set<string>();
  let stagedTotalCents = 0;
  for (const row of rows) {
    const key = spec.key(row);
    if (isFooterKey(key)) {
      excludedFooterKeys.push(key);
      continue;
    }
    if (seen.has(key)) {
      throw new StagingValueError(
        key,
        "duplicate-key",
        "a staged series key must be unique",
      );
    }
    seen.add(key);
    const cents = parseUsdCents(key, spec.value(row));
    stagedTotalCents += cents;
    if (!Number.isSafeInteger(stagedTotalCents)) {
      throw new StagingValueError(
        key,
        "unsafe-integer",
        "running total overflowed",
      );
    }
    points.push(
      Object.freeze({ key, label: spec.label ? spec.label(row) : key, cents }),
    );
  }
  return Object.freeze({
    contract: STAGING_CONTRACT,
    points: Object.freeze(points),
    stagedTotalCents,
    excludedFooterKeys: Object.freeze(excludedFooterKeys),
  });
}

export type ConservationResult =
  | {
      readonly ok: true;
      readonly stagedTotalCents: number;
      readonly controlTotalCents: number;
      readonly deltaCents: 0;
    }
  | {
      readonly ok: false;
      readonly stagedTotalCents: number;
      readonly controlTotalCents: number;
      readonly deltaCents: number;
    };

export function verifyConservation(
  series: StagedSeries,
  controlTotal: number | string,
): ConservationResult {
  const controlTotalCents = parseUsdCents("control-total", controlTotal);
  const deltaCents = series.stagedTotalCents - controlTotalCents;
  if (deltaCents === 0) {
    return {
      ok: true,
      stagedTotalCents: series.stagedTotalCents,
      controlTotalCents,
      deltaCents: 0,
    };
  }
  return {
    ok: false,
    stagedTotalCents: series.stagedTotalCents,
    controlTotalCents,
    deltaCents,
  };
}

export function assertConservation(
  series: StagedSeries,
  controlTotal: number | string,
): void {
  const result = verifyConservation(series, controlTotal);
  if (!result.ok) {
    throw new ConservationError(
      result.stagedTotalCents,
      result.controlTotalCents,
    );
  }
}

export function zeroAnchoredDomain(
  values: readonly number[],
): readonly [number, number] {
  let lo = 0;
  let hi = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new ZeroBaselineError([value, value]);
    }
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  return lo === 0 && hi === 0 ? [0, 1] : [lo, hi];
}

export function assertZeroBaseline(domain: readonly [number, number]): void {
  const [lo, hi] = domain;
  if (
    !Number.isFinite(lo) ||
    !Number.isFinite(hi) ||
    lo > 0 ||
    hi < 0 ||
    lo >= hi
  ) {
    throw new ZeroBaselineError(domain);
  }
}

export interface LinearScale {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  readonly map: (value: number) => number;
}

export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return {
    domain,
    range,
    map: (value: number) =>
      span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0),
  };
}

export function barScale(
  values: readonly number[],
  range: readonly [number, number],
): LinearScale {
  const domain = zeroAnchoredDomain(values);
  assertZeroBaseline(domain);
  return linearScale(domain, range);
}

export function sortDescendingBy<Item>(
  items: readonly Item[],
  pick: (item: Item) => number,
): Item[] {
  return items
    .map((item, order) => ({ item, order, value: pick(item) }))
    .sort((left, right) => right.value - left.value || left.order - right.order)
    .map((entry) => entry.item);
}

export const MODIFIED_Z_OUTLIER_THRESHOLD = 3.5;
export const XMR_SIGMA_FACTOR = 2.66;

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new InsufficientSeriesError("median", 1, 0);
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

export function modifiedZScores(values: readonly number[]): number[] {
  const center = median(values);
  const mad = median(values.map((value) => Math.abs(value - center)));
  if (mad === 0) {
    return values.map((value) =>
      value === center
        ? 0
        : Number.POSITIVE_INFINITY * Math.sign(value - center),
    );
  }
  return values.map((value) => (0.6745 * (value - center)) / mad);
}

export function isModifiedZOutlier(score: number): boolean {
  return Math.abs(score) > MODIFIED_Z_OUTLIER_THRESHOLD;
}

export interface ControlLimits {
  readonly rule: "xmr-2.66";
  readonly center: number;
  readonly movingRangeMean: number;
  readonly upper: number;
  readonly lower: number;
}

export function xmrLimits(values: readonly number[]): ControlLimits {
  if (values.length < 2) {
    throw new InsufficientSeriesError("XmR limits", 2, values.length);
  }
  let total = 0;
  let rangeTotal = 0;
  let previous: number | undefined;
  for (const value of values) {
    total += value;
    if (previous !== undefined) rangeTotal += Math.abs(value - previous);
    previous = value;
  }
  const center = total / values.length;
  const movingRangeMean = rangeTotal / (values.length - 1);
  return {
    rule: "xmr-2.66",
    center,
    movingRangeMean,
    upper: center + XMR_SIGMA_FACTOR * movingRangeMean,
    lower: center - XMR_SIGMA_FACTOR * movingRangeMean,
  };
}

export function outsideLimits(value: number, limits: ControlLimits): boolean {
  return value > limits.upper || value < limits.lower;
}

export type DayRegime = "steady" | "settlement" | "partial";

export const DEFAULT_SETTLEMENT_WEEKDAYS: readonly number[] = [2];

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dayKeyToUtcDate(day: string): Date {
  const match = DAY_KEY_PATTERN.exec(day);
  if (match === null) throw new DayKeyError(day);
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (date.toISOString().slice(0, 10) !== day) throw new DayKeyError(day);
  return date;
}

export function dayKeyInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export interface RegimeOptions {
  readonly today: string;
  readonly settlementWeekdays?: readonly number[];
}

export function classifyDayRegime(
  day: string,
  options: RegimeOptions,
): DayRegime {
  const date = dayKeyToUtcDate(day);
  dayKeyToUtcDate(options.today);
  if (day >= options.today) return "partial";
  const weekdays = options.settlementWeekdays ?? DEFAULT_SETTLEMENT_WEEKDAYS;
  return weekdays.includes(date.getUTCDay()) ? "settlement" : "steady";
}

export interface DailyPoint {
  readonly day: string;
  readonly value: number;
}

export interface ClassifiedDailyPoint extends DailyPoint {
  readonly regime: DayRegime;
  readonly outOfControl: boolean;
}

export interface SteadyStateTrend {
  readonly points: readonly ClassifiedDailyPoint[];
  readonly fittedCount: number;
  readonly slopePerDay: number;
  readonly intercept: number;
  readonly originDay: string;
  readonly residualLimits: ControlLimits;
}

const MS_PER_DAY = 86_400_000;

export function steadyStateTrend(
  series: readonly DailyPoint[],
  options: RegimeOptions,
): SteadyStateTrend {
  const ordered = [...series].sort((left, right) =>
    left.day < right.day ? -1 : left.day > right.day ? 1 : 0,
  );
  const regimes = ordered.map((point) => classifyDayRegime(point.day, options));
  const steady = ordered.filter(
    (_, position) => regimes[position] === "steady",
  );
  if (steady.length < 2) {
    throw new InsufficientSeriesError("steady-state trend", 2, steady.length);
  }
  const origin = dayKeyToUtcDate(steady[0]!.day).getTime();
  const xs = steady.map(
    (point) => (dayKeyToUtcDate(point.day).getTime() - origin) / MS_PER_DAY,
  );
  const ys = steady.map((point) => point.value);
  const meanX = xs.reduce((acc, value) => acc + value, 0) / xs.length;
  const meanY = ys.reduce((acc, value) => acc + value, 0) / ys.length;
  let covariance = 0;
  let variance = 0;
  xs.forEach((x, position) => {
    covariance += (x - meanX) * (ys[position]! - meanY);
    variance += (x - meanX) ** 2;
  });
  const slopePerDay = variance === 0 ? 0 : covariance / variance;
  const intercept = meanY - slopePerDay * meanX;
  const residualOf = (point: DailyPoint) =>
    point.value -
    (intercept +
      slopePerDay *
        ((dayKeyToUtcDate(point.day).getTime() - origin) / MS_PER_DAY));
  const limits = xmrLimits(steady.map(residualOf));
  const points = ordered.map((point, position) => {
    const regime = regimes[position]!;
    return {
      ...point,
      regime,
      outOfControl:
        regime === "steady" && outsideLimits(residualOf(point), limits),
    };
  });
  return {
    points,
    fittedCount: steady.length,
    slopePerDay,
    intercept,
    originDay: steady[0]!.day,
    residualLimits: limits,
  };
}

export function spreadLabels(
  desired: readonly number[],
  minGap: number,
  bounds: readonly [number, number],
): number[] {
  const order = desired
    .map((value, position) => ({ value, position }))
    .sort(
      (left, right) =>
        left.value - right.value || left.position - right.position,
    );
  const placed = order.map((entry) => entry.value);
  for (let cursor = 1; cursor < placed.length; cursor += 1) {
    placed[cursor] = Math.max(placed[cursor]!, placed[cursor - 1]! + minGap);
  }
  const overflow = (placed[placed.length - 1] ?? bounds[0]) - bounds[1];
  if (overflow > 0) {
    placed[placed.length - 1] = bounds[1];
    for (let cursor = placed.length - 2; cursor >= 0; cursor -= 1) {
      placed[cursor] = Math.min(placed[cursor]!, placed[cursor + 1]! - minGap);
    }
  }
  const result: number[] = Array.from({ length: desired.length }, () => 0);
  order.forEach((entry, rank) => {
    result[entry.position] = placed[rank]!;
  });
  return result;
}

export function labelsHonourMinGap(
  positions: readonly number[],
  minGap: number,
): boolean {
  const sorted = [...positions].sort((left, right) => left - right);
  return sorted.every(
    (value, rank) => rank === 0 || value - sorted[rank - 1]! >= minGap - 1e-9,
  );
}

export function hexToRgb(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (match === null) throw new HexColorError(hex);
  return [
    parseInt(match[1]!, 16),
    parseInt(match[2]!, 16),
    parseInt(match[3]!, 16),
  ];
}

export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

export function mixSrgb(
  foreground: string,
  background: string,
  foregroundShare: number,
): string {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  return rgbToHex([
    fg[0] * foregroundShare + bg[0] * (1 - foregroundShare),
    fg[1] * foregroundShare + bg[1] * (1 - foregroundShare),
    fg[2] * foregroundShare + bg[2] * (1 - foregroundShare),
  ]);
}

export function relativeLuminance(hex: string): number {
  const [red, green, blue] = hexToRgb(hex).map((channel) => {
    const unit = channel / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

export type Lab = readonly [number, number, number];

export function deltaE2000(first: Lab, second: Lab): number {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const rad = Math.PI / 180;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cMean = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const hue = (bp: number, ap: number) => {
    if (bp === 0 && ap === 0) return 0;
    const angle = Math.atan2(bp, ap) / rad;
    return angle < 0 ? angle + 360 : angle;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const deltaL = l2 - l1;
  const deltaC = c2p - c1p;
  let deltaHue = 0;
  if (c1p * c2p !== 0) {
    deltaHue = h2p - h1p;
    if (deltaHue > 180) deltaHue -= 360;
    else if (deltaHue < -180) deltaHue += 360;
  }
  const deltaH = 2 * Math.sqrt(c1p * c2p) * Math.sin((deltaHue * rad) / 2);
  const lMean = (l1 + l2) / 2;
  const cpMean = (c1p + c2p) / 2;
  let hMean = h1p + h2p;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hMean = (h1p + h2p) / 2;
    else
      hMean = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos((hMean - 30) * rad) +
    0.24 * Math.cos(2 * hMean * rad) +
    0.32 * Math.cos((3 * hMean + 6) * rad) -
    0.2 * Math.cos((4 * hMean - 63) * rad);
  const deltaTheta = 30 * Math.exp(-(((hMean - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cpMean ** 7 / (cpMean ** 7 + 25 ** 7));
  const sl =
    1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
  const sc = 1 + 0.045 * cpMean;
  const sh = 1 + 0.015 * cpMean * t;
  const rt = -Math.sin(2 * deltaTheta * rad) * rc;
  return Math.sqrt(
    (deltaL / sl) ** 2 +
      (deltaC / sc) ** 2 +
      (deltaH / sh) ** 2 +
      rt * (deltaC / sc) * (deltaH / sh),
  );
}

export const VIZ_CONTEXT_SHARE = 0.6;

export const VIZ_COLORS = Object.freeze({
  background: "var(--sd-surface-card)",
  context: `color-mix(in srgb, var(--sd-border-strong) ${VIZ_CONTEXT_SHARE * 100}%, var(--sd-surface-card))`,
  baseline: "var(--sd-border-strong)",
  label: "var(--sd-text-secondary)",
  accent: "var(--sd-tier-steam)",
});

export const VIZ_LABEL_FONT_PX = 11;
export const VIZ_LABEL_MIN_GAP_PX = VIZ_LABEL_FONT_PX + 2;

export function formatUsdFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.round(Math.abs(cents) / 100);
  return `${sign}$${dollars.toLocaleString("en-US")}`;
}
