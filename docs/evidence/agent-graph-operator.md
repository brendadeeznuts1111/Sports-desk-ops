# Agent graph — hierarchy + weekly metrics (operator + agents)

**Primary sources:** [manager-boot-hierarchy.md](./manager-boot-hierarchy.md) · [manager-boot-primary-sources.md](./manager-boot-primary-sources.md)

---

### ⚠️ SECURITY WARNING

If a **live Bearer JWT** or session cookie was pasted into chat or a file:

1. **Revoke it now** — log out of the manager portal (or force session expiration). An unexpired JWT still grants full API access.
2. **Do not paste it again** — not in commits, fixtures, HAR without redaction, or agent prompts.
3. **Do not hardcode tokens in TypeScript** — use `createF402ReplayTransport()` from `lib/f402_replay_transport.ts` (WebView `F402_WEBVIEW_PROFILE`, `F402_SESSION_FILE`, or `F402_REPLAY_PROXY_URL`).

Agents: read `F402_AGENT_SECURITY_WARNING_MARKDOWN` in `lib/f402_agent_policy.ts` before any live fetch.

---

### The two halves of the graph

| Half | Wire operation | Role |
|------|----------------|------|
| **Nodes + edges** | `getListAgenstByAgent` | `GENERAL` tree → SQLite `agents` (`parent_id`, levels 1–12) |
| **Root metrics (optional)** | `getWeeklyFigureByAgentLite` | Weekly figure payload for the master/root node |

Form body (matches pinned `manager.js` + HAR):

`agentID`, `agentType`, `operation=getListAgenstByAgent`, `RRO`, optional `agentOwner` (often same as `agentID` for master).

**`getWeeklyFigureByAgentLite` response** (shape seen in a DevTools response on 2026-11-01; figures not
recorded here). Rendering rules are from pinned `verification/manager-boot-oracle/pinned/manager.js:2276-2318`:

```json
{ "LIST": { "ARRAY": [{ "ThisWeek": 0.0, "Active": 0, "Today": 0.0 }], "INFO": "INFO" } }
```

| field | manager UI slot | rule |
|---|---|---|
| `Active` | `grand-total-player` (player count) | `-1` withholds all three slots |
| `ThisWeek` | `grand-total-weekly` | `null` shown as 0; unrounded float sum, shown without cents |
| `Today` | `grand-total-day` | `null` shown as 0 |
| `ARRAY` empty | — | nothing rendered |

`parseWeeklyFigureLite` (`lib/f402_weekly_figure_lite.ts`) turns this into `figures` / `withheld` /
`empty` and rejects anything else. `bun run graph:agent -- --live --account <fixture> --weekly` requests
it for the account fixture's `agentID` and stores `{ agentId, figure, fetchedAt }` as top-level `weekly`
in `agent-graph.json`, not on a node: the logged-in account (e.g. `BILLY666`) sits above every GENERAL
root and is not in the tree. `/views` shows it; `/agent/<id>` shows it only when `id` is that agent. The repo's
`.env` points `F402_BASE_URL` at `https://fantasy402.com`; the browser calls `www.fantasy402.com`.

---

### Safe execution in Bun

**Offline (no session):** envelope JSON already captured and redacted:

```bash
bun run manager:ingest-hierarchy   # defaults to scratch/raw-f402-list-agents.json
bun run graph:agent                # same default envelope; skips if manifest matches ( --force to rebuild)
bun run graph:agent:image          # skips if webp matches manifest envelope sha256
```

**Live (session transport — no token in env vars you paste to agents):**

```bash
bun run capture:f402-har -- --login --profile scratch/f402-manager-webview-profile
F402_WEBVIEW_PROFILE=scratch/f402-manager-webview-profile \
  bun run graph:agent -- --live --account tests/fixtures/f402-get-account-info-owner-fixture.json
```

Implementation: `scripts/build_agent_graph.ts` → `lib/f402_agent_graph.ts` (typed `F402ReplayTransport`, not `any`).

---

### Why ingest beats staring at raw JSON

1. **`PLAYERS` dropped** — ingesters read `GENERAL` only; do not load thousands of player rows (PII) into memory for graphing.
2. **Overflow visible** — levels 13–19 surface in `skippedOverflow`, not silent loss.
3. **Parser parity** — pinned portal quirks (`p[t]` vs `p[t][a]`) land in SQLite `parent_id` via the same path as oracle gates.

Export: Cytoscape-style `{ nodes, edges }` in `scratch/agent-graph.json` (or `--out`).

**View:**

```bash
bun run graph:agent:view      # http://127.0.0.1:9876/ — SVG dashboard + cached WebP img
curl -sI http://127.0.0.1:9876/graph.webp   # serves scratch/agent-graph.webp only (no WebView per request)
```

**WebView → Bun.Image → WebP (offline capture CLI):**

```bash
bun run graph:agent -- --envelope tests/fixtures/f402-list-agents-by-agent-snippet.json
bun run graph:agent:image     # headless /capture.html, waits for __AGENT_GRAPH_READY__, writes scratch/agent-graph.webp
bun run graph:agent:image -- --force   # re-encode when JSON changed
```

Pipeline: `Bun.WebView.screenshot()` → `Blob` → `new Bun.Image(blob).resize().webp()`. The server **never** spawns a browser per HTTP request; refresh WebP via `graph:agent:image` when `agent-graph.json` mtime is newer.

Supervised capture (avoid zombie Chrome): `bun --no-orphans run graph:agent:image`

Env: `F402_GRAPH_WEBVIEW_BACKEND=chrome|webkit`, `F402_GRAPH_VIEWPORT_W/H`, `F402_GRAPH_WEBP_QUALITY`.

**Readable views (Graphviz small multiples, needs `dot` on PATH):**

```bash
bun run graph:agent                 # 1. envelope → SQLite / JSON / manifest
bun run graph:agent:views           # 2. 24 per-branch views (SVG + WebP), index.json, structural.json
bun run graph:agent:image           # 3. capture — uses the budgeted overview only when views are fresh
bun run graph:agent:views -- --budget 90 --rankdir LR --force   # tune view size / direction
bun run graph:agent:readability     # baseline + engine benchmark + sweep → scratch/agent-graph-readability.json
bun run graph:agent:judge -- --questions               # judge sheet; --score answers.json --label X to grade
```

Viewer routes: `/views` (index), `/views/<file>`, `/agent/<id>` (upline, children, portal-parent
disagreement), `/interactive` (ELK). All 503 `no-store` when views do not match the envelope SHA.
Views use envelope nesting; SQLite `parent_id` keeps the portal parser's parents (319 differ) —
see [agent-graph-readability.md](agent-graph-readability.md).

---

### ⚠️ SECURITY WARNING (AGAIN)

Before sharing `scratch/agent-graph.json`, HAR, or probe logs externally: run redaction gates (`verify:manager-har-redaction-proof`, sentinel sweep). Never attach live session material to PRs or agent transcripts.
