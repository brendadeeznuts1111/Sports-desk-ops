/**
 * @file line.ts
 * @description Spread/total/point formatting ported from the portal's `util.js`
 * (`formatSpread`, `formatTotal`, `formatPoints`, `formatTotalPart`).
 *
 * The caller supplies the chosen and favorite team ids; the chosen side decides the quarter
 * line's sign. Odds are American integers.
 */

/** `4.5` -> `4½`, `0` -> `PK` (no leading sign). */
export function formatTotalPart(value: number): string {
  if (!Number.isFinite(value)) return "";
  const whole = Math.trunc(value);
  const fraction = Math.abs(value) - Math.abs(whole);
  if (value === 0 && fraction === 0) return "PK";
  if (whole === 0 && fraction >= 0.49 && fraction <= 0.51) return "½";
  if (fraction >= 0.49 && fraction <= 0.51) return `${whole}½`;
  return `${whole}`;
}

/** `4.5` -> `+4½`, `-4.5` -> `-4½`, `0` -> `PK`. */
export function formatPoints(value: number): string {
  if (!Number.isFinite(value)) return "";
  const whole = Math.trunc(value);
  const fraction = Math.abs(value) - Math.abs(whole);
  if (value === 0) return "PK";
  if (whole === 0 && value > 0) return "+½";
  if (whole === 0 && value < 0) return "-½";
  if (fraction >= 0.49 && fraction <= 0.51) {
    return `${value > 0 ? "+" : ""}${whole}½`;
  }
  return `${value > 0 ? "+" : ""}${whole}`;
}

function formatOdds(price: number): string {
  if (!Number.isFinite(price)) return "";
  return Number.isInteger(price) && price > 0 ? `+${price}` : `${price}`;
}

function isQuarterLine(line: number): boolean {
  const tail = Math.round(100 * Math.abs(line)) % 100;
  return tail === 25 || tail === 75;
}

/** `Ov 219½ -115`; quarter totals render as two prices, e.g. `Un 3,3½ -110`. */
export function formatTotal(
  line: number,
  price: number,
  totalOU: string,
): string {
  if (!Number.isFinite(line) || !Number.isFinite(price)) return "";
  if (isQuarterLine(line)) {
    return `${totalOU} ${formatTotalPart(line - 0.25)},${formatTotalPart(
      line + 0.25,
    )} ${formatOdds(price)}`;
  }
  return `${totalOU} ${formatTotalPart(line)} ${formatOdds(price)}`;
}

/**
 * `-4½,-4 -110` for the favorite side of a quarter line, `+4,-4½ -110` for the other side.
 * The chosen team id, not the home team id, selects the sign.
 */
export function formatSpread(
  line: number,
  price: number,
  chosenTeamId: string,
  favTeamId: string,
): string {
  if (!Number.isFinite(line) || !Number.isFinite(price)) return "";
  const chosen = chosenTeamId.trim().toUpperCase();
  const favorite = favTeamId.trim().toUpperCase();
  const magnitude = Math.abs(line);
  if (isQuarterLine(line)) {
    if (chosen === favorite) {
      return `${formatPoints(-magnitude - 0.25)},${formatPoints(
        -magnitude + 0.25,
      )} ${formatOdds(price)}`;
    }
    return `${formatPoints(magnitude - 0.25)},${formatPoints(
      -magnitude - 0.25,
    )} ${formatOdds(price)}`;
  }
  return `${
    chosen === favorite ? formatPoints(-magnitude) : formatPoints(magnitude)
  } ${formatOdds(price)}`;
}
