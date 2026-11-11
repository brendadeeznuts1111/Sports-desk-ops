import { Scroll, Text, View, type JSX } from "nsh";
import { formatUsd } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  Badge,
  createPanelReadyMotion,
  DeskButton,
  LiveDot,
  SectionHeader,
  Separator,
  SpringBar,
  StateNotice,
  Surface,
} from "../ui";
import { provenanceTone } from "./provenance";

export function SurveillanceWorkspace(props: {
  store?: DeskStore;
}): JSX.Element {
  const store = useDeskStore(props.store);
  const sumSnap = () => store.graphSummarySnap();
  const feedSnap = () => store.graphFeedSnap();
  const streamSnap = () => store.graphStreamSnap();
  const logsSnap = () => store.gsliveWeblogsSnap();
  const sessSnap = () => store.gsliveSessionSnap();
  const b3cSnap = () => store.bridge3cSnap();

  const readyMotion = createPanelReadyMotion();

  const maxBacktestSavings = () => {
    const f = feedSnap();
    if (f.status !== "ready" || f.data.backtestWeeks.length === 0) return 1;
    let m = 1;
    for (const wk of f.data.backtestWeeks) {
      if (Math.abs(wk.savingsUsd) > m) m = Math.abs(wk.savingsUsd);
    }
    return m;
  };

  return (
    <Scroll
      class="min-h-0 flex-1 bg-background"
      testID="surveillance-workspace"
    >
      <View style={readyMotion.style} class="gap-3 p-3">
        <SectionHeader
          title="Syndicate Graph, SSE Stream & GSLive Surveillance Plane"
          subtitle="6 canonical :4020 routes — /api/graph/summary, /api/graph-feed, /api/graph/stream, /api/gslive/weblogs, /api/gslive/session-health & /api/bridge3c/status"
          trailing={
            <DeskButton
              testID="surveillance-reload-btn"
              label="Reload Surveillance"
              size="xs"
              variant="outline"
              onPress={() => {
                void store.loadSurveillancePlane();
              }}
            />
          }
        />

        {/* Row 1: Graph Summary + SSE Live Stream Probe */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-80 flex-2 gap-2.5">
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <SectionHeader
                title="Syndicate Graph Feed v3 (/api/graph-feed & /api/graph/summary)"
                subtitle={(() => {
                  const s = sumSnap();
                  if (s.status !== "ready")
                    return "Wallet exposure, open legs & office IP clusters";
                  return `mode=${s.data.dataMode} · bridges=${s.data.bridgeCount} · automation=${s.data.automationActive ? "ON" : "OFF"}`;
                })()}
              />
              <If when={feedSnap().status === "ready"}>
                <Badge
                  label={(() => {
                    const f = feedSnap();
                    return f.status === "ready"
                      ? `FEED · ${f.data.provenance.basis.toUpperCase()}`
                      : "FEED";
                  })()}
                  tone={(() => {
                    const f = feedSnap();
                    return f.status === "ready"
                      ? provenanceTone(f.data.provenance)
                      : "neutral";
                  })()}
                />
              </If>
            </View>

            <If
              when={feedSnap().status === "ready"}
              else={
                <StateNotice
                  kind={
                    feedSnap().status === "loading" ? "loading" : "unavailable"
                  }
                  title={
                    feedSnap().status === "loading"
                      ? "Loading /api/graph-feed"
                      : "Syndicate graph feed unavailable"
                  }
                  detail={(() => {
                    const f = feedSnap();
                    return f.status === "unavailable"
                      ? f.cause
                      : "Reading schema v3 syndicate feed.";
                  })()}
                />
              }
            >
              <View class="gap-2.5">
                <View class="flex-row flex-wrap gap-2">
                  <Surface variant="inset" class="min-w-36 flex-1 gap-0.5">
                    <Text class="text-xs text-muted-foreground">
                      Active Wallets
                    </Text>
                    <Text class="font-mono text-base font-semibold tabular-nums text-foreground">
                      {(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? `${f.data.activeWallets} / ${f.data.configuredWallets}`
                          : "—";
                      })()}
                    </Text>
                  </Surface>
                  <Surface variant="inset" class="min-w-36 flex-1 gap-0.5">
                    <Text class="text-xs text-muted-foreground">Open Legs</Text>
                    <Text class="font-mono text-base font-semibold tabular-nums text-foreground">
                      {(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? String(f.data.openLegs)
                          : "—";
                      })()}
                    </Text>
                  </Surface>
                  <Surface variant="inset" class="min-w-44 flex-1 gap-0.5">
                    <Text class="text-xs text-muted-foreground">
                      Open Exposure
                    </Text>
                    <Text class="font-mono text-base font-semibold tabular-nums text-warning">
                      {(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? formatUsd(f.data.openExposureUsd)
                          : "—";
                      })()}
                    </Text>
                  </Surface>
                </View>

                <View class="flex-row flex-wrap gap-3">
                  {/* Pending Syndicate Tape */}
                  <View class="min-w-64 flex-1 gap-1.5">
                    <Text class="text-xs font-semibold text-foreground">
                      Pending Syndicate Legs
                    </Text>
                    <Each
                      of={(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? f.data.pendingBets.slice(0, 6)
                          : [];
                      })()}
                      key={(b) => b.id}
                    >
                      {(b) => (
                        <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                          <View class="min-w-0 flex-1">
                            <Text class="font-mono text-xs font-semibold text-foreground truncate">
                              {`${b().account} · ${b().league}`}
                            </Text>
                            <Text class="text-xs text-muted-foreground truncate">
                              {b().selection}
                            </Text>
                          </View>
                          <View class="items-end">
                            <Text class="font-mono text-xs font-semibold tabular-nums text-foreground">
                              {formatUsd(b().stakeUsd)}
                            </Text>
                            <Text class="font-mono text-xs tabular-nums text-warning">
                              {`sharp ${b().sharpScore}`}
                            </Text>
                          </View>
                        </View>
                      )}
                    </Each>
                  </View>

                  {/* Wallet Profiles & IP Clusters */}
                  <View class="min-w-64 flex-1 gap-1.5">
                    <Text class="text-xs font-semibold text-foreground">
                      Syndicate Wallets & Office IP Clusters
                    </Text>
                    <Each
                      of={(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? f.data.wallets.slice(0, 4)
                          : [];
                      })()}
                      key={(w) => w.handle}
                    >
                      {(w) => (
                        <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                          <View class="min-w-0 flex-1">
                            <Text class="font-mono text-xs font-semibold text-foreground truncate">
                              {w().handle}
                            </Text>
                            <Text class="text-xs text-muted-foreground">
                              {w().archetype}
                            </Text>
                          </View>
                          <Text class="font-mono text-xs tabular-nums text-foreground">
                            {formatUsd(w().openExposureUsd)}
                          </Text>
                        </View>
                      )}
                    </Each>
                    <Each
                      of={(() => {
                        const f = feedSnap();
                        return f.status === "ready"
                          ? f.data.ipClusters.slice(0, 3)
                          : [];
                      })()}
                      key={(c) => c.clusterId}
                    >
                      {(c) => (
                        <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-warning/40 bg-warning/10 px-2 py-1">
                          <Text class="font-mono text-xs text-foreground">
                            {`${c().clusterId} · ${c().office} (${c().accountCount} accts)`}
                          </Text>
                          <Text class="font-mono text-xs text-warning">
                            {`${c().sharedIpPrefix} · ${c().riskFlag}`}
                          </Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </View>

                <If
                  when={(() => {
                    const f = feedSnap();
                    return (
                      f.status === "ready" && f.data.backtestWeeks.length > 0
                    );
                  })()}
                >
                  <Separator />
                  <View class="gap-1.5">
                    <Text class="text-xs font-semibold text-foreground">
                      4-Week Hold & Alert Backtest
                    </Text>
                    <Each
                      of={(() => {
                        const f = feedSnap();
                        return f.status === "ready" ? f.data.backtestWeeks : [];
                      })()}
                      key={(wk) => wk.weekLabel}
                    >
                      {(wk) => (
                        <View class="gap-1">
                          <View class="flex-row items-baseline justify-between">
                            <Text class="font-mono text-xs text-foreground">
                              {wk().weekLabel}
                            </Text>
                            <Text class="font-mono text-xs tabular-nums text-positive">
                              {`${formatUsd(wk().savingsUsd)}${wk().holdDeltaBps !== null ? ` · +${wk().holdDeltaBps}bps` : ""}`}
                            </Text>
                          </View>
                          <SpringBar
                            ratio={
                              Math.abs(wk().savingsUsd) / maxBacktestSavings()
                            }
                            tone="positive"
                          />
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
              </View>
            </If>
          </Surface>

          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <View class="flex-row items-center justify-between gap-2">
              <View class="flex-row items-center gap-1.5">
                <LiveDot
                  live={streamSnap().status === "ready"}
                  accessibilityLabel="SSE stream status"
                />
                <Text class="text-xs font-semibold text-foreground">
                  SSE Graph Stream (/api/graph/stream)
                </Text>
              </View>
              <DeskButton
                testID="sample-sse-stream-btn"
                label="Sample SSE Stream"
                size="xs"
                variant="primary"
                onPress={() => {
                  void store.sampleGraphStream();
                }}
              />
            </View>
            <Text class="text-xs text-muted-foreground">
              Bounded 1.6s text/event-stream sampler reading initial frame and
              cleanly cancelling reader.
            </Text>
            <Surface variant="inset" class="gap-1">
              <If
                when={streamSnap().status === "ready"}
                else={
                  <Text class="font-mono text-xs text-muted-foreground">
                    {(() => {
                      const s = streamSnap();
                      return s.status === "unavailable"
                        ? s.cause
                        : "Press 'Sample SSE Stream' to capture live text/event-stream frame.";
                    })()}
                  </Text>
                }
              >
                <Text
                  testID="sse-stream-event-type"
                  class="font-mono text-xs font-semibold text-positive"
                >
                  {(() => {
                    const s = streamSnap();
                    return s.status === "ready"
                      ? `event: ${s.data.firstEventType} (${s.data.eventCount} frame)`
                      : "";
                  })()}
                </Text>
                <Text class="font-mono text-xs text-foreground">
                  {(() => {
                    const s = streamSnap();
                    return s.status === "ready" ? s.data.dataPreview : "";
                  })()}
                </Text>
              </If>
            </Surface>

            <Separator />

            <SectionHeader
              title="GSLive Weblogs, Session Health & Bridge3C"
              subtitle="/api/gslive/weblogs · /api/gslive/session-health · /api/bridge3c/status"
            />

            <Surface variant="inset" class="gap-1">
              <Text class="text-xs font-semibold text-foreground">
                GSLive Weblogs (/api/gslive/weblogs)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const l = logsSnap();
                  if (l.status === "unavailable") return l.cause;
                  if (l.status === "loading") return "Loading weblogs…";
                  return `status=${l.data.status} · source=${l.data.source} · accounts=${l.data.accountCount} · ${l.data.reason}`;
                })()}
              </Text>
            </Surface>

            <Surface variant="inset" class="gap-1.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-semibold text-foreground">
                  GSLive Session (/api/gslive/session-health)
                </Text>
                <View class="flex-row items-center gap-1">
                  <DeskButton
                    testID="gslive-passive-btn"
                    label="Passive"
                    size="xs"
                    variant="outline"
                    onPress={() => {
                      void store.probeGsLiveSession(false);
                    }}
                  />
                  <DeskButton
                    testID="gslive-probe-btn"
                    label="Probe ?probe=1"
                    size="xs"
                    variant="outline"
                    onPress={() => {
                      void store.probeGsLiveSession(true);
                    }}
                  />
                </View>
              </View>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const s = sessSnap();
                  if (s.status === "unavailable") return s.cause;
                  if (s.status === "loading") return "Checking GSLive session…";
                  return `auth=${s.data.authModel} · state=${s.data.sessionState} · probeRan=${s.data.probeRan ? "yes" : "no"} · ${s.data.advisory}`;
                })()}
              </Text>
            </Surface>

            <Surface variant="inset" class="gap-1">
              <Text class="text-xs font-semibold text-foreground">
                Bridge3C Boundary (/api/bridge3c/status)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const b = b3cSnap();
                  if (b.status === "unavailable") return b.cause;
                  if (b.status === "loading") return "Loading Bridge3C status…";
                  return `boundary=${b.data.boundary} · readOnly=${b.data.readOnly ? "true" : "false"} · rollup=${b.data.rollupState}`;
                })()}
              </Text>
            </Surface>
          </Surface>
        </View>
      </View>
    </Scroll>
  );
}
