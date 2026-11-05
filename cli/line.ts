/**
 * @file line.ts
 * @description Line display strings from the portal's `util.js`.
 *
 * `formatSpread`/`formatTotal` are helpers inside `getAsianLine`; the ticket display path is
 * `checkDisplayLine`/`getLineGameFull`, which orders quarter lines differently and uses
 * `isDecimal` for `PK`/`½`. Those canonical functions are the primitives here; the older
 * helpers delegate to them.
 */

/** `0` → `PK`, `4.5` → `4½`, `-4.5` → `-4½`; matches the client's `isDecimal`. */
export function isDecimal(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  if (value === 0) return "PK";
  if (value % 1 !== 0) {
    const text = value.toString();
    const whole = text.split(".")[0] ?? "";
    const parsed = Number.parseInt(text, 10);
    if (parsed === 0) return `${text.startsWith("-") ? "-" : ""}½`;
    return `${whole}½`;
  }
  return String(value);
}

/** `4.5` → `+4½`, `-4.5` → `-4½`, `0` → `PK`. */
export function formatPoints(value: number): string {
  const base = isDecimal(value);
  if (base === "PK" || base.startsWith("-")) return base;
  return `+${base}`;
}

/** Backwards-compatible name for the canonical half-point formatter. */
export function formatTotalPart(value: number): string {
  return isDecimal(value);
}

function formatOdds(price: number): string {
  if (!Number.isFinite(price)) return "";
  return Number.isInteger(price) && price > 0 ? `+${price}` : `${price}`;
}

function setSymbol(text: string): string {
  if (text === "PK" || text.startsWith("+") || text.startsWith("-"))
    return text;
  return `+${text}`;
}

export type LineType = "S" | "L" | "E" | "M" | "G";

export interface LineCtx {
  readonly line: number;
  readonly odd: number;
  readonly lineType: LineType;
  readonly totalOU?: "O" | "U" | undefined;
  /** Append the American price; default true. */
  readonly append?: boolean;
  /** Report-style leading `+` via `setSymbol`; default false. */
  readonly report?: boolean;
}

/** The client's canonical display line (`checkDisplayLine`). */
export function checkDisplayLine(ctx: LineCtx): string {
  const { line, odd, lineType, append = true } = ctx;
  const overUnder =
    ctx.totalOU === "O" ? "Ov" : ctx.totalOU === "U" ? "Un" : "";
  let out = "";

  if (lineType === "S") {
    const fraction = line.toString().split(".")[1];
    const quarter = fraction === "25" || fraction === "75";
    if (quarter) {
      if (line > 0) {
        if (line - 0.25 === 0) out = `PK,${isDecimal(line)}`;
        else if ([-1, 1].includes(Number.parseInt(String(line), 10))) {
          out = `+${Math.round(line)},${isDecimal(line)}`;
        } else out = `${isDecimal(line)},+${Math.round(line)}`;
      } else {
        if (line + 0.25 === 0) out = `PK,${isDecimal(line)}`;
        else if ([-1, 1].includes(Number.parseInt(String(line), 10))) {
          out = `${Math.round(line)},${isDecimal(line)}`;
        } else out = `${isDecimal(line)},${Math.round(line)}`;
      }
    } else {
      out = isDecimal(line);
      if (line > 0) out = `+${out.replace(/^\+/, "")}`;
    }
    if (append) out += ` ${formatOdds(odd)}`;
    return ctx.report === true ? setSymbol(out) : out;
  }

  if (lineType === "L") {
    if (2 * line === Math.floor(2 * line)) {
      out = `${overUnder} ${isDecimal(line)}`;
    } else {
      out = `${overUnder} ${isDecimal(line - 0.25)},${isDecimal(line + 0.25)}`;
    }
    if (append) out += ` ${formatOdds(odd)}`;
    return ctx.report === true ? setSymbol(out) : out;
  }

  if (lineType === "E") {
    return `${overUnder} ${isDecimal(line)}${
      append ? ` ${formatOdds(odd)}` : ""
    }`;
  }

  return isDecimal(line);
}

export interface FullLineCtx {
  readonly legWagerType: "S" | "M" | "C" | "A" | "L" | "E";
  readonly adjSpread?: number;
  readonly adjTotalPoints?: number;
  readonly finalMoney: number;
  readonly totalOU?: "O" | "U";
  readonly sportType: string;
  readonly chosenTeamId: string;
  readonly team1Id: string;
  readonly team2Id: string;
  readonly buyPoints?: number;
  readonly teaserPoints?: number;
}

/** The client's full ticket-leg line builder (`getLineGameFull`). */
export function getLineGameFull(ctx: FullLineCtx): string {
  const plus =
    ctx.finalMoney > 0 && Number.isInteger(ctx.finalMoney) ? " +" : " ";

  switch (ctx.legWagerType) {
    case "S": {
      const spread = ctx.adjSpread ?? 0;
      const base = checkDisplayLine({
        line: spread,
        odd: ctx.finalMoney,
        lineType: "S",
        append: false,
      }).replace(/^\+/, "");
      let out = `${spread > 0 ? "+" : ""}${base}${plus}${ctx.finalMoney}`;
      const buy = ctx.buyPoints ?? 0;
      if (!Number.isNaN(buy) && buy > 0) {
        out += ` (B+${isDecimal(buy)}) `;
      }
      const teaser = ctx.teaserPoints ?? 0;
      if (teaser !== 0) {
        out = isDecimal(spread + teaser).replace(/^/, teaser > 0 ? "+" : "");
      }
      return out;
    }
    case "M": {
      const draw =
        ctx.sportType.toUpperCase() === "SOCCER" &&
        ctx.chosenTeamId === `${ctx.team1Id} / ${ctx.team2Id}`;
      return `${draw ? "DRAW" : "ML"}${plus}${ctx.finalMoney}`;
    }
    case "C":
      return `${plus}${ctx.finalMoney}`;
    case "A":
      return "";
    case "L": {
      const overUnder = ctx.totalOU === "O" ? "Ov" : "Un";
      let out = `${checkDisplayLine({
        line: ctx.adjTotalPoints ?? 0,
        odd: ctx.finalMoney,
        lineType: "L",
        totalOU: ctx.totalOU,
        append: false,
      })}${plus}${ctx.finalMoney}`;
      const buy = ctx.buyPoints ?? 0;
      if (!Number.isNaN(buy) && buy > 0) {
        out += ` (B+${isDecimal(buy)}) `;
      }
      const teaser = ctx.teaserPoints ?? 0;
      if (teaser !== 0) {
        const total =
          (ctx.adjTotalPoints ?? 0) + (ctx.totalOU === "O" ? -teaser : teaser);
        out = `${overUnder} ${isDecimal(total)}`;
      }
      return out;
    }
    case "E":
      return `${ctx.totalOU === "O" ? "Ov" : "Un"} ${isDecimal(
        ctx.adjTotalPoints ?? 0,
      )}${plus}${ctx.finalMoney}`;
    default:
      return `${plus}${ctx.finalMoney}`;
  }
}

/** `Ov 219½ -115`; quarter totals split as `Un 3,3½ -110`. */
export function formatTotal(
  line: number,
  price: number,
  totalOU: string,
): string {
  return checkDisplayLine({
    line,
    odd: price,
    lineType: "L",
    totalOU: totalOU === "Ov" ? "O" : totalOU === "Un" ? "U" : undefined,
  });
}

/**
 * Compatibility wrapper around `checkDisplayLine`: the chosen side, not the home side,
 * selects the spread's sign.
 */
export function formatSpread(
  line: number,
  price: number,
  chosenTeamId: string,
  favTeamId: string,
): string {
  const chosen = chosenTeamId.trim().toUpperCase();
  const favorite = favTeamId.trim().toUpperCase();
  const signed = chosen === favorite ? -Math.abs(line) : Math.abs(line);
  return checkDisplayLine({ line: signed, odd: price, lineType: "S" });
}
