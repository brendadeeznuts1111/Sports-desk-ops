import process from "process";
import { batch, cleanup, Clipboard, computed, signal, Storage } from "nsh";
import {
  buildDiagnosticsSnapshotJson,
  buildExposurePlotData,
  buildScoreboardRows,
  buildSignalArenaView,
  DESK_PREFS_STORAGE_KEY,
  extractApiFailureCause,
  parseKalshiPayload,
  parseKpisPayload,
  parseLiveBetsSummaryPayload,
  parseScoreboardPayload,
  parseWorkspacePrefsJson,
  resolveDeskOrigin,
  serializeWorkspacePrefs,
  type DeskLeagueFilter,
  type EndpointSnapshot,
  type ParsedKalshiPayload,
  type ParsedKpisPayload,
  type ParsedLiveBetsSummary,
  type ParsedScoreboardPayload,
  type ResolvedDeskOrigin,
} from "./desk_model";
import type { DataTableSort, DockAreaLayout } from "./ui";

export type LeagueFilter = DeskLeagueFilter;

export const LEAGUE_FILTER_OPTIONS = [
  { id: "ALL", label: "All" },
  { id: "NFL", label: "NFL" },
  { id: "NBA", label: "NBA" },
  { id: "NHL", label: "NHL" },
  { id: "NCAA", label: "NCAA" },
] as const;

export function defaultWorkspaceLayout(): DockAreaLayout {
  return {
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: ["signals", "scoreboard"] },
        { type: "tabs", panels: ["exposure"] },
      ],
      sizes: [null, 352],
    },
    left: { layout: { type: "tabs", panels: ["kpis"] }, size: 296 },
    bottom: { layout: { type: "tabs", panels: ["diagnostics"] }, size: 214 },
  };
}

async function fetchJsonEndpoint<T>(
  origin: string,
  endpoint: string,
  parser: (raw: unknown) => T,
): Promise<EndpointSnapshot<T>> {
  const fetchedAtIso = new Date().toISOString();
  const url = `${origin}${endpoint}`;
  let response: Response;
  try {
    response = await fetch(url, { method: "GET" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: null,
      code: "network_unreachable",
      cause: `${url} unreachable: ${msg}`,
      fetchedAtIso,
    };
  }

  const bodyText = await response.text();
  if (!response.ok) {
    const { code, cause } = extractApiFailureCause(
      endpoint,
      response.status,
      bodyText,
    );
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code,
      cause,
      fetchedAtIso,
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code: "invalid_json",
      cause: `${endpoint} returned invalid JSON: ${msg}`,
      fetchedAtIso,
    };
  }

  try {
    return {
      status: "ready",
      endpoint,
      httpStatus: response.status,
      fetchedAtIso,
      data: parser(raw),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      endpoint,
      httpStatus: response.status,
      code: "schema_mismatch",
      cause: `${endpoint} parse error: ${msg}`,
      fetchedAtIso,
    };
  }
}

export type OriginResolution =
  | { readonly ok: true; readonly resolved: ResolvedDeskOrigin }
  | { readonly ok: false; readonly error: string };

/**
 * Encapsulated desk state owner per `nsh` Coding Guides ("State ownership"):
 * signals stay private inside `createDeskStore()` and views consume typed
 * accessors and command functions.
 */
export function createDeskStore() {
  const originInfo: OriginResolution = (() => {
    try {
      return {
        ok: true,
        resolved: resolveDeskOrigin(process.env["SPORTSDESK_ORIGIN"]),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  })();

  const kpisSnap = signal<EndpointSnapshot<ParsedKpisPayload>>({
    status: "loading",
    endpoint: "/api/kpis",
  });
  const kalshiSnap = signal<EndpointSnapshot<ParsedKalshiPayload>>({
    status: "loading",
    endpoint: "/api/signals/kalshi",
  });
  const scoreboardSnap = signal<EndpointSnapshot<ParsedScoreboardPayload>>({
    status: "loading",
    endpoint: "/api/scoreboard",
  });
  const liveBetsSnap = signal<EndpointSnapshot<ParsedLiveBetsSummary>>({
    status: "loading",
    endpoint: "/api/live-bets/summary",
  });

  const pollCount = signal(0);
  const lastPollMs = signal<number | null>(null);
  const polling = signal(false);
  const autoPoll = signal(false);

  const signalSort = signal<DataTableSort | null>({
    key: "risk",
    direction: "descending",
  });
  // Preserve selection by domain identity (`signal.id`) across sorting & refreshes.
  const selectedSignalId = signal<string | null>(null);
  const hoveredPlotIndex = signal<number | null>(null);
  const leagueFilter = signal<LeagueFilter>("ALL");

  const layout = signal<DockAreaLayout>(defaultWorkspaceLayout());
  const locked = signal(false);
  const dockOpen = signal({ left: true, bottom: true });
  const uiKitOpen = signal(false);
  const copiedDiagnosticsBytes = signal<number | null>(null);

  let userMutatedPrefs = false;

  const persistPrefs = () => {
    userMutatedPrefs = true;
    const payload = serializeWorkspacePrefs({
      schemaVersion: 1,
      leagueFilter: leagueFilter(),
      autoPoll: autoPoll(),
      locked: locked(),
      dockOpen: dockOpen(),
    });
    void Storage.setItem(DESK_PREFS_STORAGE_KEY, payload).catch(() => {
      // Non-fatal if host Storage quota or capability is unavailable.
    });
  };

  void Storage.getItem(DESK_PREFS_STORAGE_KEY)
    .then((raw) => {
      if (userMutatedPrefs || raw === null) return;
      const hydrated = parseWorkspacePrefsJson(raw);
      batch(() => {
        leagueFilter.set(hydrated.leagueFilter);
        autoPoll.set(hydrated.autoPoll);
        locked.set(hydrated.locked);
        dockOpen.set(hydrated.dockOpen);
      });
    })
    .catch(() => {
      // Keep defaults when Storage is unavailable.
    });

  const refreshAll = async () => {
    if (!originInfo.ok || polling()) return;
    polling.set(true);
    const t0 = Date.now();
    const base = originInfo.resolved.origin;
    const [nextKpis, nextKalshi, nextBoard, nextLiveBets] = await Promise.all([
      fetchJsonEndpoint(base, "/api/kpis", parseKpisPayload),
      fetchJsonEndpoint(base, "/api/signals/kalshi", parseKalshiPayload),
      fetchJsonEndpoint(base, "/api/scoreboard", parseScoreboardPayload),
      fetchJsonEndpoint(
        base,
        "/api/live-bets/summary",
        parseLiveBetsSummaryPayload,
      ),
    ]);
    const elapsed = Math.max(0, Date.now() - t0);
    batch(() => {
      kpisSnap.set(nextKpis);
      kalshiSnap.set(nextKalshi);
      scoreboardSnap.set(nextBoard);
      liveBetsSnap.set(nextLiveBets);
      lastPollMs.set(elapsed);
      pollCount.update((n) => n + 1);
      polling.set(false);
    });
  };

  void refreshAll();

  const timer = setInterval(() => {
    if (autoPoll()) {
      void refreshAll();
    }
  }, 10_000);
  cleanup(() => clearInterval(timer));

  const signalArena = computed(() => {
    const snap = kalshiSnap();
    if (snap.status !== "ready") {
      return buildSignalArenaView([], null, null);
    }
    const s = signalSort();
    return buildSignalArenaView(
      snap.data.signals,
      s?.key ?? null,
      s?.direction ?? null,
    );
  });

  const selectedSignal = computed(() => {
    const arena = signalArena();
    if (arena.items.length === 0) return null;
    const targetId = selectedSignalId();
    if (targetId !== null) {
      const matched = arena.items.find((item) => item.id === targetId);
      if (matched) return matched;
    }
    const firstIdx = arena.order[0];
    return firstIdx !== undefined ? (arena.items[firstIdx] ?? null) : null;
  });

  const plotPoints = computed(() => {
    const snap = kalshiSnap();
    return snap.status === "ready"
      ? buildExposurePlotData(snap.data.signals, 10)
      : [];
  });

  const activePlotPoint = computed(() => {
    const pts = plotPoints();
    if (pts.length === 0) return null;
    const idx = hoveredPlotIndex();
    return idx !== null ? (pts[idx] ?? pts[0] ?? null) : (pts[0] ?? null);
  });

  const scoreboardRows = computed(() => {
    const snap = scoreboardSnap();
    return snap.status === "ready"
      ? buildScoreboardRows(snap.data.games, leagueFilter())
      : [];
  });

  const allEndpoints = computed(() => [
    kpisSnap(),
    kalshiSnap(),
    scoreboardSnap(),
    liveBetsSnap(),
  ]);

  const r2Sinks = computed(() => {
    const k = kpisSnap();
    return k.status === "ready" ? k.data.r2Sinks : [];
  });

  const copyDiagnosticsToClipboard = async (): Promise<boolean> => {
    if (!originInfo.ok) return false;
    const snapshot = buildDiagnosticsSnapshotJson({
      origin: originInfo.resolved,
      pollCount: pollCount(),
      lastPollMs: lastPollMs(),
      endpoints: allEndpoints(),
      liveBets: liveBetsSnap(),
      r2Sinks: r2Sinks(),
    });
    try {
      await Clipboard.writeText(snapshot);
      copiedDiagnosticsBytes.set(snapshot.length);
      return true;
    } catch {
      return false;
    }
  };

  return {
    originInfo,
    kpisSnap: () => kpisSnap(),
    kalshiSnap: () => kalshiSnap(),
    scoreboardSnap: () => scoreboardSnap(),
    liveBetsSnap: () => liveBetsSnap(),
    pollCount: () => pollCount(),
    lastPollMs: () => lastPollMs(),
    polling: () => polling(),
    autoPoll: () => autoPoll(),
    signalSort: () => signalSort(),
    signalArena,
    selectedSignal,
    plotPoints,
    activePlotPoint,
    leagueFilter: () => leagueFilter(),
    scoreboardRows,
    allEndpoints,
    r2Sinks,
    layout: () => layout(),
    locked: () => locked(),
    dockOpen: () => dockOpen(),
    uiKitOpen: () => uiKitOpen(),
    copiedDiagnosticsBytes: () => copiedDiagnosticsBytes(),
    refreshAll,
    copyDiagnosticsToClipboard,
    setAutoPoll: (next: boolean) => {
      autoPoll.set(next);
      persistPrefs();
    },
    toggleAutoPoll: () => {
      autoPoll.update((v) => !v);
      persistPrefs();
    },
    setSignalSort: (next: DataTableSort | null) => signalSort.set(next),
    selectSignalByDisplayRow: (displayRow: number) => {
      const arena = signalArena();
      const origIdx = arena.order[displayRow];
      const chosen = origIdx !== undefined ? arena.items[origIdx] : undefined;
      if (chosen) {
        selectedSignalId.set(chosen.id);
      }
    },
    setHoveredPlotIndex: (idx: number | null) => hoveredPlotIndex.set(idx),
    setLeagueFilter: (next: LeagueFilter) => {
      leagueFilter.set(next);
      persistPrefs();
    },
    setLayout: (next: DockAreaLayout) => layout.set(next),
    resetLayout: () => {
      batch(() => {
        layout.set(defaultWorkspaceLayout());
        dockOpen.set({ left: true, bottom: true });
      });
      persistPrefs();
    },
    setLocked: (next: boolean) => {
      locked.set(next);
      persistPrefs();
    },
    toggleLocked: () => {
      locked.update((v) => !v);
      persistPrefs();
    },
    setDockOpenPlacement: (placement: "left" | "bottom", open: boolean) => {
      dockOpen.set({ ...dockOpen(), [placement]: open });
      persistPrefs();
    },
    setUiKitOpen: (next: boolean) => uiKitOpen.set(next),
  };
}

export type DeskStore = ReturnType<typeof createDeskStore>;
