# Agent Tool-Call Friction — Audit and Smoothing (2026-11-04)

This repo is operated by agents, so the cost of a tool call is real. This runbook records what
actually fails, what is merely exploration, and what has been done about it. The numbers are
reproducible from the harness's own session traces — nothing here is a guess.

Reproduce:

```sh
bun run audit:tool-calls              # this project, last 48h, human report
bun run audit:tool-calls --json    # machine-readable JSON
bun run audit:tool-calls --since-hours 24 --max-files 40
bun run agent:doctor                  # environment gaps before a long gate run
```

## 1. Method and scope

- Source: DSH persists each session as `~/.dsh/sessions/--<project>--/<session>/session.v4.jsonl.zstd`.
  `scripts/audit_tool_calls.ts` decompresses them read-only, joins `tool/call` to `tool/result`,
  and aggregates failures.
- Default window: last 48 hours, up to 200 session files.
- Measured 2026-11-04: **41 sessions · 10,545 tool results · 97 tool errors (0.9%)**.
- A tool error is `isError: true` on the result — not a bash command with a non-zero exit code.
  The two are counted separately because most non-zero exits are healthy exploration
  (`grep` found nothing, a service is not running, a probe deliberately fails).

## 2. Findings

### 2.1 Failure rate by tool

| Tool                   | Calls | Errors |  Rate |
| :--------------------- | ----: | -----: | ----: |
| `bash`                 | 8,314 |      3 |  0.0% |
| `edit`                 |   607 |     64 | 10.5% |
| `read`                 |   583 |      3 |  0.5% |
| `write`                |   219 |      8 |  3.7% |
| `cordis_inspect_query` |    42 |      7 | 16.7% |
| `grep`                 |    21 |      2 |  9.5% |
| `web_fetch`            |    23 |      1 |  4.3% |
| everything else        |  ~730 |      9 |  1.2% |

`edit` is the outlier: **64 of 97 errors (66%)**, at a 10.5% call failure rate.

### 2.2 Error codes and messages

| Code                             | Count |
| :------------------------------- | ----: |
| `FsError/FS_STALE_VERSION`       |    36 |
| `FsError/FS_NOT_OBSERVED`        |    28 |
| no code (tool-specific failures) |    18 |
| `FsError/FS_EDIT_NOT_FOUND`      |     4 |
| `FsError/FS_NOT_FOUND`           |     3 |
| `SEARCH_RAW_OUTPUT_OVERFLOW`     |     2 |
| `ABORTED`                        |     2 |
| others (single occurrence)       |     4 |

Top normalized messages:

1. `cannot edit …: file changed since it was read — re-read the file, then retry` — 32 (33%).
2. `cannot modify …: file has not been read — read the file, then retry` — 28 (29%).
3. `Slots.listSubTree: Client inspect query timed out` — 5 (inspector/UI, not repo code).
4. `old_string was not found …` — 4.
5. `old_string and new_string must differ` — 2.

So **62% of all tool errors are the two filesystem observation guards**. They are working as
designed; the cost is a mandatory extra round trip whenever an edit races a write or arrives
before a read.

### 2.3 The other signals (not tool errors)

- **Bash non-zero exits: 128 of 8,314 (1.5%).** These are mostly expected: empty `grep`, a
  probe against a stopped service, a command used to test for absence. Do not “fix” them by
  hiding exit codes.
- **Sandbox/permission lines: 204.** Most are Chrome's crashpad/GPU errors under the DSH sandbox
  and writes outside the workspace (`~/.dsh`, `/bin/ps`, `crontab`). They are environment noise,
  not agent mistakes, but they are expensive when an agent retries the same blocked call.
- **Duplicate calls inside a session: 180 groups / 252 wasted calls (2.4%).** Mostly
  `list_agents` / `wait_agent` / `team_task_*` polling in Team runs, plus repeated gate commands.
- **Slowest wall-clock spans** are unreliable as a metric: DSH can suspend a turn across hours,
  so a call's timestamp span may include no work at all. Do not rank tools by it.

## 3. Root causes and the agent rules that avoid them

1. **A formatter or generator changed the file between read and edit.** `bun fmt`, `docs:stage`,
   `artifacts:value` and the feed poller all rewrite tracked files. Running one of them after a
   read invalidates the observation and the next `edit` returns `FS_STALE_VERSION`.
   - Read the file **immediately before** editing it.
   - Never run `bun fmt` on a file between its read and its edit.
   - After any formatter/generator, re-read before editing again.
2. **Editing an existing file without reading it.** `write` on a new file is fine; `edit` on an
   existing path requires a prior `read` in the same session. When a tool returns
   `FS_NOT_OBSERVED`, the file has not been observed **by this session**: read it, then retry.
3. **`old_string` is not a unique literal.** Whitespace, line endings and formatter reflow change
   it. Anchor on the smallest unique block; for repeated rows use `replace_all` deliberately, not
   to paper over an ambiguous match.
4. **Coordination polling.** `wait_agent` already returns on the next status/message change; a
   `list_agents` loop between waits is waste. Lead should wait, not poll.
5. **Environment gaps discovered one failure at a time.** `bun run agent:doctor` reports them in
   one call (see §4).
6. **Browser verification.** Stock Chrome cannot initialize its own sandbox inside DSH. Use
   `./bin/dx shot <url> --out scratch/shots/x.png` (WebKit backend, zero deps), or the Playwright
   headless shell with `--no-sandbox`; do not retry stock Chrome.
7. **Deploy credentials.** Pages deploy needs a Pages-scoped `CLOUDFLARE_API_TOKEN` +
   `CLOUDFLARE_ACCOUNT_ID` from `./cloudflare.env` or `$XDG_CONFIG_HOME/cloudflare/pages.env`.
   Never source `.env`: it is a 1Password FIFO and carries the R2/F402 secrets that would shadow
   the Pages token.

## 4. What this repo now provides

| Surface                                                      | What it removes                                                                                                                                                                                                                             |
| :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run agent:doctor`                                       | One report: Bun/worktree, `node_modules`, gitignored `enriched_customers_full.json`, feed/provenance, dist staging, graphviz, headless browser/CDP, port 4020 daemon, `~/.dsh` writability, Pages token. Each line carries the fix command. |
| `bun run audit:tool-calls`                                   | Reproducible version of this audit (48h default, `--json`, `--since-hours`, `--project`).                                                                                                                                                   |
| `bun run ci:local`                                           | Replays the CI chain in order (`--list`, `--keep-going`, `--install`); agents no longer need to assemble gates by hand and discover failures one at a time.                                                                                 |
| `scripts/graph_feed_poller_daemon.ts --no-backtest-artifact` | A live feed refresh no longer rewrites `docs/backtest-4wk-cfb-nba.json` with environment-dependent inputs.                                                                                                                                  |
| `AGENTS.md` “Agent friction quick reference”                 | The rules in §3 in the file every session loads.                                                                                                                                                                                            |

The two rankings tests that need the gitignored `enriched_customers_full.json` remain
environment-gated; `agent:doctor` prints the symlink command for a linked worktree instead of
letting the suite fail twice.

## 5. Upstream DSH recommendations (measured, not applied here)

These are harness changes, not repo changes. Each would remove a round trip without weakening a
guard. File references are to the DSH checkout.

1. **`FS_STALE_VERSION` should carry the rebase material.** Today the error only says
   “re-read the file, then retry”. Attaching a bounded current-content window with line numbers
   (and the current version) would let one retry rebase instead of read+edit.
   Path: `packages/fs/tool-fs/src/error.ts` (message construction) and the catch in
   `packages/fs/tool-fs/src/edit.ts`.
2. **`FS_NOT_OBSERVED` could return the content and record the observation.** The guard's purpose
   is that the model sees current content before mutating it. Returning that content in the error
   (and recording `fs/observed`) preserves the intent while collapsing read+edit into one retry.
   Path: `packages/fs/fs-observation-policy` + the same catch.
3. **`FS_EDIT_NOT_FOUND` should suggest the closest match.** A whitespace-normalized nearest block
   with line numbers turns a blind retry into a correct anchor.
   Path: `packages/fs/tool-str-replace-editor/src/index.ts`.
4. **Browser/CDP failures should name the working fallback.** The current text says Chrome is
   unavailable; the measured workaround (Playwright headless shell with `--no-sandbox`, or
   `./bin/dx shot`) is what actually succeeds in this environment.
5. **The inspector timeout should say “reconnect and retry” once.** 5 of 97 errors were
   `Slots.listSubTree` timeouts; the message already hints at the Harness page, but a single
   automatic retry after the page reconnects would remove the manual step.
