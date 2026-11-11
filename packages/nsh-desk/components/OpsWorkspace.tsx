import { Scroll, Text, View, type JSX } from "nsh";
import { DESK_ENDPOINT_CATALOG, PARSER_WORKBENCH_PRESETS } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  Badge,
  createPanelReadyMotion,
  DeskButton,
  DeskInput,
  DeskSelect,
  SectionHeader,
  Separator,
  SpringBar,
  Surface,
  type SelectItem,
} from "../ui";

const REPORT_SELECT_ITEMS: SelectItem[] = [
  { value: "EVENING_SETTLEMENT", title: "EVENING_SETTLEMENT" },
  { value: "MORNING_BRIEFING", title: "MORNING_BRIEFING" },
  { value: "MIDDAY_PULSE", title: "MIDDAY_PULSE" },
];

const PARSER_SELECT_ITEMS: SelectItem[] = PARSER_WORKBENCH_PRESETS.map((p) => ({
  value: p.id,
  title: p.label,
}));

export function OpsWorkspace(props: { store?: DeskStore }): JSX.Element {
  const store = useDeskStore(props.store);
  const healthSnap = () => store.healthSnap();
  const statusSnap = () => store.statusSnap();
  const dnsSnap = () => store.dnsTelemetrySnap();
  const govSnap = () => store.governanceSnap();
  const tgStatusSnap = () => store.telegramStatusSnap();
  const tgActSnap = () => store.telegramActivitySnap();
  const parserOutSnap = () => store.parserOutputSnap();
  const errGuardSnap = () => store.errorGuardSnap();

  const readyMotion = createPanelReadyMotion();

  return (
    <Scroll class="min-h-0 flex-1 bg-background" testID="ops-workspace">
      <View style={readyMotion.style} class="gap-3 p-3">
        <SectionHeader
          title="System Health, Governance, Telegram Admin & 9-Endpoint Parser Workbench"
          subtitle={`19 canonical :4020 routes + complete ${DESK_ENDPOINT_CATALOG.length}-endpoint live parity matrix`}
          trailing={
            <View class="flex-row items-center gap-2">
              <DeskButton
                testID="ops-reload-btn"
                label="Reload Ops"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.loadOpsPlane();
                }}
              />
              <DeskButton
                testID="ops-sweep-all-btn"
                label={
                  store.sweepingAll()
                    ? "Sweeping :4020…"
                    : "Sweep All :4020 Endpoints"
                }
                size="xs"
                variant="primary"
                disabled={store.sweepingAll()}
                onPress={() => {
                  void store.sweepAllEndpoints();
                }}
              />
            </View>
          }
        />

        {/* Row 1: Health, Status, DNS Telemetry & 500 Guard + Governance */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="Daemon Health, Runtime & Bun.dns Telemetry"
              subtitle="/health · /api/status (/status.json) · /api/dns/telemetry · /api/test/error"
            />
            <View class="flex-row flex-wrap gap-2">
              <Badge
                label={(() => {
                  const h = healthSnap();
                  return h.status === "ready"
                    ? `HEALTH · ${h.data.status.toUpperCase()}`
                    : "HEALTH";
                })()}
                tone={(() => {
                  const h = healthSnap();
                  if (h.status !== "ready") return "neutral";
                  return h.data.status === "healthy" || h.data.status === "ok"
                    ? "positive"
                    : "warning";
                })()}
              />
              <Badge
                label={(() => {
                  const s = statusSnap();
                  return s.status === "ready" && s.data.rssMb !== null
                    ? `RSS · ${s.data.rssMb} MB`
                    : "RSS · n/a";
                })()}
                tone="info"
              />
              <Badge
                label={(() => {
                  const d = dnsSnap();
                  return d.status === "ready"
                    ? `DNS HIT · ${d.data.hitRatePercent.toFixed(0)}%`
                    : "DNS";
                })()}
                tone="positive"
              />
            </View>

            <Surface variant="inset" class="gap-1">
              <Text class="font-mono text-xs text-foreground">
                {(() => {
                  const h = healthSnap();
                  if (h.status === "unavailable") return h.cause;
                  if (h.status === "loading") return "Loading /health…";
                  return `runtime=${h.data.runtime} · ops=${h.data.operationalStatus} · data=${h.data.dataStatus} · uptime=${h.data.uptimeSeconds ?? 0}s`;
                })()}
              </Text>
              <If
                when={(() => {
                  const h = healthSnap();
                  return (
                    h.status === "ready" && h.data.degradedReasons.length > 0
                  );
                })()}
              >
                <Text class="font-mono text-xs text-warning">
                  {(() => {
                    const h = healthSnap();
                    return h.status === "ready"
                      ? `degraded: ${h.data.degradedReasons.join("; ")}`
                      : "";
                  })()}
                </Text>
              </If>
            </Surface>

            <Surface variant="inset" class="gap-1.5">
              <Text class="text-xs font-semibold text-foreground">
                Bun.dns Cache Telemetry (/api/dns/telemetry)
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const d = dnsSnap();
                  if (d.status === "unavailable") return d.cause;
                  if (d.status === "loading") return "Loading DNS cache stats…";
                  return `entries=${d.data.size} · hits=${d.data.hitsCompleted} · inflight=${d.data.hitsInflight} · misses=${d.data.misses} · coreHosts=${d.data.coreHostCount}`;
                })()}
              </Text>
              <SpringBar
                ratio={(() => {
                  const d = dnsSnap();
                  return d.status === "ready" ? d.data.hitRatePercent / 100 : 0;
                })()}
                tone="positive"
              />
            </Surface>

            <Separator />

            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <Text class="text-xs font-semibold text-foreground">
                Error-Boundary Redaction Probe (/api/test/error)
              </Text>
              <DeskButton
                testID="ops-probe-500-btn"
                label="Probe 500 Guard"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.probeErrorBoundaryGuard();
                }}
              />
            </View>
            <If when={errGuardSnap().status !== "loading"}>
              <Text
                testID="ops-500-guard-output"
                class="font-mono text-xs text-warning"
              >
                {(() => {
                  const e = errGuardSnap();
                  return e.status === "unavailable"
                    ? e.cause
                    : `HTTP ${e.status === "ready" ? e.httpStatus : ""}`;
                })()}
              </Text>
            </If>
          </Surface>

          {/* Governance Scorecard */}
          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="RBAC & Oracle Governance (/governance.json)"
              subtitle={(() => {
                const g = govSnap();
                return g.status === "ready"
                  ? `ref=${g.data.referenceDate} · open=${g.data.openTasks} · done=${g.data.doneTasks} · P0=${g.data.p0Open} · decisions=${g.data.pendingDecisions}`
                  : "Task governance & oracle gate readiness";
              })()}
            />

            <If
              when={govSnap().status === "ready"}
              else={
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const g = govSnap();
                    return g.status === "unavailable"
                      ? g.cause
                      : "Loading /governance.json…";
                  })()}
                </Text>
              }
            >
              <View class="gap-2">
                <View class="flex-row items-baseline justify-between">
                  <Text class="text-xs font-medium text-muted-foreground">
                    Oracle Gate Readiness
                  </Text>
                  <Text class="font-mono text-xs font-semibold tabular-nums text-positive">
                    {(() => {
                      const g = govSnap();
                      return g.status === "ready"
                        ? `${g.data.readyGates} / ${g.data.totalGates} READY`
                        : "";
                    })()}
                  </Text>
                </View>
                <SpringBar
                  ratio={(() => {
                    const g = govSnap();
                    if (g.status !== "ready" || g.data.totalGates <= 0)
                      return 0;
                    return g.data.readyGates / g.data.totalGates;
                  })()}
                  tone="positive"
                />
                <View class="gap-1">
                  <Each
                    of={(() => {
                      const g = govSnap();
                      return g.status === "ready"
                        ? g.data.gates.slice(0, 6)
                        : [];
                    })()}
                    key={(gate) => gate.id}
                  >
                    {(gate) => (
                      <View class="flex-row items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2 py-1">
                        <Text class="text-xs font-medium text-foreground truncate">
                          {`${gate().id} · ${gate().title}`}
                        </Text>
                        <Badge
                          label={gate().status.toUpperCase()}
                          tone={
                            gate().status.toLowerCase().includes("ready") ||
                            gate().status.toLowerCase().includes("pass")
                              ? "positive"
                              : "warning"
                          }
                        />
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>
          </Surface>
        </View>

        {/* Row 2: Telegram Admin Console + 9-Endpoint Parser Workbench */}
        <View class="flex-row flex-wrap gap-3">
          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="Telegram Admin Console (/api/telegram/*)"
              subtitle="Status, activity log, webhook set/delete, instant alert & executive report"
            />
            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="ops-admin-token-input"
                accessibilityLabel="Telegram admin bearer token"
                placeholder="SPORTSDESK_ADMIN_TOKEN (session memory only)…"
                masked={true}
                mono={true}
                class="flex-1"
                value={store.adminToken()}
                onChangeText={(tok) => store.setAdminToken(tok)}
              />
              <DeskButton
                label="Check Status"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.loadOpsPlane();
                }}
              />
            </View>

            <Surface variant="inset" class="gap-1">
              <Text class="font-mono text-xs text-foreground">
                {(() => {
                  const t = tgStatusSnap();
                  if (t.status === "unavailable") return t.cause;
                  if (t.status === "loading")
                    return "Checking /api/telegram/status…";
                  return `${t.data.summary} · webhookActive=${t.data.webhookActive ? "yes" : "no"}`;
                })()}
              </Text>
              <Text class="font-mono text-xs text-muted-foreground">
                {(() => {
                  const a = tgActSnap();
                  if (a.status === "unavailable") return a.cause;
                  if (a.status === "loading")
                    return "Checking /api/telegram/activity…";
                  return `activity events=${a.data.count}${a.data.entries[0] ? ` · latest: ${a.data.entries[0]}` : ""}`;
                })()}
              </Text>
            </Surface>

            <View class="flex-row flex-wrap items-center gap-2">
              <DeskButton
                testID="tg-webhook-set-btn"
                label="Set Webhook"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.runTelegramWebhookAction("set");
                }}
              />
              <DeskButton
                testID="tg-webhook-delete-btn"
                label="Delete Webhook"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.runTelegramWebhookAction("delete");
                }}
              />
            </View>

            <View class="flex-row items-center gap-2">
              <DeskInput
                testID="tg-alert-customer-input"
                accessibilityLabel="Customer ID for Telegram alert"
                placeholder="RF2003"
                mono={true}
                class="w-32"
                value={store.telegramAlertCustomer()}
                onChangeText={(c) => store.setTelegramAlertCustomer(c)}
              />
              <DeskButton
                testID="tg-send-alert-btn"
                label="Send Test Alert"
                size="xs"
                variant="outline"
                onPress={() => {
                  void store.runTelegramTestAlert();
                }}
              />
            </View>

            <View class="flex-row flex-wrap items-center gap-2">
              <DeskSelect
                accessibilityLabel="Executive report type"
                items={REPORT_SELECT_ITEMS}
                value={store.telegramReportType()}
                onValueChange={(next) => {
                  if (next) store.setTelegramReportType(next);
                }}
              />
              <DeskButton
                testID="tg-dispatch-report-btn"
                label="Dispatch Report"
                size="xs"
                variant="primary"
                onPress={() => {
                  void store.runTelegramExecutiveReport();
                }}
              />
            </View>
          </Surface>

          {/* 9-Endpoint Parser Workbench */}
          <Surface variant="card" class="min-w-80 flex-1 gap-2.5">
            <SectionHeader
              title="9-Endpoint Bun SIMD Parser Workbench (/api/parse-*)"
              subtitle="Interactive POST inspector for Bun.XML, bet-ticker, customer XML, AJAX, Bun.TOML & FormData"
            />
            <View class="flex-row flex-wrap items-center justify-between gap-2">
              <DeskSelect
                testID="parser-preset-select"
                accessibilityLabel="Parser endpoint preset"
                items={PARSER_SELECT_ITEMS}
                value={store.parserPresetId()}
                onValueChange={(next) => {
                  if (next) store.selectParserPreset(next);
                }}
              />
              <DeskButton
                testID="parser-run-btn"
                label="Run Parser POST"
                size="sm"
                variant="primary"
                onPress={() => {
                  void store.runParserWorkbench();
                }}
              />
            </View>

            <View class="flex-row flex-wrap gap-1">
              <Each of={PARSER_WORKBENCH_PRESETS} key={(p) => p.id}>
                {(p) => (
                  <DeskButton
                    testID={`parser-chip-${p().id}`}
                    label={p().id.replace("parse-", "")}
                    size="xs"
                    variant="outline"
                    selected={store.parserPresetId() === p().id}
                    onPress={() => store.selectParserPreset(p().id)}
                  />
                )}
              </Each>
            </View>

            <DeskInput
              testID="parser-body-input"
              accessibilityLabel="Parser POST request payload"
              multiline={true}
              mono={true}
              class="min-h-20"
              value={store.parserBody()}
              onChangeText={(b) => store.setParserBody(b)}
            />

            <Surface variant="inset" class="gap-1">
              <Text class="text-xs font-semibold text-muted-foreground">
                Parser Response
              </Text>
              <Text
                testID="parser-response-output"
                class="font-mono text-xs text-foreground"
              >
                {(() => {
                  const p = parserOutSnap();
                  if (p.status === "unavailable") return p.cause;
                  if (p.status === "loading") {
                    return "Select any /api/parse-* preset and press 'Run Parser POST'.";
                  }
                  return p.data;
                })()}
              </Text>
            </Surface>
          </Surface>
        </View>

        {/* Row 3: Complete 38-Endpoint Live Parity Matrix */}
        <Surface variant="card" class="gap-2.5" testID="parity-matrix-card">
          <View class="flex-row flex-wrap items-center justify-between gap-2">
            <SectionHeader
              title={`Complete :4020 Endpoint Parity Matrix (${DESK_ENDPOINT_CATALOG.length} Canonical Routes)`}
              subtitle={`Probed ${store.parityProgress().probed} / ${store.parityProgress().total} · Ready ${store.parityProgress().ready}`}
            />
            <Badge
              testID="ops-parity-summary-badge"
              label={`PARITY · ${store.parityProgress().probed}/${store.parityProgress().total}`}
              tone={store.parityProgress().probed >= 20 ? "positive" : "info"}
            />
          </View>

          <View class="gap-1">
            <Each of={DESK_ENDPOINT_CATALOG} key={(entry) => entry.id}>
              {(entry) => {
                const row = () => store.parityLedger()[entry().id];
                return (
                  <View class="flex-row flex-wrap items-center justify-between gap-2 rounded-(--radius-sm) border border-border/50 px-2.5 py-1.5">
                    <View class="flex-row items-center gap-2">
                      <Badge
                        label={entry().method}
                        tone={entry().method === "POST" ? "warning" : "info"}
                      />
                      <Text class="font-mono text-xs font-semibold text-foreground">
                        {entry().path}
                      </Text>
                      <Badge label={entry().plane} tone="neutral" />
                      <If when={entry().auth === "admin-bearer"}>
                        <Badge label="bearer" tone="warning" />
                      </If>
                    </View>
                    <View class="flex-row items-center gap-2">
                      <Text class="text-xs text-muted-foreground">
                        {entry().summary}
                      </Text>
                      <Badge
                        label={(() => {
                          const r = row();
                          if (!r || r.status === "unprobed") return "UNPROBED";
                          return r.detail.slice(0, 32);
                        })()}
                        tone={(() => {
                          const r = row();
                          if (!r || r.status === "unprobed") return "neutral";
                          return r.status === "ready" ? "positive" : "warning";
                        })()}
                      />
                    </View>
                  </View>
                );
              }}
            </Each>
          </View>
        </Surface>
      </View>
    </Scroll>
  );
}
