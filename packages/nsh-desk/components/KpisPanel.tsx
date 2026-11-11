import { Scroll, Text, View, type JSX } from "nsh";
import { formatProvenanceCompact } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import { Badge, createPanelReadyMotion, StateNotice, Surface } from "../ui";
import { provenanceTone } from "./provenance";

export function KpisPanel(props: { store?: DeskStore } = {}): JSX.Element {
  const store = useDeskStore(props.store);
  const readyMotion = createPanelReadyMotion();
  const snap = () => store.kpisSnap();
  const cards = () => {
    const s = snap();
    return s.status === "ready" ? s.data.cards : [];
  };

  return (
    <Surface variant="panel" class="min-h-0 flex-1">
      <If
        when={snap().status === "loading"}
        else={
          <If
            when={snap().status === "unavailable"}
            else={
              <Scroll class="min-h-0 flex-1">
                <View style={readyMotion.style} class="gap-2.5 p-3">
                  <Each of={cards()} key={(card) => card.id}>
                    {(card) => (
                      <Surface variant="card" class="min-w-0 gap-1.5">
                        <View class="flex-row flex-wrap items-center justify-between gap-1.5">
                          <Text class="text-xs font-medium text-muted-foreground">
                            {card().title}
                          </Text>
                          <Badge
                            label={formatProvenanceCompact(card().provenance)}
                            tone={provenanceTone(card().provenance)}
                          />
                        </View>
                        <Text class="font-mono text-base font-semibold tabular-nums text-card-foreground">
                          {card().primary}
                        </Text>
                        <Text class="text-xs text-muted-foreground">
                          {card().secondary}
                        </Text>
                        <Text class="font-mono text-xs text-muted-foreground truncate">
                          {`src: ${card().provenance.source}`}
                        </Text>
                      </Surface>
                    )}
                  </Each>
                </View>
              </Scroll>
            }
          >
            <StateNotice
              kind="unavailable"
              title="KPIs unavailable"
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
          title="Loading KPIs"
          detail="GET /api/kpis"
        />
      </If>
    </Surface>
  );
}
