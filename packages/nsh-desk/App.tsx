import { ErrorBoundary, host, keymap, mount, View, type JSX } from "nsh";
import {
  DeskHeader,
  DiagnosticsPanel,
  ExposurePanel,
  KpisPanel,
  PANEL_TITLES,
  ScoreboardPanel,
  SignalsPanel,
} from "./components";
import { createDeskStore, DeskStoreContext } from "./store";
import {
  animateUserLayoutChange,
  bindDesktopShellMenu,
  DeskWorkspace,
  StateNotice,
  Surface,
  UiKitGalleryDialog,
  type DockAreaRef,
} from "./ui";

export function RootErrorFallback(props: {
  error: unknown;
  onReset: () => void;
}): JSX.Element {
  const detail = () => {
    const err = props.error;
    return err instanceof Error ? err.message : String(err);
  };
  return (
    <Surface variant="panel" class="flex-1 justify-center p-6">
      <StateNotice
        kind="unavailable"
        title="Workspace render error"
        detail={detail()}
        actionLabel="Reload workspace"
        onAction={props.onReset}
      />
    </Surface>
  );
}

function DeskRootBody(props: {
  consumeForcedError: () => string | null;
}): JSX.Element {
  const forcedError = props.consumeForcedError();
  if (forcedError !== null) {
    throw new Error(forcedError);
  }
  const store = createDeskStore();
  let dockRef: DockAreaRef | undefined;

  if (!store.originInfo.ok) {
    return (
      <Surface variant="panel" class="flex-1 justify-center p-6">
        <StateNotice
          kind="unavailable"
          title="Desk origin configuration error"
          detail={store.originInfo.error}
        />
      </Surface>
    );
  }

  const resolvedOrigin = store.originInfo.resolved;

  const toggleLeftDock = () => {
    animateUserLayoutChange();
    dockRef?.toggleDock("left");
  };

  const toggleBottomDock = () => {
    animateUserLayoutChange();
    dockRef?.toggleDock("bottom");
  };

  const resetWorkspaceLayout = () => {
    animateUserLayoutChange();
    store.resetLayout();
  };

  const copyDiagnostics = () => {
    void store.copyDiagnosticsToClipboard();
  };

  keymap.bind({
    "mod+r": () => {
      void store.refreshAll();
    },
    "mod+1": toggleLeftDock,
    "mod+2": toggleBottomDock,
    "mod+shift+l": () => store.toggleLocked(),
    "mod+shift+c": copyDiagnostics,
    "mod+u": () => store.setUiKitOpen(true),
  });

  bindDesktopShellMenu({
    windowTitle: () => `Sportsdesk Desk — ${resolvedOrigin.origin}`,
    autoPoll: store.autoPoll,
    locked: store.locked,
    leftOpen: () => store.dockOpen().left,
    bottomOpen: () => store.dockOpen().bottom,
    onRefresh: () => {
      void store.refreshAll();
    },
    onToggleAutoPoll: () => store.toggleAutoPoll(),
    onToggleLeftDock: toggleLeftDock,
    onToggleBottomDock: toggleBottomDock,
    onToggleLocked: () => store.toggleLocked(),
    onResetLayout: resetWorkspaceLayout,
    onCopyDiagnostics: copyDiagnostics,
    onOpenUiKit: () => store.setUiKitOpen(true),
  });

  return (
    <DeskStoreContext.Provider value={store}>
      <View class="min-h-0 flex-1">
        <DeskHeader
          origin={resolvedOrigin}
          onToggleLeftDock={toggleLeftDock}
          onToggleBottomDock={toggleBottomDock}
          onResetLayout={resetWorkspaceLayout}
          onCopyDiagnostics={copyDiagnostics}
        />

        <DeskWorkspace
          onRef={(r) => {
            dockRef = r;
          }}
          layout={store.layout()}
          locked={store.locked()}
          panelTitles={PANEL_TITLES}
          onLayoutChange={(next) => store.setLayout(next)}
          onDockOpenChange={(placement, open) =>
            store.setDockOpenPlacement(placement, open)
          }
          renderPanel={(panelId) => {
            switch (panelId) {
              case "signals":
                return <SignalsPanel />;
              case "exposure":
                return <ExposurePanel />;
              case "scoreboard":
                return <ScoreboardPanel />;
              case "kpis":
                return <KpisPanel />;
              case "diagnostics":
                return <DiagnosticsPanel />;
              default:
                return (
                  <StateNotice
                    kind="empty"
                    title="Unknown panel"
                    detail={`Panel '${panelId}' is not registered.`}
                  />
                );
            }
          }}
        />

        <UiKitGalleryDialog
          open={store.uiKitOpen()}
          onOpenChange={(open) => store.setUiKitOpen(open)}
        />
      </View>
    </DeskStoreContext.Provider>
  );
}

export function App(): JSX.Element {
  let forcedCrashConsumed = false;
  const consumeForcedError = (): string | null => {
    if (forcedCrashConsumed) return null;
    const raw = host.params["__testForceRenderError"];
    if (typeof raw === "string" && raw.length > 0) {
      forcedCrashConsumed = true;
      return raw;
    }
    return null;
  };
  const isolatedPanel = host.params["__testIsolatedPanel"];

  return (
    <View class="flex-1 bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <ErrorBoundary
        fallback={(error, reset) => (
          <RootErrorFallback error={error} onReset={reset} />
        )}
      >
        <If
          when={isolatedPanel === "signals"}
          else={<DeskRootBody consumeForcedError={consumeForcedError} />}
        >
          {() => {
            const isolatedStore = createDeskStore();
            return (
              <DeskStoreContext.Provider value={isolatedStore}>
                <SignalsPanel />
              </DeskStoreContext.Provider>
            );
          }}
        </If>
      </ErrorBoundary>
    </View>
  );
}

mount(App);
