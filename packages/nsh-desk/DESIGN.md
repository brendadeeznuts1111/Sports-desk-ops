# Sportsdesk Desk (`ops.sportsdesk.desk`) — Design & Motion Specification

Normative product design document for `packages/nsh-desk`, authored before feature UI changes per
`nsh-design-guides` ("Start from the task", "Establish the app's design system first", and "Motion
inventory").

## 1. Task, Objects, and Scope ("Start from the task")

- **Primary task:** Monitor Kalshi market signals, risk concentration, KPI provenance, and R2
  pipeline freshness against a read-only Sportsdesk `:4020` daemon with zero silent zeroes or
  disguised stale windows.
- **Primary objects:**
  1. **Kalshi signals** (`/api/signals/kalshi`) — sortable by risk, account count, fair probability,
     edge, and confidence, paired with a selected-signal account breakdown and an exposure bar chart.
  2. **KPIs & provenance** (`/api/kpis`) — headline desk metrics paired with explicit `[LIVE]`,
     `[STALE]`, `[PENDING]`, or `[FIXTURE]` provenance badges.
  3. **Pipeline & honesty telemetry** (`/api/kpis` R2 sinks + `:4020` endpoint statuses, including
     `/api/live-bets/summary`) — separating R2 object publish age from `#78` data-window age
     (`[DATA-STALE]`) and surfacing `503 [unauthorized]` causes verbatim.
  4. **Scoreboard** (`/api/scoreboard`) — league-filtered matchup states and scores.
- **Immediate vs secondary actions:**
  - **Primary toolbar (`Toolbar`):** `Refresh` (`mod+r`), `Auto 10s` immediate setting (`DeskSwitch`),
    dock visibility toggles (`KPIs`, `Pipeline`), and `Workspace` command `Menu`.
  - **Secondary commands (`Workspace` `Menu` + `nsh/desktop` application menu):** `Lock layout`
    (`mod+shift+l`), `Reset layout`, `Copy diagnostics JSON` (`mod+shift+c`, writes a signal-honest
    JSON snapshot via `Clipboard.writeText`), appearance override (`System`, `Light`, `Dark`), and
    `UI kit…` (`mod+u`, opens the `ui/` component showcase dialog).
  - **Persisted operator preferences (`Storage`):** `leagueFilter`, `autoPoll`, `locked`, and dock
    open/close state hydrate from and persist to `Storage` under `ops.sportsdesk.desk.prefs.v1`.
- **Empty, loading, unavailable, and read-only states:**
  - Every panel renders explicit `loading`, `empty`, and `unavailable` states via `StateNotice`
    (stating HTTP status, diagnostic code, verbatim cause, and recovery command `Refresh`).
  - Subsequent refreshes keep current rows on screen while `Refresh` reports busy state; panels
    never flash blank during background 10s polling.
  - Strictly read-only (`GET` only against `127.0.0.1` / `localhost`).

## 2. Supported Platform Targets

- **Desktop & Web (`platform.desktop === true`):**
  - Compact 28pt (`sm`) toolbar controls, 28pt dense `DataTable` rows, pointer hover washes,
    outward `focus-visible:` rings, `Toolbar` arrow-key roving focus, `Tabs` roving focus,
    `keymap` shortcuts (`mod+r`, `mod+1`, `mod+2`, `mod+shift+l`, `mod+u`), and macOS menu bar
    integration (`Menu.setApplicationMenu`).
- **Mobile (`!platform.desktop`, iOS / Android / narrow viewport `< 600pt`):**
  - `DockArea` compact mode presents left/bottom docks as edge drawers and bottom sheets over a
    scrim backdrop; `DeskButton` and `DeskSwitch` expand touch hit targets (`ios:min-h-11
android:min-h-12` / `hitSlop`) so every interactive target meets 44pt / 48dp minimums.
- **TUI:** Not targeted (`ops.sportsdesk.desk` relies on graphical `DataTable` and `Plot` views).

## 3. Visual System, Scales, and Semantic Theme Tokens (`theme.json`)

All presentation colors resolve through `theme.json` tokens (`nsh.json` `"theme": "theme.json"`).
Raw hex, `rgb()`, `hsl()`, and Tailwind palette utilities (`red-*`, `amber-*`, `green-*`, `zinc-*`)
are prohibited in TSX presentation code.

- **Radius scale (concentric):**
  - `--radius-lg`: `8px` — outer cards, floating dialogs, compact sheets.
  - `--radius`: `6px` — default controls, popovers, menus, tables (`rounded-(--radius)`).
  - `--radius-sm`: `4px` — inset segments and compact badges inside `p-1` (`8 - 4 = 4`).
- **Typography scale (minimum 12pt for reading, <= 3 sizes & 2 weights per region):**
  - `text-base` (16pt, `font-semibold`, `font-mono tabular-nums`): primary KPI figures.
  - `text-sm` (14pt, `font-semibold` / `font-normal`): workspace title, dialog headings, empty-state titles.
  - `text-xs` (12pt, `font-medium` / `font-normal`): toolbar controls, tabs, dense table cells,
    axis labels, metadata (`text-muted-foreground`), and monospace identifiers (`font-mono tabular-nums`).
  - Zero sub-12pt literal sizes (`text-[10px]`, `text-[11px]` are forbidden).
- **Spacing grammar (4pt steps, Shared content spines):**
  - `gap-1` (4pt): parts of one control or title/subtitle pair.
  - `gap-1.5` / `gap-2` (6–8pt): related toolbar controls and compact rows.
  - `gap-3` (12pt): content groups inside a panel (`p-3` shared panel inset; scrollbars stay on
    the `Scroll` outer edge with `p-3` inside the scroll child).
- **Semantic status & chart tokens (light & dark balanced):**
  - `positive` / `positive-foreground`: verified `[LIVE]`, healthy R2 sinks, positive signal edge.
  - `warning` / `warning-foreground`: `[STALE]`, `[DATA-STALE]` (`#78`), degraded Kalshi, `503` auth notice.
  - `negative` / `negative-foreground` & `destructive`: negative signal edge and hard endpoint errors.
  - `chart-1` .. `chart-5`: exposure plot bars and series.

## 4. Architecture, Root Component (`App.tsx`), `components/`, & `ui/` Layer

Following `https://nsh.dev/docs/project-structure/#the-root-component`, the package enforces an
acyclic module graph (`App.tsx` → `components/` → `store.ts` / `ui/` → `nsh/base`):

- **Root component (`App.tsx`):** Single `mount(App)` entry point owning the outer safe-area shell,
  root `<ErrorBoundary>` (`RootErrorFallback` with `Reload workspace` reset), `createDeskStore()`,
  `keymap.bind` (`mod+r`, `mod+1`, `mod+2`, `mod+shift+l`, `mod+shift+c`, `mod+u`), desktop
  application menu binding, and `DeskWorkspace` panel dispatch.
- **Feature panels (`components/`):** `DeskHeader`, `SignalsPanel`, `ExposurePanel`,
  `ScoreboardPanel`, `KpisPanel`, `DiagnosticsPanel`, and `provenance.ts`. Feature modules
  (`App.tsx`, `components/*`, `store.ts`) import **only** `nsh` primitives (`View`, `Text`,
  `Scroll`, `ErrorBoundary`, `Storage`, `Clipboard`) and `./ui` components — never `nsh/base`
  directly and never `../App`:

- `ui/tokens.ts` — `ControlSize` (`xs` | `sm` | `md`), motion token classes, `animateUserLayoutChange()`.
- `ui/Button.tsx` — `DeskButton` (`default`, `primary`, `outline`, `ghost`, `danger`) & `DeskIconButton`.
- `ui/Switch.tsx` — `DeskSwitch` (`Switch` with styled track, sliding thumb, focus ring, touch slop).
- `ui/SegmentedTabs.tsx` — `SegmentedTabs` (`Tabs` + `Tab` with native spring-sliding `indicatorClass`).
- `ui/Menu.tsx` — `DeskMenu`, `DeskMenuItem`, `DeskMenuSeparator` (shared popup surface & enter/exit classes).
- `ui/Dialog.tsx` — `DeskDialog` (themed modal surface with Escape/backdrop dismissal).
- `ui/Surface.tsx` — `Surface`, `Badge`, `SectionHeader`, `Separator`, `StateNotice`.
- `ui/DataView.tsx` — `DeskDataTable`, `DeskExposurePlot`, `DeskToolbar`, `DeskWorkspace`.
- `ui/UiKitGallery.tsx` — interactive gallery rendering every `ui/` component in every variant,
  size, and state in both Light and Dark appearances.

## 5. Motion Tokens & Screen Motion Inventory

### Motion Tokens

| Token     | Value / Class               | Curve             | Purpose                                                     |
| --------- | --------------------------- | ----------------- | ----------------------------------------------------------- |
| `instant` | `100ms` (`duration-100`)    | `ease-out`        | Pointer hover washes and border emphasis                    |
| `fast`    | `150ms` (`duration-150`)    | `ease-out`        | Button press scale (`0.97`), switch thumb/track, popup exit |
| `base`    | `200ms` (`duration-200`)    | `ease-in-out`     | Popup entrance, panel first-ready fade, user layout change  |
| `spring`  | Native `Tabs` `spring_move` | Critically damped | Sliding segmented selection indicator                       |

### Motion Inventory (`ops.sportsdesk.desk`)

| #   | State Change Kind              | Concrete Screen Element                                                                 | Tool & Motion Tokens                                                                                                                                                                                                                         | `reduceMotion` Behavior                                                                         |
| --- | ------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Press & hover on controls      | `DeskButton`, `DeskMenu` trigger, `DockArea` tabs                                       | `transition duration-100 ease-out` hover wash (`hover:bg-accent`); `active:scale-[0.97] duration-150` press settle                                                                                                                           | `motion-reduce:transition-none motion-reduce:active:scale-100` (instant state color only)       |
| 2   | Glyph or label changing        | `Auto 10s` `DeskSwitch`; `Refresh` ↔ `Refreshing…`; poll latency counter                | `DeskSwitch` thumb `transition-transform duration-150 checked:translate-x-3.5` + track `transition-colors duration-150`; `Refresh` dims via `disabled:opacity-50`; poll latency counter uses **no motion** (frequent numeric telemetry tick) | `motion-reduce:transition-none` snaps switch thumb at once                                      |
| 3   | Selection that moves           | Scoreboard league `SegmentedTabs` (`ALL`/`NFL`/`NBA`/`NHL`/`NCAA`), UI kit preview tabs | `nsh/base` `Tabs` single `indicatorClass` sliding natively via `spring_move`                                                                                                                                                                 | Native `Tabs` indicator jumps immediately when `reduceMotion` is on                             |
| 4   | Content arriving or leaving    | Panel initial `loading` → `ready` content; `DataTable` sorted cells                     | Panel ready container plays one component-owned `createMotion({ enter: "fadeIn", duration: 180 })`; `DataTable` cells use **no motion** (dense financial/sports rows must sort & recycle with zero lag)                                      | `createMotion` lands at rest immediately when `reduceMotion()` is true                          |
| 5   | Surface opening or closing     | `Workspace` `DeskMenu` popup; `UI kit…` `DeskDialog`; compact `DockArea` drawer/sheet   | `Menu` `popupStartingClass="opacity-0 scale-95 -translate-y-1"` & `popupEndingClass="opacity-0 scale-95 -translate-y-1"` with `transition duration-150 ease-out`; `Dialog` `animation` switches `"fade"` vs `"none"`                         | `motion-reduce:transition-none`; `Dialog` passes `animation={reduceMotion() ? "none" : "fade"}` |
| 6   | Layout changing by user action | `KPIs` dock toggle, `Pipeline` dock toggle, `Reset layout` command                      | `animateUserLayoutChange()` calls `LayoutAnimation.configureNext(LayoutAnimation.create(200, "easeInEaseOut", "opacity"))` prior to user state update (never on window resize)                                                               | `if (reduceMotion()) return;` skips `LayoutAnimation` so panes jump cleanly                     |
| 7   | Drag, swipe, or throw released | `DockArea` split handles, tab drag-and-drop, compact sheet swipe-down                   | Native `DockArea` 1:1 pointer tracking and sheet dismissal physics                                                                                                                                                                           | Native instant settle under system reduced motion                                               |
| 8   | Loading & progress             | Initial endpoint fetch vs subsequent manual/auto refresh                                | Initial load renders calm `StateNotice` (`loading`); subsequent refreshes keep live data mounted while `Refresh` disables (`Refreshing…`) — no skeleton flash                                                                                | Identical calm behavior (no continuous spinner animation)                                       |
| 9   | Live / continuous & sound      | Auto-poll 10s tick; audio feedback                                                      | **No continuous shader** and **no sound** — operator desk runs silently alongside live sports feeds; visual provenance badges carry state                                                                                                    | Fully legible at rest and silent                                                                |
