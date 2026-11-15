import { platform, Scroll, Text, View, type JSX } from "nsh";
import {
  formatUsd,
  type TerminalBlotterStatusFilter,
  type TerminalInspectorTab,
  type TerminalLadderRow,
  type TerminalLadderViewMode,
} from "../desk_model";
import type { DeskStore } from "../store";
import {
  animateUserLayoutChange,
  Badge,
  createPanelReadyMotion,
  DeskButton,
  DeskInput,
  DeskSwitch,
  DualTrajectoryCanvas,
  LiveDot,
  ProvenanceChannelBadge,
  SectionHeader,
  SegmentedTabs,
  Separator,
  SpringBar,
  StateNotice,
  Surface,
  type BadgeTone,
  type SegmentedTabItem,
} from "../ui";

const INSPECTOR_TABS: readonly SegmentedTabItem<TerminalInspectorTab>[] = [
  { id: "betslip", label: "Bet Slip" },
  { id: "otc", label: "Telegram OTC" },
  { id: "hedge", label: "Hedge Monitor" },
];

const LADDER_TABS: readonly SegmentedTabItem<TerminalLadderViewMode>[] = [
  { id: "live", label: "Live Odds" },
  { id: "movement", label: "Odds Movement" },
  { id: "key_numbers", label: "Key Numbers" },
];

const BLOTTER_STATUS_TABS: readonly SegmentedTabItem<TerminalBlotterStatusFilter>[] =
  [
    { id: "all", label: "All" },
    { id: "accepted", label: "Accepted" },
    { id: "auto", label: "Auto" },
    { id: "flagged", label: "Flagged" },
    { id: "hedged", label: "Hedged" },
    { id: "hedge_pending", label: "Hedge Pending" },
  ];

function kpiValueClass(
  tone: "default" | "positive" | "warning" | "danger",
): string {
  if (tone === "positive") {
    return "font-mono text-base font-semibold tabular-nums text-positive";
  }
  if (tone === "warning") {
    return "font-mono text-base font-semibold tabular-nums text-warning";
  }
  if (tone === "danger") {
    return "font-mono text-base font-semibold tabular-nums text-destructive";
  }
  return "font-mono text-base font-semibold tabular-nums text-foreground";
}

function sorStatusBadgeTone(
  status: "PASS" | "WARN" | "REJECT" | "UNMEASURED",
): BadgeTone {
  if (status === "PASS") return "positive";
  if (status === "WARN") return "warning";
  if (status === "REJECT") return "danger";
  return "neutral";
}

function filterLadderRowsForMode(
  rows: readonly TerminalLadderRow[],
  mode: TerminalLadderViewMode,
): readonly TerminalLadderRow[] {
  if (mode === "key_numbers") {
    const flagged = rows.filter((r) => r.riskBadge !== null);
    return flagged.length > 0 ? flagged : rows;
  }
  return rows;
}

export function TradingTerminalWorkspace(props: {
  store: DeskStore;
}): JSX.Element {
  const store = props.store;
  const snap = () => store.tradingTerminalSnapshot();
  const readyMotion = createPanelReadyMotion();

  return (
    <Scroll
      class="min-h-0 flex-1 bg-background"
      testID="trading-terminal-workspace"
    >
      <View style={readyMotion.style} class="gap-3 p-3">
        {/* Panel 1: Top KPI Strip + Read-Only Banner + Search */}
        <Surface variant="card" class="gap-2.5">
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <View class="flex-row flex-wrap items-center gap-2">
              <LiveDot
                live={store.autoPoll() || snap().totalLiveGames > 0}
                accessibilityLabel="Trading desk stream status"
              />
              <Text
                role="header"
                class="text-sm font-semibold text-card-foreground"
              >
                Unified Institutional Trading Desk
              </Text>
              <Badge
                testID="terminal-readonly-badge"
                label="READ-ONLY SNAPSHOT"
                tone="info"
              />
              <Text class="font-mono text-xs text-muted-foreground">
                Zero order-routing, OTC approval, or hedge execution mutations
              </Text>
            </View>

            <View class="flex-row flex-wrap items-center gap-2">
              <DeskInput
                testID="terminal-search-input"
                accessibilityLabel="Search trading desk matches, accounts, or channels"
                value={store.terminalSearchQuery()}
                placeholder="Search match, account, channel…"
                mono={true}
                class="w-60"
                onChangeText={(next) => store.setTerminalSearchQuery(next)}
              />
              <If when={store.terminalSearchQuery().length > 0}>
                <DeskButton
                  label="Clear"
                  size="xs"
                  variant="ghost"
                  onPress={() => store.setTerminalSearchQuery("")}
                />
              </If>
            </View>
          </View>

          <Separator />

          <View class="flex-row flex-wrap gap-2.5">
            <Each of={snap().kpis} key={(item) => item.id}>
              {(kpi) => (
                <Surface
                  variant="inset"
                  class="min-w-36 flex-1 justify-between gap-1"
                >
                  <View class="flex-row items-center justify-between gap-1.5">
                    <Text class="text-xs font-medium text-muted-foreground">
                      {kpi().label}
                    </Text>
                    <Badge
                      label={kpi().provenance}
                      tone={
                        kpi().tone === "danger"
                          ? "danger"
                          : kpi().tone === "positive"
                            ? "positive"
                            : "neutral"
                      }
                    />
                  </View>
                  <Text class={kpiValueClass(kpi().tone)}>{kpi().value}</Text>
                </Surface>
              )}
            </Each>
          </View>
        </Surface>

        {/* Main 3-Column Institutional Grid: Sport View | Line & Live Trading | Read-Only Inspector */}
        <View class={platform.desktop ? "flex-row flex-wrap gap-3" : "gap-3"}>
          {/* Left Column: Sport View Hierarchy */}
          <Surface
            variant="card"
            testID="terminal-sport-view"
            class={platform.desktop ? "w-56 shrink-0 gap-2" : "gap-2"}
          >
            <SectionHeader
              title="Sport View"
              trailing={`Live (${snap().totalLiveGames})`}
            />

            <DeskButton
              testID="sport-filter-all"
              label={`All Sports (${snap().totalLiveGames} live · ${snap().blotterSummary.canonicalCount} bets)`}
              size="xs"
              variant="outline"
              selected={store.terminalSportFilter() === "ALL"}
              onPress={() => {
                animateUserLayoutChange();
                store.setTerminalSportFilter("ALL");
              }}
            />

            <Separator />

            <If
              when={snap().sportTree.length > 0}
              else={
                <StateNotice
                  kind="empty"
                  title="No active sports"
                  detail="Waiting for /api/scoreboard, /api/game-admin/board, or /api/signals/kalshi."
                />
              }
            >
              <View class="gap-1.5">
                <Each of={snap().sportTree} key={(node) => node.filterKey}>
                  {(node) => {
                    const isExpanded = () =>
                      store.terminalExpandedSports()[node().sport] !== false;
                    const sportSelected = () =>
                      store.terminalSportFilter() === node().filterKey;
                    return (
                      <View class="gap-1">
                        <View class="flex-row items-center justify-between gap-1">
                          <DeskButton
                            label={`${isExpanded() ? "▾" : "▸"} ${node().sport}`}
                            size="xs"
                            variant={sportSelected() ? "default" : "ghost"}
                            selected={sportSelected()}
                            class="flex-1 justify-start"
                            onPress={() => {
                              animateUserLayoutChange();
                              if (sportSelected()) {
                                store.toggleTerminalSportExpanded(node().sport);
                              } else {
                                store.setTerminalSportFilter(node().filterKey);
                              }
                            }}
                          />
                          <Badge
                            label={`${node().liveCount + node().betCount}`}
                            tone={node().liveCount > 0 ? "positive" : "neutral"}
                          />
                        </View>

                        <If when={isExpanded()}>
                          <View class="gap-1 ps-3">
                            <Each
                              of={node().leagues}
                              key={(lg) => lg.filterKey}
                            >
                              {(lg) => (
                                <View class="flex-row items-center justify-between gap-1">
                                  <DeskButton
                                    testID={`sport-league-${lg().league}`}
                                    label={lg().league}
                                    size="xs"
                                    variant="ghost"
                                    selected={
                                      store.terminalSportFilter() ===
                                      lg().filterKey
                                    }
                                    onPress={() => {
                                      animateUserLayoutChange();
                                      store.setTerminalSportFilter(
                                        lg().filterKey,
                                      );
                                    }}
                                  />
                                  <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                                    {`${lg().liveCount}L · ${lg().betCount}B`}
                                  </Text>
                                </View>
                              )}
                            </Each>
                          </View>
                        </If>
                      </View>
                    );
                  }}
                </Each>
              </View>
            </If>
          </Surface>

          {/* Center Area: Line-Trading Dashboard + Live Trading Dashboard Cards */}
          <View class="min-w-80 flex-3 gap-3">
            <View
              class={platform.desktop ? "flex-row flex-wrap gap-3" : "gap-3"}
            >
              {/* Panel 3: Line-Trading Dashboard */}
              <Surface
                variant="card"
                testID="line-trading-dashboard"
                class="min-w-76 flex-1 gap-2.5"
              >
                <SectionHeader
                  title="Line-Trading Dashboard"
                  subtitle="1X2, Spread & Over-Under ladder · Point & Historic Odds trajectories"
                  trailing={
                    snap().selectedMatch ? snap().selectedMatch!.league : "—"
                  }
                />

                <If
                  when={snap().selectedMatch}
                  else={
                    <StateNotice
                      kind="empty"
                      title="No match selected"
                      detail="No live or scheduled matchups match the active Sport View filter."
                    />
                  }
                >
                  {(match) => (
                    <View class="gap-2.5">
                      <Surface variant="inset" class="gap-2">
                        <View class="flex-row flex-wrap items-center justify-between gap-2">
                          <View class="flex-row flex-wrap items-baseline gap-2">
                            <Text class="text-sm font-semibold text-foreground">
                              {`${match().awayTeam} vs ${match().homeTeam}`}
                            </Text>
                            <Text class="font-mono text-sm font-semibold tabular-nums text-positive">
                              {match().scoreLabel}
                            </Text>
                            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                              {`(${match().periodClock})`}
                            </Text>
                          </View>
                          <Badge
                            label={`${match().status} · ${match().provenanceLabel}`}
                            tone={
                              match().status === "LIVE" ? "positive" : "neutral"
                            }
                          />
                        </View>

                        <View class="gap-1.5">
                          <Text class="text-xs font-semibold text-muted-foreground">
                            Live Performance & Handle Split
                          </Text>
                          <Each
                            of={match().performanceBars}
                            key={(bar) => bar.label}
                          >
                            {(bar) => (
                              <View class="gap-1">
                                <View class="flex-row items-center justify-between">
                                  <Text class="font-mono text-xs tabular-nums text-foreground">
                                    {bar().awayValueLabel}
                                  </Text>
                                  <Text class="text-xs text-muted-foreground">
                                    {bar().label}
                                  </Text>
                                  <Text class="font-mono text-xs tabular-nums text-foreground">
                                    {bar().homeValueLabel}
                                  </Text>
                                </View>
                                <View class="flex-row items-center gap-1.5">
                                  <SpringBar
                                    ratio={bar().awayRatio}
                                    from="right"
                                    tone="primary"
                                    class="flex-1"
                                  />
                                  <SpringBar
                                    ratio={bar().homeRatio}
                                    from="left"
                                    tone="positive"
                                    class="flex-1"
                                  />
                                </View>
                              </View>
                            )}
                          </Each>
                        </View>
                      </Surface>

                      <SegmentedTabs
                        accessibilityLabel="Line-trading ladder view"
                        items={LADDER_TABS}
                        value={store.terminalLadderMode()}
                        onChange={(next) => {
                          animateUserLayoutChange();
                          store.setTerminalLadderMode(next);
                        }}
                      />

                      <View class="gap-1.5">
                        <View class="flex-row items-center justify-between px-1">
                          <Text class="text-xs font-semibold text-muted-foreground">
                            Market / Line
                          </Text>
                          <Text class="font-mono text-xs text-muted-foreground">
                            Away / Mid / Home · Move
                          </Text>
                        </View>
                        <Each
                          of={filterLadderRowsForMode(
                            match().ladderRows,
                            store.terminalLadderMode(),
                          )}
                          key={(row) => row.id}
                        >
                          {(row) => (
                            <Surface variant="inset" class="gap-1 py-2">
                              <View class="flex-row flex-wrap items-center justify-between gap-2">
                                <View class="flex-row items-center gap-1.5">
                                  <Badge
                                    label={row().marketType}
                                    tone="neutral"
                                  />
                                  <Text class="text-xs font-medium text-foreground">
                                    {row().lineLabel}
                                  </Text>
                                  <If when={row().riskBadge !== null}>
                                    <Badge
                                      label={row().riskBadge ?? ""}
                                      tone="warning"
                                    />
                                  </If>
                                </View>

                                <View class="flex-row items-center gap-2">
                                  <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                                    {row().awayOdds}
                                  </Text>
                                  <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                                    {row().midOrDrawLabel}
                                  </Text>
                                  <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                                    {row().homeOdds}
                                  </Text>
                                  <Badge
                                    label={row().deltaLabel}
                                    tone={
                                      row().deltaTone === "positive"
                                        ? "positive"
                                        : row().deltaTone === "negative"
                                          ? "danger"
                                          : "neutral"
                                    }
                                  />
                                </View>
                              </View>
                            </Surface>
                          )}
                        </Each>
                      </View>

                      <Separator />

                      <View class="gap-1.5">
                        <Text class="text-xs font-semibold text-muted-foreground">
                          Point Chart
                        </Text>
                        <DualTrajectoryCanvas
                          points={match().pointChart}
                          primaryLabel={match().awayTeam.slice(0, 8)}
                          secondaryLabel={match().homeTeam.slice(0, 8)}
                          baseline={0}
                          accessibilityLabel="Match score and momentum trajectory"
                        />
                      </View>

                      <View class="gap-1.5">
                        <Text class="text-xs font-semibold text-muted-foreground">
                          Historic Odds
                        </Text>
                        <DualTrajectoryCanvas
                          points={match().historicOddsChart}
                          primaryLabel="Book"
                          secondaryLabel="Poly"
                          unitSuffix="¢"
                          baseline={50}
                          accessibilityLabel="Historic book versus Polymarket fair probability trajectory"
                        />
                      </View>
                    </View>
                  )}
                </If>
              </Surface>

              {/* Panel 4: Live Trading Dashboard Multi-Match Cards */}
              <Surface
                variant="card"
                testID="live-trading-dashboard"
                class="min-w-72 flex-1 gap-2.5"
              >
                <SectionHeader
                  title={`Live Trading Dashboard (${snap().liveMatches.length})`}
                  subtitle="Select any live card to inspect full ladder & curves"
                />

                <If
                  when={snap().liveMatches.length > 0}
                  else={
                    <StateNotice
                      kind="empty"
                      title="No live matches in view"
                      detail="Clear search or switch Sport View filter to inspect active games."
                    />
                  }
                >
                  <View class="gap-2">
                    <Each of={snap().liveMatches} key={(m) => m.id}>
                      {(m) => {
                        const isSelected = () =>
                          snap().selectedMatch?.id === m().id;
                        return (
                          <Surface
                            variant="inset"
                            testID={`live-match-card-${m().id}`}
                            onPress={() => {
                              animateUserLayoutChange();
                              store.setTerminalSelectedMatchId(m().id);
                            }}
                            class={
                              isSelected()
                                ? "gap-2 border-primary bg-accent/45"
                                : "gap-2 hover:bg-accent/30"
                            }
                          >
                            <View class="flex-row items-center justify-between gap-2">
                              <View class="flex-row items-center gap-1.5">
                                <Badge label={m().league} tone="neutral" />
                                <Text class="text-xs font-semibold text-foreground">
                                  {`${m().awayTeam} vs ${m().homeTeam}`}
                                </Text>
                              </View>
                              <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                                {m().periodClock}
                              </Text>
                            </View>

                            <View class="flex-row items-center justify-between">
                              <Text class="font-mono text-sm font-semibold tabular-nums text-positive">
                                {m().scoreLabel}
                              </Text>
                              <Badge
                                label={m().status}
                                tone={
                                  m().status === "LIVE" ? "positive" : "neutral"
                                }
                              />
                            </View>

                            <View class="gap-1">
                              <Each of={m().ladderRows} key={(lr) => lr.id}>
                                {(lr) => (
                                  <View class="flex-row items-center justify-between gap-2">
                                    <Text class="font-mono text-xs text-muted-foreground">
                                      {lr().marketType}
                                    </Text>
                                    <View class="flex-row items-center gap-2">
                                      <Text class="font-mono text-xs tabular-nums text-foreground">
                                        {lr().awayOdds}
                                      </Text>
                                      <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                                        {lr().midOrDrawLabel}
                                      </Text>
                                      <Text class="font-mono text-xs tabular-nums text-foreground">
                                        {lr().homeOdds}
                                      </Text>
                                      <Text
                                        class={
                                          lr().deltaTone === "positive"
                                            ? "font-mono text-xs tabular-nums text-positive"
                                            : lr().deltaTone === "negative"
                                              ? "font-mono text-xs tabular-nums text-destructive"
                                              : "font-mono text-xs tabular-nums text-muted-foreground"
                                        }
                                      >
                                        {lr().deltaLabel}
                                      </Text>
                                    </View>
                                  </View>
                                )}
                              </Each>
                            </View>
                          </Surface>
                        );
                      }}
                    </Each>
                  </View>
                </If>
              </Surface>
            </View>
          </View>

          {/* Right Column: Read-Only OTC / Bet Slip / Hedge Inspector + Liability vs Polymarket + Liability Monitor */}
          <View class={platform.desktop ? "w-84 shrink-0 gap-3" : "gap-3"}>
            {/* Card 5A: Bet Slip | Telegram OTC | Hedge Monitor (Strictly Read-Only) */}
            <Surface
              variant="card"
              testID="terminal-inspector-card"
              class="gap-2.5"
            >
              <View class="flex-row items-center justify-between gap-2">
                <SegmentedTabs
                  accessibilityLabel="Read-only quote and hedge inspector"
                  items={INSPECTOR_TABS}
                  value={store.terminalInspectorTab()}
                  onChange={(next) => {
                    animateUserLayoutChange();
                    store.setTerminalInspectorTab(next);
                  }}
                />
              </View>

              <If when={store.terminalInspectorTab() === "otc"}>
                <View class="gap-2" testID="terminal-otc-panel">
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs font-semibold text-foreground">
                      Telegram OTC Quote Feed
                    </Text>
                    <Badge label="READ-ONLY" tone="info" />
                  </View>

                  <If
                    when={snap().otcQuotes.length > 0}
                    else={
                      <StateNotice
                        kind="empty"
                        title="No OTC quote snapshots"
                        detail="High-stake / gateway quote requests appear here for read-only pricing inspection."
                      />
                    }
                  >
                    <View class="gap-2">
                      <Each of={snap().otcQuotes} key={(q) => q.id}>
                        {(q) => (
                          <Surface variant="inset" class="gap-1.5">
                            <View class="flex-row items-center justify-between gap-2">
                              <Text class="font-mono text-xs font-semibold text-foreground">
                                {`User: ${q().customerHandle}`}
                              </Text>
                              <Badge
                                label={q().advisoryVerdict}
                                tone={q().verdictTone}
                              />
                            </View>
                            <Text class="text-xs text-muted-foreground">
                              {`Match: ${q().matchup}`}
                            </Text>
                            <Text class="text-xs font-medium text-foreground">
                              {`Side: ${q().sideLabel}`}
                            </Text>
                            <View class="flex-row flex-wrap items-center justify-between gap-2">
                              <Text class="font-mono text-xs tabular-nums text-foreground">
                                {`Stake: ${q().stakeFormatted}`}
                              </Text>
                              <Text class="font-mono text-xs tabular-nums text-warning">
                                {`Req: ${q().requestedOdds} · Fair: ${q().bookFairOdds}`}
                              </Text>
                            </View>
                            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                              {`Implied Edge: ${q().edgeBps >= 0 ? `+${q().edgeBps}` : q().edgeBps} bps · Snapshot only (no approval controls)`}
                            </Text>
                          </Surface>
                        )}
                      </Each>
                    </View>
                  </If>
                </View>
              </If>

              <If when={store.terminalInspectorTab() === "betslip"}>
                <View class="gap-2" testID="terminal-betslip-panel">
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs font-semibold text-foreground">
                      Selected Market Pricing
                    </Text>
                    <Badge label="READ-ONLY" tone="info" />
                  </View>
                  <If
                    when={snap().betSlip}
                    else={
                      <StateNotice
                        kind="empty"
                        title="No market selected"
                        detail="Select a match to inspect book vs no-vig fair pricing."
                      />
                    }
                  >
                    {(bs) => (
                      <Surface variant="inset" class="gap-1.5">
                        <Text class="text-xs font-semibold text-foreground">
                          {bs().matchup}
                        </Text>
                        <Text class="text-xs text-muted-foreground">
                          {bs().marketLabel}
                        </Text>
                        <Separator />
                        <View class="flex-row items-center justify-between">
                          <Text class="text-xs text-muted-foreground">
                            Book Odds / No-Vig Fair
                          </Text>
                          <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                            {`${bs().bookDecimalOdds} / ${bs().noVigFairOdds}`}
                          </Text>
                        </View>
                        <View class="flex-row items-center justify-between">
                          <Text class="text-xs text-muted-foreground">
                            Polymarket Mid / Vig
                          </Text>
                          <Text class="font-mono text-xs tabular-nums text-positive">
                            {`${bs().polymarketMidPct} · ${bs().overroundPct}`}
                          </Text>
                        </View>
                        <Text class="font-mono text-xs text-muted-foreground">
                          {bs().layoffAdvisory}
                        </Text>
                      </Surface>
                    )}
                  </If>
                </View>
              </If>

              <If when={store.terminalInspectorTab() === "hedge"}>
                <Surface
                  variant="inset"
                  testID="terminal-hedge-panel"
                  class="gap-1.5"
                >
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs font-semibold text-foreground">
                      SOR-1 Slippage Advisory
                    </Text>
                    <Badge
                      label={`SOR-1 · ${snap().hedgeMonitor.sor1Status}`}
                      tone={sorStatusBadgeTone(snap().hedgeMonitor.sor1Status)}
                    />
                  </View>
                  <View class="flex-row items-center justify-between">
                    <Text class="text-xs text-muted-foreground">
                      Observed Walk / Caps
                    </Text>
                    <Text class="font-mono text-xs tabular-nums text-foreground">
                      {`${snap().hedgeMonitor.observedSlippageBps ?? "—"} bps (soft ${snap().hedgeMonitor.softLimitBps} / max ${snap().hedgeMonitor.hardCeilingBps})`}
                    </Text>
                  </View>
                  <Text class="font-mono text-xs text-muted-foreground">
                    {snap().hedgeMonitor.advisoryNote}
                  </Text>
                </Surface>
              </If>
            </Surface>

            {/* Card 5B: Book Liability vs Polymarket Liquidity */}
            <Surface
              variant="card"
              testID="liability-vs-polymarket-card"
              class="gap-2.5"
            >
              <SectionHeader
                title="Book Liability vs Polymarket Liquidity"
                trailing={
                  <Badge
                    label={`SOR-1 ${snap().liabilityVsLiquidity.sor1Status}`}
                    tone={sorStatusBadgeTone(
                      snap().liabilityVsLiquidity.sor1Status,
                    )}
                  />
                }
              />

              <View class="gap-1">
                <View class="flex-row items-center justify-between">
                  <Text class="text-xs text-muted-foreground">
                    Our Book Liability
                  </Text>
                  <Text class="font-mono text-xs font-semibold tabular-nums text-warning">
                    {snap().liabilityVsLiquidity.bookFormatted}
                  </Text>
                </View>
                <SpringBar
                  ratio={snap().liabilityVsLiquidity.bookRatio}
                  tone="warning"
                />
              </View>

              <View class="gap-1">
                <View class="flex-row items-center justify-between">
                  <Text class="text-xs text-muted-foreground">
                    Polymarket Available Liquidity
                  </Text>
                  <Text class="font-mono text-xs font-semibold tabular-nums text-positive">
                    {snap().liabilityVsLiquidity.polyFormatted}
                  </Text>
                </View>
                <SpringBar
                  ratio={snap().liabilityVsLiquidity.polyRatio}
                  tone="positive"
                />
              </View>

              <View class="flex-row items-center justify-between">
                <Text class="font-mono text-xs text-muted-foreground">
                  {snap().liabilityVsLiquidity.provenanceLabel}
                </Text>
                <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                  {(() => {
                    const pct = snap().liabilityVsLiquidity.coveragePct;
                    return pct !== null
                      ? `Coverage ${pct.toFixed(1)}%`
                      : "Coverage —";
                  })()}
                </Text>
              </View>
            </Surface>

            {/* Card 5C: Liability Monitor Matrix + Show Unhedged Only */}
            <Surface
              variant="card"
              testID="liability-monitor-card"
              class="gap-2.5"
            >
              <SectionHeader
                title="Liability Monitor"
                subtitle="Total Wagered · Hold · Net Risk across outcomes"
              />

              <If
                when={snap().liabilityMatrix.length > 0}
                else={
                  <StateNotice
                    kind="empty"
                    title="No matching exposure rows"
                    detail={
                      store.terminalUnhedgedOnly()
                        ? "All tracked outcomes are hedged. Toggle off Show Unhedged Only to inspect full matrix."
                        : "Waiting for /api/game-admin or /api/signals/kalshi exposure slices."
                    }
                  />
                }
              >
                <View class="gap-1.5">
                  <View class="flex-row items-center justify-between px-1">
                    <Text class="text-xs font-semibold text-muted-foreground">
                      Outcome
                    </Text>
                    <Text class="font-mono text-xs text-muted-foreground">
                      Total / Hold / Risk
                    </Text>
                  </View>
                  <Each of={snap().liabilityMatrix} key={(r) => r.id}>
                    {(r) => (
                      <Surface variant="inset" class="py-1.5">
                        <View class="flex-row items-center justify-between gap-2">
                          <View class="min-w-0 flex-1">
                            <Text class="truncate text-xs font-medium text-foreground">
                              {r().outcomeLabel}
                            </Text>
                            <Text class="font-mono text-xs text-muted-foreground">
                              {r().league}
                            </Text>
                          </View>
                          <View class="flex-row items-center gap-2">
                            <Text class="font-mono text-xs tabular-nums text-foreground">
                              {r().totalFormatted}
                            </Text>
                            <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                              {r().holdFormatted}
                            </Text>
                            <Badge
                              label={r().netRiskFormatted}
                              tone={r().tone}
                            />
                          </View>
                        </View>
                      </Surface>
                    )}
                  </Each>
                </View>
              </If>

              <Separator />

              <DeskSwitch
                testID="terminal-unhedged-switch"
                label="Show Unhedged Only"
                checked={store.terminalUnhedgedOnly()}
                onChange={(next) => {
                  animateUserLayoutChange();
                  store.setTerminalUnhedgedOnly(next);
                }}
              />
            </Surface>
          </View>
        </View>

        {/* Panel 6: Bottom Full-Width Active Bet Logs & Risk Triggers Blotter */}
        <Surface
          variant="card"
          testID="active-bet-logs-blotter"
          class="gap-2.5"
        >
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <SectionHeader
              title="Active Bet Logs & Risk Triggers"
              subtitle={`Canonical stake ${formatUsd(snap().blotterSummary.canonicalStakeUsd)} · liability ${formatUsd(snap().blotterSummary.canonicalLiabilityUsd)} (${snap().blotterSummary.excludedNoiseCount} ALERT/BLOCKED excluded from volume)`}
              trailing={`${snap().blotterRows.length} shown`}
            />
            <SegmentedTabs
              accessibilityLabel="Active bet blotter filter"
              items={BLOTTER_STATUS_TABS}
              value={store.terminalBlotterStatus()}
              onChange={(next) => {
                animateUserLayoutChange();
                store.setTerminalBlotterStatus(next);
              }}
            />
          </View>

          <Separator />

          <If
            when={snap().blotterRows.length > 0}
            else={
              <StateNotice
                kind="empty"
                title="No active bets match current filters"
                detail="Adjust status tabs, search query, Sport View, or Show Unhedged Only switch."
              />
            }
          >
            <View class="gap-1.5">
              <View class="flex-row flex-wrap items-center justify-between px-2">
                <Text class="text-xs font-semibold text-muted-foreground">
                  Timestamp · Account · Sport · Market
                </Text>
                <Text class="font-mono text-xs font-semibold text-muted-foreground">
                  Book / Poly · Stake / Liability · Channel · Status · Hedge
                  Coverage
                </Text>
              </View>

              <Each of={snap().blotterRows} key={(row) => row.id}>
                {(row) => (
                  <Surface
                    variant="inset"
                    testID={`blotter-row-${row().id}`}
                    class="py-2"
                  >
                    <View class="flex-row flex-wrap items-center justify-between gap-2">
                      <View class="min-w-64 flex-1 flex-row flex-wrap items-center gap-2">
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {row().timestamp}
                        </Text>
                        <Text class="font-mono text-xs font-semibold text-foreground">
                          {row().account}
                        </Text>
                        <Badge label={row().league} tone="neutral" />
                        <Text class="text-xs text-foreground">
                          {row().market}
                        </Text>
                      </View>

                      <View class="flex-row flex-wrap items-center gap-2">
                        <Text class="font-mono text-xs tabular-nums text-foreground">
                          {`${row().bookOdds} / ${row().polyFairOdds}`}
                        </Text>
                        <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                          {row().stakeFormatted}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-warning">
                          {row().liabilityFormatted}
                        </Text>
                        <ProvenanceChannelBadge
                          channel={row().channel}
                          writer={row().writer}
                        />
                        <Badge
                          label={row().status}
                          tone={
                            row().status === "Flagged"
                              ? "danger"
                              : row().status === "Accepted"
                                ? "positive"
                                : "neutral"
                          }
                        />
                        <Badge
                          label={row().hedgeStatus}
                          tone={
                            row().hedgeStatus === "Hedged"
                              ? "positive"
                              : row().hedgeStatus === "Hedge Pending"
                                ? "warning"
                                : "neutral"
                          }
                        />
                      </View>
                    </View>
                  </Surface>
                )}
              </Each>
            </View>
          </If>
        </Surface>
      </View>
    </Scroll>
  );
}
