import { Text, View, type JSX } from "nsh";
import { LEAGUE_FILTER_OPTIONS, useDeskStore, type DeskStore } from "../store";
import {
  createPanelReadyMotion,
  DeskDataTable,
  SegmentedTabs,
  StateNotice,
  Surface,
  type DataTableColumn,
} from "../ui";

export const SCOREBOARD_COLUMNS: DataTableColumn[] = [
  { key: "league", title: "Lg", width: 46, fixed: true },
  { key: "status", title: "State", width: 78 },
  { key: "period", title: "Period", width: 102 },
  { key: "matchup", title: "Matchup", width: 150 },
  { key: "score", title: "Score", width: 72, align: "end" },
];

export function ScoreboardPanel(
  props: { store?: DeskStore } = {},
): JSX.Element {
  const store = useDeskStore(props.store);
  const readyMotion = createPanelReadyMotion();
  const snap = () => store.scoreboardSnap();

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
                  <SegmentedTabs
                    accessibilityLabel="Filter scoreboard by league"
                    items={LEAGUE_FILTER_OPTIONS}
                    value={store.leagueFilter()}
                    onChange={(next) => store.setLeagueFilter(next)}
                  />
                  <Text class="shrink font-mono text-xs tabular-nums text-muted-foreground truncate">
                    {(() => {
                      const s = snap();
                      return s.status === "ready"
                        ? `observed: ${s.data.observedAt ?? "unreported"} · src: ${s.data.source}`
                        : "";
                    })()}
                  </Text>
                </View>

                <If
                  when={store.scoreboardRows().length > 0}
                  else={
                    <StateNotice
                      kind="empty"
                      title="No games in filter"
                      detail={`No games matched league '${store.leagueFilter()}'.`}
                      actionLabel="Show all leagues"
                      onAction={() => store.setLeagueFilter("ALL")}
                    />
                  }
                >
                  <DeskDataTable
                    accessibilityLabel="Scoreboard matchups"
                    columns={SCOREBOARD_COLUMNS}
                    data={store.scoreboardRows()}
                  />
                </If>
              </View>
            }
          >
            <StateNotice
              kind="unavailable"
              title="Scoreboard unavailable"
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
          title="Loading scoreboard"
          detail="GET /api/scoreboard"
        />
      </If>
    </Surface>
  );
}
