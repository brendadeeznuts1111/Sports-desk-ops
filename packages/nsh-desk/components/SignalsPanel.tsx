import { Text, View, type JSX } from "nsh";
import { formatProvenanceCompact, formatUsd } from "../desk_model";
import type { DeskStore } from "../store";
import {
  Badge,
  createPanelReadyMotion,
  DeskDataTable,
  SEMANTIC_DELTA_CLASSES,
  StateNotice,
  Surface,
  type DataTableColumn,
} from "../ui";
import { provenanceTone } from "./provenance";

export const SIGNAL_COLUMNS: DataTableColumn[] = [
  { key: "league", title: "Lg", width: 58, fixed: true, sortable: true },
  {
    key: "market",
    title: "Market signal",
    width: 196,
    fixed: true,
    sortable: true,
  },
  { key: "risk", title: "Risk", width: 84, align: "end", sortable: true },
  { key: "accounts", title: "Accts", width: 72, align: "end", sortable: true },
  { key: "fairProb", title: "Fair%", width: 78, align: "end", sortable: true },
  {
    key: "edge",
    title: "Edge",
    width: 96,
    align: "end",
    sortable: true,
    ...SEMANTIC_DELTA_CLASSES,
  },
  { key: "confidence", title: "Conf", width: 76, align: "end", sortable: true },
  { key: "verdict", title: "Verdict", width: 120 },
  { key: "provenance", title: "Provenance", width: 170 },
];

export function SignalsPanel(props: { store: DeskStore }): JSX.Element {
  const readyMotion = createPanelReadyMotion();
  const snap = () => props.store.kalshiSnap();

  return (
    <Surface variant="panel" class="min-h-0 flex-1">
      <If
        when={snap().status === "loading"}
        else={
          <If
            when={snap().status === "unavailable"}
            else={
              <View
                style={readyMotion.style}
                class="min-h-0 flex-1 gap-2.5 p-3"
              >
                <View class="min-w-0 flex-row flex-wrap items-center justify-between gap-2">
                  <View class="min-w-0 flex-1 flex-row flex-wrap items-center gap-2">
                    <Text class="font-mono text-xs tabular-nums text-foreground">
                      {`${props.store.signalArena().rows.length} signals`}
                    </Text>
                    <Badge
                      label={(() => {
                        const s = snap();
                        return s.status === "ready"
                          ? formatProvenanceCompact(s.data.provenance)
                          : "PENDING";
                      })()}
                      tone={(() => {
                        const s = snap();
                        return s.status === "ready"
                          ? provenanceTone(s.data.provenance)
                          : "neutral";
                      })()}
                    />
                    <Text class="shrink font-mono text-xs text-muted-foreground truncate">
                      {(() => {
                        const s = snap();
                        return s.status === "ready"
                          ? `src: ${s.data.provenance.source}`
                          : "";
                      })()}
                    </Text>
                  </View>
                  <Badge
                    label={(() => {
                      const s = snap();
                      if (s.status !== "ready") return "KALSHI · UNKNOWN";
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

                <If
                  when={props.store.signalArena().rows.length > 0}
                  else={
                    <StateNotice
                      kind="empty"
                      title="No Kalshi signals reported"
                      detail="/api/signals/kalshi returned 0 active rows."
                      actionLabel="Refresh"
                      onAction={() => {
                        void props.store.refreshAll();
                      }}
                    />
                  }
                >
                  <DeskDataTable
                    accessibilityLabel="Kalshi market signals"
                    columns={SIGNAL_COLUMNS}
                    data={props.store.signalArena().rows}
                    sort={props.store.signalSort()}
                    onSortChange={(next) => props.store.setSignalSort(next)}
                    onRowSelect={(row) =>
                      props.store.selectSignalByDisplayRow(row)
                    }
                  />
                </If>

                <If when={props.store.selectedSignal()}>
                  {(active) => (
                    <Surface variant="inset" class="min-w-0 gap-1.5">
                      <View class="min-w-0 flex-row flex-wrap items-baseline justify-between gap-2">
                        <Text class="text-xs font-semibold text-foreground">
                          {`${active().id} · ${formatUsd(active().riskUsd)} across ${active().distinctAccounts} acct(s)`}
                        </Text>
                        <Text class="shrink font-mono text-xs text-muted-foreground truncate">
                          {`${active().verdict}: ${active().reason}`}
                        </Text>
                      </View>
                      <View class="min-w-0 flex-row flex-wrap gap-2">
                        <Each
                          of={active().accounts}
                          key={(acc) => `${acc.login}:${acc.agentId}`}
                        >
                          {(acc) => (
                            <Text class="shrink font-mono text-xs tabular-nums text-muted-foreground truncate">
                              {`${acc().login} (${acc().agentId}) ${formatUsd(acc().riskUsd)} [${acc().archetype}]`}
                            </Text>
                          )}
                        </Each>
                      </View>
                    </Surface>
                  )}
                </If>
              </View>
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
                void props.store.refreshAll();
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
