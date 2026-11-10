import { effect, Text, View, type JSX } from "nsh";
import {
  DataTable,
  DockArea,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  type DataTableColumn,
  type DataTableSort,
  type DockAreaLayout,
  type DockAreaRef,
} from "nsh/base";
import { Bar, Grid, Plot, PlotAxis } from "nsh/base/plot";
import {
  isAvailable as isDesktopMenuAvailable,
  Menu as DesktopMenu,
  Window as DesktopWindow,
} from "nsh/desktop";
import type { ExposurePlotPoint } from "../desk_model";
import { FOCUS_RING_CLASS, SCRIM_BACKDROP_CLASS } from "./tokens";

export type { DataTableColumn, DataTableSort, DockAreaLayout, DockAreaRef };

export const SEMANTIC_DELTA_CLASSES = {
  positiveClass: "text-positive tabular-nums",
  negativeClass: "text-negative tabular-nums",
} as const;

const DESK_TABLE_CLASSES = {
  root: "overflow-hidden rounded-(--radius) border border-border bg-card text-card-foreground",
  header: "border-b border-border bg-muted/60 text-muted-foreground",
  headerCell: "ps-2.5 pe-1.5",
  headerContent: "gap-1",
  headerCellSelected: "bg-accent/70",
  sortIndicator:
    "rounded-(--radius-sm) text-muted-foreground hover:bg-accent active:bg-accent",
  sortAscending:
    "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
  sortDescending:
    "text-muted-foreground opacity-60 selected:text-foreground selected:opacity-100",
  resizeHandle: "bg-border group-hover:bg-primary group-active:bg-primary",
  row: "border-b border-border/60 font-mono tabular-nums",
  rowOdd: "bg-muted/25",
  rowHover: "bg-accent/45",
  rowSelected: "bg-accent",
  cell: "px-2.5",
  fixedEdge: "bg-border",
};

export interface DeskDataTableProps<T = Record<string, unknown>> {
  columns: DataTableColumn[];
  data: T[];
  sort?: DataTableSort | null;
  accessibilityLabel?: string;
  onSortChange?: (next: DataTableSort | null) => void;
  onRowSelect?: (rowIndex: number) => void;
}

export function DeskDataTable<T = Record<string, unknown>>(
  props: DeskDataTableProps<T>,
): JSX.Element {
  return (
    <DataTable
      class="min-h-0 flex-1"
      classes={DESK_TABLE_CLASSES}
      columns={props.columns}
      data={props.data}
      rowHeight={28}
      fontSize={12}
      stripe={true}
      rowHeader={false}
      accessibilityLabel={props.accessibilityLabel}
      sort={props.sort ?? undefined}
      onSortChange={
        props.onSortChange
          ? ({ sort }) => props.onSortChange?.(sort ?? null)
          : undefined
      }
      onSelectionChange={
        props.onRowSelect
          ? ({ selection }) => {
              if (selection?.row != null) {
                props.onRowSelect?.(selection.row);
              }
            }
          : undefined
      }
    />
  );
}

export interface DeskExposurePlotProps {
  points: ExposurePlotPoint[];
  formatUsd: (usd: number) => string;
  onHoverIndexChange: (index: number | null) => void;
}

export function DeskExposurePlot(props: DeskExposurePlotProps): JSX.Element {
  return (
    <View class="min-h-0 flex-1 ps-12 pe-2 pb-6 pt-2">
      <Plot
        class="flex-1 text-chart-1"
        data={props.points}
        xScale={{ type: "band", paddingInner: 0.28, paddingOuter: 0.15 }}
        y="riskUsd"
        accessibilityLabel="Risk exposure in USD by Kalshi signal"
        onHoverChange={({ index }) => props.onHoverIndexChange(index ?? null)}
      >
        <Grid class="stroke-border" />
        <Bar cornerRadii={4} class="fill-chart-1/85" />
        <PlotAxis
          placement="left"
          ticks={5}
          format={(v) => props.formatUsd(v)}
          labelClass="font-mono text-xs tabular-nums text-muted-foreground"
        />
        <PlotAxis
          placement="bottom"
          format={(v) => props.points[Math.round(v)]?.league ?? ""}
          labelClass="font-mono text-xs text-muted-foreground"
        />
      </Plot>
    </View>
  );
}

export function DeskToolbar(props: {
  accessibilityLabel: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <Toolbar
      accessibilityLabel={props.accessibilityLabel}
      class="min-w-0 shrink flex-row flex-wrap items-center gap-1.5"
    >
      {props.children}
    </Toolbar>
  );
}

export function DeskToolbarGroup(props: {
  accessibilityLabel: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <ToolbarGroup
      accessibilityLabel={props.accessibilityLabel}
      class="flex-row items-center gap-1.5"
    >
      {props.children}
    </ToolbarGroup>
  );
}

export function DeskToolbarSeparator(): JSX.Element {
  return <ToolbarSeparator class="mx-0.5 h-5 w-px bg-border" />;
}

export interface DeskWorkspaceProps {
  layout: DockAreaLayout;
  locked: boolean;
  panelTitles: Readonly<Record<string, string>>;
  onRef: (ref: DockAreaRef) => void;
  onLayoutChange: (layout: DockAreaLayout) => void;
  onDockOpenChange: (placement: "left" | "bottom", open: boolean) => void;
  renderPanel: (panelId: string) => JSX.Element;
}

export function DeskWorkspace(props: DeskWorkspaceProps): JSX.Element {
  return (
    <DockArea
      ref={props.onRef}
      class="min-h-0 flex-1"
      layout={props.layout}
      locked={props.locked}
      handleAccessibilityLabel="Resize workspace pane"
      onLayoutChange={({ layout: next }) => props.onLayoutChange(next)}
      onDockOpenChange={({ placement, open }) => {
        if (placement === "left" || placement === "bottom") {
          props.onDockOpenChange(placement, open);
        }
      }}
      groupClass="min-h-0 min-w-0 flex-1 bg-background"
      tabBarClass="flex-row items-center gap-1 border-b border-border bg-muted/45 px-1.5 pt-1"
      tabClass={`group rounded-t-(--radius) border border-b-0 border-transparent px-3 py-1.5 transition duration-100 hover:bg-accent/55 active:bg-accent selected:border-border selected:bg-background motion-reduce:transition-none ${FOCUS_RING_CLASS}`}
      contentClass="min-h-0 min-w-0 flex-1"
      handleClass="basis-px bg-border group-hover:bg-primary group-active:bg-primary"
      dockClass="bg-background"
      drawerClass="border-e border-border bg-card shadow-lg"
      sheetClass="rounded-t-(--radius-lg) border-t border-border bg-card shadow-lg"
      backdropClass={SCRIM_BACKDROP_CLASS}
      dropIndicatorClass="rounded-(--radius) border-2 border-primary bg-primary/10"
      renderTab={(tab) => (
        <Text
          class={
            tab.active
              ? "text-xs font-semibold text-foreground"
              : "text-xs font-medium text-muted-foreground group-hover:text-foreground"
          }
        >
          {props.panelTitles[tab.panel] ?? tab.panel}
        </Text>
      )}
      renderPanel={(panel) => props.renderPanel(panel.id)}
    />
  );
}

export interface DesktopShellMenuOptions {
  windowTitle: () => string;
  autoPoll: () => boolean;
  locked: () => boolean;
  leftOpen: () => boolean;
  bottomOpen: () => boolean;
  onRefresh: () => void;
  onToggleAutoPoll: () => void;
  onToggleLeftDock: () => void;
  onToggleBottomDock: () => void;
  onToggleLocked: () => void;
  onResetLayout: () => void;
  onCopyDiagnostics?: () => void;
  onOpenUiKit: () => void;
}

/**
 * Registers the native desktop window title and macOS/Windows/Linux menu bar
 * when running on a desktop target (`nsh/desktop` `isAvailable`).
 */
export function bindDesktopShellMenu(opts: DesktopShellMenuOptions): void {
  if (!isDesktopMenuAvailable) return;

  effect(() => {
    DesktopWindow.setTitle(opts.windowTitle());
  });

  effect(() => {
    const autoOn = opts.autoPoll();
    const isLocked = opts.locked();
    const isLeftOpen = opts.leftOpen();
    const isBottomOpen = opts.bottomOpen();

    DesktopMenu.setApplicationMenu([
      {
        label: "Sportsdesk Desk",
        submenu: [
          { role: "about" },
          { type: "separator" },
          {
            label: "UI kit…",
            shortcut: "mod+u",
            onSelect: opts.onOpenUiKit,
          },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "showAll" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [{ role: "copy" }, { role: "selectAll" }],
      },
      {
        label: "Workspace",
        submenu: [
          {
            label: "Refresh endpoints",
            shortcut: "mod+r",
            onSelect: opts.onRefresh,
          },
          {
            label: "Auto refresh every 10s",
            checked: autoOn,
            onSelect: opts.onToggleAutoPoll,
          },
          { type: "separator" },
          {
            label: "KPIs dock",
            shortcut: "mod+1",
            checked: isLeftOpen,
            onSelect: opts.onToggleLeftDock,
          },
          {
            label: "Pipeline dock",
            shortcut: "mod+2",
            checked: isBottomOpen,
            onSelect: opts.onToggleBottomDock,
          },
          { type: "separator" },
          {
            label: "Lock layout",
            shortcut: "mod+shift+l",
            checked: isLocked,
            onSelect: opts.onToggleLocked,
          },
          {
            label: "Reset layout",
            onSelect: opts.onResetLayout,
          },
          ...(opts.onCopyDiagnostics
            ? [
                { type: "separator" as const },
                {
                  label: "Copy diagnostics JSON",
                  shortcut: "mod+shift+c",
                  onSelect: opts.onCopyDiagnostics,
                },
              ]
            : []),
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { role: "toggleFullScreen" },
          { type: "separator" },
          { role: "close" },
        ],
      },
    ]);
  });
}
