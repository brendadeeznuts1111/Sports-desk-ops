import {
  Canvas,
  createAnimatedValue,
  effect,
  PanResponder,
  reduceMotion,
  signal,
  split,
  Text,
  token,
  View,
  type JSX,
  type ViewProps,
} from "nsh";

/**
 * Dampens vertical axis bounds across chart period transitions and ticks so
 * figures never snap-jump abruptly, matching NSH Gallery `Stocks` (`calm()`).
 */
export function createCalmRange(rate = 0.24) {
  let lo: number | null = null;
  let hi: number | null = null;
  let initialized = false;
  return {
    reset: () => {
      initialized = false;
    },
    step: (targetLo: number, targetHi: number): [number, number] => {
      if (!initialized || lo === null || hi === null || reduceMotion()) {
        lo = targetLo;
        hi = targetHi;
        initialized = true;
        return [lo, hi];
      }
      lo = lo + (targetLo - lo) * rate;
      hi = hi + (targetHi - hi) * rate;
      if (Math.abs(lo - targetLo) < 0.0005) lo = targetLo;
      if (Math.abs(hi - targetHi) < 0.0005) hi = targetHi;
      return [lo, hi];
    },
  };
}

export interface LiveDotProps {
  live: boolean;
  tone?: "positive" | "warning" | "muted";
  accessibilityLabel?: string;
}

/**
 * Native `<Canvas>` live-feed pulse indicator inspired by `Stocks` `LiveDot`.
 * Animates radius & alpha on the UI thread with zero JS per-frame work and
 * settles to a calm static dot when `live` is false or `reduceMotion()` is enabled.
 */
export function LiveDot(props: LiveDotProps): JSX.Element {
  const pulse = createAnimatedValue(0);

  effect(() => {
    const active = props.live && !reduceMotion();
    if (!active) {
      pulse.set(0);
      return;
    }
    void pulse.keyframes([0, 1], {
      duration: 1600,
      easing: "easeOut",
      iterations: "infinite",
    });
    return () => {
      pulse.set(0);
    };
  });

  const ringRadius = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [3, 6.5],
  });
  const ringAlpha = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.42, 0],
  });

  return (
    <Canvas
      class="h-3.5 w-3.5 shrink-0"
      accessibilityLabel={props.accessibilityLabel ?? "Feed status"}
      draw={(cx, size) => {
        const x = size.width / 2;
        const y = size.height / 2;
        const t = props.tone ?? (props.live ? "positive" : "muted");
        const color =
          t === "positive"
            ? token("positive")
            : t === "warning"
              ? token("warning")
              : token("muted-foreground");

        if (props.live) {
          cx.save();
          cx.fillStyle = color;
          cx.globalAlpha = ringAlpha;
          cx.beginPath();
          cx.arc(x, y, ringRadius, 0, Math.PI * 2);
          cx.fill();
          cx.restore();
        }

        cx.fillStyle = color;
        cx.beginPath();
        cx.arc(x, y, 2.75, 0, Math.PI * 2);
        cx.fill();
      }}
    />
  );
}

export type SpringBarTone =
  "positive" | "negative" | "primary" | "warning" | "muted";

const SPRING_BAR_FILL_CLASSES: Record<SpringBarTone, string> = {
  positive: "bg-positive/30",
  negative: "bg-negative/30",
  primary: "bg-primary/35",
  warning: "bg-warning/35",
  muted: "bg-muted-foreground/25",
};

export interface SpringBarProps extends Omit<ViewProps, "children"> {
  ratio: number;
  from?: "left" | "right";
  tone?: SpringBarTone;
  trackClass?: string;
}

/**
 * Spring-animated proportion bar inspired by `Stocks` `SpringBar` (used in
 * Composite breadth, Order book `BID %`/`ASK %` ladders, and `Trade flow`).
 */
export function SpringBar(props: SpringBarProps): JSX.Element {
  const [own, rest] = split(props, [
    "ratio",
    "from",
    "tone",
    "trackClass",
    "class",
  ]);
  const widthPx = signal(0);
  const tx = createAnimatedValue(0);

  effect(() => {
    const w = widthPx();
    const clamped = Math.max(
      0,
      Math.min(1, Number.isFinite(own.ratio) ? own.ratio : 0),
    );
    const side = own.from ?? "left";
    const target = side === "right" ? (1 - clamped) * w : (clamped - 1) * w;
    if (w <= 0 || reduceMotion()) {
      tx.set(target);
    } else {
      void tx.spring(target, { stiffness: 250, damping: 26 });
    }
  });

  const tone = () => own.tone ?? "primary";

  return (
    <View
      {...rest}
      onLayout={({ bounds }) => widthPx.set(bounds.size.width)}
      class={`overflow-hidden rounded-(--radius-sm) ${own.trackClass ?? "h-2 bg-muted/70"} ${own.class ?? ""}`}
    >
      <View
        style={{ transform: [{ translateX: tx }] }}
        class={`h-full w-full rounded-(--radius-sm) ${SPRING_BAR_FILL_CLASSES[tone()]}`}
      />
    </View>
  );
}

export interface StatCellItem {
  readonly label: string;
  readonly value: string;
  readonly tone?: "default" | "positive" | "negative" | "warning";
}

export interface StatGridProps extends Omit<ViewProps, "children"> {
  items: readonly StatCellItem[];
  compact?: boolean;
}

/**
 * 4-column (`w-[25%]`, `w-[50%]` on compact mobile) tabular figure grid modeled
 * directly on NSH Gallery `Stocks` `Detail.tsx` (`Open`, `Prev close` … `Turnover`).
 */
export function StatGrid(props: StatGridProps): JSX.Element {
  const [own, rest] = split(props, ["items", "compact", "class"]);
  const toneClass = (tone: StatCellItem["tone"]): string => {
    if (tone === "positive") return "text-positive";
    if (tone === "negative") return "text-negative";
    if (tone === "warning") return "text-warning";
    return "text-foreground";
  };

  return (
    <View {...rest} class={`flex-row flex-wrap gap-y-2.5 ${own.class ?? ""}`}>
      <Each of={own.items} key={(item) => item.label}>
        {(item) => (
          <View
            class={
              own.compact
                ? "w-[50%] gap-0.5 pe-2"
                : "w-[25%] min-w-28 gap-0.5 pe-2"
            }
          >
            <Text class="text-xs text-muted-foreground">{item().label}</Text>
            <Text
              class={`font-mono text-xs font-semibold tabular-nums ${toneClass(item().tone)}`}
            >
              {item().value}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

export interface DayRangeBarProps {
  low: number;
  high: number;
  prevClose: number;
  last: number;
  formatValue: (v: number) => string;
}

/**
 * `Stocks`-style `DayRange` bar (`L <low>` —— `prevClose` tick + spring `last`
 * knob —— `H <high>`).
 */
export function DayRangeBar(props: DayRangeBarProps): JSX.Element {
  const trackWidth = signal(0);
  const knobX = createAnimatedValue(0);

  const ratioOf = (val: number): number => {
    const span = props.high - props.low;
    if (!Number.isFinite(span) || span <= 0) return 0.5;
    return Math.max(0, Math.min(1, (val - props.low) / span));
  };

  effect(() => {
    const w = trackWidth();
    const target = ratioOf(props.last) * Math.max(0, w - 8);
    if (w <= 0 || reduceMotion()) {
      knobX.set(target);
    } else {
      void knobX.spring(target, { stiffness: 260, damping: 26 });
    }
  });

  const prevRatioPct = (): `${number}%` =>
    `${Math.round(ratioOf(props.prevClose) * 100)}%`;
  const isUp = () => props.last >= props.prevClose;

  return (
    <View class="flex-row items-center gap-2.5">
      <Text class="font-mono text-xs tabular-nums text-muted-foreground">
        {`L ${props.formatValue(props.low)}`}
      </Text>
      <View
        onLayout={({ bounds }) => trackWidth.set(bounds.size.width)}
        class="relative h-4 flex-1 justify-center"
      >
        <View class="h-1.5 rounded-full bg-muted" />
        <View
          style={{ left: prevRatioPct() }}
          class="absolute h-3 w-0.5 rounded-full bg-muted-foreground/65"
        />
        <View
          style={{ transform: [{ translateX: knobX }] }}
          class={
            isUp()
              ? "absolute h-2.5 w-2.5 rounded-full border border-background bg-positive"
              : "absolute h-2.5 w-2.5 rounded-full border border-background bg-negative"
          }
        />
      </View>
      <Text class="font-mono text-xs tabular-nums text-muted-foreground">
        {`H ${props.formatValue(props.high)}`}
      </Text>
    </View>
  );
}

export interface SparklineCanvasProps {
  values: readonly number[];
  prevClose: number;
  live?: boolean;
  accessibilityLabel?: string;
}

/**
 * Watchlist `<Canvas>` sparkline inspired by `Stocks.tsx` (`Sparkline`):
 * dotted `prevClose` baseline, quadratic smoothed curve, translucent semantic
 * area fill (`cx.globalAlpha`), and pulsing latest-point ring.
 */
export function SparklineCanvas(props: SparklineCanvasProps): JSX.Element {
  const pulse = createAnimatedValue(0);

  effect(() => {
    const active = Boolean(props.live) && !reduceMotion();
    if (!active) {
      pulse.set(0);
      return;
    }
    void pulse.keyframes([0, 1], {
      duration: 1600,
      easing: "easeOut",
      iterations: "infinite",
    });
    return () => {
      pulse.set(0);
    };
  });

  const ringRadius = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [2.2, 6.2],
  });
  const ringAlpha = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0],
  });

  return (
    <Canvas
      class="h-9 w-24 shrink-0"
      accessibilityLabel={props.accessibilityLabel ?? "Price sparkline"}
      draw={(cx, size) => {
        const pts = props.values;
        const w = size.width;
        const h = size.height;
        if (pts.length < 2 || w <= 8 || h <= 8) return;

        const padX = 4;
        const padY = 5;
        let lo = props.prevClose;
        let hi = props.prevClose;
        for (let i = 0; i < pts.length; i++) {
          const v = pts[i]!;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const span = Math.max(0.5, hi - lo);
        const xOf = (idx: number) =>
          padX + (idx / (pts.length - 1)) * (w - padX * 2);
        const yOf = (val: number) =>
          padY + (1 - (val - lo) / span) * (h - padY * 2);

        const lastVal = pts[pts.length - 1]!;
        const strokeColor =
          lastVal >= props.prevClose ? token("positive") : token("negative");

        // Dotted Prev close reference line
        const prevY = yOf(props.prevClose);
        cx.save();
        cx.strokeStyle = token("border");
        cx.lineWidth = 1;
        cx.setLineDash([2, 2]);
        cx.beginPath();
        cx.moveTo(padX, prevY);
        cx.lineTo(w - padX, prevY);
        cx.stroke();
        cx.restore();

        // Build smooth quadratic path
        const drawCurve = () => {
          cx.beginPath();
          cx.moveTo(xOf(0), yOf(pts[0]!));
          for (let i = 1; i < pts.length - 1; i++) {
            const xc = (xOf(i) + xOf(i + 1)) / 2;
            const yc = (yOf(pts[i]!) + yOf(pts[i + 1]!)) / 2;
            cx.quadraticCurveTo(xOf(i), yOf(pts[i]!), xc, yc);
          }
          cx.lineTo(xOf(pts.length - 1), yOf(lastVal));
        };

        // Translucent fill down to bottom
        cx.save();
        drawCurve();
        cx.lineTo(xOf(pts.length - 1), h - 2);
        cx.lineTo(xOf(0), h - 2);
        cx.closePath();
        cx.fillStyle = strokeColor;
        cx.globalAlpha = 0.16;
        cx.fill();
        cx.restore();

        // Crisp stroke
        cx.save();
        drawCurve();
        cx.strokeStyle = strokeColor;
        cx.lineWidth = 1.6;
        cx.lineJoin = "round";
        cx.lineCap = "round";
        cx.stroke();
        cx.restore();

        // Latest point + optional live pulse
        const lx = xOf(pts.length - 1);
        const ly = yOf(lastVal);
        if (props.live) {
          cx.save();
          cx.fillStyle = strokeColor;
          cx.globalAlpha = ringAlpha;
          cx.beginPath();
          cx.arc(lx, ly, ringRadius, 0, Math.PI * 2);
          cx.fill();
          cx.restore();
        }
        cx.fillStyle = strokeColor;
        cx.beginPath();
        cx.arc(lx, ly, 2.2, 0, Math.PI * 2);
        cx.fill();
      }}
    />
  );
}

export interface MarketChartPoint {
  readonly label: string;
  readonly value: number;
  readonly volume: number;
  readonly ma5: number;
}

export interface MarketChartCanvasProps {
  points: readonly MarketChartPoint[];
  prevClose: number;
  unitSuffix?: string;
  accessibilityLabel?: string;
}

/**
 * Multi-period scrubbable `<Canvas>` chart inspired by `Stocks` `Chart.tsx`:
 * - Horizontal `PanResponder` scrub (`activeOffsetX: 6, failOffsetY: 8`)
 * - Smooth `createCalmRange` Y-axis bounds
 * - Dotted `Prev close`, primary price curve + translucent fill, `MA5` warning line,
 *   volume/handle bars, right-edge tabular ticks (`12px system-ui`), and crosshair readout.
 */
export function MarketChartCanvas(props: MarketChartCanvasProps): JSX.Element {
  const scrubIndex = signal<number | null>(null);
  const canvasWidth = signal(0);
  const calmBounds = createCalmRange(0.28);

  const resolveIndexFromX = (x: number): number | null => {
    const pts = props.points;
    const w = canvasWidth();
    if (pts.length === 0 || w <= 64) return null;
    const plotLeft = 10;
    const plotRight = w - 54;
    const clampedX = Math.max(plotLeft, Math.min(plotRight, x));
    const ratio = (clampedX - plotLeft) / Math.max(1, plotRight - plotLeft);
    return Math.max(
      0,
      Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))),
    );
  };

  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      scrubIndex.set(resolveIndexFromX(e.locationX));
    },
    onPanResponderMove: (e) => {
      scrubIndex.set(resolveIndexFromX(e.locationX));
    },
    onPanResponderRelease: () => {
      scrubIndex.set(null);
    },
    onPanResponderTerminate: () => {
      scrubIndex.set(null);
    },
  });

  const activePoint = () => {
    const idx = scrubIndex();
    const pts = props.points;
    if (pts.length === 0) return null;
    if (idx !== null && pts[idx]) return pts[idx]!;
    return pts[pts.length - 1]!;
  };

  const suffix = () => props.unitSuffix ?? "¢";

  return (
    <View class="gap-1.5">
      <If when={activePoint()}>
        {(pt) => (
          <View class="flex-row flex-wrap items-center justify-between gap-2 px-1">
            <View class="flex-row items-center gap-2">
              <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                {pt().label}
              </Text>
              <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                {`Last ${pt().value.toFixed(1)}${suffix()}`}
              </Text>
              <Text class="font-mono text-xs tabular-nums text-warning">
                {`MA5 ${pt().ma5.toFixed(1)}${suffix()}`}
              </Text>
            </View>
            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
              {scrubIndex() !== null
                ? `Scrub · Vol $${Math.round(pt().volume).toLocaleString("en-US")}`
                : `Handle $${Math.round(pt().volume).toLocaleString("en-US")}`}
            </Text>
          </View>
        )}
      </If>

      <View
        {...pan.panHandlers}
        panActivation={{ activeOffsetX: 6, failOffsetY: 8 }}
        onLayout={({ bounds }) => canvasWidth.set(bounds.size.width)}
        class="h-52 overflow-hidden rounded-(--radius) border border-border bg-card"
      >
        <Canvas
          class="flex-1"
          accessibilityLabel={
            props.accessibilityLabel ??
            "Interactive price and volume chart; drag horizontally to scrub"
          }
          draw={(cx, size) => {
            const pts = props.points;
            const w = size.width;
            const h = size.height;
            if (pts.length < 2 || w <= 80 || h <= 60) return;

            const left = 10;
            const right = w - 54;
            const top = 12;
            const priceBottom = Math.round(h * 0.72);
            const volTop = priceBottom + 8;
            const volBottom = h - 18;

            let rawLo = props.prevClose;
            let rawHi = props.prevClose;
            let maxVol = 1;
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i]!;
              if (p.value < rawLo) rawLo = p.value;
              if (p.value > rawHi) rawHi = p.value;
              if (p.ma5 < rawLo) rawLo = p.ma5;
              if (p.ma5 > rawHi) rawHi = p.ma5;
              if (p.volume > maxVol) maxVol = p.volume;
            }
            const padRange = Math.max(0.8, (rawHi - rawLo) * 0.12);
            const [lo, hi] = calmBounds.step(
              rawLo - padRange,
              rawHi + padRange,
            );
            const span = Math.max(0.5, hi - lo);

            const xOf = (idx: number) =>
              left + (idx / (pts.length - 1)) * (right - left);
            const yOf = (val: number) =>
              top + (1 - (val - lo) / span) * (priceBottom - top);

            // Gridlines + right-edge price labels (12px tabular-nums)
            cx.font = "500 12px system-ui";
            cx.fontVariantNumeric = "tabular-nums";
            cx.textAlign = "right";
            cx.textBaseline = "middle";

            for (let g = 0; g <= 3; g++) {
              const frac = g / 3;
              const gy = top + frac * (priceBottom - top);
              const gVal = hi - frac * span;
              cx.save();
              cx.strokeStyle = token("border");
              cx.globalAlpha = 0.55;
              cx.lineWidth = 1;
              cx.beginPath();
              cx.moveTo(left, gy);
              cx.lineTo(right, gy);
              cx.stroke();
              cx.restore();

              cx.fillStyle = token("muted-foreground");
              cx.fillText(`${gVal.toFixed(1)}${suffix()}`, w - 6, gy);
            }

            // Dotted Prev close line
            const prevY = yOf(props.prevClose);
            if (prevY >= top && prevY <= priceBottom) {
              cx.save();
              cx.strokeStyle = token("muted-foreground");
              cx.globalAlpha = 0.65;
              cx.setLineDash([3, 3]);
              cx.lineWidth = 1;
              cx.beginPath();
              cx.moveTo(left, prevY);
              cx.lineTo(right, prevY);
              cx.stroke();
              cx.restore();
            }

            const lastVal = pts[pts.length - 1]!.value;
            const mainColor =
              lastVal >= props.prevClose
                ? token("positive")
                : token("negative");

            // Price area fill
            cx.save();
            cx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const px = xOf(i);
              const py = yOf(pts[i]!.value);
              if (i === 0) cx.moveTo(px, py);
              else cx.lineTo(px, py);
            }
            cx.lineTo(xOf(pts.length - 1), priceBottom);
            cx.lineTo(xOf(0), priceBottom);
            cx.closePath();
            cx.fillStyle = mainColor;
            cx.globalAlpha = 0.14;
            cx.fill();
            cx.restore();

            // Price stroke
            cx.save();
            cx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const px = xOf(i);
              const py = yOf(pts[i]!.value);
              if (i === 0) cx.moveTo(px, py);
              else cx.lineTo(px, py);
            }
            cx.strokeStyle = mainColor;
            cx.lineWidth = 2;
            cx.lineJoin = "round";
            cx.stroke();
            cx.restore();

            // MA5 line
            cx.save();
            cx.beginPath();
            for (let i = 0; i < pts.length; i++) {
              const px = xOf(i);
              const py = yOf(pts[i]!.ma5);
              if (i === 0) cx.moveTo(px, py);
              else cx.lineTo(px, py);
            }
            cx.strokeStyle = token("warning");
            cx.globalAlpha = 0.85;
            cx.lineWidth = 1.25;
            cx.stroke();
            cx.restore();

            // Volume / handle bars
            const barStep = (right - left) / pts.length;
            const barW = Math.max(2, Math.min(10, barStep * 0.62));
            for (let i = 0; i < pts.length; i++) {
              const p = pts[i]!;
              const prevP = i > 0 ? pts[i - 1]!.value : props.prevClose;
              const upBar = p.value >= prevP;
              const bh = Math.max(
                2,
                (p.volume / maxVol) * Math.max(6, volBottom - volTop),
              );
              const bx = xOf(i) - barW / 2;
              const by = volBottom - bh;
              cx.save();
              cx.fillStyle = upBar ? token("positive") : token("negative");
              cx.globalAlpha = 0.45;
              cx.fillRect(bx, by, barW, bh);
              cx.restore();
            }

            // Bottom start/end timestamps
            cx.fillStyle = token("muted-foreground");
            cx.textAlign = "left";
            cx.textBaseline = "bottom";
            cx.fillText(pts[0]!.label, left, h - 2);
            cx.textAlign = "right";
            cx.fillText(pts[pts.length - 1]!.label, right, h - 2);

            // Crosshair when scrubbing
            const sIdx = scrubIndex();
            if (sIdx !== null && pts[sIdx]) {
              const sx = xOf(sIdx);
              const sy = yOf(pts[sIdx]!.value);
              cx.save();
              cx.strokeStyle = token("foreground");
              cx.globalAlpha = 0.55;
              cx.setLineDash([3, 2]);
              cx.lineWidth = 1;
              cx.beginPath();
              cx.moveTo(sx, top);
              cx.lineTo(sx, volBottom);
              cx.moveTo(left, sy);
              cx.lineTo(right, sy);
              cx.stroke();
              cx.restore();

              cx.fillStyle = mainColor;
              cx.beginPath();
              cx.arc(sx, sy, 4, 0, Math.PI * 2);
              cx.fill();
            }
          }}
        />
      </View>
    </View>
  );
}

export interface DepthLevelItem {
  readonly price: number;
  readonly sizeUsd: number;
  readonly cumulativeUsd: number;
}

export interface DepthChartCanvasProps {
  bids: readonly DepthLevelItem[];
  asks: readonly DepthLevelItem[];
  unitSuffix?: string;
}

/**
 * Cumulative order-book depth step chart inspired by `Stocks` `Book.tsx` (`Depth`):
 * cumulative bid steps (`positive`), cumulative ask steps (`negative`), and
 * diagonal hatched spread corridor around the mid-price.
 */
export function DepthChartCanvas(props: DepthChartCanvasProps): JSX.Element {
  const suffix = () => props.unitSuffix ?? "¢";
  return (
    <Canvas
      class="h-36 rounded-(--radius) border border-border bg-card"
      accessibilityLabel="Cumulative bid and ask depth curve"
      draw={(cx, size) => {
        const w = size.width;
        const h = size.height;
        const bids = props.bids;
        const asks = props.asks;
        if (w <= 64 || h <= 48 || bids.length === 0 || asks.length === 0) {
          return;
        }

        const padX = 12;
        const top = 12;
        const bottom = h - 22;
        const midX = w / 2;
        const spreadHalf = 10;

        const maxCum = Math.max(
          1,
          bids[bids.length - 1]?.cumulativeUsd ?? 1,
          asks[asks.length - 1]?.cumulativeUsd ?? 1,
        );
        const yOf = (cum: number) =>
          bottom - (cum / maxCum) * Math.max(8, bottom - top);

        // Bids (left side: midX - spreadHalf outward to padX)
        const bidLeft = padX;
        const bidRight = midX - spreadHalf;
        const drawBidSteps = () => {
          cx.beginPath();
          for (let i = 0; i < bids.length; i++) {
            const frac = bids.length === 1 ? 0 : i / (bids.length - 1);
            const x = bidRight - frac * (bidRight - bidLeft);
            const y = yOf(bids[i]!.cumulativeUsd);
            if (i === 0) {
              cx.moveTo(bidRight, bottom);
              cx.lineTo(bidRight, y);
            } else {
              const prevFrac = (i - 1) / (bids.length - 1);
              const prevX = bidRight - prevFrac * (bidRight - bidLeft);
              cx.lineTo(x, yOf(bids[i - 1]!.cumulativeUsd));
              cx.lineTo(x, y);
              void prevX;
            }
            if (i === bids.length - 1) {
              cx.lineTo(bidLeft, y);
            }
          }
        };

        cx.save();
        drawBidSteps();
        cx.lineTo(bidLeft, bottom);
        cx.closePath();
        cx.fillStyle = token("positive");
        cx.globalAlpha = 0.16;
        cx.fill();
        cx.restore();

        cx.save();
        drawBidSteps();
        cx.strokeStyle = token("positive");
        cx.lineWidth = 1.75;
        cx.stroke();
        cx.restore();

        // Asks (right side: midX + spreadHalf outward to w - padX)
        const askLeft = midX + spreadHalf;
        const askRight = w - padX;
        const drawAskSteps = () => {
          cx.beginPath();
          for (let i = 0; i < asks.length; i++) {
            const frac = asks.length === 1 ? 0 : i / (asks.length - 1);
            const x = askLeft + frac * (askRight - askLeft);
            const y = yOf(asks[i]!.cumulativeUsd);
            if (i === 0) {
              cx.moveTo(askLeft, bottom);
              cx.lineTo(askLeft, y);
            } else {
              cx.lineTo(x, yOf(asks[i - 1]!.cumulativeUsd));
              cx.lineTo(x, y);
            }
            if (i === asks.length - 1) {
              cx.lineTo(askRight, y);
            }
          }
        };

        cx.save();
        drawAskSteps();
        cx.lineTo(askRight, bottom);
        cx.closePath();
        cx.fillStyle = token("negative");
        cx.globalAlpha = 0.16;
        cx.fill();
        cx.restore();

        cx.save();
        drawAskSteps();
        cx.strokeStyle = token("negative");
        cx.lineWidth = 1.75;
        cx.stroke();
        cx.restore();

        // Spread corridor hatched lines
        cx.save();
        cx.strokeStyle = token("border");
        cx.lineWidth = 1;
        cx.setLineDash([2, 2]);
        cx.beginPath();
        cx.moveTo(midX, top);
        cx.lineTo(midX, bottom);
        cx.stroke();
        cx.restore();

        // Axis labels (12px tabular-nums)
        cx.font = "500 12px system-ui";
        cx.fontVariantNumeric = "tabular-nums";
        cx.fillStyle = token("muted-foreground");
        cx.textBaseline = "bottom";
        cx.textAlign = "left";
        cx.fillText(
          `Bid ${bids[0]!.price.toFixed(1)}${suffix()}`,
          bidLeft,
          h - 4,
        );
        cx.textAlign = "center";
        const spreadVal = Math.max(0, asks[0]!.price - bids[0]!.price);
        cx.fillText(`Spread ${spreadVal.toFixed(1)}${suffix()}`, midX, h - 4);
        cx.textAlign = "right";
        cx.fillText(
          `Ask ${asks[0]!.price.toFixed(1)}${suffix()}`,
          askRight,
          h - 4,
        );
      }}
    />
  );
}

export interface RangeHorizonItem {
  readonly label: string;
  readonly low: number;
  readonly high: number;
  readonly prev: number;
  readonly last: number;
}

export interface RangesDumbbellCanvasProps {
  ranges: readonly RangeHorizonItem[];
  unitSuffix?: string;
}

/**
 * Multi-horizon low-to-high dumbbell range `<Canvas>` inspired by `Stocks`
 * `Tape.tsx` (`Ranges`).
 */
export function RangesDumbbellCanvas(
  props: RangesDumbbellCanvasProps,
): JSX.Element {
  const suffix = () => props.unitSuffix ?? "¢";
  return (
    <Canvas
      class="h-36 rounded-(--radius) border border-border bg-card"
      accessibilityLabel="Multi-horizon price ranges"
      draw={(cx, size) => {
        const rows = props.ranges;
        const w = size.width;
        const h = size.height;
        if (rows.length === 0 || w <= 120 || h <= 48) return;

        let globalLo = rows[0]!.low;
        let globalHi = rows[0]!.high;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]!;
          if (r.low < globalLo) globalLo = r.low;
          if (r.high > globalHi) globalHi = r.high;
        }
        const span = Math.max(1, globalHi - globalLo);
        const trackLeft = 92;
        const trackRight = w - 64;
        const xOf = (v: number) =>
          trackLeft +
          ((v - globalLo) / span) * Math.max(12, trackRight - trackLeft);

        cx.font = "500 12px system-ui";
        cx.fontVariantNumeric = "tabular-nums";
        cx.textBaseline = "middle";

        const rowH = h / rows.length;
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i]!;
          const cy = (i + 0.5) * rowH;
          const xLo = xOf(r.low);
          const xHi = xOf(r.high);
          const xPrev = xOf(r.prev);
          const xLast = xOf(r.last);
          const up = r.last >= r.prev;
          const accent = up ? token("positive") : token("negative");

          // Label
          cx.fillStyle = token("muted-foreground");
          cx.textAlign = "left";
          cx.fillText(r.label, 10, cy);

          // Full track background
          cx.save();
          cx.strokeStyle = token("border");
          cx.lineWidth = 2;
          cx.beginPath();
          cx.moveTo(trackLeft, cy);
          cx.lineTo(trackRight, cy);
          cx.stroke();
          cx.restore();

          // Active low..high segment
          cx.save();
          cx.strokeStyle = accent;
          cx.globalAlpha = 0.65;
          cx.lineWidth = 4;
          cx.lineCap = "round";
          cx.beginPath();
          cx.moveTo(xLo, cy);
          cx.lineTo(xHi, cy);
          cx.stroke();
          cx.restore();

          // Prev tick
          cx.fillStyle = token("muted-foreground");
          cx.fillRect(xPrev - 1, cy - 5, 2, 10);

          // Last dot
          cx.fillStyle = accent;
          cx.beginPath();
          cx.arc(xLast, cy, 4, 0, Math.PI * 2);
          cx.fill();

          // Span readout on right
          cx.fillStyle = token("foreground");
          cx.textAlign = "right";
          cx.fillText(
            `${r.low.toFixed(0)}–${r.high.toFixed(0)}${suffix()}`,
            w - 10,
            cy,
          );
        }
      }}
    />
  );
}

export interface OrderToastBannerProps {
  message: string | null;
  tone?: "positive" | "warning" | "danger";
  onDismiss: () => void;
}

/**
 * Spring drop-in confirmation banner modeled on `Stocks` `OrderToast`.
 */
export function OrderToastBanner(props: OrderToastBannerProps): JSX.Element {
  const ty = createAnimatedValue(-12);
  const op = createAnimatedValue(0);

  effect(() => {
    const msg = props.message;
    if (!msg) {
      ty.set(-12);
      op.set(0);
      return;
    }
    if (reduceMotion()) {
      ty.set(0);
      op.set(1);
      return;
    }
    ty.set(-12);
    op.set(0);
    void ty.spring(0, { stiffness: 280, damping: 24 });
    void op.timing(1, { duration: 160, easing: "easeOut" });
  });

  const toneBorderClass = () => {
    if (props.tone === "danger") {
      return "border-destructive/45 bg-destructive/12";
    }
    if (props.tone === "warning") return "border-warning/45 bg-warning/15";
    return "border-positive/45 bg-positive/12";
  };

  return (
    <If when={props.message}>
      {(msg) => (
        <View
          role="alert"
          testID="order-toast-banner"
          style={{ opacity: op, transform: [{ translateY: ty }] }}
          onPress={props.onDismiss}
          class={`flex-row items-center justify-between gap-2 rounded-(--radius) border px-3 py-1.5 ${toneBorderClass()}`}
        >
          <Text class="flex-1 font-mono text-xs font-medium text-foreground">
            {msg()}
          </Text>
          <Text class="text-xs font-semibold text-muted-foreground">
            Dismiss
          </Text>
        </View>
      )}
    </If>
  );
}
