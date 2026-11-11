import { Scroll, Text, View, type JSX } from "nsh";
import { formatUsd, type LiveBetsSourceMode } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  Badge,
  createPanelReadyMotion,
  DeskButton,
  DeskInput,
  SectionHeader,
  SegmentedTabs,
  Separator,
  SpringBar,
  StateNotice,
  Surface,
  type SegmentedTabItem,
} from "../ui";

const WINDOW_TABS: readonly SegmentedTabItem<"24" | "48" | "-1">[] = [
  { id: "24", label: "24h Window" },
  { id: "48", label: "48h Window" },
  { id: "-1", label: "Current -1" },
];

const SOURCE_TABS: readonly SegmentedTabItem<LiveBetsSourceMode>[] = [
  { id: "file", label: "File" },
  { id: "auto", label: "Auto" },
  { id: "live", label: "Live" },
];

export function BoardWorkspace(props: { store?: DeskStore }): JSX.Element {
  const store = useDeskStore(props.store);
  const boardSnap = () => store.gameAdminBoardSnap();
  const adminSnap = () => store.gameAdminSnap();
  const sportsSnap = () => store.sportsSnap();
  const catalogSnap = () => store.sportsCatalogSnap();
  const logoSnap = () => store.logoMetaSnap();
  const contestsSnap = () => store.contestsSnap();
  const v1Snap = () => store.v1LiveBetsSnap();
  const v2Snap = () => store.v2LiveBetsSnap();
  const wagersSnap = () => store.liveWagersSnap();
  const retiredSnap = () => store.retiredPendingSnap();

  const readyMotion = createPanelReadyMotion();

  const windowValue = (): "24" | "48" | "-1" => {
    const w = store.boardWindow();
    if (w === 48) return "48";
    if (w === -1) return "-1";
    return "24";
  };

  const maxAdminWagered = () => {
    const a = adminSnap();
    if (a.status !== "ready" || a.data.games.length === 0) return 1;
    let m = 1;
    for (const g of a.data.games) {
      if (g.wageredUsd > m) m = g.wageredUsd;
    }
    return m;
  };

  return (
    <Scroll class="min-h-0 flex-1 bg-background" testID="board-workspace">
      <View style={readyMotion.style} class="gap-3 p-3">
        <View class="flex-row flex-wrap items-center justify-between gap-2">
          <SectionHeader
            title="Board, Sports Catalog & Live Bets Plane"
            subtitle="12 canonical :4020 routes — Game Admin lines, Straight/Parlay/Teaser rollups, taxonomy, contests & v1/v2 live-bets"
            trailing={
              <DeskButton
                testID="board-reload-btn"
                label="Reload Board Plane"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.loadBoardPlane();
                }}
              />
            }
          />
        </View>

        {/* Row 1: Game Admin Board + Straight/Parlay/Teaser Rollups */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-80 flex-2 gap-2.5">
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <SectionHeader
                title="Game Admin Line Board (/api/game-admin/board)"
                subtitle={(() => {
                  const b = boardSnap();
                  if (b.status !== "ready")
                    return "Opener vs current spread, moneyline & total";
                  return `source=${b.data.source} · games=${b.data.gamesCount}${b.data.totalWageredUsd !== null ? ` · wagered=${formatUsd(b.data.totalWageredUsd)}` : ""}`;
                })()}
              />
              <SegmentedTabs
                accessibilityLabel="Game Admin board window"
                items={WINDOW_TABS}
                value={windowValue()}
                onChange={(next) => {
                  const num = next === "48" ? 48 : next === "-1" ? -1 : 24;
                  store.setBoardWindow(num);
                }}
              />
            </View>

            <If
              when={boardSnap().status === "ready"}
              else={
                <StateNotice
                  kind={
                    boardSnap().status === "loading" ? "loading" : "unavailable"
                  }
                  title={
                    boardSnap().status === "loading"
                      ? "Loading /api/game-admin/board"
                      : "Game Admin board unavailable"
                  }
                  detail={(() => {
                    const b = boardSnap();
                    return b.status === "unavailable"
                      ? b.cause
                      : "Fetching live/captured line board.";
                  })()}
                />
              }
            >
              <View class="gap-1.5">
                <View class="flex-row items-center justify-between border-b border-border pb-1">
                  <Text class="w-20 text-xs font-semibold text-muted-foreground">
                    Game
                  </Text>
                  <Text class="min-w-36 flex-1 text-xs font-semibold text-muted-foreground">
                    Matchup
                  </Text>
                  <Text class="w-20 text-right text-xs font-semibold text-muted-foreground">
                    Opener
                  </Text>
                  <Text class="w-24 text-right text-xs font-semibold text-muted-foreground">
                    Spread
                  </Text>
                  <Text class="w-24 text-right text-xs font-semibold text-muted-foreground">
                    Money
                  </Text>
                  <Text class="w-24 text-right text-xs font-semibold text-muted-foreground">
                    Total
                  </Text>
                </View>
                <If
                  when={(() => {
                    const b = boardSnap();
                    return b.status === "ready" && b.data.games.length > 0;
                  })()}
                  else={
                    <Text class="py-2 text-xs text-muted-foreground">
                      0 board matchups in selected window.
                    </Text>
                  }
                >
                  <Each
                    of={(() => {
                      const b = boardSnap();
                      return b.status === "ready"
                        ? b.data.games.slice(0, 14)
                        : [];
                    })()}
                    key={(row) =>
                      `${row.gameNum}-${row.awayTeam}-${row.homeTeam}`
                    }
                  >
                    {(row) => (
                      <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 bg-background/60 px-2 py-1.5">
                        <View class="w-20 gap-0.5">
                          <Text class="font-mono text-xs font-semibold text-foreground">
                            {`G-${row().gameNum}`}
                          </Text>
                          <Badge label={row().league} tone="neutral" />
                        </View>
                        <View class="min-w-36 flex-1 gap-0.5">
                          <Text class="text-xs font-medium text-foreground truncate">
                            {`${row().awayTeam} @ ${row().homeTeam}`}
                          </Text>
                          <Text class="font-mono text-xs text-muted-foreground">
                            {`${row().status} · ${row().scoreText}`}
                          </Text>
                        </View>
                        <Text class="w-20 text-right font-mono text-xs tabular-nums text-muted-foreground">
                          {row().openerText}
                        </Text>
                        <Text class="w-24 text-right font-mono text-xs tabular-nums text-foreground">
                          {row().spreadText}
                        </Text>
                        <Text class="w-24 text-right font-mono text-xs tabular-nums text-positive">
                          {row().moneyText}
                        </Text>
                        <Text class="w-24 text-right font-mono text-xs tabular-nums text-foreground">
                          {row().totalText}
                        </Text>
                      </View>
                    )}
                  </Each>
                </If>
              </View>
            </If>
          </Surface>

          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <SectionHeader
              title="Position Rollups (/api/game-admin)"
              subtitle="Straight · Parlay · Teaser exposure breakdown"
            />
            <If
              when={adminSnap().status === "ready"}
              else={
                <StateNotice
                  kind={
                    adminSnap().status === "loading" ? "loading" : "unavailable"
                  }
                  title={
                    adminSnap().status === "loading"
                      ? "Loading /api/game-admin"
                      : "Position rollups unavailable"
                  }
                  detail={(() => {
                    const a = adminSnap();
                    return a.status === "unavailable"
                      ? a.cause
                      : "Reading position rollups.";
                  })()}
                />
              }
            >
              <View class="gap-2">
                <Each
                  of={(() => {
                    const a = adminSnap();
                    return a.status === "ready" ? a.data.games.slice(0, 8) : [];
                  })()}
                  key={(g) => `${g.league}-${g.matchup}`}
                >
                  {(g) => (
                    <Surface variant="inset" class="gap-1.5">
                      <View class="flex-row items-baseline justify-between gap-2">
                        <Text class="text-xs font-semibold text-foreground truncate">
                          {`${g().league} · ${g().matchup}`}
                        </Text>
                        <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                          {formatUsd(g().wageredUsd)}
                        </Text>
                      </View>
                      <SpringBar
                        ratio={g().wageredUsd / maxAdminWagered()}
                        tone="primary"
                      />
                      <View class="flex-row flex-wrap items-center justify-between gap-1">
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {`Str ${formatUsd(g().straightUsd)}`}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {`Par ${formatUsd(g().parlayUsd)}`}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {`Tsr ${formatUsd(g().teaserUsd)}`}
                        </Text>
                      </View>
                    </Surface>
                  )}
                </Each>
              </View>
            </If>
          </Surface>
        </View>

        {/* Row 2: Sports Taxonomy & Logo Asset Meta + Contests */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <SectionHeader
              title="Sports Taxonomy & Logo Meta"
              subtitle="/api/sports · /api/sports/catalog · /api/logo/:team?meta=1&lqip=1"
            />
            <If
              when={catalogSnap().status === "ready"}
              else={
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const c = catalogSnap();
                    return c.status === "unavailable"
                      ? c.cause
                      : "Loading /api/sports/catalog…";
                  })()}
                </Text>
              }
            >
              <View class="flex-row flex-wrap gap-2">
                <Badge
                  label={(() => {
                    const c = catalogSnap();
                    return c.status === "ready"
                      ? `SPORTS · ${c.data.sportsCount}`
                      : "SPORTS";
                  })()}
                  tone="info"
                />
                <Badge
                  label={(() => {
                    const c = catalogSnap();
                    return c.status === "ready"
                      ? `SUB-SPORTS · ${c.data.subSportsCount}`
                      : "SUB-SPORTS";
                  })()}
                  tone="neutral"
                />
                <Badge
                  label={(() => {
                    const c = catalogSnap();
                    return c.status === "ready"
                      ? `PERIODS · ${c.data.periodEntriesCount}`
                      : "PERIODS";
                  })()}
                  tone="neutral"
                />
                <Badge
                  label={(() => {
                    const c = catalogSnap();
                    return c.status === "ready"
                      ? `COLLISIONS · ${c.data.collisionsCount}`
                      : "COLLISIONS";
                  })()}
                  tone={(() => {
                    const c = catalogSnap();
                    return c.status === "ready" && c.data.collisionsCount > 0
                      ? "warning"
                      : "positive";
                  })()}
                />
                <Badge
                  label={(() => {
                    const c = catalogSnap();
                    return c.status === "ready"
                      ? `RISKS · ${c.data.migrationRisksCount}`
                      : "RISKS";
                  })()}
                  tone="warning"
                />
              </View>
            </If>

            <If when={sportsSnap().status === "ready"}>
              <Text class="text-xs text-muted-foreground">
                {(() => {
                  const s = sportsSnap();
                  if (s.status !== "ready") return "";
                  return `Cross-feed sports (${s.data.allSports.length}, liveFilter=${s.data.liveFilterCount}): ${s.data.allSports.slice(0, 8).join(", ")}`;
                })()}
              </Text>
            </If>

            <Separator />

            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="board-logo-input"
                accessibilityLabel="Team slug for /api/logo/:team"
                placeholder="lakers"
                mono={true}
                class="flex-1"
                value={store.logoTeam()}
                onChangeText={(v) => store.setLogoTeam(v)}
                onSubmitText={() => {
                  void store.loadBoardPlane();
                }}
              />
              <DeskButton
                testID="board-logo-probe-btn"
                label="Probe Logo"
                size="sm"
                variant="outline"
                onPress={() => {
                  void store.loadBoardPlane();
                }}
              />
            </View>

            <Surface variant="inset" class="gap-1">
              <If
                when={logoSnap().status === "ready"}
                else={
                  <Text class="font-mono text-xs text-muted-foreground">
                    {(() => {
                      const l = logoSnap();
                      return l.status === "unavailable"
                        ? l.cause
                        : "Probing logo metadata…";
                    })()}
                  </Text>
                }
              >
                <Text class="font-mono text-xs text-foreground">
                  {(() => {
                    const l = logoSnap();
                    if (l.status !== "ready") return "";
                    const dims =
                      l.data.width !== null && l.data.height !== null
                        ? `${l.data.width}x${l.data.height}`
                        : "dims n/a";
                    return `${l.data.name} · ${l.data.format} · ${dims} · ${l.data.bytes ?? 0}B · LQIP=${l.data.hasPlaceholder ? "yes" : "no"}`;
                  })()}
                </Text>
              </If>
            </Surface>
          </Surface>

          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="Contests & Futures Catalog (/api/contests)"
              subtitle={(() => {
                const c = contestsSnap();
                return c.status === "ready"
                  ? `matched ${c.data.count} / ${c.data.total} · groups: ${c.data.groups.slice(0, 5).join(", ") || "all"}`
                  : "Filterable futures and props catalog";
              })()}
            />
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="board-contest-query"
                accessibilityLabel="Contest search query"
                placeholder="Filter contests (e.g. Championship, MVP)…"
                class="flex-1"
                value={store.contestQuery()}
                onChangeText={(v) => store.setContestQuery(v)}
                onSubmitText={() => {
                  void store.loadBoardPlane();
                }}
              />
              <DeskButton
                testID="board-contest-search-btn"
                label="Search"
                size="sm"
                variant="outline"
                onPress={() => {
                  void store.loadBoardPlane();
                }}
              />
            </View>
            <If
              when={contestsSnap().status === "ready"}
              else={
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const c = contestsSnap();
                    return c.status === "unavailable"
                      ? c.cause
                      : "Loading /api/contests…";
                  })()}
                </Text>
              }
            >
              <View class="gap-1">
                <Each
                  of={(() => {
                    const c = contestsSnap();
                    return c.status === "ready"
                      ? c.data.entries.slice(0, 6)
                      : [];
                  })()}
                  key={(e) => `${e.id}-${e.title}`}
                >
                  {(e) => (
                    <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                      <View class="min-w-0 flex-1">
                        <Text class="text-xs font-medium text-foreground truncate">
                          {e().title}
                        </Text>
                        <Text class="font-mono text-xs text-muted-foreground">
                          {`${e().group} · id=${e().id}`}
                        </Text>
                      </View>
                      <Text class="font-mono text-xs text-muted-foreground">
                        {e().closeAt}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </Surface>
        </View>

        {/* Row 3: Live Bets v1 vs v2, Live Wagers & Retired 410 Guard */}
        <Surface variant="card" class="gap-2.5">
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <SectionHeader
              title="Live Bets v1 / v2, Parsed Wagers & Retired f402 Guard"
              subtitle="/api/v1/live-bets (/api/live-bets 308) · /api/v2/live-bets · /api/live-wagers · /api/f402/get-pending"
            />
            <View class="flex-row flex-wrap items-center gap-2">
              <SegmentedTabs
                accessibilityLabel="Live bets source mode"
                items={SOURCE_TABS}
                value={store.liveSourceMode()}
                onChange={(src) => store.setLiveSourceMode(src)}
              />
              <Badge
                testID="retired-f402-badge"
                label={(() => {
                  const r = retiredSnap();
                  if (r.status === "unavailable") {
                    return `f402 GUARD · HTTP ${r.httpStatus ?? "ERR"}`;
                  }
                  if (r.status === "ready") {
                    return `f402 GUARD · HTTP ${r.httpStatus}`;
                  }
                  return "f402 GUARD · PROBING";
                })()}
                tone={(() => {
                  const r = retiredSnap();
                  return r.status === "unavailable" && r.httpStatus === 410
                    ? "info"
                    : "warning";
                })()}
              />
            </View>
          </View>

          <View class="flex-row flex-wrap gap-3">
            <Surface variant="inset" class="min-w-64 flex-1 gap-1.5">
              <Text class="text-xs font-semibold text-foreground">
                v1 Live Bets (/api/v1/live-bets)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const s = v1Snap();
                  if (s.status === "unavailable") return s.cause;
                  if (s.status === "loading") return "Loading v1 live-bets…";
                  return `apiVersion=${s.data.apiVersion} · source=${s.data.dataSource} · pending=${s.data.pendingCount} · games=${s.data.games.length}`;
                })()}
              </Text>
            </Surface>

            <Surface variant="inset" class="min-w-64 flex-1 gap-1.5">
              <Text class="text-xs font-semibold text-foreground">
                v2 Provenance Live Bets (/api/v2/live-bets)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const s = v2Snap();
                  if (s.status === "unavailable") return s.cause;
                  if (s.status === "loading") return "Loading v2 live-bets…";
                  return `apiVersion=${s.data.apiVersion} · source=${s.data.dataSource} · fallback=${s.data.fallbackUsed ? "yes" : "no"} · games=${s.data.games.length}`;
                })()}
              </Text>
            </Surface>

            <Surface variant="inset" class="min-w-64 flex-1 gap-1.5">
              <Text class="text-xs font-semibold text-foreground">
                Retired Endpoint Honesty (/api/f402/get-pending)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const r = retiredSnap();
                  if (r.status === "unavailable") return r.cause;
                  if (r.status === "loading") return "Probing retired route…";
                  return `HTTP ${r.httpStatus}`;
                })()}
              </Text>
            </Surface>
          </View>

          <Separator />

          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <Text class="text-xs font-semibold text-foreground">
              Parsed Live Wagers (/api/live-wagers)
            </Text>
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="board-wagers-writer"
                accessibilityLabel="Filter live wagers by writer"
                placeholder="Writer filter (optional)…"
                mono={true}
                class="w-48"
                value={store.liveWagersWriter()}
                onChangeText={(v) => store.setLiveWagersWriter(v)}
                onSubmitText={() => {
                  void store.loadBoardPlane();
                }}
              />
              <DeskButton
                label="Filter Wagers"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.loadBoardPlane();
                }}
              />
            </View>
          </View>

          <If
            when={wagersSnap().status === "ready"}
            else={
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const w = wagersSnap();
                  return w.status === "unavailable"
                    ? w.cause
                    : "Loading /api/live-wagers…";
                })()}
              </Text>
            }
          >
            <View class="gap-1">
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const w = wagersSnap();
                  if (w.status !== "ready") return "";
                  return `tickets=${w.data.count}${w.data.totalRiskUsd !== null ? ` · totalRisk=${formatUsd(w.data.totalRiskUsd)}` : ""}`;
                })()}
              </Text>
              <Each
                of={(() => {
                  const w = wagersSnap();
                  return w.status === "ready" ? w.data.wagers.slice(0, 8) : [];
                })()}
                key={(t) => `${t.ticketId}-${t.customer}`}
              >
                {(t) => (
                  <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                    <Text class="w-28 font-mono text-xs font-semibold text-foreground truncate">
                      {`${t().customer} · ${t().wagerType}`}
                    </Text>
                    <Text class="min-w-0 flex-1 text-xs text-muted-foreground truncate">
                      {t().pickSummary}
                    </Text>
                    <Text class="font-mono text-xs tabular-nums text-foreground">
                      {`${formatUsd(t().riskUsd)} → ${formatUsd(t().toWinUsd)}`}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </Surface>
      </View>
    </Scroll>
  );
}
