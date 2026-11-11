import {
  createAnimatedValue,
  effect,
  reduceMotion,
  Scroll,
  Text,
  View,
  windowSize,
  type JSX,
} from "nsh";
import {
  formatProvenanceCompact,
  formatUsd,
  type MarketChartPeriod,
  type MarketInstrument,
  type MarketWatchFilter,
} from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  animateUserLayoutChange,
  Badge,
  createPanelReadyMotion,
  DayRangeBar,
  DepthChartCanvas,
  DeskButton,
  DeskSheet,
  LiveDot,
  MarketChartCanvas,
  RangesDumbbellCanvas,
  SectionHeader,
  SegmentedTabs,
  Separator,
  SparklineCanvas,
  SpringBar,
  StateNotice,
  StatGrid,
  Surface,
  type SegmentedTabItem,
  type StatCellItem,
} from "../ui";
import { provenanceTone } from "./provenance";

const WATCH_FILTER_TABS: readonly SegmentedTabItem<MarketWatchFilter>[] = [
  { id: "all", label: "All" },
  { id: "gainers", label: "Gainers" },
  { id: "losers", label: "Losers" },
  { id: "active", label: "Active" },
];

const CHART_PERIOD_TABS: readonly SegmentedTabItem<MarketChartPeriod>[] = [
  { id: "intraday", label: "Intraday" },
  { id: "1m", label: "1m" },
  { id: "5m", label: "5m" },
  { id: "15m", label: "15m" },
  { id: "4w", label: "4W" },
];

function buildQuoteStats(inst: MarketInstrument): StatCellItem[] {
  const q = inst.quote;
  return [
    { label: "Open", value: `${q.open.toFixed(1)}¢` },
    { label: "Prev close", value: `${q.prevClose.toFixed(1)}¢` },
    { label: "Avg price", value: `${q.avgPrice.toFixed(1)}¢` },
    { label: "Amplitude", value: `${q.amplitudePct.toFixed(2)}%` },
    { label: "Volume", value: `${q.distinctAccounts} accts` },
    {
      label: "Turnover",
      value: formatUsd(q.riskUsd),
      tone: q.riskUsd >= 20_000 ? "positive" : "default",
    },
    { label: "Book high", value: `${q.bookHigh.toFixed(1)}¢` },
    { label: "Book low", value: `${q.bookLow.toFixed(1)}¢` },
  ];
}

function CompositeHeaderStrip(props: { store: DeskStore }): JSX.Element {
  const { store } = props;
  const comp = () => store.marketComposite();
  const chevronDeg = createAnimatedValue(0);

  effect(() => {
    const target = store.compositeExpanded() ? 90 : 0;
    if (reduceMotion()) {
      chevronDeg.set(target);
    } else {
      void chevronDeg.spring(target, { stiffness: 280, damping: 24 });
    }
  });

  const rotateStr = chevronDeg.interpolate({
    inputRange: [0, 90],
    outputRange: ["0deg", "90deg"],
  });

  return (
    <Surface variant="inset" class="gap-2">
      <View
        role="button"
        testID="stocks-composite-toggle"
        accessibilityLabel="Toggle Composite market breadth"
        onPress={() => {
          animateUserLayoutChange();
          store.toggleCompositeExpanded();
        }}
        class="flex-row items-center justify-between gap-2"
      >
        <View class="gap-0.5">
          <View class="flex-row items-center gap-1.5">
            <Text class="text-xs font-semibold text-foreground">Composite</Text>
            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
              {`${comp().advancers}↑ ${comp().decliners}↓`}
            </Text>
          </View>
          <Text class="font-mono text-xs tabular-nums text-muted-foreground">
            {`${formatUsd(comp().totalRiskUsd)} open · ${comp().totalAccounts} accts`}
          </Text>
        </View>

        <View class="flex-row items-center gap-2">
          <View class="items-end">
            <Text class="font-mono text-sm font-semibold tabular-nums text-foreground">
              {`${comp().indexValue.toFixed(2)}¢`}
            </Text>
            <Text
              class={
                comp().changePoints >= 0
                  ? "font-mono text-xs font-semibold tabular-nums text-positive"
                  : "font-mono text-xs font-semibold tabular-nums text-negative"
              }
            >
              {`${comp().changePoints >= 0 ? "+" : ""}${comp().changePoints.toFixed(2)}¢ (${comp().changePct >= 0 ? "+" : ""}${comp().changePct.toFixed(2)}%)`}
            </Text>
          </View>
          <View style={{ transform: [{ rotate: rotateStr }] }}>
            <Text class="text-xs font-semibold text-muted-foreground">›</Text>
          </View>
        </View>
      </View>

      <If when={store.compositeExpanded()}>
        <View class="gap-1.5 border-t border-border pt-2">
          <Text class="text-xs font-semibold text-muted-foreground">
            Breadth by League
          </Text>
          <Each of={comp().leagues} key={(row) => row.league}>
            {(row) => (
              <View class="gap-1">
                <View class="flex-row items-baseline justify-between gap-2">
                  <Text class="font-mono text-xs font-medium text-foreground">
                    {`${row().league} (${row().count})`}
                  </Text>
                  <Text
                    class={
                      row().avgEdgeBps >= 0
                        ? "font-mono text-xs tabular-nums text-positive"
                        : "font-mono text-xs tabular-nums text-negative"
                    }
                  >
                    {`${formatUsd(row().riskUsd)} · ${row().avgEdgeBps >= 0 ? "+" : ""}${row().avgEdgeBps} bps`}
                  </Text>
                </View>
                <SpringBar
                  ratio={row().ratio}
                  tone={row().avgEdgeBps >= 0 ? "positive" : "negative"}
                />
              </View>
            )}
          </Each>
        </View>
      </If>
    </Surface>
  );
}

function InstrumentDetailPane(props: {
  store: DeskStore;
  inst: () => MarketInstrument;
  compact: boolean;
}): JSX.Element {
  const { store } = props;
  const inst = props.inst;
  const dirArrowDeg = createAnimatedValue(0);

  effect(() => {
    const target = inst().quote.changeCents >= 0 ? 0 : 180;
    if (reduceMotion()) {
      dirArrowDeg.set(target);
    } else {
      void dirArrowDeg.spring(target, { stiffness: 260, damping: 24 });
    }
  });

  const dirRotate = dirArrowDeg.interpolate({
    inputRange: [0, 180],
    outputRange: ["0deg", "180deg"],
  });

  const visibleBids = () =>
    store.bookDepth10() ? inst().book.bids : inst().book.bids.slice(0, 5);
  const visibleAsks = () =>
    store.bookDepth10() ? inst().book.asks : inst().book.asks.slice(0, 5);

  return (
    <Scroll class="min-h-0 flex-1 bg-background">
      <View class="gap-3 p-3">
        {/* Quote Header & 8-Stat Grid (Open, Prev close ... Turnover) */}
        <Surface variant="card" class="gap-3">
          <View class="flex-row flex-wrap items-start justify-between gap-2">
            <View class="min-w-0 flex-1 gap-0.5">
              <View class="flex-row flex-wrap items-center gap-2">
                <Text
                  role="header"
                  class="font-mono text-sm font-semibold text-foreground"
                >
                  {inst().code}
                </Text>
                <Badge
                  label={inst().verdict.toUpperCase()}
                  tone={
                    inst().verdict === "actionable" ? "positive" : "neutral"
                  }
                />
                <Badge
                  label={formatProvenanceCompact(inst().provenance)}
                  tone={provenanceTone(inst().provenance)}
                />
              </View>
              <Text class="text-xs text-muted-foreground truncate">
                {`${inst().id} · ${inst().name}`}
              </Text>
            </View>

            <View class="flex-row items-center gap-1.5">
              <DeskButton
                testID="open-order-ticket-btn"
                label="Trade / Ticket"
                variant="primary"
                size="sm"
                onPress={() => store.openTicketForSelected()}
              />
            </View>
          </View>

          <View class="flex-row flex-wrap items-baseline justify-between gap-3">
            <View class="flex-row items-baseline gap-2.5">
              <Text class="font-mono text-xl font-semibold tabular-nums text-foreground">
                {`${inst().quote.last.toFixed(1)}¢`}
              </Text>
              <View style={{ transform: [{ rotate: dirRotate }] }}>
                <Text
                  class={
                    inst().quote.changeCents >= 0
                      ? "font-mono text-sm font-semibold text-positive"
                      : "font-mono text-sm font-semibold text-negative"
                  }
                >
                  ↑
                </Text>
              </View>
              <Text
                class={
                  inst().quote.changeCents >= 0
                    ? "font-mono text-xs font-semibold tabular-nums text-positive"
                    : "font-mono text-xs font-semibold tabular-nums text-negative"
                }
              >
                {`${inst().quote.changeCents >= 0 ? "+" : ""}${inst().quote.changeCents.toFixed(1)}¢ (${inst().quote.changePct >= 0 ? "+" : ""}${inst().quote.changePct.toFixed(2)}%)`}
              </Text>
              <If when={inst().quote.edgeBps !== null}>
                <Badge
                  label={`Edge ${(inst().quote.edgeBps ?? 0) >= 0 ? "+" : ""}${(inst().quote.edgeBps ?? 0).toFixed(0)} bps`}
                  tone={
                    (inst().quote.edgeBps ?? 0) >= 0 ? "positive" : "danger"
                  }
                />
              </If>
            </View>
            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
              {`Conf ${inst().quote.confidence}% · ${inst().reason}`}
            </Text>
          </View>

          <DayRangeBar
            low={inst().quote.low}
            high={inst().quote.high}
            prevClose={inst().quote.prevClose}
            last={inst().quote.last}
            formatValue={(v) => `${v.toFixed(1)}¢`}
          />

          <Separator />

          <StatGrid items={buildQuoteStats(inst())} compact={props.compact} />
        </Surface>

        {/* Multi-Period Scrubbable Canvas Chart */}
        <Surface variant="card" class="gap-2.5">
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <SectionHeader title="Price & Handle Trajectory" />
            <SegmentedTabs
              accessibilityLabel="Chart timeframe"
              items={CHART_PERIOD_TABS}
              value={store.chartPeriod()}
              onChange={(p) => store.setChartPeriod(p)}
            />
          </View>
          <MarketChartCanvas
            points={inst().periods[store.chartPeriod()]}
            prevClose={inst().quote.prevClose}
            unitSuffix="¢"
          />
        </Surface>

        {/* Order Book (5 -> 10) + Cumulative Depth Step Canvas */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <View class="flex-row items-center justify-between gap-2">
              <SectionHeader
                title="Order book"
                trailing={`Spread ${inst().book.spreadCents.toFixed(1)}¢`}
              />
              <DeskButton
                testID="book-depth-toggle"
                label={store.bookDepth10() ? "10 → 5" : "5 → 10"}
                size="xs"
                variant="outline"
                onPress={() => {
                  animateUserLayoutChange();
                  store.toggleBookDepth10();
                }}
              />
            </View>

            <View class="gap-1">
              <View class="flex-row items-baseline justify-between">
                <Text class="font-mono text-xs tabular-nums text-positive">
                  {`BID ${Math.round(inst().book.bidRatio * 100)}%`}
                </Text>
                <Text class="font-mono text-xs tabular-nums text-negative">
                  {`ASK ${Math.round(inst().book.askRatio * 100)}%`}
                </Text>
              </View>
              <View class="flex-row items-center gap-1">
                <SpringBar
                  ratio={inst().book.bidRatio}
                  from="right"
                  tone="positive"
                  class="flex-1"
                />
                <SpringBar
                  ratio={inst().book.askRatio}
                  from="left"
                  tone="negative"
                  class="flex-1"
                />
              </View>
            </View>

            <View class="flex-row gap-2">
              <View class="flex-1 gap-1">
                <Each of={visibleBids()} key={(b) => `B${b.level}`}>
                  {(b) => (
                    <View class="gap-0.5">
                      <View class="flex-row items-baseline justify-between gap-1">
                        <Text class="font-mono text-xs text-muted-foreground">
                          {`B${b().level}`}
                        </Text>
                        <Text class="font-mono text-xs font-medium tabular-nums text-positive">
                          {`${b().price.toFixed(1)}¢`}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-foreground">
                          {formatUsd(b().sizeUsd)}
                        </Text>
                      </View>
                      <SpringBar
                        ratio={b().ratio}
                        from="right"
                        tone="positive"
                        trackClass="h-1 bg-muted/50"
                      />
                    </View>
                  )}
                </Each>
              </View>

              <View class="flex-1 gap-1">
                <Each of={visibleAsks()} key={(a) => `A${a.level}`}>
                  {(a) => (
                    <View class="gap-0.5">
                      <View class="flex-row items-baseline justify-between gap-1">
                        <Text class="font-mono text-xs tabular-nums text-foreground">
                          {formatUsd(a().sizeUsd)}
                        </Text>
                        <Text class="font-mono text-xs font-medium tabular-nums text-negative">
                          {`${a().price.toFixed(1)}¢`}
                        </Text>
                        <Text class="font-mono text-xs text-muted-foreground">
                          {`A${a().level}`}
                        </Text>
                      </View>
                      <SpringBar
                        ratio={a().ratio}
                        from="left"
                        tone="negative"
                        trackClass="h-1 bg-muted/50"
                      />
                    </View>
                  )}
                </Each>
              </View>
            </View>
          </Surface>

          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <SectionHeader
              title="Depth & Multi-Horizon Ranges"
              trailing={`Imbalance ${inst().book.imbalancePct >= 0 ? "+" : ""}${inst().book.imbalancePct}%`}
            />
            <DepthChartCanvas
              bids={inst().book.bids}
              asks={inst().book.asks}
              unitSuffix="¢"
            />
            <RangesDumbbellCanvas ranges={inst().ranges} unitSuffix="¢" />
          </Surface>
        </View>

        {/* Time & Sales Tape + Stake-Tier Trade Flow */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-72 flex-1 gap-2">
            <SectionHeader
              title="Time & sales (Account Exposure Tape)"
              trailing="At ask · At bid · Blocks"
            />
            <Each of={inst().trades} key={(tr) => tr.key}>
              {(tr) => (
                <Surface
                  variant="inset"
                  class="flex-row flex-wrap items-center justify-between gap-2 px-2.5 py-1.5"
                >
                  <View class="min-w-0 flex-1 flex-row items-center gap-2">
                    <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                      {tr().timeLabel}
                    </Text>
                    <Text class="font-mono text-xs font-medium text-foreground truncate">
                      {`${tr().actor} [${tr().archetype}]`}
                    </Text>
                    <If when={tr().isBlock}>
                      <Badge label="BLOCK" tone="warning" />
                    </If>
                  </View>
                  <Text
                    class={
                      tr().side === "down"
                        ? "font-mono text-xs font-semibold tabular-nums text-negative"
                        : "font-mono text-xs font-semibold tabular-nums text-positive"
                    }
                  >
                    {`${tr().price.toFixed(1)}¢ · ${formatUsd(tr().sizeUsd)}`}
                  </Text>
                </Surface>
              )}
            </Each>
          </Surface>

          <Surface variant="card" class="min-w-72 flex-1 gap-2">
            <SectionHeader
              title="Trade flow"
              trailing="Inflow vs Outflow by Stake Tier"
            />
            <Each of={inst().flow} key={(f) => f.label}>
              {(f) => (
                <View class="gap-1">
                  <View class="flex-row items-baseline justify-between gap-2">
                    <Text class="text-xs font-medium text-foreground">
                      {f().label}
                    </Text>
                    <Text
                      class={
                        f().netUsd >= 0
                          ? "font-mono text-xs tabular-nums text-positive"
                          : "font-mono text-xs tabular-nums text-negative"
                      }
                    >
                      {`Net ${f().netUsd >= 0 ? "+" : ""}${formatUsd(f().netUsd)}`}
                    </Text>
                  </View>
                  <View class="flex-row items-center gap-1">
                    <SpringBar
                      ratio={f().outflowRatio}
                      from="right"
                      tone="negative"
                      class="flex-1"
                    />
                    <SpringBar
                      ratio={f().inflowRatio}
                      from="left"
                      tone="positive"
                      class="flex-1"
                    />
                  </View>
                </View>
              )}
            </Each>
          </Surface>
        </View>
      </View>
    </Scroll>
  );
}

/**
 * Flagship NSH `Apps -> Stocks`-inspired Markets Terminal panel.
 */
export function MarketsPanel(props: { store?: DeskStore } = {}): JSX.Element {
  const store = useDeskStore(props.store);
  const readyMotion = createPanelReadyMotion();
  const snap = () => store.kalshiSnap();
  const compact = () => windowSize().width < 760;

  return (
    <Surface variant="panel" class="min-h-0 flex-1">
      <If
        when={snap().status === "loading"}
        else={
          <If
            when={snap().status === "unavailable"}
            else={
              <If
                when={store.marketInstruments().length > 0}
                else={
                  <StateNotice
                    kind="empty"
                    title="No Kalshi signals reported"
                    detail="/api/signals/kalshi returned 0 active rows."
                    actionLabel="Refresh"
                    onAction={() => {
                      void store.refreshAll();
                    }}
                  />
                }
              >
                <View style={readyMotion.style} class="min-h-0 flex-1 flex-row">
                  {/* Left Watchlist Sidebar */}
                  <View
                    class={
                      compact()
                        ? "min-h-0 flex-1 gap-2 p-2.5"
                        : "min-h-0 w-72 shrink-0 gap-2 border-e border-border bg-card/45 p-2.5"
                    }
                  >
                    <View class="flex-row items-center justify-between gap-2">
                      <View class="flex-row items-center gap-1.5">
                        <LiveDot
                          live={store.autoPoll()}
                          accessibilityLabel="Auto-poll pulse"
                        />
                        <Text class="text-xs font-semibold text-foreground">
                          Watchlist
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {`(${store.filteredMarketInstruments().length})`}
                        </Text>
                      </View>
                      <Badge
                        label={(() => {
                          const s = snap();
                          if (s.status !== "ready") return "KALSHI";
                          return s.data.kalshiDegraded
                            ? "KALSHI · DEGRADED"
                            : s.data.kalshiOk
                              ? "KALSHI · OK"
                              : "KALSHI · OFFLINE";
                        })()}
                        tone={(() => {
                          const s = snap();
                          if (s.status !== "ready") return "neutral";
                          if (s.data.kalshiDegraded) return "warning";
                          return s.data.kalshiOk ? "positive" : "danger";
                        })()}
                      />
                    </View>

                    <CompositeHeaderStrip store={store} />

                    <SegmentedTabs
                      accessibilityLabel="Watchlist filter"
                      items={WATCH_FILTER_TABS}
                      value={store.marketFilter()}
                      onChange={(next) => {
                        animateUserLayoutChange();
                        store.setMarketFilter(next);
                      }}
                    />

                    <Scroll class="min-h-0 flex-1">
                      <View class="gap-1.5">
                        <Each
                          of={store.filteredMarketInstruments()}
                          key={(item) => item.id}
                        >
                          {(item) => {
                            const isSelected = () =>
                              store.selectedInstrument()?.id === item().id;
                            return (
                              <View
                                role="button"
                                testID={`watch-row-${item().id}`}
                                accessibilityLabel={`${item().code} ${item().quote.last.toFixed(1)} cents`}
                                onPress={() => {
                                  store.selectInstrumentById(item().id);
                                  if (compact()) {
                                    store.setMobileDetailOpen(true);
                                  }
                                }}
                                class={
                                  isSelected()
                                    ? "flex-row items-center justify-between gap-2 rounded-(--radius) border border-primary/50 bg-accent px-2.5 py-2"
                                    : "flex-row items-center justify-between gap-2 rounded-(--radius) border border-border/70 bg-card px-2.5 py-2 transition duration-100 hover:bg-accent/55 motion-reduce:transition-none"
                                }
                              >
                                <View class="min-w-0 flex-1 gap-0.5">
                                  <Text class="font-mono text-xs font-semibold text-foreground truncate">
                                    {item().code}
                                  </Text>
                                  <Text class="font-mono text-xs text-muted-foreground truncate">
                                    {item().id}
                                  </Text>
                                </View>

                                <SparklineCanvas
                                  values={item().sparkline}
                                  prevClose={item().quote.prevClose}
                                  live={store.autoPoll() && isSelected()}
                                />

                                <View class="items-end gap-0.5">
                                  <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                                    {`${item().quote.last.toFixed(1)}¢`}
                                  </Text>
                                  <Text
                                    class={
                                      item().quote.changePct >= 0
                                        ? "font-mono text-xs font-semibold tabular-nums text-positive"
                                        : "font-mono text-xs font-semibold tabular-nums text-negative"
                                    }
                                  >
                                    {`${item().quote.changePct >= 0 ? "+" : ""}${item().quote.changePct.toFixed(1)}%`}
                                  </Text>
                                </View>
                              </View>
                            );
                          }}
                        </Each>
                      </View>
                    </Scroll>
                  </View>

                  {/* Right Master-Detail Pane (Desktop) or Sheet (Mobile) */}
                  <If
                    when={!compact()}
                    else={
                      <If when={store.selectedInstrument()}>
                        {(sel) => (
                          <DeskSheet
                            open={store.mobileDetailOpen()}
                            onOpenChange={(open) =>
                              store.setMobileDetailOpen(open)
                            }
                            title={sel().code}
                            subtitle={sel().name}
                          >
                            <InstrumentDetailPane
                              store={store}
                              inst={sel}
                              compact={true}
                            />
                          </DeskSheet>
                        )}
                      </If>
                    }
                  >
                    <If when={store.selectedInstrument()}>
                      {(sel) => (
                        <InstrumentDetailPane
                          store={store}
                          inst={sel}
                          compact={false}
                        />
                      )}
                    </If>
                  </If>
                </View>
              </If>
            }
          >
            <StateNotice
              kind="unavailable"
              title="Kalshi signals unavailable"
              detail={(() => {
                const s = snap();
                return s.status === "unavailable" ? s.cause : "";
              })()}
              actionLabel="Refresh"
              onAction={() => {
                void store.refreshAll();
              }}
            />
          </If>
        }
      >
        <StateNotice
          kind="loading"
          title="Loading Kalshi signals"
          detail="GET /api/signals/kalshi"
        />
      </If>
    </Surface>
  );
}
