import { setColorScheme, Text, View, type JSX } from "nsh";
import type { DeskPlaneId, ResolvedDeskOrigin } from "../desk_model";
import { useDeskStore, type DeskStore } from "../store";
import {
  animateUserLayoutChange,
  Badge,
  DeskButton,
  DeskMenu,
  DeskMenuItem,
  DeskMenuSeparator,
  DeskSwitch,
  DeskToolbar,
  DeskToolbarGroup,
  DeskToolbarSeparator,
  OrderToastBanner,
  SegmentedTabs,
  type SegmentedTabItem,
} from "../ui";

const PLANE_TABS: readonly SegmentedTabItem<DeskPlaneId>[] = [
  { id: "markets", label: "Markets" },
  { id: "board", label: "Board" },
  { id: "surveillance", label: "Surveillance" },
  { id: "forensics", label: "Forensics" },
  { id: "ops", label: "System & Ops" },
];

export interface DeskHeaderProps {
  store?: DeskStore;
  origin: ResolvedDeskOrigin;
  onToggleLeftDock: () => void;
  onToggleBottomDock: () => void;
  onResetLayout: () => void;
  onCopyDiagnostics: () => void;
}

export function DeskHeader(props: DeskHeaderProps): JSX.Element {
  const store = useDeskStore(props.store);
  const progress = () => store.parityProgress();

  return (
    <View class="border-b border-border bg-card px-3 py-2 gap-1.5">
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="flex-row flex-wrap items-baseline gap-2">
          <Text
            role="header"
            class="text-sm font-semibold text-card-foreground"
          >
            Sportsdesk Desk
          </Text>
          <Text class="font-mono text-xs text-muted-foreground">
            {`${props.origin.origin} [${props.origin.source}]`}
          </Text>
          <Text class="font-mono text-xs tabular-nums text-muted-foreground">
            {store.lastPollMs() === null
              ? "polling…"
              : `poll #${store.pollCount()} · ${store.lastPollMs()}ms`}
          </Text>
          <Badge
            testID="endpoint-parity-badge"
            label={`routes ${progress().probed}/${progress().total}`}
            tone={progress().probed >= 20 ? "positive" : "neutral"}
          />
          <If when={store.copiedDiagnosticsBytes() !== null}>
            <Badge
              testID="diagnostics-copied-badge"
              label={`copied ${store.copiedDiagnosticsBytes() ?? 0}B`}
              tone="positive"
            />
          </If>
        </View>

        <DeskToolbar accessibilityLabel="Workspace controls">
          <SegmentedTabs
            accessibilityLabel="Workspace plane"
            items={PLANE_TABS}
            value={store.activePlane()}
            onChange={(next) => {
              animateUserLayoutChange();
              store.setActivePlane(next);
            }}
          />

          <DeskToolbarSeparator />

          <DeskToolbarGroup accessibilityLabel="Polling">
            <DeskButton
              label={store.polling() ? "Refreshing…" : "Refresh"}
              variant="default"
              loading={store.polling()}
              tooltip="Refresh active :4020 endpoints"
              onPress={() => {
                void store.refreshAll();
              }}
            />
            <DeskSwitch
              label="Auto 10s"
              checked={store.autoPoll()}
              onChange={(next) => store.setAutoPoll(next)}
            />
          </DeskToolbarGroup>

          <If when={store.activePlane() === "markets"}>
            <DeskToolbarSeparator />
            <DeskToolbarGroup accessibilityLabel="Docks">
              <DeskButton
                label="KPIs"
                variant="outline"
                selected={store.dockOpen().left}
                accessibilityLabel="KPIs dock"
                onPress={props.onToggleLeftDock}
              />
              <DeskButton
                label="Pipeline"
                variant="outline"
                selected={store.dockOpen().bottom}
                accessibilityLabel="Pipeline dock"
                onPress={props.onToggleBottomDock}
              />
            </DeskToolbarGroup>
          </If>

          <DeskToolbarSeparator />

          <DeskMenu label="Workspace" testID="workspace-menu">
            <DeskMenuItem
              testID="menu-sweep-endpoints"
              label="Sweep all :4020 endpoints"
              onSelect={() => {
                void store.sweepAllEndpoints();
              }}
            />
            <DeskMenuItem
              testID="menu-open-ticket"
              label="Execution ticket…"
              onSelect={() => store.openTicketForSelected()}
            />
            <DeskMenuSeparator />
            <DeskMenuItem
              label="Lock layout"
              shortcut="mod+shift+l"
              checked={store.locked()}
              onSelect={() => store.toggleLocked()}
            />
            <DeskMenuItem label="Reset layout" onSelect={props.onResetLayout} />
            <DeskMenuItem
              testID="menu-copy-diagnostics"
              label="Copy diagnostics JSON"
              shortcut="mod+shift+c"
              onSelect={props.onCopyDiagnostics}
            />
            <DeskMenuSeparator />
            <DeskMenuItem
              label="System appearance"
              onSelect={() => setColorScheme("system")}
            />
            <DeskMenuItem
              label="Light appearance"
              onSelect={() => setColorScheme("light")}
            />
            <DeskMenuItem
              label="Dark appearance"
              onSelect={() => setColorScheme("dark")}
            />
            <DeskMenuSeparator />
            <DeskMenuItem
              testID="menu-ui-kit"
              label="UI kit…"
              shortcut="mod+u"
              onSelect={() => store.setUiKitOpen(true)}
            />
          </DeskMenu>
        </DeskToolbar>
      </View>

      <OrderToastBanner
        message={store.toastBanner()?.message ?? null}
        tone={store.toastBanner()?.tone ?? "positive"}
        onDismiss={() => store.dismissToastBanner()}
      />
    </View>
  );
}
