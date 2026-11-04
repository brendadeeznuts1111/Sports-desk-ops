# Remaining tasks — SportsDesk ops

Read it: `bun ./docs/REMAINING_TASKS.md` (zero-code ANSI renderer, no JS VM; honours `NO_COLOR`,
`FORCE_COLOR` and `COLUMNS`).

Artifact/gate: `bun run tasks:render` (ANSI; colour and OSC 8 links only on a TTY),
`--no-color --columns 0` for logs, `--format html --out scratch/remaining-tasks.html` for HTML,
`--format iframe` for an embeddable `<iframe srcdoc>` wrapper.

### Embedding

`srcdoc` is entity-decoded once by the HTML parser before its contents are parsed. Escaping only `"`
therefore turns the `&lt;img …&gt;` that `noHtml*` emitted back into live markup; escaping `&` first keeps
one decode level in place. The renderer escapes `&` then `"`, adds `sandbox` and a `title`, and a test
asserts that one decode restores the HTML exactly and that no `<img` survives.

`[OBSERVED]` 2026-10-31, local headless Chrome on a scratch page: the `"`-only form executed
`onerror` and retitled the parent document; the `&`-first form did not. The probe was not committed.

### Docs pipeline

`bun run docs:render` renders every `docs/**/*.md` to a content-addressed cache and writes
`manifest.json`; `bun run docs:serve` serves that cache with zstd negotiation. The manifest `buildId`
is a hash of the entries, so an unchanged tree rebuilds byte-identically and a changed tree gets a
new id.

`Bun.zstdCompress` returns `Promise<Buffer>`, and `Bun.write(path, promise)` stores the string
`[object Promise]`: the write succeeds, `.byteLength` is `undefined`, and the `.zst` only fails later
with `ERR_ZSTD`. The builder uses `Bun.zstdCompressSync` and writes through a temp file plus rename,
so a crash cannot leave a truncated entry that the next run trusts.

### Renderer parity

The JS API and the `bun ./file.md` loader are both documented as Rust-based. The CLI adds global table
widths and `COLUMNS` detection, not a different parser core; still diff both after a Bun upgrade before
snapshotting either output.

`Bun.markdown.ansi()` takes an `AnsiTheme` only — `tagFilter`/`headings` belong to `html()`. The 1.4.3
guide says it enables `wikiLinks`, `underline` and `latexMath` by default; measured on 1.4.4, `ansi()`
leaves wiki brackets, double underscores and dollar math literal, and only `html({ wikiLinks: true })`
changes output to an `x-wikilink` element. `underline` and `latexMath` had no effect on these inputs
either way. This doc still avoids all three (test-enforced) so the artifact cannot opt into a link the
terminal view does not render. Per-task colouring requires `render()`, where `listItem.checked` is `undefined` for a plain
bullet, `false` for `- [ ]`, and `true` for `- [x]`.

`tagFilter` is a GFM compatibility filter, not a sanitizer: it escapes a specific tag list but leaves
event-handler attributes alone. The HTML artifact therefore also sets `noHtmlBlocks`/`noHtmlSpans`;
untrusted Markdown would still need a real sanitizer at the boundary.

Those four claims are resolved against Bun records, not memory:

- `doc:runtime/markdown` — the Markdown guide (Options table, callback metas, heading IDs).
- `api:Bun.markdown.html` — `html(input, options?: Options): string`.
- `api:Bun.markdown.ansi` — `ansi(input, theme?: AnsiTheme): string` (no `Options` parameter).
- `api:Bun.markdown.render` — `render(input, callbacks?, options?): string`.
- `api:Bun.markdown.Options` — `headings?: boolean | { autolink: boolean; ids: boolean }` (both fields
  required by the type; the guide's `{ ids: true }` example is partial) and `tagFilter?: boolean`
  described as the GFM tag filter for disallowed tags.
- `api:Bun.markdown.ListItemMeta` — the `listItem` meta, including `checked?`.

Record version: `bun-types` v1.4.3, resolved through the `bun-dev` MCP server. Record ids are cited in
the references table below and are the strings to re-resolve after a Bun upgrade.

Meta task list. Every item carries a **basis** (`[CODE]`, `[OBSERVED]`, `[UNVERIFIED]`, `[ASSUMPTION]`),
a **done when** condition you can check against an artifact, and the **blocked by** dependency.

| Label          | Meaning                                          | Can close a task?       |
| :------------- | :----------------------------------------------- | :---------------------- |
| `[CODE]`       | Reproducible from this repository                | Yes                     |
| `[OBSERVED]`   | A capture/artifact with a date and path          | Yes                     |
| `[UNVERIFIED]` | External-system behaviour inferred, not captured | No — needs a capture    |
| `[ASSUMPTION]` | A modelling choice about data                    | No — needs confirmation |

### Reference IDs

Each task carries a stable `Ref:` id. The id does not change when tasks are renumbered or reordered;
the table resolves it to the record that justifies the basis and to the artifact that closes it. A ref
id that appears on a task but not in this table is a defect, and a test enforces it.

| Ref                    | Task     | Basis record                              | Closes against    |
| :--------------------- | :------- | :---------------------------------------- | :---------------- |
| `RT-F402-CAPTURE`      | P0.1     | `[OBSERVED]` captures/2026-11-01/         | ledger row        |
| `RT-PREFEE-PNL`        | P0.2     | `[UNVERIFIED]` third-party toolkit        | one wallet        |
| `RT-AUTH-BACKEND-DIFF` | P0.3     | `[OBSERVED]` captures/2026-11-01/run.json | CDP vs WebKit     |
| `RT-GSLIVE-LINKS`      | P1.6     | `[OBSERVED]` three GSLive surfaces        | three captures    |
| `RT-ARTIFACT-CADENCE`  | P2.3     | `[CODE]` package.json:76                  | cadence + check   |
| `RT-RENDER-HTML`       | Renderer | `[OBSERVED]` MCP api:Bun.markdown.html    | HTML artifact     |
| `RT-RENDER-ANSI`       | Renderer | `[OBSERVED]` MCP api:Bun.markdown.ansi    | CLI/JS diff       |
| `RT-RENDER-LISTITEM`   | Renderer | `[OBSERVED]` MCP api:Bun.markdown.render  | checked semantics |
| `RT-RENDER-SECURITY`   | Renderer | `[OBSERVED]` MCP api:Bun.markdown.Options | tagFilter tests   |
| `RT-DOCS-MANIFEST`     | Pipeline | `[CODE]` lib/docs_render_cache.ts         | stable buildId    |
| `RT-DOCS-SERVE`        | Pipeline | `[CODE]` lib/docs_server.ts               | q-value + range   |

Full paths and line numbers stay on each task's **Basis** line; this table is the ref-to-record index,
so an id resolves without guessing which artifact it came from.

## P0 — trust blockers

- [ ] **P0.1 Capture the seven F402 customer-report operations by per-prefix group (`[Manager]`, `[Report]`, `[unknown]`)**
  - **Ref:** `RT-F402-CAPTURE`
  - **Basis:** `[OBSERVED]` `docs/evidence/captures/2026-11-01/` (3 promoted 200s + `run.json` TLSv1.3 provenance);
    `[CODE]` PII-safe form-key contract in `docs/evidence/captures/schema/` (parameter names only, no parameter
    values recorded); `[OBSERVED]` client JS inspection of cached `customer/report/report.js` (`offset 8578`,
    `offset 25633`, `offset 33171`, `offset 108955`) and diagnostic/disposition artifact in
    `docs/evidence/captures/pending-500s/diagnostics.json`.
  - **Per-prefix groups (`[Manager]`, `[Report]`, `[unknown]` — replacing the single-prefix "seven F402 report endpoints" phrasing):**
    - **`[Manager]` (`getTransactions` — `[A-empty]` + cross-prefix routing):** `POST /cloud/api/Manager/getTransactions`
      returned **200 `{"LIST":""}`** (11 B, promoted in `docs/evidence/captures/2026-11-01/getTransactions.post.json`),
      whereas `/cloud/api/Report/getTransactions` returned **500 (0 B)** without `date` and **200 `{"LIST":[]}`** only when
      `date=MM/DD/YYYY` for a settled day is supplied. Both empty shapes (`""` and `[]`) are handled by
      `parseF402ListEnvelope()` in `lib/blob_ingest.ts`.
    - **`[Report]` (`getGrading` and `Pending` — `[A-empty]` and substantive `[A]`):**
      - `Pending` (`[A]`, prefix-divergent from `Manager/getPending`): `POST /cloud/api/Report/Pending` with a real downline
        player id returned **200 with 41–46 KB** on `2026-11-01` (73-field `Pending[]` leg objects, promoted to `[A]` in
        `docs/evidence/captures/2026-11-01/Pending.post.json`), whereas `POST /cloud/api/Manager/getPending` last returned
        **500 (0 B)** on `2026-10-31`. The two prefixes are distinct handlers, not aliases: use `/cloud/api/Report/Pending`
        and retire `/cloud/api/Manager/getPending` after one identical-payload re-probe.
      - `getGrading` (`[A-empty]` + polymorphic `LIST` schema): `POST /cloud/api/Report/getGrading` returned
        **200 `{"LIST":""}`** (11 B, promoted to `[A]` in `docs/evidence/captures/2026-11-01/getGrading.post.json`) on
        `/cloud/api/Report` and **500 (0 B)** on `/cloud/api/Manager` on `2026-11-01`. The empty envelope is a JSON string
        (`""`), not `[]` or `null`; `parseF402ListEnvelope()` in `lib/blob_ingest.ts` enforces this polymorphic contract
        (`"" | null -> []`, `Array -> rows`, anything else throws).
    - **`[unknown]` (`getDailyFiguresByCustomer`, `getGradedWagerByCustomer`, `getTicketDetailPrint` — the three 500-on-both):**
      Both `/cloud/api/Manager` and `/cloud/api/Report` returned **500 (0 B)** on the initial `2026-11-01` default-envelope
      probe (staged in `docs/evidence/captures/pending-500s/diagnostics.json`). Because both prefixes failed identically with
      zero bytes, prefix routing and 4xx parameter validation were ruled out — the shared handler threw before response
      serialization. Client JS (`customer/report/report.js:25633`) subsequently revealed that `getDailyFiguresByCustomer` is
      the sole operation sending `contentType: "application/json"` with `JSON.stringify` and an integer `week` index
      (`0..ShowHowManyWeeks`), resolving `getDailyFiguresByCustomer` to **200** with real figure data (verified against
      customers CLL118, NNC128); `getGradedWagerByCustomer` and `getTicketDetailPrint` remain `[unknown]` (500-on-both)
      pending valid `week` / `ticketNumber`+`wagerNumber`+`flag` captures.
    - **`[client-js-read-only]` (`PendingDelete` — resolved in `customer/report/report.js:8578`):** Client JS inspection
      (`setDeleteWager` at `offset 42092` -> `getPendingWagers` with `deleteWagers: true` at `offset 8578`) confirms
      `PendingDelete` sends `{ customerID, ticketNumber, operation: "PendingDelete" }`, logs `"View Pending Plays Selected"`,
      and renders `e.Pending[]` inside the `"Ticket Detail"` modal for a previously bought-out ticket. Probe strategy:
      send sentinel `ticketNumber=-1` first to confirm read-style wire behaviour, then capture with a valid ticket number.
  - **26 unprobed Tier-C dispositions (`[CODE]`):** Every one of the 26 unprobed Tier-C operations in `docs/evidence/ledger.json`
    now carries an explicit disposition (`14 probe`, `12 defer` with safety/priority reason) in
    `docs/evidence/captures/pending-500s/diagnostics.json` (`unprobedTierCDispositions`).
  - **Parameter-name contract (`[CODE]`):** In-page WebKit XHR/fetch sniffing recorded all six `/cloud/api/Manager/*`
    form-key signatures (`["RRO", "agentID", "agentOwner", "customerID", "operation"]`) and `/cloud/api/Report/*`
    form-key signatures without CDP and with **no parameter values recorded** (PII-safe, committed under
    `docs/evidence/captures/schema/`).
  - **Runtime & TLS sidecars:** The `1152x720` WebP viewport proof (`Bun.Image` on WebKit, 1,536 B, sha256
    `3f302482ed919d3da6a0a6293d297660774b03a8ea3571201dfd8b8edf0959da`) lives under
    `docs/evidence/captures/runtime/bun-image/`, and `docs/evidence/captures/2026-11-01/run.json` records the live
    `TLSv1.3` (`TLS_AES_128_GCM_SHA256`, 73 ms, Google Trust Services WE1) handshake beside the promoted captures.
  - **Done when:** (1) one upstream server error log line is retrieved for the `[unknown]` 500-on-both handler group,
    (2) the six dated 500s (`3` from `2026-11-01` and `3` from `2026-10-31`) are re-probed with their identical captured
    payloads to separate deterministic crashes from transient failures, (3) `getDailyFiguresByCustomer` is promoted with
    `application/json` per `report.js:25633`, and (4) `PendingDelete` is probed with sentinel `ticketNumber=-1` and
    promoted or retired.
  - **Blocked by:** upstream server error log access for the `500 (0 B)` handler crashes and a live session to execute
    the identical-payload re-probes and sentinel `PendingDelete` probe.
  - **Probe support (2026-11-01):** `capture:f402` accepts `--week <value>` (default `0`, the portal's integer
    week offset 0..ShowHowManyWeeks), `--ticket <n>`, `--wager <n>`, `--flag <s>` and `--body` overrides. Per
    `customer/report/report.js`, `week` is an integer (not a date) and `getTicketDetailPrint` sends
    `ticketNumber`, `wagerNumber`, `flag`. `lib/blob_ingest.ts` enforces `parseF402ListEnvelope()` for
    `LIST: ""` vs `LIST: []`.

- [ ] **P0.2 Verify the pre-fee PnL claim**
  - **Ref:** `RT-PREFEE-PNL`
  - **Basis:** `[UNVERIFIED]` — inferred from a third-party toolkit and the `usdcSize − size × price` residual.
  - **Done when:** on one taker-heavy wallet, the residual reconciles to the gap between the official PnL and a
    cashflow replay, with the capture path recorded.
  - **Blocked by:** activity rows that carry `size` and `price` for every fill.

- [ ] **P0.3 Verify the backend-difference resolution (WebKit in-page vs CDP) for the Authorization-header discrepancy**
  - **Ref:** `RT-AUTH-BACKEND-DIFF`
  - **Basis:** `[OBSERVED]` 2026-10-28 HAR recorded no `Authorization` header (`auth: "cookie"`), 2026-10-31 live
    captures recorded `authorization: "<redacted>"`, and 2026-11-01 WebKit probes (`docs/evidence/captures/2026-11-01/run.json`)
    recorded `backend: "webkit"`, `authMode: "env-login"`, `headersObserved: false`.
  - **Likely resolution (backend-difference hypothesis — WebKit in-page vs CDP):** Both prior observations were truthful
    views of different capture backends rather than an upstream auth change. Under `env-login`, WebKit in-page
    `fetch`/`XMLHttpRequest` sniffing (`--sniff-requests`) observes form keys in page context without exposing wire
    headers (`headersObserved: false`), whereas CDP-backed captures (`Network.requestWillBeSent` on `--backend chrome`)
    intercept at the browser network stack and surface the outbound `Authorization: Bearer <redacted>` header attached
    from `sessionStorage.credentials.code`.
  - **Done when:** CDP re-capture (`--backend chrome`) of one confirmed 200 (`getTransactions` on `/cloud/api/Manager`,
    or `getGrading` / `Pending` on `/cloud/api/Report`) is diffed against the WebKit `run.json` + probe record,
    confirming CDP surfaces the redacted `Authorization` header while WebKit records `authMode: "env-login"` with
    `headersObserved: false`.
  - **Blocked by:** a local Chrome/Chromium binary (`BUN_CHROME_PATH`) to execute the single-op CDP re-capture.

- [ ] **P0.4 Restore the gslive_report_columns `labelsFor` export (typecheck red on main)**
  - **Ref:** `RT-GSLIVE-TYPECHECK`
  - **Owner:** gslive workstream (@bw496915-cmyk)
  - **Issue:** [#14](https://github.com/bw496915-cmyk/Sports-desk-ops/issues/14)
  - **Basis:** `[OBSERVED]` 2026-11-03, clean `origin/main` worktree, `bun run typecheck`:
    `tests/gslive_report_columns.test.ts(4,3): error TS2305: Module '"../lib/gslive_report_columns.ts"'
has no exported member 'labelsFor'` (753 files, that single error); introduced by `a102219`.
  - **Fix:** re-export `labelsFor` from `lib/gslive_report_columns.ts`, or update the test import to the
    replacement API.
  - **Exit:** `bun run typecheck` green on `main`; the client/seam change merges only after this closes.

## P1 — coverage and data quality

- [ ] **P1.6 Capture GSLive deep-link behaviour**
  - **Ref:** `RT-GSLIVE-LINKS`
  - **Basis:** `[OBSERVED]` the three surfaces exist; `[UNVERIFIED]` window/bot parameters beyond the captured
    examples.
  - **Done when:** each surface has one capture-backed example and the docs say `[OBSERVED]`.
  - **Blocked by:** a GSLive session.

## P2 — hygiene

- [ ] **P2.3 Schedule artifact regeneration**
  - **Ref:** `RT-ARTIFACT-CADENCE`
  - **Basis:** `[CODE]` `docs/combo-uniqueness.json` and `docs/cross-domain-bridge.json` only change when
    `artifacts:value` is run manually. `[CODE]` `--offline` now reproduces the combo half from the cached
    CFB event index, but the bridge half still needs `scratch/bridge-live-all.json` or the demo book, so a
    clean CI checkout cannot regenerate either artifact.
  - **Done when:** a documented cadence (or cron job) regenerates and deploys them, with a freshness check.
  - **Cadence in place:** the daily `schedule:` run in `.github/workflows/ci.yml` re-checks
    `artifacts:lock` and `audit:ops`, so drift surfaces within a day even when nothing is pushed.
    `bun run artifacts:cron` is the host that can actually rebuild: an in-process `Bun.cron` job runs
    `artifacts:value` (`--offline` by default) then refreshes the lock, and journals each run to
    `scratch/artifacts-cron.jsonl` (`--history` reads it with `Bun.JSONL`). Deployment stays manual.
  - **Guard:** `bun run artifacts:lock` fails when an artifact or one of its generator inputs changed
    since `docs/artifacts.lock.json` was written. It proves nothing changed since the lock, not that the
    lock was taken right after a regeneration — so pair `artifacts:value` with `artifacts:lock --update`.
  - **Blocked by:** regeneration itself needs live inputs (the Gamma fetch and the bridge capture), which a
    clean CI checkout does not have; the schedule can detect drift but not rebuild.

## Done (for context)

- [x] `[CODE]` Untracked `gs-manager-cli.zip` deleted (`P2.1`, `RT-CLI-ZIP`): its extracted contents remain in
      `scratch/docs-audit/gs-manager-cli/` for local audit reference, and `bun run audit:archives` passes with zero warnings.
- [x] `[OBSERVED]` Channel model: 955 live `getBetTicker` rows carry `TicketWriter` = Internet, ALERT,
      GSLIVE, GSBUILDER, plus one dirty `WILBANKS.` value that is an agent login. `GATEWAY`, `BLOCKED` and
      `CSLEVEL2` never appear, so the lane table describes configuration, not observed traffic.
- [x] `[OBSERVED]` Wager numbers: 0 duplicates across 955 live rows; the 48 collisions are confined to
      the demo generator, and the audit keeps warning on fixtures rather than on live data.
- [x] `[OBSERVED]` Manager auth is `Authorization: Bearer <sessionStorage.credentials.code>`; without it
      openresty answers 401. The `fantasy402Cookie` security scheme now says so.
- [x] `[CODE]` Claim labels and citation tests (`[CODE]` / `[OBSERVED]` / `[UNVERIFIED]` / `[ASSUMPTION]`).
- [x] `[CODE]` Seven F402 customer-report operations published as tier-C candidates (split by route prefix in P0.1:
      `[Manager]` for `getTransactions`, `[Report]` for `getGrading` and `Pending`, `[unknown]` for the three 500-on-both).
- [x] `[CODE]` TypeScript pinned to 5.9.3 for `bunx tsc`.
- [x] `[CODE]` Stale docs tags are registered as superseded and non-deployable: `docs/releases.json`,
      enforced by `bun run audit:release`.
- [x] `[CODE]` Capture manifest splits response accounting: `withSuccessResponse`, `withErrorResponse`,
      `emptyResponse` beside the legacy `withResponse`; validity invariants enforced on read.
- [x] `[CODE]` `coverage.attributionLinkRows` and `attributionLinks` separate link counts from `wallets`;
      `attributionTypes` kept as a deprecated alias.
- [x] `[CODE]` `reports/docs-review/PLAN-full-coverage.md` reconciled in place: stale `append_tracked_domains.mjs`
      references annotated, disproved deploy-target claim closed, status block added.
- [x] `[CODE]` Backtest engine runs in CI from a committed synthetic fixture
      (`tests/fixtures/backtest/`); file-independent sections are pinned against
      `docs/backtest-4wk-cfb-nba.json`.
- [x] `[OBSERVED]` `docs-v2026.11.01` tagged and deployed; 47-path spec live.
