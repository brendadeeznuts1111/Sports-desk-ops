import { Scroll, Text, View, type JSX } from "nsh";
import { formatAgeShort, formatUsd } from "../desk_model";
import type { DeskStore } from "../store";
import { SectionHeader, Surface } from "../ui";

export function DiagnosticsPanel(props: { store: DeskStore }): JSX.Element {
  const formatEndpointReady = (
    endpoint: string,
    httpStatus: number,
  ): string => {
    if (endpoint === "/api/live-bets/summary") {
      const lb = props.store.liveBetsSnap();
      if (lb.status === "ready") {
        const wagers =
          lb.data.totalWagers !== null
            ? `${lb.data.totalWagers} wagers`
            : "wagers n/a";
        const risk =
          lb.data.totalRiskUsd !== null
            ? formatUsd(lb.data.totalRiskUsd)
            : "risk n/a";
        return `HTTP ${httpStatus} · ${wagers} · ${risk} [${lb.data.mode}]`;
      }
    }
    return `HTTP ${httpStatus} · ready`;
  };

  return (
    <Scroll class="min-h-0 flex-1 bg-background">
      <View class="flex-row flex-wrap gap-3 p-3">
        <View class="min-w-72 flex-1 gap-2">
          <SectionHeader
            title="Endpoints"
            trailing="read-only GET · no silent zeroes"
          />
          <Each of={props.store.allEndpoints()} key={(ep) => ep.endpoint}>
            {(ep) => (
              <Surface
                variant="inset"
                class="flex-row items-baseline justify-between gap-2 px-2.5 py-1"
              >
                <Text class="font-mono text-xs font-medium text-foreground">
                  {ep().endpoint}
                </Text>
                <If
                  when={ep().status === "loading"}
                  else={
                    <If
                      when={ep().status === "ready"}
                      else={
                        <Text class="flex-1 text-end font-mono text-xs text-warning truncate">
                          {(() => {
                            const cur = ep();
                            return cur.status === "unavailable"
                              ? cur.cause
                              : "";
                          })()}
                        </Text>
                      }
                    >
                      <Text class="font-mono text-xs tabular-nums text-positive">
                        {(() => {
                          const cur = ep();
                          return cur.status === "ready"
                            ? formatEndpointReady(cur.endpoint, cur.httpStatus)
                            : "";
                        })()}
                      </Text>
                    </If>
                  }
                >
                  <Text class="font-mono text-xs text-muted-foreground">
                    loading…
                  </Text>
                </If>
              </Surface>
            )}
          </Each>
        </View>

        <View class="min-w-72 flex-1 gap-2">
          <SectionHeader
            title="R2 pipeline sinks (#78)"
            trailing="publish age vs data window"
          />
          <If
            when={props.store.r2Sinks().length > 0}
            else={
              <Surface variant="inset" class="px-2.5 py-2">
                <Text class="font-mono text-xs text-muted-foreground">
                  {(() => {
                    const k = props.store.kpisSnap();
                    return k.status === "unavailable"
                      ? `pipeline unavailable (${k.code})`
                      : "no R2 sink telemetry reported";
                  })()}
                </Text>
              </Surface>
            }
          >
            <Each of={props.store.r2Sinks()} key={(s) => s.sink}>
              {(s) => (
                <Surface
                  variant="inset"
                  class="flex-row items-baseline justify-between gap-2 px-2.5 py-1"
                >
                  <Text class="font-mono text-xs font-medium text-foreground">
                    {s().sink}
                  </Text>
                  <Text
                    class={
                      s().publishStale || s().dataStale
                        ? "font-mono text-xs tabular-nums text-warning"
                        : "font-mono text-xs tabular-nums text-positive"
                    }
                  >
                    {`pub ${formatAgeShort(s().publishAgeSeconds)} (${s().state}) · data ${formatAgeShort(s().dataAgeSeconds)}${s().windowDivergent ? " [DATA-STALE]" : ""}`}
                  </Text>
                </Surface>
              )}
            </Each>
          </If>
        </View>
      </View>
    </Scroll>
  );
}
