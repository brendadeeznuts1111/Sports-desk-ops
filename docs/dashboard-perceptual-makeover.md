# Dashboard perceptual makeover

Applies four rules to the Sports-desk-ops dashboard charts: aligned-baseline position encodings
(Cleveland & McGill), separate panels for extensive and intensive quantities with boundary days
kept out of trend fits (Tukey / SPC), data-ink and one semantic accent (Tufte, WCAG, CIEDE2000),
and fail-closed staging with conservation oracles.

The rules live in one pure, browser-safe module, `packages/ui/src/viz/perceptual.ts`, tested by
`tests/dashboard_perceptual_viz.test.tsx`. Chart primitives are in `packages/ui/src/viz/charts.tsx`.

## Before: inventory of every rendered visual encoding

| #   | Surface                                                                 | Chart                | Metric                                                                 | Encoding                                                                   | Problems                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Shadow pricing, `shadow_pricing/ShadowElasticityChart.tsx`              | 3-line SVG           | Net desk savings, sharp savings, retail net impact (USD) vs elasticity | Position on one USD axis; 3 hues + emerald marker + red breakeven (5 hues) | No legend and no labels, so the lines could not be told apart; y-axis end labels were padded values (+10%), not data; heavy dashed zero line; every series competed for attention                                                                  |
| 2   | Customers, `panels/CustomersTabPanel.tsx` "Decomposed Sharpness Radars" | 5 progress bars      | Score components (CLV, skill, sizing, signature, timing)               | Bar length as % of each component's own cap                                | Five different scales: 1.2/1.5 drew longer than 2.0/3.0, so lengths could not be compared; 5 hues with no meaning; unsorted; the "Sum" next to the bars disagreed with the profile score with no warning (RF2003: 3.4 vs 3.8; SQUARE1: 0.7 vs 1.2) |
| 3   | Surveillance, `panels/SurveillanceTabPanel.tsx` DNS cache               | Inline meter         | LRU slots used %                                                       | Bar length                                                                 | Drawn at a 4% minimum, so an empty cache looked occupied; hard-coded hex colours                                                                                                                                                                   |
| 4   | `static/telegram-miniapp-dashboard.html` agent and market rows          | Row bars             | Pending wagered per agent / sub-sport                                  | Bar length relative to the largest row                                     | Drawn at a 3% minimum, so a $0 row looked non-zero                                                                                                                                                                                                 |
| 5   | Slice metrics, `SliceMetricsViews.tsx`                                  | Table only, no chart | Handle (USD) and hold % per slice                                      | Text, red/green per cell                                                   | Extensive handle and intensive hold % sat side by side in one table; there was no aligned comparison across slices                                                                                                                                 |

Counts: 1 multi-line chart, 3 bar or meter encodings, 1 table with no chart. Problems found:
3 non-zero or non-common baselines (#2, #3, #4), 2 multi-hue encodings with no legend or labels
(#1, #2), 1 silent conservation break (#2), 1 padded-axis misread (#1), and 1 extensive/intensive
mix (#5). There were no pies, donuts, bubbles, dual y-axes or daily trend charts anywhere.

`lib/dashboard_*.ts`, `lib/tracker_dashboard.ts`, `scripts/market_edge_dashboard.ts`,
`static/customer-churn-simulation-dashboard.html` and `dashboard.md` render text, tables or KPI
cards only. They have no chart encodings, so nothing there changed.

## After: what changed, rule by rule

### 1. Position on a common aligned baseline

- **Slice small multiples** (new, `viz/SliceSmallMultiples.tsx`, shown above the SliceMetrics
  table): slices are sorted by handle and drawn as zero-anchored horizontal bars. A dot plot of
  hold % uses the same row order, so each slice reads straight across.
- **Sharpness decomposition** (`viz/SharpnessDecomposition.tsx`): every component sits on one
  0-based points scale, sorted, with a tick at each cap and labels such as `1.50 / 1.5`.
- **Meters** (#3, #4): the minimum widths are gone, so length is honest at zero.

### 2. Separate regimes; extensive vs intensive

- Handle (USD, extensive) and hold % (intensive) are two panels with two axes. They are never
  drawn on one axis.
- `classifyDayRegime` sorts each day into one of three regimes. `partial` is the current day or
  later, with "today" taken in the desk time zone through `dayKeyInZone`. `settlement` is a
  configured settlement weekday, Tuesday by default. Every other day is `steady`.
- `steadyStateTrend` fits OLS on steady days only. It returns every point with its regime, so a
  chart can draw partial days hollow and settlement days flagged, and those days never move the
  fit. Steady points are checked with XmR limits on the detrended residuals.
- No dashboard panel plots a daily series today, so these functions are tested but not wired to
  a chart. See "Needs a decision" below.

### 3. Data-ink, one accent, direct labels

- No legends and no gridlines. A 1px `--sd-border-strong` zero baseline is the only reference
  line, and every series or bar carries its own label.
- Context marks use one grey: `color-mix(in srgb, var(--sd-border-strong) 60%, var(--sd-surface-card))`.
- One accent, `--sd-tier-steam`, is reserved for actionable items:
  - Slices: hold below the configured floor (`floor_delta_pct < 0`, the contract's
    `HOLD_BELOW_FLOOR`), or a cross-slice modified z-score above 3.5 (Iglewicz–Hoaglin).
  - Elasticity frontier: the breakeven point only.
  - DNS meter: 85% or more occupied.
- The elasticity frontier now draws net desk savings as the emphasized line and the other two
  series in grey, with direct end labels. Its y-axis is anchored at $0 over actual data extents,
  with no padding.
- Text never scales below 11px. SVGs render at their natural pixel width and scroll sideways
  instead of shrinking.

### 4. Fail-closed staging and conservation oracles

- `stageCentsSeries` is the dashboard's version of a QUERY / REGEXEXTRACT / VALUE staging tab:
  - Integer cents only, with currency text parsed by regex.
  - `NaN`, `Infinity`, sub-cent values, unsafe integers, double signs and duplicate keys throw a
    `StagingValueError` with a reason code.
  - Footer and total rows (`Total`, `Grand Total`, `subtotal`, `Σ`, …) are excluded and listed.
  - The input is never mutated, and the output is frozen.
- `verifyConservation` / `assertConservation` check that the staged total equals the control
  total to the cent. The slice panel checks staged slice handle against
  `blendedHoldSlo.total_handle_usd`.
- The sharpness chart checks its components against the profile score in hundredths of a point.
- On a mismatch, a panel renders `ChartFailClosed` (`role="alert"`) with the error and the delta,
  and draws no chart.
- `barScale` / `assertZeroBaseline` throw a `ZeroBaselineError` for any bar domain that leaves out
  0 or holds non-finite values.
- `spreadLabels` enforces a minimum label gap of font size + 2 px. It is used for the frontier's
  end labels and y-axis labels.

## Contrast (dark theme, background `--sd-surface-card` #0b1120)

| Pair                         | Current tokens (`--sd-border-strong` #7085a1) | After PR #195 (#7b8aa1) | Floor                                          |
| ---------------------------- | --------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Accent #f59e0b vs background | 8.77:1                                        | 8.77:1                  | 4.5:1                                          |
| Accent vs grey context       | 3.42:1 (#48576d)                              | 3.25:1 (#4e5a6d)        | 3:1                                            |
| Label #cbd5e1 vs background  | 12.68:1                                       | 12.68:1                 | 4.5:1                                          |
| Label vs grey context        | 4.95:1                                        | 4.70:1                  | 4.5:1                                          |
| Grey context vs background   | 2.56:1                                        | 2.70:1                  | 2.5:1 (context only; values carried by labels) |
| dE00 accent vs grey          | 52.68                                         | 50.61                   | 40                                             |
| dE00 accent vs background    | 69.46                                         | 69.46                   | 40                                             |
| dE00 grey vs background      | 22.21                                         | 23.15                   | 15                                             |

dE00 is computed from `Bun.color(hex, "lab")` in the test. The `deltaE2000` implementation is
checked against the Sharma, Wu & Dalal reference pairs.

No pair of existing tokens gets an amber accent and a grey that are both 3:1 against the
background and 3:1 against each other. Two proposed tokens would clear every pair at 3:1 or
better: `--sd-viz-context: #5b6b82` and `--sd-viz-accent: #fbbf24`, giving grey vs background
3.47, accent vs grey 3.25 and accent vs background 11.28. They are not added here because
`design/tokens.toml` is owned by PR #195.

## Screenshots

Captured with `Bun.WebView` (Chrome backend) through `scripts/webview_shot_cli.ts`, from
server-rendered fixture panels:

- `docs/assets/dashboard-makeover/before-elasticity.png` → `after-elasticity.png`
- `docs/assets/dashboard-makeover/before-slices.png` → `after-slices.png`
- `docs/assets/dashboard-makeover/before-customer-mismatch.png` → `after-customer-mismatch.png`
  (the silent 3.4 vs 3.8 sum becomes a visible conservation error)
- `docs/assets/dashboard-makeover/after-customer-ok.png` (a consistent profile on the common scale)

## Needs a decision

- **Hold % and LOC utilization trend source.** No dashboard panel receives a daily Hold % or LOC
  utilization series, so the regime and trend functions have no consumer yet. Name the source to
  wire a small-multiples trend panel.
- **Showcase data.** RF2003 (components 3.40, score 3.8) and SQUARE1 (components 0.70, score 1.2)
  now render the fail-closed state. Either the showcase scores or the component values need
  correcting.
- **Settlement weekday.** The default is Tuesday (`DEFAULT_SETTLEMENT_WEEKDAYS = [2]`). Confirm it,
  or say whether it should come from config.
