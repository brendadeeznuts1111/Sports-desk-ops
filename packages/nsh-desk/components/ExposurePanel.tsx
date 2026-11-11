import { Text, View, type JSX } from "nsh";
import { formatUsd } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  createPanelReadyMotion,
  DeskExposurePlot,
  StateNotice,
  Surface,
} from "../ui";

export function ExposurePanel(props: { store?: DeskStore } = {}): JSX.Element {
  const store = useDeskStore(props.store);
  const readyMotion = createPanelReadyMotion();
  const snap = () => store.kalshiSnap();

  return (
    <Surface variant="panel" class="min-h-0 flex-1">
      <If
        when={snap().status === "loading"}
        else={
          <If
            when={snap().status === "unavailable"}
            else={
              <If
                when={store.plotPoints().length > 0}
                else={
                  <StateNotice
                    kind="empty"
                    title="No exposure bars to plot"
                    detail="0 Kalshi signals returned by /api/signals/kalshi."
                    actionLabel="Refresh"
                    onAction={() => {
                      void store.refreshAll();
                    }}
                  />
                }
              >
                <View
                  style={readyMotion.style}
                  class="min-h-0 flex-1 gap-2.5 p-3"
                >
                  <If when={store.activePlotPoint()}>
                    {(hov) => (
                      <Surface variant="inset" class="gap-1">
                        <Text class="text-xs font-semibold text-foreground">
                          {hov().fullLabel}
                        </Text>
                        <Text class="font-mono text-xs tabular-nums text-muted-foreground">
                          {`Exposure ${formatUsd(hov().riskUsd)} · conf ${hov().confidence}% · ${hov().verdict} · [${hov().provenanceText}]`}
                        </Text>
                      </Surface>
                    )}
                  </If>
                  <DeskExposurePlot
                    points={store.plotPoints()}
                    formatUsd={formatUsd}
                    onHoverIndexChange={(idx) => store.setHoveredPlotIndex(idx)}
                  />
                </View>
              </If>
            }
          >
            <StateNotice
              kind="unavailable"
              title="Exposure plot unavailable"
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
          title="Loading exposure plot"
          detail="GET /api/signals/kalshi"
        />
      </If>
    </Surface>
  );
}
