import { Scroll, Text, View, type JSX } from "nsh";
import { formatUsd } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  Badge,
  createPanelReadyMotion,
  DeskButton,
  DeskInput,
  SectionHeader,
  Separator,
  SpringBar,
  StateNotice,
  Surface,
} from "../ui";

export function ForensicsWorkspace(props: { store?: DeskStore }): JSX.Element {
  const store = useDeskStore(props.store);
  const searchSnap = () => store.agentsSearchSnap();
  const flatTreeSnap = () => store.agentTreeFlatSnap();
  const hierTreeSnap = () => store.agentTreeHierarchySnap();
  const filtersSnap = () => store.analysisFiltersSnap();
  const reportsSnap = () => store.analysisReportsSnap();
  const analysisSnap = () => store.analysisSnap();
  const profileSnap = () => store.customerProfileSnap();
  const ratingSnap = () => store.customerRatingSnap();
  const watchlistSnap = () => store.watchlistSnap();

  const readyMotion = createPanelReadyMotion();

  return (
    <Scroll class="min-h-0 flex-1 bg-background" testID="forensics-workspace">
      <View style={readyMotion.style} class="gap-3 p-3">
        <SectionHeader
          title="Agents, Portal Analysis & Customer Book Forensics Plane"
          subtitle="8 canonical :4020 routes — /api/agents/search, /api/agent-tree, /api/analysis/*, /api/customer/profile, /api/customer/rating & /api/watchlist"
          trailing={
            <DeskButton
              testID="forensics-reload-btn"
              label="Reload Forensics"
              size="xs"
              variant="outline"
              onPress={() => {
                void store.loadForensicsPlane();
              }}
            />
          }
        />

        {/* Row 1: Agent Typeahead Search + 2,276-Node Agent Hierarchy */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <SectionHeader
              title="Agent Typeahead Search (/api/agents/search)"
              subtitle="Prefix/substring lookup (>= 2 chars)"
            />
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="forensics-agent-query"
                accessibilityLabel="Agent search query"
                placeholder="Search agent code (e.g. BI, BILLY)…"
                mono={true}
                class="flex-1"
                value={store.agentQuery()}
                onChangeText={(q) => store.setAgentQuery(q)}
                onSubmitText={() => {
                  void store.loadAgentSearch();
                }}
              />
              <DeskButton
                testID="forensics-agent-search-btn"
                label="Search"
                size="sm"
                variant="outline"
                onPress={() => {
                  void store.loadAgentSearch();
                }}
              />
            </View>

            <If
              when={searchSnap().status === "ready"}
              else={
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const s = searchSnap();
                    return s.status === "unavailable"
                      ? s.cause
                      : "Enter >= 2 chars to search agent hierarchy.";
                  })()}
                </Text>
              }
            >
              <View class="gap-1">
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const s = searchSnap();
                    return s.status === "ready"
                      ? `query='${s.data.query}' · matched=${s.data.count}`
                      : "";
                  })()}
                </Text>
                <View class="flex-row flex-wrap gap-1.5">
                  <Each
                    of={(() => {
                      const s = searchSnap();
                      return s.status === "ready"
                        ? s.data.agents.slice(0, 12)
                        : [];
                    })()}
                    key={(a) => a.key}
                  >
                    {(a) => (
                      <DeskButton
                        label={`${a().key}${a().level !== null ? ` (L${a().level})` : ""}`}
                        size="xs"
                        variant="outline"
                        onPress={() => {
                          store.setAnalysisAgent(a().key);
                          void store.loadAnalysisSlice();
                        }}
                      />
                    )}
                  </Each>
                </View>
              </View>
            </If>

            <Separator />

            <SectionHeader
              title="Agent Tree (/api/agent-tree & ?view=hierarchy)"
              subtitle="Flat node inventory vs hierarchical roots & collisions"
            />
            <View class="flex-row flex-wrap gap-2">
              <Badge
                label={(() => {
                  const f = flatTreeSnap();
                  return f.status === "ready"
                    ? `FLAT NODES · ${f.data.agentCount}`
                    : "FLAT NODES";
                })()}
                tone="info"
              />
              <Badge
                label={(() => {
                  const h = hierTreeSnap();
                  return h.status === "ready"
                    ? `ROOTS · ${h.data.rootCount}`
                    : "ROOTS";
                })()}
                tone="neutral"
              />
              <Badge
                label={(() => {
                  const h = hierTreeSnap();
                  return h.status === "ready"
                    ? `COLLISIONS · ${h.data.collisionCount}`
                    : "COLLISIONS";
                })()}
                tone={(() => {
                  const h = hierTreeSnap();
                  return h.status === "ready" && h.data.collisionCount > 0
                    ? "warning"
                    : "positive";
                })()}
              />
            </View>
            <If when={hierTreeSnap().status === "ready"}>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const h = hierTreeSnap();
                  if (h.status !== "ready") return "";
                  return `Top hierarchy roots: ${h.data.topRoots.slice(0, 6).join(", ") || "none"}`;
                })()}
              </Text>
            </If>
          </Surface>

          {/* Portal Analysis Explorer */}
          <Surface variant="card" class="min-w-80 flex-2 gap-2.5">
            <SectionHeader
              title="Portal Analysis Explorer (/api/analysis, /filters, /reports)"
              subtitle={(() => {
                const f = filtersSnap();
                const r = reportsSnap();
                const fSummary =
                  f.status === "ready"
                    ? `reports=${f.data.reports.length} · sports=${f.data.sports.length} · weeks=${f.data.weeks.length}`
                    : "filters loading";
                const rSummary =
                  r.status === "ready" ? `captured=${r.data.count}` : "";
                return `${fSummary}${rSummary ? ` · ${rSummary}` : ""}`;
              })()}
            />

            <View class="flex-row flex-wrap items-center gap-2">
              <DeskInput
                testID="forensics-analysis-report"
                accessibilityLabel="Analysis report code"
                placeholder="CP"
                mono={true}
                class="w-20"
                value={store.analysisReport()}
                onChangeText={(v) => store.setAnalysisReport(v)}
              />
              <DeskInput
                testID="forensics-analysis-agent"
                accessibilityLabel="Analysis agent code"
                placeholder="BILLY666"
                mono={true}
                class="w-32"
                value={store.analysisAgent()}
                onChangeText={(v) => store.setAnalysisAgent(v)}
              />
              <DeskInput
                testID="forensics-analysis-sport"
                accessibilityLabel="Analysis sport"
                placeholder="Baseball"
                mono={true}
                class="w-32"
                value={store.analysisSport()}
                onChangeText={(v) => store.setAnalysisSport(v)}
              />
              <DeskInput
                testID="forensics-analysis-week"
                accessibilityLabel="Analysis week"
                placeholder="-1"
                mono={true}
                class="w-20"
                value={store.analysisWeek()}
                onChangeText={(v) => store.setAnalysisWeek(v)}
              />
              <DeskButton
                testID="forensics-analysis-run-btn"
                label="Query Slice"
                size="sm"
                variant="primary"
                onPress={() => {
                  void store.loadAnalysisSlice();
                }}
              />
            </View>

            <If
              when={analysisSnap().status === "ready"}
              else={
                <StateNotice
                  kind={
                    analysisSnap().status === "loading"
                      ? "loading"
                      : "unavailable"
                  }
                  title={
                    analysisSnap().status === "loading"
                      ? "Loading /api/analysis"
                      : "Analysis slice unavailable"
                  }
                  detail={(() => {
                    const a = analysisSnap();
                    return a.status === "unavailable"
                      ? a.cause
                      : "Querying portal analysis slice.";
                  })()}
                />
              }
            >
              <View class="gap-1.5">
                <View class="flex-row flex-wrap items-center justify-between gap-2">
                  <Text class="font-mono text-xs text-muted-foreground">
                    {(() => {
                      const a = analysisSnap();
                      return a.status === "ready" ? a.data.description : "";
                    })()}
                  </Text>
                  <Badge
                    label={(() => {
                      const a = analysisSnap();
                      return a.status === "ready"
                        ? `DISCREPANCIES · ${a.data.discrepancyCount}`
                        : "DISCREPANCIES";
                    })()}
                    tone={(() => {
                      const a = analysisSnap();
                      return a.status === "ready" && a.data.discrepancyCount > 0
                        ? "warning"
                        : "positive";
                    })()}
                  />
                </View>

                <Each
                  of={(() => {
                    const a = analysisSnap();
                    return a.status === "ready" ? a.data.rows.slice(0, 8) : [];
                  })()}
                  key={(r) => `${r.player}-${r.agent}`}
                >
                  {(r) => (
                    <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                      <View class="min-w-0 flex-1">
                        <Text class="font-mono text-xs font-semibold text-foreground">
                          {r().player}
                        </Text>
                        <Text class="font-mono text-xs text-muted-foreground">
                          {`agent=${r().agent} · wagers=${r().wagers}`}
                        </Text>
                      </View>
                      <View class="items-end">
                        <Text class="font-mono text-xs tabular-nums text-foreground">
                          {`Risk ${r().riskUsd}`}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-positive">
                          {`Net ${r().netUsd}`}
                        </Text>
                      </View>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </Surface>
        </View>

        {/* Row 2: Customer Profile + Bayesian/Kelly Rating + Admin Watchlist */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="Customer Book & Bayesian Skill Lookup"
              subtitle="/api/customer/profile · /api/customer/rating (Bayesian posterior & Kelly fraction)"
            />
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="forensics-customer-input"
                accessibilityLabel="Customer ID lookup"
                placeholder="Customer ID (e.g. DK121)…"
                mono={true}
                class="flex-1"
                value={store.customerLookupId()}
                onChangeText={(v) => store.setCustomerLookupId(v)}
                onSubmitText={() => {
                  void store.lookupCustomerForensics();
                }}
              />
              <DeskButton
                testID="forensics-customer-lookup-btn"
                label="Lookup Customer"
                size="sm"
                variant="primary"
                onPress={() => {
                  void store.lookupCustomerForensics();
                }}
              />
            </View>

            <View class="flex-row flex-wrap gap-2.5">
              <Surface variant="inset" class="min-w-60 flex-1 gap-1">
                <Text class="text-xs font-semibold text-foreground">
                  Book Profile (/api/customer/profile)
                </Text>
                <If
                  when={profileSnap().status === "ready"}
                  else={
                    <Text
                      testID="customer-profile-error"
                      class="font-mono text-xs text-muted-foreground"
                    >
                      {(() => {
                        const p = profileSnap();
                        return p.status === "unavailable"
                          ? p.cause
                          : "Looking up customer profile…";
                      })()}
                    </Text>
                  }
                >
                  <Text class="font-mono text-xs text-foreground">
                    {(() => {
                      const p = profileSnap();
                      if (p.status !== "ready") return "";
                      return `id=${p.data.id} · agent=${p.data.agentId} · tickets=${p.data.ticketSampleCount}${p.data.sampleOnly ? " (sampleOnly)" : ""}`;
                    })()}
                  </Text>
                  <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                    {(() => {
                      const p = profileSnap();
                      if (p.status !== "ready") return "";
                      const life =
                        p.data.lifetimeNetUsd !== null
                          ? formatUsd(p.data.lifetimeNetUsd)
                          : "n/a";
                      const wk =
                        p.data.week7dNetUsd !== null
                          ? formatUsd(p.data.week7dNetUsd)
                          : "n/a";
                      return `Lifetime Net: ${life} · 7d Net: ${wk}`;
                    })()}
                  </Text>
                </If>
              </Surface>

              <Surface variant="inset" class="min-w-60 flex-1 gap-1.5">
                <Text class="text-xs font-semibold text-foreground">
                  Skill & Kelly Rating (/api/customer/rating)
                </Text>
                <If
                  when={ratingSnap().status === "ready"}
                  else={
                    <Text class="font-mono text-xs text-muted-foreground">
                      {(() => {
                        const r = ratingSnap();
                        return r.status === "unavailable"
                          ? r.cause
                          : "Computing Bayesian skill & Kelly metrics…";
                      })()}
                    </Text>
                  }
                >
                  <View class="flex-row items-center justify-between">
                    <Badge
                      label={(() => {
                        const r = ratingSnap();
                        return r.status === "ready"
                          ? `TIER · ${r.data.tier.toUpperCase()}`
                          : "TIER";
                      })()}
                      tone="info"
                    />
                    <Text class="font-mono text-xs tabular-nums text-foreground">
                      {(() => {
                        const r = ratingSnap();
                        if (r.status !== "ready") return "";
                        const kelly =
                          r.data.kellyFraction !== null
                            ? `${(r.data.kellyFraction * 100).toFixed(1)}%`
                            : "n/a";
                        const bayes =
                          r.data.bayesianMean !== null
                            ? r.data.bayesianMean.toFixed(3)
                            : "n/a";
                        return `Bayes μ=${bayes} · Kelly=${kelly}`;
                      })()}
                    </Text>
                  </View>
                  <SpringBar
                    ratio={(() => {
                      const r = ratingSnap();
                      if (
                        r.status !== "ready" ||
                        r.data.sharpProbability === null
                      ) {
                        return 0.25;
                      }
                      const raw = r.data.sharpProbability;
                      return raw > 1 ? raw / 100 : raw;
                    })()}
                    tone="warning"
                  />
                </If>
              </Surface>
            </View>
          </Surface>

          <Surface variant="card" class="min-w-72 flex-1 gap-2.5">
            <SectionHeader
              title="Admin Surveillance Watchlist (/api/watchlist)"
              subtitle="Bearer SPORTSDESK_ADMIN_TOKEN — surfaces 401/503 honestly when unset"
            />
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="forensics-admin-token-input"
                accessibilityLabel="Session admin bearer token"
                placeholder="Session bearer token (optional)…"
                masked={true}
                mono={true}
                class="flex-1"
                value={store.adminToken()}
                onChangeText={(tok) => store.setAdminToken(tok)}
                onSubmitText={() => {
                  void store.loadWatchlist();
                }}
              />
              <DeskButton
                testID="forensics-watchlist-reload-btn"
                label="Reload Watchlist"
                size="sm"
                variant="outline"
                onPress={() => {
                  void store.loadWatchlist();
                }}
              />
            </View>

            <If
              when={watchlistSnap().status === "ready"}
              else={
                <Surface variant="inset" class="gap-1">
                  <Text
                    testID="watchlist-auth-honesty"
                    class="font-mono text-xs text-warning"
                  >
                    {(() => {
                      const w = watchlistSnap();
                      return w.status === "unavailable"
                        ? w.cause
                        : "Requesting /api/watchlist…";
                    })()}
                  </Text>
                </Surface>
              }
            >
              <View class="gap-1">
                <Text class="font-mono text-xs text-positive">
                  {(() => {
                    const w = watchlistSnap();
                    return w.status === "ready"
                      ? `Watchlist authorized · ${w.data.count} watched customer(s)`
                      : "";
                  })()}
                </Text>
                <Each
                  of={(() => {
                    const w = watchlistSnap();
                    return w.status === "ready"
                      ? w.data.entries.slice(0, 8)
                      : [];
                  })()}
                  key={(it) => it.id}
                >
                  {(it) => (
                    <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                      <Text class="font-mono text-xs font-semibold text-foreground">
                        {it().label}
                      </Text>
                      <Text class="text-xs text-muted-foreground">
                        {it().reason}
                      </Text>
                    </View>
                  )}
                </Each>
              </View>
            </If>
          </Surface>
        </View>
      </View>
    </Scroll>
  );
}
