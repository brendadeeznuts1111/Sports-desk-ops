/**
 * Client half of the paper-only watchlist autobet bundle: the operator control plane.
 *
 * WHAT THIS IS
 *
 * A left-sidebar entry (`sidebar.panellist`, id "watchlist-autobet") plus the main-column
 * page it opens (`main`, keyed by the same id). The page is the human-in-the-loop control
 * plane for the watchlist autobet pipeline: its Queue tab (the default) shows the paper
 * ledger's intents, records operator approve/reject decisions, paper-fills approved intents
 * and settles paper fills; its Signals tab inspects the watchlist itself — the derived
 * signals with every closed gate check, so the operator can see why nothing is eligible.
 *
 * DATA (same-origin Host routes served by this bundle's index.js)
 *
 *   GET  /api/watchlist-autobet/board   the whole operator board (csrftoken included)
 *   GET  /api/watchlist-autobet/signals the watchlist inspector payload: counts, source
 *                                       freshness and per-signal gate verdicts
 *   POST /api/watchlist-autobet/action  one confirm-gated mutation; maps onto the CLI
 *
 * Every board has the frozen shape documented in
 * Scratch/watchlist-autobet/CONTROL-PLANE-CONTRACT.md: safety, config, source freshness,
 * ledger counts, intents (market label, provenance, accounts, gate checks), paper summary,
 * the current enqueue plan and the recent decision feed. Missing fields render as unknown,
 * never as an invented zero.
 *
 * SAFETY
 *
 * - PAPER ONLY. The page has no live-order action; `execute` is the paper adapter and the
 *   server hard-codes venue paper. There is no code path here that could place a live bet.
 * - Human in the loop. Approve and Reject are disabled until the operator types a name
 *   (persisted in localStorage "watchlist-autobet.operator"); every decision records it.
 * - Confirm-gated twice: every action first opens an inline form on the card, and the
 *   POST body always carries { confirm: true } next to the board's x-autobet-csrf header.
 *   Nothing mutates on mount, on a poll, or on a single click.
 * - CLI refusals are shown inline with `cli.error.code` + message; they are never swallowed.
 * - A failed refresh keeps the last good board and says how old it is ("stale since ...").
 *   It never renders "all good" from a failed fetch.
 *
 * RULES FOLLOWED
 *
 * - The factory is side-effect free: it builds components, hooks and the CSS string. The
 *   locale dictionaries and the two slot registrations are owned effects created in `apply`.
 * - Board loading is mount-scoped: fetch on mount, on Refresh, after every action, and every
 *   20 s while the document is visible (paused while hidden, immediate refresh on return).
 *   The in-flight board request is aborted on unmount and the timer/listener are cleared by
 *   the same effect cleanup. Actions are not aborted on unmount, because the server may have
 *   applied them already.
 * - Signals loading is activation-scoped: the first Signals-tab activation fetches, header
 *   Refresh refetches while the tab is active, and a successful enqueue refetches so the
 *   duplicate/cap gates stay honest. One AbortController per fetch; the in-flight request is
 *   aborted on unmount or when a forced refresh supersedes it, and nothing publishes after
 *   disposal. There is no signals poll timer.
 * - Visible copy goes through the Client locale service (ctx.locale.register plus the
 *   `locale:` registration option, which supplies `t`), with an English dictionary fallback.
 * - Chrome uses only host `--dsw-alias-*` tokens; the sidebar glyph uses `currentColor`, so
 *   the host owns its color in every theme. No literal colors, no page-root writes.
 * - React comes from the browser module table. No Harness Client package is imported and no
 *   DOM outside this page's own slot is read or written.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-watchlist-autobet",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this bundle (also the `locale:` registration option). */
    const NS = "watchlist-autobet";
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = "watchlist-autobet";

    /** Same-origin routes served by this bundle's Host half (index.js). */
    const BOARD_URL = "/api/watchlist-autobet/board";
    const ACTION_URL = "/api/watchlist-autobet/action";
    /** The signals inspector route; the Lead freezes its payload shape. */
    const SIGNALS_URL = "/api/watchlist-autobet/signals";
    /** The inspector always asks for refused signals too; "Show refused" filters locally. */
    const SIGNALS_LIMIT = 200;
    /**
     * The signals route spawns the CLI once per query (`timeoutMs` defaults to 60 s in the
     * Host half), so the client waits past that instead of aborting a request the server
     * may still answer with a structured refusal.
     */
    const SIGNALS_TIMEOUT_MS = 70_000;
    /** Account-cohort rows shown before the "+N more" note. */
    const SIGNALS_ACCOUNT_ROWS = 4;
    /** Body tabs, in keyboard order. The Queue tab is the default. */
    const TAB_ORDER = Object.freeze(["queue", "signals"]);
    /** Per-activation CSRF token: the board hands it out, every POST must echo it. */
    const CSRF_HEADER = "x-autobet-csrf";
    /** Operator identity, persisted across page switches and reloads. */
    const OPERATOR_STORAGE_KEY = "watchlist-autobet.operator";
    /** Poll cadence while the page is mounted and the document is visible. */
    const POLL_MS = 20_000;
    /** Per-request bounds. The action bound sits above the CLI's 60 s tool timeout. */
    const BOARD_TIMEOUT_MS = 15_000;
    const ACTION_TIMEOUT_MS = 75_000;
    /** A success notice is transient; an error notice stays until dismissed. */
    const NOTICE_MS = 8_000;
    /** Queued intents expiring inside this window are called out in the attention banner. */
    const EXPIRING_SOON_MINUTES = 30;
    /** The recent-decisions feed is deliberately bounded. */
    const RECENT_DECISIONS_LIMIT = 20;
    /** Server-side bounds mirrored here so the form cannot send an invalid body. */
    const FREE_TEXT_MAX_LENGTH = 2_000;
    const ACTOR_MAX_LENGTH = 120;

    /* -------------------------------------------------------------------------- */
    /* Small helpers: never invent data                                          */
    /* -------------------------------------------------------------------------- */

    /**
     * Narrow to a non-array object.
     * @param {unknown} value
     * @returns {Record<string, unknown> | null}
     */
    function asRecord(value) {
      return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
        ? value
        : null;
    }

    /**
     * Narrow to an array; a missing value yields an empty list rather than throwing.
     * @param {unknown} value
     * @returns {unknown[]}
     */
    function asArray(value) {
      return Array.isArray(value) ? value : [];
    }

    /**
     * Narrow to a finite number.
     * @param {unknown} value
     * @returns {number | null}
     */
    function numberOrNull(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /**
     * Narrow to a non-empty string (empty strings are treated as missing).
     * @param {unknown} value
     * @returns {string | null}
     */
    function stringOrNull(value) {
      return typeof value === "string" && value.trim() !== "" ? value : null;
    }

    /**
     * Narrow to a boolean.
     * @param {unknown} value
     * @returns {boolean | null}
     */
    function booleanOrNull(value) {
      return typeof value === "boolean" ? value : null;
    }

    /**
     * Format USD with thousands separators; an optional leading sign for P&L.
     * @param {unknown} value
     * @param {{ sign?: boolean }} [options]
     * @returns {string | null}
     */
    function money(value, options) {
      const amount = numberOrNull(value);
      if (amount === null) return null;
      const absolute = Math.abs(amount).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      const sign = amount < 0 ? "-" : options && options.sign ? "+" : "";
      return `${sign}$${absolute}`;
    }

    /**
     * Format a 0..1 probability as a percent.
     * @param {unknown} value
     * @returns {string | null}
     */
    function percent(value) {
      const probability = numberOrNull(value);
      if (probability === null) return null;
      return `${(probability * 100).toFixed(1)}%`;
    }

    /**
     * Format a probability percent already expressed on a 0..100 scale (ROI, confidence).
     * @param {unknown} value
     * @returns {string | null}
     */
    function percentPoints(value) {
      const points = numberOrNull(value);
      if (points === null) return null;
      const rounded = Math.round(points * 10) / 10;
      return `${rounded}%`;
    }

    /**
     * Format a number without unit conversion.
     * @param {unknown} value
     * @returns {string | null}
     */
    function plainNumber(value) {
      const number = numberOrNull(value);
      return number === null ? null : String(number);
    }

    /**
     * Format American odds ("+110", "-110").
     * @param {unknown} value
     * @returns {string | null}
     */
    function americanOdds(value) {
      const odds = numberOrNull(value);
      if (odds === null) return null;
      return odds > 0 ? `+${odds}` : String(odds);
    }

    /**
     * A duration in seconds, localized and rounded to a readable unit.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} seconds
     * @returns {string | null}
     */
    function durationText(t, seconds) {
      const total = numberOrNull(seconds);
      if (total === null || total < 0) return null;
      if (total < 60) return t("durationSeconds", { count: Math.round(total) });
      const minutes = Math.floor(total / 60);
      if (minutes < 60) return t("durationMinutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return t("durationHours", { count: hours });
      return t("durationDays", { count: Math.floor(hours / 24) });
    }

    /**
     * "3m ago" style relative time for an ISO timestamp.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} iso
     * @param {number} now
     * @returns {string | null}
     */
    function relativeTime(t, iso, now) {
      const milliseconds =
        typeof iso === "string" ? Date.parse(iso) : Number.NaN;
      if (!Number.isFinite(milliseconds)) return null;
      const deltaSeconds = Math.max(
        0,
        Math.round((now - milliseconds) / 1_000),
      );
      if (deltaSeconds < 10) return t("ageNow");
      if (deltaSeconds < 60) return t("ageSeconds", { count: deltaSeconds });
      const minutes = Math.floor(deltaSeconds / 60);
      if (minutes < 60) return t("ageMinutes", { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 48) return t("ageHours", { count: hours });
      return t("ageDays", { count: Math.floor(hours / 24) });
    }

    /**
     * Absolute local time for an ISO timestamp.
     * @param {unknown} iso
     * @returns {string | null}
     */
    function absoluteTime(iso) {
      const milliseconds =
        typeof iso === "string" ? Date.parse(iso) : Number.NaN;
      return Number.isFinite(milliseconds)
        ? new Date(milliseconds).toLocaleString()
        : null;
    }

    /**
     * Compact JSON for a gate's actual/required value; long values are elided.
     * @param {unknown} value
     * @returns {string}
     */
    function compactJson(value) {
      if (value === undefined) return "—";
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value);
      }
      if (typeof text !== "string") return String(value);
      return text.length > 140 ? `${text.slice(0, 137)}...` : text;
    }

    /**
     * Render a formatted value, or the not-available marker when it is missing.
     * @param {(key: string) => string} t
     * @param {string | null} value
     * @returns {string}
     */
    function shown(t, value) {
      return value === null || value === undefined ? t("notAvailable") : value;
    }

    /**
     * The board's full market label, with a local fallback when the server derivation is
     * missing (extra fields may be added; missing ones must not blank the card).
     * @param {unknown} intent
     * @returns {string}
     */
    function intentMarketLabel(intent) {
      const record = asRecord(intent);
      if (record === null) return "—";
      const label = stringOrNull(record.marketLabel);
      if (label !== null) return label;
      const parts = [];
      const league = stringOrNull(record.league);
      if (league !== null) parts.push(league);
      const teams = asArray(record.teams).filter(
        (team) => typeof team === "string",
      );
      if (teams.length > 0) parts.push(teams.join(" vs "));
      const kind = stringOrNull(record.marketKind);
      if (kind !== null) parts.push(kind);
      const line = numberOrNull(record.line);
      if (line !== null) parts.push(String(line));
      const lean =
        stringOrNull(record.overUnder) || stringOrNull(record.sideTeam);
      if (lean !== null) parts.push(lean);
      if (parts.length > 0) return parts.join(" · ");
      return (
        stringOrNull(record.signalId) || stringOrNull(record.intentId) || "—"
      );
    }

    /**
     * The side/line summary a trade ticket would show, without the league/teams prefix.
     * @param {unknown} intent
     * @returns {string | null}
     */
    function intentSideLine(intent) {
      const record = asRecord(intent);
      if (record === null) return null;
      const parts = [];
      const kind = stringOrNull(record.marketKind);
      if (kind !== null) parts.push(kind);
      const line = numberOrNull(record.line);
      if (line !== null) parts.push(String(line));
      const lean =
        stringOrNull(record.overUnder) || stringOrNull(record.sideTeam);
      if (lean !== null) parts.push(lean);
      return parts.length > 0 ? parts.join(" · ") : null;
    }

    /**
     * Reference price as "odds (implied probability)".
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} intent
     * @returns {string | null}
     */
    function referencePriceText(t, intent) {
      const record = asRecord(intent);
      if (record === null) return null;
      const odds = americanOdds(record.referenceAmericanOdds);
      const probability = percent(record.referenceImpliedProb);
      if (odds === null && probability === null) return null;
      if (odds !== null && probability !== null) {
        return t("referenceLine", { odds, probability });
      }
      return odds === null ? probability : odds;
    }

    /**
     * Expiry in minutes, preferring the server derivation and falling back to the timestamp.
     * @param {unknown} intent
     * @returns {number | null}
     */
    function minutesUntilExpiry(intent) {
      const record = asRecord(intent);
      if (record === null) return null;
      const derived = numberOrNull(record.expiresInMinutes);
      if (derived !== null) return derived;
      const expiresAt =
        typeof record.expiresAt === "string"
          ? Date.parse(record.expiresAt)
          : Number.NaN;
      return Number.isFinite(expiresAt)
        ? Math.round((expiresAt - Date.now()) / 60_000)
        : null;
    }

    /**
     * The expiry countdown copy for a card or the context panel.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} intent
     * @returns {string}
     */
    function expiryText(t, intent) {
      const minutes = minutesUntilExpiry(intent);
      if (minutes === null) return t("expiryUnknown");
      if (minutes <= 0) return t("expired");
      return t("expiresIn", { minutes });
    }

    /** Status id -> locale key. */
    const STATUS_LABEL_KEYS = Object.freeze({
      queued: "statusQueued",
      approved: "statusApproved",
      filled: "statusFilled",
      settled: "statusSettled",
      rejected: "statusRejected",
      expired: "statusExpired",
    });

    /** Action id -> locale key (decision feed and `nextAction`). */
    const ACTION_LABEL_KEYS = Object.freeze({
      enqueue: "actionEnqueue",
      approve: "actionApprove",
      reject: "actionReject",
      execute: "actionExecute",
      settle: "actionSettle",
      expire: "actionExpire",
    });

    /**
     * Localized status label.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} status
     * @returns {string}
     */
    function statusLabel(t, status) {
      const normalized = stringOrNull(status);
      const key =
        normalized === null ? null : STATUS_LABEL_KEYS[normalized] || null;
      return key === null ? t("unknown") : t(key);
    }

    /**
     * Localized action label, or null when the action is unknown.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} action
     * @returns {string | null}
     */
    function actionLabel(t, action) {
      const normalized = stringOrNull(action);
      if (normalized === null) return null;
      const key = ACTION_LABEL_KEYS[normalized];
      return key === undefined ? normalized : t(key);
    }

    /**
     * Localized settlement result label.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} result
     * @returns {string}
     */
    function settlementLabel(t, result) {
      const normalized = stringOrNull(result);
      if (normalized === "won") return t("resultWon");
      if (normalized === "lost") return t("resultLost");
      if (normalized === "void") return t("resultVoid");
      return t("unknown");
    }

    /** The intents array of a board, filtered to objects. */
    function boardIntents(board) {
      return asArray(board === null ? null : board.intents).filter(
        (intent) => asRecord(intent) !== null,
      );
    }

    /**
     * A status count, from `counts` first and `summary.byStatus` as a fallback.
     * @param {unknown} board
     * @param {string} status
     * @returns {number | null}
     */
    function statusCount(board, status) {
      const counts = asRecord(board === null ? null : board.counts);
      const direct = counts === null ? null : numberOrNull(counts[status]);
      if (direct !== null) return direct;
      const summary = asRecord(board === null ? null : board.summary);
      const byStatus = summary === null ? null : asRecord(summary.byStatus);
      return byStatus === null ? null : numberOrNull(byStatus[status]);
    }

    /**
     * A numeric summary field.
     * @param {unknown} board
     * @param {string} key
     * @returns {number | null}
     */
    function summaryNumber(board, key) {
      const summary = asRecord(board === null ? null : board.summary);
      return summary === null ? null : numberOrNull(summary[key]);
    }

    /**
     * `plan.caps` (daily cap accounting), or null when the board omits it.
     * @param {unknown} board
     * @returns {Record<string, unknown> | null}
     */
    function planCaps(board) {
      const plan = asRecord(board === null ? null : board.plan);
      return plan === null ? null : asRecord(plan.caps);
    }

    /**
     * Number of signals the current plan would queue, or null when unknown.
     * @param {unknown} board
     * @returns {number | null}
     */
    function wouldQueueCount(board) {
      const plan = asRecord(board === null ? null : board.plan);
      if (plan === null || !Array.isArray(plan.wouldQueue)) return null;
      return plan.wouldQueue.length;
    }

    /**
     * Ledger existence/event counts, distinguishing "missing" from "unknown".
     * @param {unknown} board
     * @returns {{ known: boolean, exists: boolean | null, events: number | null, path: string | null }}
     */
    function readLedger(board) {
      const ledger = asRecord(board === null ? null : board.ledger);
      if (ledger === null) {
        return { known: false, exists: null, events: null, path: null };
      }
      return {
        known: true,
        exists: booleanOrNull(ledger.exists),
        events: numberOrNull(ledger.events),
        path: stringOrNull(ledger.path),
      };
    }

    /** The decisions feed of a board, newest first (server order). */
    function boardDecisions(board) {
      return asArray(board === null ? null : board.decisions).filter(
        (decision) => asRecord(decision) !== null,
      );
    }

    /**
     * The decisions recorded for one intent.
     * @param {unknown} board
     * @param {string} intentId
     * @returns {unknown[]}
     */
    function decisionsForIntent(board, intentId) {
      return boardDecisions(board).filter(
        (decision) => decision.intentId === intentId,
      );
    }

    /* -------------------------------------------------------------------------- */
    /* Signals inspector helpers: closed gate ids, market labels, payload shape   */
    /* -------------------------------------------------------------------------- */

    /** The 12 closed gate checks -> locale keys (reason chips reuse the same labels). */
    const GATE_LABEL_KEYS = Object.freeze({
      enabled: "gateEnabled",
      league_allowed: "gateLeagueAllowed",
      fixture_provenance: "gateFixtureProvenance",
      freshness: "gateFreshness",
      confidence: "gateConfidence",
      distinct_accounts: "gateDistinctAccounts",
      one_sided_share: "gateOneSidedShare",
      reference_price: "gateReferencePrice",
      stake_available: "gateStakeAvailable",
      daily_stake_cap: "gateDailyStakeCap",
      league_daily_cap: "gateLeagueDailyCap",
      duplicate_intent: "gateDuplicateIntent",
    });

    /**
     * Localized label for a gate check id. An id added server-side later renders verbatim
     * rather than blanking the check.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} check
     * @returns {string}
     */
    function gateCheckLabel(t, check) {
      const normalized = stringOrNull(check);
      if (normalized === null) return t("unknown");
      const key = GATE_LABEL_KEYS[normalized];
      return key === undefined ? normalized : t(key);
    }

    /**
     * The `signal` object of one `signals` entry, or null when the entry is malformed.
     * @param {unknown} entry
     * @returns {Record<string, unknown> | null}
     */
    function entrySignal(entry) {
      const record = asRecord(entry);
      return record === null ? null : asRecord(record.signal);
    }

    /**
     * The `gate` object of one `signals` entry, or null when the entry is malformed.
     * @param {unknown} entry
     * @returns {Record<string, unknown> | null}
     */
    function entryGate(entry) {
      const record = asRecord(entry);
      return record === null ? null : asRecord(record.gate);
    }

    /**
     * One gate check by id, or null when the gate omits it.
     * @param {Record<string, unknown> | null} gate
     * @param {string} name
     * @returns {Record<string, unknown> | null}
     */
    function findGateCheck(gate, name) {
      const checks = asArray(gate === null ? null : gate.checks).filter(
        (check) => asRecord(check) !== null,
      );
      return checks.find((check) => check.check === name) ?? null;
    }

    /**
     * The signal's market label: league · teams · marketKind · line · side/over-under.
     * The signal payload carries no prebuilt label, so the inspector derives one.
     * @param {unknown} signal
     * @returns {string}
     */
    function signalMarketLabel(signal) {
      const record = asRecord(signal);
      if (record === null) return "—";
      const parts = [];
      const league = stringOrNull(record.league);
      if (league !== null) parts.push(league);
      const teams = asArray(record.teams).filter(
        (team) => typeof team === "string" && team.trim() !== "",
      );
      if (teams.length > 0) parts.push(teams.join(" vs "));
      const kind = stringOrNull(record.marketKind);
      if (kind !== null) parts.push(kind);
      const line = numberOrNull(record.line);
      if (line !== null) parts.push(String(line));
      const lean =
        stringOrNull(record.overUnder) || stringOrNull(record.sideTeam);
      if (lean !== null) parts.push(lean);
      if (parts.length > 0) return parts.join(" · ");
      return stringOrNull(record.id) || "—";
    }

    /**
     * A numeric `counts` field of a signals payload.
     * @param {unknown} payload
     * @param {string} key
     * @returns {number | null}
     */
    function signalCount(payload, key) {
      const counts = asRecord(payload === null ? null : payload.counts);
      return counts === null ? null : numberOrNull(counts[key]);
    }

    /**
     * The payload's `signals` array, or null when the field is absent. A missing array is
     * "unknown", never "0 signals"; a present empty array is a real empty snapshot.
     * @param {unknown} payload
     * @returns {unknown[] | null}
     */
    function signalEntries(payload) {
      const record = asRecord(payload);
      if (record === null || !Array.isArray(record.signals)) return null;
      return record.signals.filter((entry) => asRecord(entry) !== null);
    }

    /**
     * Distinct leagues among the entries, in payload order (the league filter's options).
     * @param {unknown[]} entries
     * @returns {string[]}
     */
    function signalLeagues(entries) {
      const seen = new Set();
      const leagues = [];
      for (const entry of entries) {
        const signal = entrySignal(entry);
        const league = signal === null ? null : stringOrNull(signal.league);
        if (league !== null && !seen.has(league)) {
          seen.add(league);
          leagues.push(league);
        }
      }
      return leagues;
    }

    /**
     * The payload's `candidates` array — logins in the captures that the watchlist registry
     * does not cover — or null when the field is absent. A missing list is "unknown", never
     * "0 new accounts": a Host bundle that predates the discovery pass cannot answer it.
     * @param {unknown} payload
     * @returns {unknown[] | null}
     */
    function candidateEntries(payload) {
      const record = asRecord(payload);
      if (record === null || !Array.isArray(record.candidates)) return null;
      return record.candidates.filter((entry) => asRecord(entry) !== null);
    }

    /**
     * The candidate row's secondary line: agent, wager count and the captures that saw it.
     * @param {(key: string, params?: object) => string} t
     * @param {Record<string, unknown>} candidate
     * @returns {string}
     */
    function candidateMeta(t, candidate) {
      const parts = [];
      const agent = stringOrNull(candidate.agentId);
      if (agent !== null) parts.push(agent);
      const wagers = numberOrNull(candidate.wagers);
      if (wagers !== null) {
        parts.push(t("signalsCandidateWagers", { count: plainNumber(wagers) }));
      }
      const sources = asArray(candidate.sources).filter(
        (source) => typeof source === "string" && source.trim() !== "",
      );
      if (sources.length > 0) parts.push(sources.join(", "));
      return parts.join(" · ");
    }

    /* -------------------------------------------------------------------------- */
    /* Visible copy: en + zh, namespace `watchlist-autobet`                       */
    /* -------------------------------------------------------------------------- */

    const DICTS = {
      en: {
        /* Sidebar + page chrome */
        panel: "Watchlist autobet",
        title: "Watchlist autobet — control plane",
        subtitle:
          "Paper-only, human-in-the-loop queue for watchlist signals. Approvals, paper fills and settlements are recorded in the append-only paper ledger; live betting is not implemented and no live order path exists.",
        paperOnly: "PAPER ONLY",
        paperOnlyHint:
          "The control plane has no live-order action: execute is the paper adapter and the server hard-codes venue paper.",
        liveExecutionReported: "LIVE EXECUTION REPORTED",
        liveExecutionReportedHint:
          "The board snapshot reports that live execution is enabled. Stop and inspect the server before acting.",
        safetyUnknown:
          "This board snapshot does not report the server safety state.",
        refresh: "Refresh",
        refreshing: "Refreshing...",
        retry: "Retry",
        loading: "Loading the paper board...",
        dismiss: "Dismiss",
        /* Operator identity */
        operator: "Operator",
        operatorPlaceholder: "Your name (recorded with each decision)",
        operatorRequiredHint:
          "Set the operator name to approve or reject — every decision records it.",
        /* Source freshness + snapshot chips */
        staleSourcesChip: "{count} stale source(s)",
        sourcesFresh: "Sources fresh",
        sourcesUnknown: "Sources unknown",
        snapshotChip: "Snapshot {age}",
        snapshotUnknown: "Snapshot unknown",
        /* Stat strip */
        statsTitle: "Paper desk snapshot",
        statQueued: "Queued",
        statApproved: "Approved",
        statFilled: "Filled, unsettled",
        statSettledPnl: "Settled P&L",
        statStaked: "Staked / settled stake",
        statCap: "Daily cap used / remaining",
        statLedger: "Ledger",
        statSnapshot: "Snapshot",
        roiNote: "ROI {pct}",
        stakePair: "{staked} / {settled}",
        capPair: "{used} / {remaining}",
        capOf: "Daily cap {cap}",
        ledgerMissing: "missing",
        ledgerEmpty: "0 events",
        ledgerEvents: "{count} event(s)",
        /* Attention banner */
        attentionTitle: "Needs attention",
        attentionStaleSources:
          "{count} source(s) stale — new signals will be refused until captures refresh",
        attentionExpiring:
          "{count} queued intent(s) expiring within {minutes} minutes",
        attentionApproved: "{count} approved intent(s) not executed",
        attentionFilled: "{count} filled intent(s) not settled",
        attentionWouldQueue: "{count} eligible signal(s) waiting to be queued",
        scanQueue: "Scan & queue",
        confirmScanQueue: "Confirm scan & queue",
        scanQueueHint:
          "Queues paper intents through the same gates. Nothing is approved or executed.",
        /* Queue */
        queueTitle: "Queue",
        sectionQueued: "Queued",
        sectionApproved: "Approved",
        sectionFilled: "Filled",
        emptyQueued: "No intents waiting for approval.",
        emptyApproved: "No approved intents waiting to execute.",
        emptyFilled: "No paper fills waiting to settle.",
        noIntents:
          "No paper intents yet — Scan & queue or run the CLI enqueue.",
        intentsUnknown:
          "This board snapshot has no intents list, so the queue is unknown rather than empty.",
        ledgerMissingNote:
          "The paper ledger is missing at {path}. That is not zero activity — nothing has been recorded yet.",
        /* Status + action words */
        statusQueued: "queued",
        statusApproved: "approved",
        statusFilled: "filled",
        statusSettled: "settled",
        statusRejected: "rejected",
        statusExpired: "expired",
        actionEnqueue: "enqueue",
        actionApprove: "approve",
        actionReject: "reject",
        actionExecute: "execute paper",
        actionSettle: "settle",
        actionExpire: "expire",
        noNextAction: "—",
        resultWon: "won",
        resultLost: "lost",
        resultVoid: "void",
        unknown: "unknown",
        notAvailable: "—",
        notProvided: "This board snapshot does not include this value.",
        /* Card metadata */
        selectIntent: "Show context for {market}",
        metaStake: "stake {value}",
        metaConfidence: "confidence {value}",
        metaAccounts: "{count} account(s)",
        metaFair: "fair {value}",
        metaOdds: "odds {value}",
        metaRisk: "risk {value}",
        metaCreated: "created {age}",
        metaNext: "next: {value}",
        expiresIn: "expires in {minutes}m",
        expiryUnknown: "expiry unknown",
        expired: "expired",
        nextAction: "Next action",
        /* Card action forms */
        actionApproveTitle: "Approve this paper intent",
        actionRejectTitle: "Reject this paper intent",
        actionExecuteTitle: "Paper-fill this approved intent",
        actionSettleTitle: "Settle this paper fill",
        noteLabel: "Note (optional)",
        notePlaceholder: "Why this approval?",
        reasonLabel: "Reason (required)",
        reasonPlaceholder: "Why this rejection?",
        reasonRequired: "A rejection reason is required.",
        approveHint:
          "Records the approval in the paper ledger with the operator name. No order is placed.",
        rejectHint:
          "Records the rejection in the paper ledger; the reserved stake is released.",
        executeHint:
          "Paper fill only — no live order path exists. The server pins venue paper.",
        settleHint:
          "Record the paper result. This moves no real money and only appends to the ledger.",
        confirmApprove: "Confirm approve",
        confirmReject: "Confirm reject",
        confirmExecute: "Confirm paper execute",
        confirmWon: "Confirm won",
        confirmLost: "Confirm lost",
        confirmVoid: "Confirm void",
        cancel: "Cancel",
        working: "Working...",
        /* Context panel */
        contextTitle: "Context",
        noSelection:
          "Select an intent in the queue to see its market, provenance, accounts and gate checks.",
        stakeDetail: "Stake",
        statusDetail: "Status",
        created: "Created",
        expires: "Expires",
        referencePrice: "Reference price",
        referenceLine: "{odds} ({probability})",
        riskDetail: "Risk",
        confidenceDetail: "Confidence",
        accountsDetail: "Distinct accounts",
        paperFillTitle: "Paper fill",
        fillMissing: "This snapshot has no paper-fill math for this intent.",
        fillVenue: "Venue",
        fillAt: "Filled at",
        fillEffective: "Effective probability",
        fillSlippage: "Slippage",
        fillPayout: "Payout if win",
        paperMath: "{stake} at {probability} → {payout} if won (paper)",
        fillIncomplete: "This paper-fill snapshot is incomplete.",
        settlementTitle: "Settlement",
        settlementMissing:
          "The ledger reports a settlement but this snapshot has no settlement math.",
        settlementAt: "Settled at",
        settlementProfit: "Profit",
        settlementPayout: "Payout",
        provenanceTitle: "Provenance",
        provenanceMissing:
          "This snapshot has no provenance for the intent; treat the numbers as unverified.",
        dataMode: "Data mode",
        asOf: "As of",
        ageLabel: "Age",
        staleLabel: "Stale",
        fixtureLabel: "Fixture",
        yes: "yes",
        no: "no",
        fixtureWarning: "synthetic fixture — not live market evidence",
        sourcesTitle: "Sources",
        noSources: "No sources reported.",
        accountsTitle: "Accounts",
        noAccounts: "No accounts in this intent snapshot.",
        colLogin: "Login",
        colAgent: "Agent",
        colArchetype: "Archetype",
        colCategory: "Category",
        colRisk: "Risk",
        gatesTitle: "Gate checks",
        noGates: "No gate checks in this intent snapshot.",
        colCheck: "Check",
        colResult: "Result",
        colActual: "Actual",
        colRequired: "Required",
        gatePass: "pass",
        gateFail: "fail",
        decisionTrailTitle: "Decision trail",
        noTrail: "No recorded decisions for this intent.",
        recentDecisionsTitle: "Recent decisions",
        recentDecisionsSub:
          "Newest approval, rejection, fill and settlement events from the paper ledger.",
        noDecisions: "No decisions recorded yet.",
        decisionsUnknown:
          "This board snapshot has no decision feed, so recent decisions are unknown.",
        decisionNote: "Note",
        decisionReason: "Reason",
        decisionBy: "by {actor}",
        /* Errors */
        errorTimeout: "The board request timed out.",
        errorInvalidResponse:
          "The control-plane API did not answer with a JSON object.",
        errorCodeOnly: "The control-plane API returned {code}.",
        errorDetail: "{code}: {message}",
        fetchFailedTitle: "Could not load the control-plane board",
        fetchFailedBody:
          "No board snapshot has been received yet. The queue, counts and decisions are unknown, not empty.",
        staleSince:
          "Showing the last snapshot from {time} — the refresh failed.",
        actionTimeout:
          "The action request timed out. Refresh the board to see whether it was recorded.",
        actorRequired: "Set the operator name before recording a decision.",
        csrfUnavailable:
          "This board snapshot is missing the CSRF token. Refresh before acting.",
        busy: "Another action is already in flight.",
        /* Success notices */
        successApprove: "Approved {intentId}.",
        successReject: "Rejected {intentId}.",
        successExecute: "Paper-filled {intentId}.",
        successSettle: "Settled {intentId}.",
        successSettleResult: "Settled {intentId} as {result}.",
        successEnqueue: "Queued {count} paper intent(s).",
        successEnqueueNone: "Scan complete — no eligible signals to queue.",
        successEnqueueGeneric:
          "Scan & queue completed; the board was refreshed.",
        successGeneric: "{action} recorded.",
        /* Durations + relative ages */
        durationSeconds: "{count}s",
        durationMinutes: "{count}m",
        durationHours: "{count}h",
        durationDays: "{count}d",
        ageNow: "just now",
        ageSeconds: "{count}s ago",
        ageMinutes: "{count}m ago",
        ageHours: "{count}h ago",
        ageDays: "{count}d ago",
        /* Tabs */
        tabsLabel: "Control-plane views",
        tabSignals: "Signals",
        /* Signals inspector */
        signalsTitle: "Signals inspector",
        signalsSub:
          "Watchlist signals with every closed gate check. The fetch always includes refused signals, so an empty queue is explained.",
        signalsLoading: "Loading the watchlist signals...",
        signalsErrorTitle: "Could not load the watchlist signals",
        signalsErrorBody:
          "No signals snapshot has been received yet. Counts and signals are unknown, not empty.",
        signalsRouteMissing:
          "Signals route not available; update the Host bundle.",
        signalsUnknown:
          "This payload has no signals list, so the watchlist is unknown rather than empty.",
        signalsEmpty: "No signals in this snapshot.",
        signalsNoMatches: "No signals match the current filters.",
        signalsSummaryLabel: "Signals summary",
        signalsFiltersLabel: "Signal filters",
        signalsCountTotal: "Total {count}",
        signalsCountEligible: "Eligible {count}",
        signalsCountRejected: "Refused {count}",
        signalsGenerated: "generated {age}",
        signalsReceived: "received {age}",
        signalsShowRefused: "Show refused",
        signalsLeagueFilter: "League",
        signalsLeagueAll: "All leagues",
        signalsEligible: "eligible",
        signalsRefused: "refused",
        signalsEligibleEnqueue: "Enqueue eligible signals",
        signalsConfirmEnqueue: "Confirm enqueue",
        signalsEnqueueHint:
          "Queues paper intents through the same gates. Nothing is approved or executed; the operator name is recorded.",
        signalsActorRequired: "Set the operator name before enqueuing signals.",
        signalsNoEligible:
          "No signal is currently eligible; refused signals show which gate failed.",
        signalsDetailsShow: "Show gate checks",
        signalsDetailsHide: "Hide gate checks",
        signalsConfidence: "confidence {actual} / {required}",
        signalsAccounts: "accounts {actual} / {required}",
        signalsOneSided: "one-sided {value}",
        signalsRefPrice: "ref {value}",
        signalsAge: "age {value}",
        signalsDataModeChip: "data mode {mode}",
        signalsProvenanceUnknown: "provenance unknown",
        /* Not-on-the-watchlist discovery */
        signalsCandidatesTitle: "Not on the watchlist",
        signalsCandidatesSub:
          "Accounts in the captures that the watchlist registry does not cover. Advisory only: the gate ignores them until an operator promotes the account.",
        signalsCandidatesCount: "Unwatched {count}",
        signalsCandidatesUnknown:
          "This payload has no candidate list, so new accounts are unknown rather than none.",
        signalsCandidatesEmpty: "No unwatched accounts in this snapshot.",
        signalsCandidateWagers: "{count} wager(s)",
        signalsCandidateLastBet: "last bet {age}",
        signalsCandidateNoBet: "no bet time",
        signalsReasonsTitle: "Refused by",
        signalsMoreAccounts: "+{count} more account(s)",
        /* Gate check labels (the 12 closed checks; reasons reuse them) */
        gateEnabled: "enabled",
        gateLeagueAllowed: "league allowed",
        gateFixtureProvenance: "fixture provenance",
        gateFreshness: "freshness",
        gateConfidence: "confidence",
        gateDistinctAccounts: "distinct accounts",
        gateOneSidedShare: "one-sided share",
        gateReferencePrice: "reference price",
        gateStakeAvailable: "stake available",
        gateDailyStakeCap: "daily stake cap",
        gateLeagueDailyCap: "league daily cap",
        gateDuplicateIntent: "duplicate intent",
      },
      zh: {
        /* Sidebar + page chrome */
        panel: "关注列表自动下注",
        title: "关注列表自动下注 — 控制台",
        subtitle:
          "仅纸面、人工介入的关注列表信号队列。批准、纸面成交与结算都记录在只追加的纸面账本中；未实现真实下注，也不存在真实下单路径。",
        paperOnly: "仅纸面",
        paperOnlyHint:
          "控制台没有真实下单操作：执行使用纸面适配器，服务器固定 venue 为 paper。",
        liveExecutionReported: "检测到真实执行",
        liveExecutionReportedHint:
          "看板快照报告真实执行已启用。请停止操作并检查服务器。",
        safetyUnknown: "该看板快照未报告服务器安全状态。",
        refresh: "刷新",
        refreshing: "刷新中...",
        retry: "重试",
        loading: "正在加载纸面看板...",
        dismiss: "关闭",
        /* Operator identity */
        operator: "操作员",
        operatorPlaceholder: "你的名字（随每条决定记录）",
        operatorRequiredHint:
          "填写操作员名字后才能批准或拒绝 — 每条决定都会记录。",
        /* Source freshness + snapshot chips */
        staleSourcesChip: "{count} 个数据源已过期",
        sourcesFresh: "数据源新鲜",
        sourcesUnknown: "数据源未知",
        snapshotChip: "快照 {age}",
        snapshotUnknown: "快照时间未知",
        /* Stat strip */
        statsTitle: "纸面工作台快照",
        statQueued: "待处理",
        statApproved: "已批准",
        statFilled: "已成交未结算",
        statSettledPnl: "已结算盈亏",
        statStaked: "已下注 / 已结算下注",
        statCap: "每日额度已用 / 剩余",
        statLedger: "账本",
        statSnapshot: "快照",
        roiNote: "回报率 {pct}",
        stakePair: "{staked} / {settled}",
        capPair: "{used} / {remaining}",
        capOf: "每日额度 {cap}",
        ledgerMissing: "缺失",
        ledgerEmpty: "0 条事件",
        ledgerEvents: "{count} 条事件",
        /* Attention banner */
        attentionTitle: "需要注意",
        attentionStaleSources:
          "{count} 个数据源已过期 — 数据刷新前新信号将被拒绝",
        attentionExpiring: "{count} 个待处理意图将在 {minutes} 分钟内过期",
        attentionApproved: "{count} 个已批准意图尚未执行",
        attentionFilled: "{count} 个已成交意图尚未结算",
        attentionWouldQueue: "{count} 个符合条件的信号等待入队",
        scanQueue: "扫描并入队",
        confirmScanQueue: "确认扫描并入队",
        scanQueueHint:
          "仅通过相同风控闸门排队纸面意图；不会批准或执行任何操作。",
        /* Queue */
        queueTitle: "队列",
        sectionQueued: "待处理",
        sectionApproved: "已批准",
        sectionFilled: "已成交",
        emptyQueued: "没有等待批准的意图。",
        emptyApproved: "没有等待执行的已批准意图。",
        emptyFilled: "没有等待结算的纸面成交。",
        noIntents: "还没有纸面意图 — 可扫描入队，或运行 CLI enqueue。",
        intentsUnknown:
          "该看板快照没有意图列表，因此队列状态是未知，而不是空。",
        ledgerMissingNote:
          "纸面账本缺失：{path}。这不代表零活动 — 目前还没有任何记录。",
        /* Status + action words */
        statusQueued: "待处理",
        statusApproved: "已批准",
        statusFilled: "已成交",
        statusSettled: "已结算",
        statusRejected: "已拒绝",
        statusExpired: "已过期",
        actionEnqueue: "入队",
        actionApprove: "批准",
        actionReject: "拒绝",
        actionExecute: "纸面执行",
        actionSettle: "结算",
        actionExpire: "过期",
        noNextAction: "—",
        resultWon: "赢",
        resultLost: "输",
        resultVoid: "无效",
        unknown: "未知",
        notAvailable: "—",
        notProvided: "该看板快照不包含此值。",
        /* Card metadata */
        selectIntent: "查看 {market} 的上下文",
        metaStake: "下注 {value}",
        metaConfidence: "置信度 {value}",
        metaAccounts: "{count} 个账户",
        metaFair: "公允 {value}",
        metaOdds: "赔率 {value}",
        metaRisk: "风险 {value}",
        metaCreated: "创建于 {age}",
        metaNext: "下一步：{value}",
        expiresIn: "{minutes} 分钟后过期",
        expiryUnknown: "过期时间未知",
        expired: "已过期",
        nextAction: "下一步",
        /* Card action forms */
        actionApproveTitle: "批准该纸面意图",
        actionRejectTitle: "拒绝该纸面意图",
        actionExecuteTitle: "纸面成交该已批准意图",
        actionSettleTitle: "结算该纸面成交",
        noteLabel: "备注（可选）",
        notePlaceholder: "为什么批准？",
        reasonLabel: "原因（必填）",
        reasonPlaceholder: "为什么拒绝？",
        reasonRequired: "拒绝必须填写原因。",
        approveHint: "把批准记录到纸面账本并署名操作员。不会下任何订单。",
        rejectHint: "把拒绝记录到纸面账本；预留的下注额度将被释放。",
        executeHint:
          "仅纸面成交 — 不存在真实下单路径，服务器固定 venue 为 paper。",
        settleHint: "记录纸面结果。不涉及真实资金，只会追加到账本。",
        confirmApprove: "确认批准",
        confirmReject: "确认拒绝",
        confirmExecute: "确认纸面执行",
        confirmWon: "确认赢",
        confirmLost: "确认输",
        confirmVoid: "确认无效",
        cancel: "取消",
        working: "处理中...",
        /* Context panel */
        contextTitle: "上下文",
        noSelection:
          "在队列中选择一个意图，查看其市场、数据来源、账户与闸门检查。",
        stakeDetail: "下注额",
        statusDetail: "状态",
        created: "创建时间",
        expires: "过期时间",
        referencePrice: "参考价格",
        referenceLine: "{odds}（{probability}）",
        riskDetail: "风险",
        confidenceDetail: "置信度",
        accountsDetail: "独立账户数",
        paperFillTitle: "纸面成交",
        fillMissing: "该快照中没有此意图的纸面成交计算。",
        fillVenue: "场所",
        fillAt: "成交时间",
        fillEffective: "有效概率",
        fillSlippage: "滑点",
        fillPayout: "命中赔付",
        paperMath: "{stake} 按 {probability} → 命中赔付 {payout}（纸面）",
        fillIncomplete: "该纸面成交快照不完整。",
        settlementTitle: "结算",
        settlementMissing: "账本报告已结算，但该快照没有结算计算。",
        settlementAt: "结算时间",
        settlementProfit: "盈亏",
        settlementPayout: "赔付",
        provenanceTitle: "数据来源",
        provenanceMissing: "该快照没有该意图的来源信息；相关数字未经核实。",
        dataMode: "数据模式",
        asOf: "截至",
        ageLabel: "时效",
        staleLabel: "过期",
        fixtureLabel: "模拟数据",
        yes: "是",
        no: "否",
        fixtureWarning: "模拟数据 — 不是真实市场证据",
        sourcesTitle: "来源",
        noSources: "未报告来源。",
        accountsTitle: "账户",
        noAccounts: "该意图快照中没有账户。",
        colLogin: "登录名",
        colAgent: "代理",
        colArchetype: "原型",
        colCategory: "类别",
        colRisk: "风险",
        gatesTitle: "闸门检查",
        noGates: "该意图快照中没有闸门检查。",
        colCheck: "检查",
        colResult: "结果",
        colActual: "实际",
        colRequired: "要求",
        gatePass: "通过",
        gateFail: "未通过",
        decisionTrailTitle: "决定轨迹",
        noTrail: "该意图尚无已记录的决定。",
        recentDecisionsTitle: "最近决定",
        recentDecisionsSub: "纸面账本中最新的批准、拒绝、成交与结算事件。",
        noDecisions: "尚无已记录的决定。",
        decisionsUnknown: "该看板快照没有决定流，因此最近决定是未知。",
        decisionNote: "备注",
        decisionReason: "原因",
        decisionBy: "操作员 {actor}",
        /* Errors */
        errorTimeout: "看板请求超时。",
        errorInvalidResponse: "控制台 API 未返回 JSON 对象。",
        errorCodeOnly: "控制台 API 返回了 {code}。",
        errorDetail: "{code}：{message}",
        fetchFailedTitle: "无法加载控制台看板",
        fetchFailedBody:
          "尚未收到任何看板快照。队列、计数与决定均为未知，而不是空。",
        staleSince: "正在显示 {time} 的最后快照 — 刷新失败。",
        actionTimeout: "操作请求超时。请刷新看板，确认该操作是否已记录。",
        actorRequired: "记录决定前请先填写操作员名字。",
        csrfUnavailable: "该看板快照缺少 CSRF 令牌，请先刷新再操作。",
        busy: "另一个操作正在进行中。",
        /* Success notices */
        successApprove: "已批准 {intentId}。",
        successReject: "已拒绝 {intentId}。",
        successExecute: "已纸面成交 {intentId}。",
        successSettle: "已结算 {intentId}。",
        successSettleResult: "已结算 {intentId}，结果为{result}。",
        successEnqueue: "已入队 {count} 个纸面意图。",
        successEnqueueNone: "扫描完成 — 没有可入队的信号。",
        successEnqueueGeneric: "扫描并入队完成；看板已刷新。",
        successGeneric: "已记录 {action}。",
        /* Durations + relative ages */
        durationSeconds: "{count} 秒",
        durationMinutes: "{count} 分",
        durationHours: "{count} 小时",
        durationDays: "{count} 天",
        ageNow: "刚刚",
        ageSeconds: "{count} 秒前",
        ageMinutes: "{count} 分钟前",
        ageHours: "{count} 小时前",
        ageDays: "{count} 天前",
        /* Tabs */
        tabsLabel: "控制台视图",
        tabSignals: "信号",
        /* Signals inspector */
        signalsTitle: "信号检查器",
        signalsSub:
          "关注列表信号及全部封闭闸门检查。请求始终包含被拒绝的信号，以便解释队列为空的原因。",
        signalsLoading: "正在加载关注列表信号...",
        signalsErrorTitle: "无法加载关注列表信号",
        signalsErrorBody: "尚未收到信号快照。计数与信号均为未知，而不是空。",
        signalsRouteMissing: "信号路由不可用；请更新 Host 端插件包。",
        signalsUnknown: "该负载没有信号列表，因此关注列表是未知，而不是空。",
        signalsEmpty: "该快照中没有信号。",
        signalsNoMatches: "没有信号符合当前筛选条件。",
        signalsSummaryLabel: "信号摘要",
        signalsFiltersLabel: "信号筛选",
        signalsCountTotal: "共 {count}",
        signalsCountEligible: "符合条件 {count}",
        signalsCountRejected: "被拒绝 {count}",
        signalsGenerated: "生成于 {age}",
        signalsReceived: "接收于 {age}",
        signalsShowRefused: "显示被拒绝",
        signalsLeagueFilter: "联赛",
        signalsLeagueAll: "所有联赛",
        signalsEligible: "符合条件",
        signalsRefused: "被拒绝",
        signalsEligibleEnqueue: "符合条件信号入队",
        signalsConfirmEnqueue: "确认入队",
        signalsEnqueueHint:
          "通过相同闸门排队纸面意图；不会批准或执行任何操作，并记录操作员名字。",
        signalsActorRequired: "入队信号前请先填写操作员名字。",
        signalsNoEligible:
          "当前没有符合条件的信号；被拒绝的信号会显示未通过的闸门。",
        signalsDetailsShow: "显示闸门检查",
        signalsDetailsHide: "隐藏闸门检查",
        signalsConfidence: "置信度 {actual} / {required}",
        signalsAccounts: "账户 {actual} / {required}",
        signalsOneSided: "单边占比 {value}",
        signalsRefPrice: "参考 {value}",
        signalsAge: "时效 {value}",
        signalsDataModeChip: "数据模式 {mode}",
        signalsProvenanceUnknown: "来源未知",
        /* 不在关注列表中的账户发现 */
        signalsCandidatesTitle: "不在关注列表中",
        signalsCandidatesSub:
          "捕获中出现、但关注列表注册表未覆盖的账户。仅为提示：在操作员将其加入关注列表前，闸门会忽略这些账户。",
        signalsCandidatesCount: "未关注 {count}",
        signalsCandidatesUnknown:
          "该负载没有候选列表，因此新账户是未知，而不是没有。",
        signalsCandidatesEmpty: "该快照中没有未关注的账户。",
        signalsCandidateWagers: "{count} 注",
        signalsCandidateLastBet: "最近下注 {age}",
        signalsCandidateNoBet: "无下注时间",
        signalsReasonsTitle: "拒绝原因",
        signalsMoreAccounts: "另有 {count} 个账户",
        /* Gate check labels (the 12 closed checks; reasons reuse them) */
        gateEnabled: "已启用",
        gateLeagueAllowed: "联赛允许",
        gateFixtureProvenance: "模拟数据来源",
        gateFreshness: "时效",
        gateConfidence: "置信度",
        gateDistinctAccounts: "独立账户",
        gateOneSidedShare: "单边占比",
        gateReferencePrice: "参考价格",
        gateStakeAvailable: "可用下注额",
        gateDailyStakeCap: "每日下注额度",
        gateLeagueDailyCap: "联赛每日额度",
        gateDuplicateIntent: "重复意图",
      },
    };

    /**
     * English fallback used only when the slot hands the component no `t` seat.
     * @param {string} key
     * @param {object} [params]
     * @returns {string}
     */
    function fallbackT(key, params) {
      const template = DICTS.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name)
          ? String(params[name])
          : match,
      );
    }

    /** Every form receives a deterministic id prefix so labels tie to inputs. */
    function sanitizeId(value) {
      return String(value).replace(/[^A-Za-z0-9_-]/g, "_");
    }

    /* -------------------------------------------------------------------------- */
    /* HTTP layer                                                                 */
    /* -------------------------------------------------------------------------- */

    /**
     * Turn a failed HTTP answer into an Error carrying the server's machine reason and
     * message. Nothing is swallowed: the component layer renders code + message.
     * @param {number} status
     * @param {unknown} body
     * @returns {Error & { code?: string, status?: number }}
     */
    function toApiError(status, body) {
      const record = asRecord(body);
      const reason = record === null ? null : stringOrNull(record.reason);
      const message = record === null ? null : stringOrNull(record.message);
      const error = new Error(message === null ? `HTTP ${status}` : message);
      error.code = reason === null ? `http_${status}` : reason;
      error.status = status;
      return error;
    }

    /**
     * GET the operator board. A non-2xx answer or a non-object body rejects; the caller
     * keeps the previous board visible and stale rather than inventing an empty one.
     * @param {AbortSignal} signal
     * @param {boolean} timedOut
     * @returns {Promise<Record<string, unknown>>}
     */
    async function fetchBoard(signal) {
      const response = await fetch(BOARD_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw toApiError(response.status, body);
      if (asRecord(body) === null) {
        const error = new Error("the board response was not a JSON object");
        error.code = "invalid_response";
        error.status = response.status;
        throw error;
      }
      if (body.ok === false) throw toApiError(response.status, body);
      return body;
    }

    /**
     * GET the watchlist signals inspector payload. The query always includes refused
     * signals (so an empty queue is explained) and always asks for the maximum; the
     * "Show refused" and league controls filter the received payload client-side.
     * @param {AbortSignal} signal
     * @returns {Promise<Record<string, unknown>>}
     */
    async function fetchSignals(signal) {
      const query = new URLSearchParams({
        includeRejected: "true",
        limit: String(SIGNALS_LIMIT),
      });
      const response = await fetch(`${SIGNALS_URL}?${query.toString()}`, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) throw toApiError(response.status, body);
      const record = asRecord(body);
      if (record === null || record.ok !== true) {
        const error = new Error(
          "the signals response was not an ok JSON object",
        );
        error.code = "invalid_response";
        error.status = response.status;
        throw error;
      }
      return record;
    }

    /**
     * POST one confirm-gated action. The CSRF header is the board's per-activation token;
     * `confirm: true` is always in the body. The caller always renders the refusal.
     * @param {Record<string, unknown>} payload
     * @param {string} csrfToken
     * @param {AbortSignal} signal
     * @returns {Promise<{ status: number, responseOk: boolean, body: unknown }>}
     */
    async function postAction(payload, csrfToken, signal) {
      const response = await fetch(ACTION_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(payload),
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, responseOk: response.ok, body };
    }

    /**
     * Normalize a thrown fetch failure into a code + message pair.
     * @param {unknown} error
     * @returns {{ code: string, message: string }}
     */
    function failureOf(error) {
      if (error !== null && typeof error === "object") {
        const code = stringOrNull(error.code);
        const message = stringOrNull(error.message);
        return {
          code: code === null ? "network_error" : code,
          message: message === null ? "" : message,
          status: numberOrNull(error.status),
        };
      }
      return { code: "network_error", message: String(error), status: null };
    }

    /* -------------------------------------------------------------------------- */
    /* Board state (mount-scoped fetch + poll)                                    */
    /* -------------------------------------------------------------------------- */

    /** Nothing measured yet: the page says "loading", never "all good". */
    const INITIAL_BOARD_STATE = Object.freeze({
      board: null,
      receivedAt: null,
      error: null,
      loading: true,
    });

    /**
     * Read the persisted operator name; storage may be unavailable (private mode), in which
     * case the field still works for this page but does not persist.
     * @returns {string}
     */
    function readStoredOperator() {
      try {
        if (typeof window === "undefined" || !window.localStorage) return "";
        const value = window.localStorage.getItem(OPERATOR_STORAGE_KEY);
        return typeof value === "string" ? value : "";
      } catch {
        return "";
      }
    }

    /**
     * Persist the operator name. A storage failure is not a reason to lose the field.
     * @param {string} value
     */
    function storeOperator(value) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.setItem(OPERATOR_STORAGE_KEY, value);
      } catch {
        /* the field keeps working for this page */
      }
    }

    /**
     * Operator identity, persisted in localStorage so it survives panel switches and reloads.
     * @returns {[string, (next: string) => void]}
     */
    function useOperator() {
      const [operator, setOperator] = React.useState(readStoredOperator);
      React.useEffect(() => {
        storeOperator(operator);
      }, [operator]);
      return [operator, setOperator];
    }

    /**
     * The board lifecycle: fetch on mount, on Refresh, after actions and every 20 s while
     * visible. A failed fetch keeps the previous board (visibly stale). The in-flight board
     * request is aborted on unmount, and the poll timer + visibility listener are cleared by
     * the same cleanup. No mutation ever happens here.
     * @returns {{
     *   board: Record<string, unknown> | null,
     *   receivedAt: number | null,
     *   error: { code: string, message: string, at: number } | null,
     *   loading: boolean,
     *   fetching: boolean,
     *   refresh: () => void,
     *   applyBoard: (board: Record<string, unknown>) => void,
     * }}
     */
    function useBoard() {
      const [state, setState] = React.useState(INITIAL_BOARD_STATE);
      const [fetching, setFetching] = React.useState(false);
      const alive = React.useRef(true);
      const inFlight = React.useRef(null);

      const load = React.useCallback(async (options) => {
        const silent = options !== undefined && options.silent === true;
        const force = options !== undefined && options.force === true;
        const pending = inFlight.current;
        if (pending !== null) {
          if (!force) return; // a poll never stacks requests
          pending.abort();
        }
        const controller = new AbortController();
        inFlight.current = controller;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, BOARD_TIMEOUT_MS);
        if (!silent) setFetching(true);

        let outcome;
        try {
          const board = await fetchBoard(controller.signal);
          outcome = { kind: "ok", board };
        } catch (error) {
          if (timedOut) {
            outcome = {
              kind: "error",
              failure: { code: "timeout", message: "" },
            };
          } else if (
            error !== null &&
            typeof error === "object" &&
            error.name === "AbortError"
          ) {
            outcome = {
              kind: "error",
              failure: { code: "aborted", message: "" },
            };
          } else {
            outcome = { kind: "error", failure: failureOf(error) };
          }
        } finally {
          clearTimeout(timeout);
        }
        if (!alive.current || inFlight.current !== controller) return;
        inFlight.current = null;
        if (!silent) setFetching(false);
        const at = Date.now();
        setState((previous) =>
          outcome.kind === "ok"
            ? {
                board: outcome.board,
                receivedAt: at,
                error: null,
                loading: false,
              }
            : {
                board: previous.board,
                receivedAt: previous.receivedAt,
                error: {
                  code: outcome.failure.code,
                  message: outcome.failure.message,
                  at,
                },
                loading: false,
              },
        );
      }, []);

      /**
       * Adopt a board that came back inside an action response. The POST board is the same
       * shape as GET but may omit the per-activation CSRF token, so the previous token is
       * kept so the next action still works.
       */
      const applyBoard = React.useCallback((board) => {
        if (!alive.current) return;
        setState((previous) => {
          const previousToken =
            previous.board !== null &&
            typeof previous.board.csrfToken === "string"
              ? previous.board.csrfToken
              : null;
          const incomingToken =
            board !== null && typeof board.csrfToken === "string"
              ? board.csrfToken
              : previousToken;
          const merged =
            incomingToken === null || typeof board.csrfToken === "string"
              ? board
              : { ...board, csrfToken: incomingToken };
          return {
            board: merged,
            receivedAt: Date.now(),
            error: null,
            loading: false,
          };
        });
      }, []);

      const refresh = React.useCallback(() => {
        void load({ force: true });
      }, [load]);

      React.useEffect(() => {
        alive.current = true;
        void load({});
        let timer = null;
        const visible = () =>
          typeof document === "undefined" ||
          document.visibilityState !== "hidden";
        const stopPolling = () => {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        };
        const startPolling = () => {
          stopPolling();
          timer = setInterval(() => {
            if (visible()) void load({ silent: true });
          }, POLL_MS);
        };
        if (visible()) startPolling();
        const onVisibilityChange = () => {
          if (!alive.current) return;
          if (visible()) {
            void load({ silent: true });
            startPolling();
          } else {
            stopPolling();
          }
        };
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", onVisibilityChange);
        }
        return () => {
          alive.current = false;
          stopPolling();
          if (typeof document !== "undefined") {
            document.removeEventListener(
              "visibilitychange",
              onVisibilityChange,
            );
          }
          const pending = inFlight.current;
          inFlight.current = null;
          if (pending !== null) pending.abort();
        };
      }, [load]);

      return {
        board: state.board,
        receivedAt: state.receivedAt,
        error: state.error,
        loading: state.loading,
        fetching,
        refresh,
        applyBoard,
      };
    }

    /** Nothing measured yet for the signals inspector: the panel says "loading", never zeros. */
    const INITIAL_SIGNALS_STATE = Object.freeze({
      payload: null,
      receivedAt: null,
      error: null,
      fetching: false,
    });

    /**
     * The signals inspector lifecycle. Fetching is activation-scoped: the first Signals-tab
     * activation fetches, header Refresh refetches only while the tab is active, and a
     * successful enqueue refetches the payload. One AbortController per fetch; a forced
     * refresh aborts the request it supersedes, and the unmount cleanup aborts the last one.
     * A failed refresh after a good payload keeps the payload visible (the panel marks it
     * stale with `receivedAt`), and nothing publishes after disposal.
     * @param {boolean} active
     * @returns {{
     *   payload: Record<string, unknown> | null,
     *   receivedAt: number | null,
     *   error: { code: string, message: string, status: number | null, at: number } | null,
     *   fetching: boolean,
     *   load: (options?: { force?: boolean, silent?: boolean }) => Promise<void>,
     * }}
     */
    function useSignals(active) {
      const [state, setState] = React.useState(INITIAL_SIGNALS_STATE);
      const alive = React.useRef(true);
      const inFlight = React.useRef(null);

      const load = React.useCallback(async (options) => {
        const silent = options !== undefined && options.silent === true;
        const force = options !== undefined && options.force === true;
        const pending = inFlight.current;
        if (pending !== null) {
          if (!force) return; // a normal refresh never stacks requests
          pending.abort();
        }
        const controller = new AbortController();
        inFlight.current = controller;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, SIGNALS_TIMEOUT_MS);
        if (!silent) setState((previous) => ({ ...previous, fetching: true }));

        let outcome;
        try {
          const payload = await fetchSignals(controller.signal);
          outcome = { kind: "ok", payload };
        } catch (error) {
          if (timedOut) {
            outcome = {
              kind: "error",
              failure: { code: "timeout", message: "", status: null },
            };
          } else if (
            error !== null &&
            typeof error === "object" &&
            error.name === "AbortError"
          ) {
            outcome = {
              kind: "error",
              failure: { code: "aborted", message: "", status: null },
            };
          } else {
            outcome = { kind: "error", failure: failureOf(error) };
          }
        } finally {
          clearTimeout(timeout);
        }
        if (!alive.current || inFlight.current !== controller) return;
        inFlight.current = null;
        const at = Date.now();
        setState((previous) =>
          outcome.kind === "ok"
            ? {
                payload: outcome.payload,
                receivedAt: at,
                error: null,
                fetching: false,
              }
            : {
                payload: previous.payload,
                receivedAt: previous.receivedAt,
                error: {
                  code: outcome.failure.code,
                  message: outcome.failure.message,
                  status: outcome.failure.status,
                  at,
                },
                fetching: false,
              },
        );
      }, []);

      React.useEffect(() => {
        if (!active) return;
        if (state.payload !== null || state.error !== null) return;
        if (inFlight.current !== null) return;
        void load({});
      }, [active, state.payload, state.error, load]);

      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          const pending = inFlight.current;
          inFlight.current = null;
          if (pending !== null) pending.abort();
        };
      }, []);

      return {
        payload: state.payload,
        receivedAt: state.receivedAt,
        error: state.error,
        fetching: state.fetching,
        load,
      };
    }

    /* -------------------------------------------------------------------------- */
    /* Localized failure / success text                                          */
    /* -------------------------------------------------------------------------- */

    /**
     * Render a board/action failure as code + message. CLI refusals keep the CLI's own
     * `error.code` and `error.message` so the operator can act on them.
     * @param {(key: string, params?: object) => string} t
     * @param {{ code?: string, message?: string }} failure
     * @returns {string}
     */
    function describeFailure(t, failure) {
      const code =
        failure === null || failure === undefined
          ? null
          : stringOrNull(failure.code);
      const message =
        failure === null || failure === undefined
          ? null
          : stringOrNull(failure.message);
      if (code === "actor_required") return t("actorRequired");
      if (code === "csrf_unavailable") return t("csrfUnavailable");
      if (code === "busy") return t("busy");
      if (code === "action_timeout") return t("actionTimeout");
      if (code === "timeout") return t("errorTimeout");
      if (code === "invalid_response") return t("errorInvalidResponse");
      if (code === null) return t("errorCodeOnly", { code: "unknown_error" });
      return message === null
        ? t("errorCodeOnly", { code })
        : t("errorDetail", { code, message });
    }

    /**
     * Render a signals failure. A 404 means the installed Host bundle predates the route,
     * so the operator is told to update rather than shown a bare HTTP code; every other
     * failure keeps the route's machine reason and message.
     * @param {(key: string, params?: object) => string} t
     * @param {{ code?: string, message?: string, status?: number | null } | null} failure
     * @returns {string}
     */
    function signalsFailureText(t, failure) {
      const code =
        failure === null || failure === undefined
          ? null
          : stringOrNull(failure.code);
      const status =
        failure === null || failure === undefined
          ? null
          : numberOrNull(failure.status);
      if (status === 404 || code === "http_404") {
        return t("signalsRouteMissing");
      }
      return describeFailure(t, failure);
    }

    /**
     * Success copy for one intent-scoped action, using the CLI payload where available.
     * @param {(key: string, params?: object) => string} t
     * @param {string} action
     * @param {string} intentId
     * @param {unknown} cli
     * @returns {string}
     */
    function successTextFor(t, action, intentId, cli) {
      const answer = asRecord(cli);
      if (action === "approve") return t("successApprove", { intentId });
      if (action === "reject") return t("successReject", { intentId });
      if (action === "execute") return t("successExecute", { intentId });
      if (action === "settle") {
        const settlement = answer === null ? null : asRecord(answer.settlement);
        const result =
          settlement === null ? null : stringOrNull(settlement.result);
        return result === null
          ? t("successSettle", { intentId })
          : t("successSettleResult", {
              intentId,
              result: settlementLabel(t, result),
            });
      }
      return t("successGeneric", {
        action: actionLabel(t, action) || action,
      });
    }

    /**
     * Success copy for the plan-wide enqueue action.
     * @param {(key: string, params?: object) => string} t
     * @param {unknown} cli
     * @returns {string}
     */
    function enqueueSuccessText(t, cli) {
      const answer = asRecord(cli);
      const created =
        answer !== null && Array.isArray(answer.created)
          ? answer.created.length
          : null;
      if (created === null) return t("successEnqueueGeneric");
      return created === 0
        ? t("successEnqueueNone")
        : t("successEnqueue", { count: created });
    }

    /* -------------------------------------------------------------------------- */
    /* CSS: one static string, class prefix wab-, host tokens only                */
    /* -------------------------------------------------------------------------- */

    const CSS = `
.wab-page { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.55; }
.wab-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.wab-content { max-width: 1400px; margin: 0 auto; padding: 0 clamp(16px, 3vw, 40px) 56px; }
.wab-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 24px; margin-bottom: 16px; }
.wab-heading { flex: 1 1 340px; min-width: 0; }
.wab-heading h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.wab-sub { margin: 6px 0 0; max-width: 82ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.wab-head-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.wab-badge { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 1px solid var(--dsw-alias-state-success-primary); border-radius: 999px; color: var(--dsw-alias-state-success-primary); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; line-height: 18px; }
.wab-badge[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wab-badge[data-tone='error'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.wab-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wab-chip[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wab-chip[data-tone='success'] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wab-chip[data-tone='error'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.wab-head-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px; }
.wab-field { display: flex; flex-direction: column; gap: 4px; min-width: 220px; }
.wab-label { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.wab-input, .wab-textarea { box-sizing: border-box; width: 100%; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; }
.wab-textarea { min-height: 56px; resize: vertical; }
.wab-input:focus-visible, .wab-textarea:focus-visible, .wab-btn:focus-visible, .wab-card-select:focus-visible, .wab-notice-close:focus-visible, .wab-tab:focus-visible, .wab-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.wab-input:disabled, .wab-textarea:disabled { opacity: 0.6; }
.wab-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; cursor: pointer; }
.wab-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.wab-btn:disabled { cursor: not-allowed; opacity: 0.55; }
.wab-btn-primary { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 500; }
.wab-btn-danger { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.wab-notice { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 14px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1); border-left: 3px solid var(--dsw-alias-brand-primary); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); font-size: 13px; line-height: 20px; }
.wab-notice[data-kind='error'] { border-left-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.wab-notice-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.wab-notice-close { flex: none; border: 0; background: transparent; color: inherit; font: inherit; font-size: 16px; line-height: 1; padding: 0 2px; cursor: pointer; }
.wab-stale { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 14px; padding: 8px 12px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); font-size: 12px; line-height: 18px; }
.wab-stale-text { flex: 1 1 320px; min-width: 0; margin: 0; }
.wab-stale-error { flex: 1 1 100%; min-width: 0; margin: 0; color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.wab-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 10px; margin-bottom: 14px; }
.wab-stat { min-width: 0; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; letter-spacing: 0.02em; text-transform: uppercase; }
.wab-stat-value { margin-top: 2px; font-size: 16px; line-height: 22px; font-weight: 500; overflow-wrap: anywhere; }
.wab-stat-note { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; overflow-wrap: anywhere; }
.wab-cap-bar { height: 5px; margin-top: 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.wab-cap-bar > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.wab-attention { margin: 0 0 14px; padding: 10px 12px; border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-attention-title { margin: 0 0 6px; font-size: 13px; line-height: 18px; font-weight: 500; }
.wab-attention-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.wab-attention-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wab-attention-text { flex: 1 1 260px; min-width: 0; }
.wab-scan-form { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wab-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 400px); gap: 18px; align-items: start; }
.wab-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wab-main-title { margin: 0; font-size: 15px; line-height: 22px; font-weight: 500; }
.wab-aside { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wab-section { display: flex; flex-direction: column; gap: 8px; }
.wab-section-head { display: flex; align-items: center; gap: 8px; }
.wab-section-title { margin: 0; font-size: 13px; line-height: 18px; font-weight: 500; }
.wab-count { padding: 0 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wab-cards { display: flex; flex-direction: column; gap: 8px; }
.wab-card { display: flex; flex-direction: column; gap: 8px; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-card[data-selected='true'] { border-color: var(--dsw-alias-brand-primary); }
.wab-card-select { display: flex; flex-direction: column; gap: 4px; box-sizing: border-box; width: 100%; padding: 10px; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.wab-card-select:hover { background: var(--dsw-alias-bg-layer-2); }
.wab-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wab-card-title { flex: 1 1 260px; min-width: 0; font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
.wab-status { display: inline-flex; align-items: center; padding: 0 7px; border: 1px solid var(--dsw-alias-state-idle-primary); border-radius: 999px; color: var(--dsw-alias-state-idle-primary); font-size: 11px; line-height: 17px; letter-spacing: 0.03em; text-transform: uppercase; }
.wab-status[data-status='approved'] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.wab-status[data-status='filled'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.wab-status[data-status='settled'] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.wab-status[data-status='rejected'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.wab-status[data-status='expired'] { border-color: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-state-idle-primary); }
.wab-card-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; }
.wab-card-meta > span { white-space: nowrap; }
.wab-card-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 10px 8px; }
.wab-card-hint { flex: 1 1 220px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; }
.wab-form { display: flex; flex-direction: column; gap: 8px; margin: 0 6px 6px; padding: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wab-form-row { display: flex; flex-direction: column; gap: 4px; }
.wab-form-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wab-form-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.wab-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; }
.wab-prose { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 19px; }
.wab-empty { margin: 0; padding: 18px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 10px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; text-align: center; }
.wab-ledger-note { margin: 0 0 14px; color: var(--dsw-alias-state-warn-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.wab-panel { min-width: 0; padding: 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-panel-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.wab-panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.wab-context-market { margin: 8px 0 0; font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
.wab-subsection { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wab-subtitle { margin: 0 0 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-weight: 500; letter-spacing: 0.03em; text-transform: uppercase; }
.wab-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px 12px; margin: 10px 0 0; }
.wab-kv-item { min-width: 0; }
.wab-kv dt { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 15px; }
.wab-kv dd { margin: 1px 0 0; font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.wab-math { margin: 0 0 6px; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-2); font-size: 12px; line-height: 17px; overflow-wrap: anywhere; }
.wab-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.wab-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.wab-table-wrap { margin-top: 6px; overflow-x: auto; }
.wab-table { width: 100%; border-collapse: collapse; font-size: 12px; line-height: 17px; }
.wab-table caption { padding-bottom: 4px; color: var(--dsw-alias-label-secondary); font-size: 11px; text-align: left; }
.wab-table th { padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); font-weight: 500; text-align: left; white-space: nowrap; }
.wab-table td { padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; overflow-wrap: anywhere; }
.wab-gates { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.wab-gate { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 12px; line-height: 17px; }
.wab-gate:last-child { border-bottom: 0; }
.wab-gate-check { flex: 1 1 90px; font-weight: 500; overflow-wrap: anywhere; }
.wab-gate-result { flex: none; }
.wab-gate[data-ok='true'] .wab-gate-result { color: var(--dsw-alias-state-success-primary); }
.wab-gate[data-ok='false'] .wab-gate-result { color: var(--dsw-alias-state-error-primary); }
.wab-gate-values { flex: 1 1 180px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.wab-gate-detail { flex: 1 1 100%; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.wab-decisions { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.wab-decision { padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.wab-decision:last-child { padding-bottom: 0; border-bottom: 0; }
.wab-decision-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wab-decision-action { color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; }
.wab-decision-market { flex: 1 1 160px; min-width: 0; overflow-wrap: anywhere; }
.wab-decision-text { margin-top: 2px; font-size: 12px; line-height: 17px; overflow-wrap: anywhere; white-space: pre-wrap; }
.wab-decision-label { color: var(--dsw-alias-label-secondary); }
.wab-sources { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.wab-source { padding: 0 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.wab-tone-positive { color: var(--dsw-alias-state-success-primary); }
.wab-tone-negative { color: var(--dsw-alias-state-error-primary); }
.wab-tone-warn { color: var(--dsw-alias-state-warn-primary); }
.wab-tone-idle { color: var(--dsw-alias-state-idle-primary); }
.wab-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.wab-loading, .wab-board-error { max-width: 720px; margin: 40px auto; padding: 18px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-board-error { border-color: var(--dsw-alias-state-error-primary); }
.wab-board-error h2 { margin: 0 0 6px; font-size: 15px; line-height: 21px; }
.wab-board-error p { margin: 0 0 10px; }
.wab-tabs { display: flex; flex-wrap: wrap; gap: 2px; margin: 0 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.wab-tab { box-sizing: border-box; min-height: 30px; margin-bottom: -1px; padding: 0 12px; border: 1px solid transparent; border-bottom: 2px solid transparent; border-radius: var(--dsw-radius-sm, 6px) var(--dsw-radius-sm, 6px) 0 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; cursor: pointer; }
.wab-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.wab-tab[aria-selected='true'] { border-bottom-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary); font-weight: 500; }
.wab-tabpanel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wab-tabpanel[hidden] { display: none; }
.wab-select { box-sizing: border-box; min-height: 28px; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; }
.wab-check { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: pointer; }
.wab-check input { margin: 0; accent-color: var(--dsw-alias-brand-primary); }
.wab-signals { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.wab-signals-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.wab-signals-controls { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 10px 14px; }
.wab-signals-enqueue { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.wab-signals-enqueue-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wab-candidates { display: flex; flex-direction: column; gap: 8px; padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.wab-candidates-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wab-candidates-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.wab-candidate { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.wab-candidate-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.wab-candidate-login { font-weight: 600; font-size: 13px; line-height: 19px; color: var(--dsw-alias-label-primary); }
.wab-candidate-markets { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wab-signal { gap: 6px; padding: 0; }
.wab-signal-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 10px 0; }
.wab-signal-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; padding: 0 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 17px; }
.wab-signal-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 10px; }
.wab-signal-id { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.wab-signal-reasons { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 0 10px; }
.wab-signal-reasons-label { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wab-signal-cohort { padding: 0 10px; }
.wab-signal-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 10px 10px; }
.wab-signal-expanded { padding: 0 10px 10px; }
.wab-signal[data-eligible='false'] { border-color: var(--dsw-alias-state-error-primary); }
@media (max-width: 1080px) { .wab-layout { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 640px) { .wab-head-controls { width: 100%; } .wab-field { flex: 1 1 100%; min-width: 0; } .wab-card-meta > span { white-space: normal; } }
`;

    /* -------------------------------------------------------------------------- */
    /* Small presentational components                                           */
    /* -------------------------------------------------------------------------- */

    /** Decorative sidebar glyph; the host owns the entry's color and label. */
    function ControlPlaneIcon({ size, active }) {
      const strokeWidth = active === true ? 1.9 : 1.6;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          "aria-hidden": true,
          focusable: "false",
          style: { display: "block" },
        },
        h("rect", {
          x: 4.25,
          y: 4.75,
          width: 15.5,
          height: 15,
          rx: 2.5,
          stroke: "currentColor",
          strokeWidth,
        }),
        h("path", {
          d: "M8.5 3.1h7",
          stroke: "currentColor",
          strokeWidth,
          strokeLinecap: "round",
        }),
        h("path", {
          d: "M8.2 9.4h5.1M8.2 12.7h3.1",
          stroke: "currentColor",
          strokeWidth,
          strokeLinecap: "round",
        }),
        h("path", {
          d: "M12.7 15.9l1.75 1.75 3.05-3.5",
          stroke: "currentColor",
          strokeWidth,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
      );
    }

    /** A status pill for an intent. */
    function StatusBadge({ t, status }) {
      const normalized = stringOrNull(status);
      return h(
        "span",
        {
          className: "wab-status",
          "data-status": normalized === null ? "unknown" : normalized,
        },
        statusLabel(t, normalized),
      );
    }

    /** One label/value cell inside the stat strip. */
    function Stat({ t, label, value, tone, note, title, meterPct }) {
      const text =
        value === null || value === undefined ? t("notAvailable") : value;
      const toneClass =
        tone === "positive"
          ? " wab-tone-positive"
          : tone === "negative"
            ? " wab-tone-negative"
            : tone === "warn"
              ? " wab-tone-warn"
              : "";
      return h(
        "div",
        { className: "wab-stat" },
        h("div", { className: "wab-stat-label" }, label),
        h(
          "div",
          {
            className: `wab-stat-value${toneClass}`,
            title:
              value === null || value === undefined ? t("notProvided") : title,
          },
          text,
        ),
        note ? h("div", { className: "wab-stat-note" }, note) : null,
        meterPct === null || meterPct === undefined
          ? null
          : h(
              "div",
              {
                className: "wab-cap-bar",
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(
                  Math.max(0, Math.min(100, meterPct)),
                ),
                "aria-label": t("statCap"),
              },
              h("span", {
                style: { width: `${Math.max(0, Math.min(100, meterPct))}%` },
              }),
            ),
      );
    }

    /** One label/value pair in the context panel. */
    function KeyValue({ label, value, title }) {
      return h(
        "div",
        { className: "wab-kv-item" },
        h("dt", null, label),
        h("dd", { title }, value),
      );
    }

    /* -------------------------------------------------------------------------- */
    /* Header                                                                     */
    /* -------------------------------------------------------------------------- */

    const Header = React.memo(function Header(props) {
      const { t, board, operator, onOperatorChange, fetching, onRefresh } =
        props;
      const now = Date.now();
      const sources = asArray(board === null ? null : board.sources).filter(
        (source) => asRecord(source) !== null,
      );
      const staleSources = sources.filter(
        (source) => source.stale === true,
      ).length;
      const hasSources = board !== null && Array.isArray(board.sources);
      const generatedAt = board === null ? null : board.generatedAt;
      const generatedRelative = relativeTime(t, generatedAt, now);
      const safety = asRecord(board === null ? null : board.safety);
      const liveExecution =
        safety === null ? null : booleanOrNull(safety.liveExecution);
      const operatorMissing = operator.trim() === "";

      let safetyBadge;
      if (liveExecution === true) {
        safetyBadge = h(
          "span",
          {
            className: "wab-badge",
            "data-tone": "error",
            title: t("liveExecutionReportedHint"),
          },
          t("liveExecutionReported"),
        );
      } else if (liveExecution === false) {
        safetyBadge = h(
          "span",
          { className: "wab-badge", title: t("paperOnlyHint") },
          t("paperOnly"),
        );
      } else {
        safetyBadge = h(
          "span",
          {
            className: "wab-badge",
            "data-tone": "warn",
            title: t("safetyUnknown"),
          },
          t("paperOnly"),
        );
      }

      let sourcesChip = null;
      if (board !== null) {
        if (!hasSources) {
          sourcesChip = h(
            "span",
            { className: "wab-chip" },
            t("sourcesUnknown"),
          );
        } else if (staleSources > 0) {
          sourcesChip = h(
            "span",
            { className: "wab-chip", "data-tone": "warn" },
            t("staleSourcesChip", { count: staleSources }),
          );
        } else {
          sourcesChip = h(
            "span",
            { className: "wab-chip", "data-tone": "success" },
            t("sourcesFresh"),
          );
        }
      }

      const snapshotChip =
        board === null
          ? null
          : h(
              "span",
              {
                className: "wab-chip",
                title: absoluteTime(generatedAt) || t("notProvided"),
              },
              generatedRelative === null
                ? t("snapshotUnknown")
                : t("snapshotChip", { age: generatedRelative }),
            );

      return h(
        "header",
        { className: "wab-head" },
        h(
          "div",
          { className: "wab-heading" },
          h("h1", null, t("title")),
          h("p", { className: "wab-sub" }, t("subtitle")),
          h(
            "div",
            { className: "wab-head-badges" },
            safetyBadge,
            sourcesChip,
            snapshotChip,
            operatorMissing
              ? h(
                  "span",
                  {
                    className: "wab-chip",
                    "data-tone": "warn",
                    id: "wab-operator-hint",
                  },
                  t("operatorRequiredHint"),
                )
              : null,
          ),
        ),
        h(
          "div",
          { className: "wab-head-controls" },
          h(
            "div",
            { className: "wab-field" },
            h(
              "label",
              { className: "wab-label", htmlFor: "wab-operator" },
              t("operator"),
            ),
            h("input", {
              id: "wab-operator",
              className: "wab-input",
              type: "text",
              value: operator,
              placeholder: t("operatorPlaceholder"),
              maxLength: ACTOR_MAX_LENGTH,
              autoComplete: "off",
              spellCheck: false,
              "aria-describedby": operatorMissing
                ? "wab-operator-hint"
                : undefined,
              onChange: (event) => onOperatorChange(event.target.value),
            }),
          ),
          h(
            "button",
            {
              type: "button",
              className: "wab-btn wab-btn-primary",
              onClick: onRefresh,
              disabled: fetching,
              "aria-busy": fetching ? "true" : "false",
            },
            fetching ? t("refreshing") : t("refresh"),
          ),
        ),
      );
    });

    /* -------------------------------------------------------------------------- */
    /* Stat strip, attention banner, notices                                      */
    /* -------------------------------------------------------------------------- */

    const StatStrip = React.memo(function StatStrip({ t, board }) {
      const queued = statusCount(board, "queued");
      const approved = statusCount(board, "approved");
      const filled = statusCount(board, "filled");
      const profit = summaryNumber(board, "profitUsd");
      const roiPct = summaryNumber(board, "roiPct");
      const staked = summaryNumber(board, "stakedUsd");
      const settledStake = summaryNumber(board, "settledStakeUsd");
      const caps = planCaps(board);
      const capUsed =
        caps === null ? null : numberOrNull(caps.dailyStakeUsedUsd);
      const capRemaining =
        caps === null ? null : numberOrNull(caps.remainingUsd);
      const capTotal =
        caps === null ? null : numberOrNull(caps.dailyStakeCapUsd);
      const ledger = readLedger(board);
      const generatedAt = board === null ? null : board.generatedAt;
      const generatedRelative = relativeTime(t, generatedAt, Date.now());
      const ledgerValue = !ledger.known
        ? null
        : ledger.exists === false
          ? t("ledgerMissing")
          : ledger.events === null
            ? null
            : ledger.events === 0
              ? t("ledgerEmpty")
              : t("ledgerEvents", { count: ledger.events });
      const profitTone =
        profit === null || profit === 0
          ? null
          : profit > 0
            ? "positive"
            : "negative";
      const meterPct =
        capUsed === null || capTotal === null || capTotal <= 0
          ? null
          : (capUsed / capTotal) * 100;
      const stakedValue =
        staked === null || settledStake === null
          ? (money(staked) ?? money(settledStake))
          : t("stakePair", {
              staked: money(staked),
              settled: money(settledStake),
            });
      const capValue =
        capUsed === null || capRemaining === null
          ? null
          : t("capPair", {
              used: money(capUsed),
              remaining: money(capRemaining),
            });

      return h(
        "section",
        { className: "wab-stats", "aria-label": t("statsTitle") },
        h(Stat, { t, label: t("statQueued"), value: plainNumber(queued) }),
        h(Stat, { t, label: t("statApproved"), value: plainNumber(approved) }),
        h(Stat, { t, label: t("statFilled"), value: plainNumber(filled) }),
        h(Stat, {
          t,
          label: t("statSettledPnl"),
          value: money(profit, { sign: true }),
          tone: profitTone,
          note:
            roiPct === null
              ? null
              : t("roiNote", { pct: percentPoints(roiPct) }),
        }),
        h(Stat, { t, label: t("statStaked"), value: stakedValue }),
        h(Stat, {
          t,
          label: t("statCap"),
          value: capValue,
          note: capTotal === null ? null : t("capOf", { cap: money(capTotal) }),
          meterPct,
        }),
        h(Stat, {
          t,
          label: t("statLedger"),
          value: ledgerValue,
          note: ledger.path,
          title: ledger.path,
        }),
        h(Stat, {
          t,
          label: t("statSnapshot"),
          value: generatedRelative,
          note: absoluteTime(generatedAt),
          title: absoluteTime(generatedAt),
        }),
      );
    });

    const AttentionBanner = React.memo(function AttentionBanner(props) {
      const { t, board, busyKey, runAction, notify } = props;
      const [scanOpen, setScanOpen] = React.useState(false);
      const [scanError, setScanError] = React.useState(null);
      const busy = busyKey !== null;
      const items = [];
      const sources = asArray(board === null ? null : board.sources).filter(
        (source) => asRecord(source) !== null,
      );
      const staleSources = sources.filter(
        (source) => source.stale === true,
      ).length;
      if (staleSources > 0) {
        items.push({
          key: "staleSources",
          text: t("attentionStaleSources", { count: staleSources }),
        });
      }
      const intents = boardIntents(board);
      const expiringSoon = intents.filter((intent) => {
        if (intent.status !== "queued") return false;
        const minutes = minutesUntilExpiry(intent);
        return (
          minutes !== null && minutes >= 0 && minutes <= EXPIRING_SOON_MINUTES
        );
      }).length;
      if (expiringSoon > 0) {
        items.push({
          key: "expiringSoon",
          text: t("attentionExpiring", {
            count: expiringSoon,
            minutes: EXPIRING_SOON_MINUTES,
          }),
        });
      }
      const approved = intents.filter(
        (intent) => intent.status === "approved",
      ).length;
      if (approved > 0) {
        items.push({
          key: "approved",
          text: t("attentionApproved", { count: approved }),
        });
      }
      const filled = intents.filter(
        (intent) => intent.status === "filled",
      ).length;
      if (filled > 0) {
        items.push({
          key: "filled",
          text: t("attentionFilled", { count: filled }),
        });
      }
      const wouldQueue = wouldQueueCount(board);
      if (wouldQueue !== null && wouldQueue > 0) {
        items.push({
          key: "wouldQueue",
          text: t("attentionWouldQueue", { count: wouldQueue }),
          actionable: true,
        });
      }
      if (items.length === 0) return null;

      const scan = async () => {
        const result = await runAction({ key: "enqueue", action: "enqueue" });
        if (result.ok) {
          setScanOpen(false);
          setScanError(null);
          notify({
            kind: "success",
            text: enqueueSuccessText(t, result.cli),
          });
        } else {
          setScanError(describeFailure(t, result));
        }
      };

      return h(
        "section",
        { className: "wab-attention", "aria-label": t("attentionTitle") },
        h("h2", { className: "wab-attention-title" }, t("attentionTitle")),
        h(
          "ul",
          { className: "wab-attention-list" },
          items.map((item) =>
            h(
              "li",
              { className: "wab-attention-item", key: item.key },
              h("span", {
                className:
                  item.actionable === true
                    ? "wab-dot wab-tone-idle"
                    : "wab-dot wab-tone-warn",
                "aria-hidden": true,
              }),
              h("span", { className: "wab-attention-text" }, item.text),
              item.actionable === true
                ? h(
                    "button",
                    {
                      type: "button",
                      className: "wab-btn wab-btn-primary",
                      disabled: busy,
                      title: busy ? t("busy") : t("scanQueueHint"),
                      "aria-expanded": scanOpen ? "true" : "false",
                      onClick: () => {
                        setScanError(null);
                        setScanOpen((open) => !open);
                      },
                    },
                    t("scanQueue"),
                  )
                : null,
            ),
          ),
        ),
        scanOpen
          ? h(
              "div",
              { className: "wab-scan-form" },
              h("p", { className: "wab-hint" }, t("scanQueueHint")),
              scanError === null
                ? null
                : h(
                    "p",
                    { className: "wab-form-error", role: "alert" },
                    scanError,
                  ),
              h(
                "div",
                { className: "wab-form-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "wab-btn wab-btn-primary",
                    disabled: busy,
                    onClick: () => {
                      void scan();
                    },
                  },
                  busy ? t("working") : t("confirmScanQueue"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wab-btn",
                    disabled: busy,
                    onClick: () => {
                      setScanOpen(false);
                      setScanError(null);
                    },
                  },
                  t("cancel"),
                ),
              ),
            )
          : null,
      );
    });

    function NoticeBar({ t, notice, onDismiss }) {
      const isError = notice.kind === "error";
      return h(
        "div",
        {
          className: "wab-notice",
          "data-kind": isError ? "error" : "success",
          role: isError ? "alert" : "status",
          "aria-live": "polite",
        },
        h("span", { className: "wab-notice-text" }, notice.text),
        h(
          "button",
          {
            type: "button",
            className: "wab-notice-close",
            onClick: onDismiss,
            "aria-label": t("dismiss"),
          },
          "×",
        ),
      );
    }

    function StaleBanner({ t, error, receivedAt, onRetry, failureText }) {
      const time =
        receivedAt === null
          ? t("notAvailable")
          : new Date(receivedAt).toLocaleTimeString();
      return h(
        "div",
        { className: "wab-stale", role: "status" },
        h("p", { className: "wab-stale-text" }, t("staleSince", { time })),
        h(
          "p",
          { className: "wab-stale-error" },
          failureText === undefined ? describeFailure(t, error) : failureText,
        ),
        h(
          "button",
          { type: "button", className: "wab-btn", onClick: onRetry },
          t("retry"),
        ),
      );
    }

    function BoardErrorState({ t, error, onRetry }) {
      return h(
        "div",
        { className: "wab-board-error", role: "alert" },
        h("h2", null, t("fetchFailedTitle")),
        h("p", { className: "wab-prose" }, t("fetchFailedBody")),
        h("p", { className: "wab-form-error" }, describeFailure(t, error)),
        h(
          "button",
          {
            type: "button",
            className: "wab-btn wab-btn-primary",
            onClick: onRetry,
          },
          t("retry"),
        ),
      );
    }

    function LoadingState({ t }) {
      return h(
        "div",
        { className: "wab-loading", role: "status", "aria-live": "polite" },
        h("p", { className: "wab-prose" }, t("loading")),
      );
    }

    /* -------------------------------------------------------------------------- */
    /* Action form + intent card                                                   */
    /* -------------------------------------------------------------------------- */

    /** Which forms a card offers, by derived status. Actions are unchanged transitions. */
    const CARD_ACTIONS = Object.freeze({
      queued: Object.freeze([
        Object.freeze({
          mode: "approve",
          labelKey: "actionApprove",
          tone: "primary",
          needsActor: true,
        }),
        Object.freeze({
          mode: "reject",
          labelKey: "actionReject",
          tone: "danger",
          needsActor: true,
        }),
      ]),
      approved: Object.freeze([
        Object.freeze({
          mode: "execute",
          labelKey: "actionExecute",
          tone: "primary",
          needsActor: false,
        }),
        Object.freeze({
          mode: "reject",
          labelKey: "actionReject",
          tone: "danger",
          needsActor: true,
        }),
      ]),
      filled: Object.freeze([
        Object.freeze({
          mode: "settle",
          labelKey: "actionSettle",
          tone: "primary",
          needsActor: false,
        }),
      ]),
    });

    /** Confirm-button key per form mode. */
    const CONFIRM_KEY_BY_MODE = Object.freeze({
      approve: "confirmApprove",
      reject: "confirmReject",
      execute: "confirmExecute",
    });

    /** Hint key per form mode. */
    const FORM_HINT_KEY = Object.freeze({
      approve: "approveHint",
      reject: "rejectHint",
      execute: "executeHint",
      settle: "settleHint",
    });

    /** Form title key per mode. */
    const FORM_TITLE_KEY = Object.freeze({
      approve: "actionApproveTitle",
      reject: "actionRejectTitle",
      execute: "actionExecuteTitle",
      settle: "actionSettleTitle",
    });

    /** Settlement result -> confirm-button key. */
    const SETTLE_CONFIRM_KEYS = Object.freeze({
      won: "confirmWon",
      lost: "confirmLost",
      void: "confirmVoid",
    });

    /**
     * The inline, confirm-gated form for one card action. It never calls the API itself:
     * the card owns the request and the in-flight/refusal state.
     */
    const ActionForm = React.memo(function ActionForm(props) {
      const { t, mode, busy, errorText, onSubmit, onCancel } = props;
      const [note, setNote] = React.useState("");
      const [reason, setReason] = React.useState("");
      const [localError, setLocalError] = React.useState(null);
      const suffix = sanitizeId(
        props.fieldId === undefined ? mode : props.fieldId,
      );
      const noteId = `wab-note-${suffix}`;
      const reasonId = `wab-reason-${suffix}`;
      const needsNote = mode === "approve";
      const needsReason = mode === "reject";
      const isSettle = mode === "settle";
      const error = localError === null ? errorText : localError;

      const submit = (event) => {
        if (event !== undefined && event !== null && event.preventDefault) {
          event.preventDefault();
        }
        if (needsReason && reason.trim() === "") {
          setLocalError(t("reasonRequired"));
          return;
        }
        setLocalError(null);
        if (isSettle) return;
        if (needsNote) {
          const trimmed = note.trim();
          onSubmit(trimmed === "" ? {} : { note: trimmed });
          return;
        }
        onSubmit({});
      };

      const isTextForm = needsNote || needsReason;
      const textValue = needsNote ? note : reason;
      const fieldId = needsNote ? noteId : reasonId;
      const formTitle = t(FORM_TITLE_KEY[mode]);

      return h(
        "form",
        {
          className: "wab-form",
          "aria-label": formTitle,
          onSubmit: submit,
        },
        isTextForm
          ? h(
              "div",
              { className: "wab-form-row" },
              h(
                "label",
                { className: "wab-label", htmlFor: fieldId },
                needsNote ? t("noteLabel") : t("reasonLabel"),
              ),
              h("textarea", {
                id: fieldId,
                className: "wab-textarea",
                value: textValue,
                rows: 2,
                maxLength: FREE_TEXT_MAX_LENGTH,
                required: needsReason,
                "aria-required": needsReason ? "true" : undefined,
                placeholder: needsNote
                  ? t("notePlaceholder")
                  : t("reasonPlaceholder"),
                disabled: busy,
                onChange: (event) => {
                  if (needsNote) setNote(event.target.value);
                  else setReason(event.target.value);
                },
              }),
            )
          : null,
        h("p", { className: "wab-hint" }, t(FORM_HINT_KEY[mode])),
        error === null || error === undefined
          ? null
          : h("p", { className: "wab-form-error", role: "alert" }, error),
        h(
          "div",
          { className: "wab-form-actions" },
          isSettle
            ? ["won", "lost", "void"].map((result) =>
                h(
                  "button",
                  {
                    key: result,
                    type: "button",
                    className: "wab-btn wab-btn-primary",
                    disabled: busy,
                    onClick: () => {
                      setLocalError(null);
                      onSubmit({ result });
                    },
                  },
                  t(SETTLE_CONFIRM_KEYS[result]),
                ),
              )
            : h(
                "button",
                {
                  type: "submit",
                  className:
                    mode === "reject"
                      ? "wab-btn wab-btn-danger"
                      : "wab-btn wab-btn-primary",
                  disabled: busy || (needsReason && reason.trim() === ""),
                },
                busy ? t("working") : t(CONFIRM_KEY_BY_MODE[mode]),
              ),
          h(
            "button",
            {
              type: "button",
              className: "wab-btn",
              disabled: busy,
              onClick: onCancel,
            },
            t("cancel"),
          ),
        ),
      );
    });

    /**
     * Build the POST request for one card action. Empty note/reason strings are omitted
     * because the server treats a provided empty free-text field as malformed.
     */
    function buildActionRequest(mode, intentId, values) {
      const base = { key: `${mode}:${intentId}`, action: mode, intentId };
      if (mode === "approve") {
        const note = stringOrNull(values.note);
        return note === null ? base : { ...base, note };
      }
      if (mode === "reject") {
        return { ...base, reason: values.reason };
      }
      if (mode === "settle") {
        return { ...base, result: values.result };
      }
      return base;
    }

    const IntentCard = React.memo(function IntentCard(props) {
      const {
        t,
        intent,
        selected,
        onSelect,
        actorMissing,
        actionBlock,
        busyKey,
        runAction,
        notify,
        now,
      } = props;
      const [form, setForm] = React.useState(null);
      const [formError, setFormError] = React.useState(null);
      const status = stringOrNull(intent.status);
      const actions = CARD_ACTIONS[status] ?? [];
      const busy = busyKey !== null;
      const accountsCount = Array.isArray(intent.accounts)
        ? intent.accounts.length
        : null;
      const sideLine = intentSideLine(intent);
      const meta = [];
      if (sideLine !== null) {
        meta.push(h("span", { key: "side" }, sideLine));
      }
      meta.push(
        h(
          "span",
          { key: "stake" },
          t("metaStake", { value: shown(t, money(intent.stakeUsd)) }),
        ),
        h(
          "span",
          { key: "confidence" },
          t("metaConfidence", {
            value: shown(t, plainNumber(intent.confidence)),
          }),
        ),
        h(
          "span",
          { key: "accounts" },
          t("metaAccounts", { count: shown(t, plainNumber(accountsCount)) }),
        ),
        h(
          "span",
          { key: "fair" },
          t("metaFair", { value: shown(t, percent(intent.fairProb)) }),
        ),
        h(
          "span",
          { key: "odds" },
          t("metaOdds", {
            value: shown(t, americanOdds(intent.referenceAmericanOdds)),
          }),
        ),
        h(
          "span",
          { key: "risk" },
          t("metaRisk", { value: shown(t, money(intent.riskUsd)) }),
        ),
        h(
          "span",
          { key: "created" },
          t("metaCreated", {
            value: shown(t, relativeTime(t, intent.createdAt, now)),
          }),
        ),
        h("span", { key: "expiry" }, expiryText(t, intent)),
        h(
          "span",
          { key: "next" },
          t("metaNext", { value: shown(t, actionLabel(t, intent.nextAction)) }),
        ),
      );

      const trigger = (mode) => {
        setFormError(null);
        setForm((current) => (current === mode ? null : mode));
      };

      const submit = async (values) => {
        if (form === null) return;
        const mode = form;
        const request = buildActionRequest(mode, intent.intentId, values);
        const result = await runAction(request);
        if (result.ok) {
          setForm(null);
          setFormError(null);
          notify({
            kind: "success",
            text: successTextFor(t, mode, intent.intentId, result.cli),
          });
        } else {
          setFormError(describeFailure(t, result));
        }
      };

      const disabledTitle = (needsActor) => {
        if (actionBlock !== null) return actionBlock;
        if (needsActor && actorMissing) return t("operatorRequiredHint");
        if (busy) return t("working");
        return undefined;
      };

      return h(
        "article",
        {
          className: "wab-card",
          "data-selected": selected ? "true" : "false",
        },
        h(
          "button",
          {
            type: "button",
            className: "wab-card-select",
            onClick: () => onSelect(intent.intentId),
            "aria-pressed": selected ? "true" : "false",
            "aria-label": t("selectIntent", {
              market: intentMarketLabel(intent),
            }),
          },
          h(
            "span",
            { className: "wab-card-head" },
            h(
              "span",
              { className: "wab-card-title" },
              intentMarketLabel(intent),
            ),
            h(StatusBadge, { t, status }),
          ),
          h("span", { className: "wab-card-meta" }, meta),
        ),
        h(
          "div",
          { className: "wab-card-actions" },
          actions.map((action) => {
            const title = disabledTitle(action.needsActor === true);
            return h(
              "button",
              {
                key: action.mode,
                type: "button",
                className:
                  action.tone === "danger"
                    ? "wab-btn wab-btn-danger"
                    : "wab-btn wab-btn-primary",
                disabled: title !== undefined,
                title,
                "aria-expanded": form === action.mode ? "true" : "false",
                onClick: () => trigger(action.mode),
              },
              t(action.labelKey),
            );
          }),
          actorMissing && (status === "queued" || status === "approved")
            ? h(
                "span",
                { className: "wab-card-hint" },
                t("operatorRequiredHint"),
              )
            : null,
        ),
        form === null
          ? null
          : h(ActionForm, {
              key: `form-${form}`,
              t,
              mode: form,
              busy,
              errorText: formError,
              fieldId: `${form}-${intent.intentId}`,
              onSubmit: (values) => {
                void submit(values);
              },
              onCancel: () => {
                setForm(null);
                setFormError(null);
              },
            }),
      );
    });

    const QueueSection = React.memo(function QueueSection(props) {
      const {
        t,
        titleKey,
        emptyKey,
        intents,
        selectedId,
        onSelect,
        actorMissing,
        actionBlock,
        busyKey,
        runAction,
        notify,
        now,
      } = props;
      return h(
        "section",
        { className: "wab-section" },
        h(
          "div",
          { className: "wab-section-head" },
          h("h3", { className: "wab-section-title" }, t(titleKey)),
          h("span", { className: "wab-count" }, String(intents.length)),
        ),
        intents.length === 0
          ? h("p", { className: "wab-prose" }, t(emptyKey))
          : h(
              "div",
              { className: "wab-cards" },
              intents.map((intent) =>
                h(IntentCard, {
                  key: intent.intentId,
                  t,
                  intent,
                  selected: selectedId === intent.intentId,
                  onSelect,
                  actorMissing,
                  actionBlock,
                  busyKey,
                  runAction,
                  notify,
                  now,
                }),
              ),
            ),
      );
    });

    /* -------------------------------------------------------------------------- */
    /* Context panel pieces                                                       */
    /* -------------------------------------------------------------------------- */

    function PaperFillDetails({ t, intent, fill }) {
      const stake = money(fill.stakeUsd) ?? money(intent.stakeUsd);
      const probability = percent(fill.effectiveImpliedProb);
      const payout = money(fill.payoutIfWinUsd);
      const math =
        stake === null || probability === null || payout === null
          ? null
          : t("paperMath", { stake, probability, payout });
      return h(
        "div",
        { className: "wab-subsection" },
        h("h3", { className: "wab-subtitle" }, t("paperFillTitle")),
        math === null
          ? h("p", { className: "wab-prose" }, t("fillIncomplete"))
          : h("p", { className: "wab-math" }, math),
        h(
          "dl",
          { className: "wab-kv" },
          h(KeyValue, {
            label: t("fillVenue"),
            value: shown(t, stringOrNull(fill.venue)),
          }),
          h(KeyValue, {
            label: t("fillAt"),
            value: shown(t, absoluteTime(fill.filledAt)),
            title: absoluteTime(fill.filledAt) || undefined,
          }),
          h(KeyValue, {
            label: t("fillEffective"),
            value: shown(t, percent(fill.effectiveImpliedProb)),
          }),
          h(KeyValue, {
            label: t("fillSlippage"),
            value: shown(
              t,
              numberOrNull(fill.slippageBps) === null
                ? null
                : `${fill.slippageBps} bps`,
            ),
          }),
          h(KeyValue, {
            label: t("fillPayout"),
            value: shown(t, money(fill.payoutIfWinUsd)),
          }),
        ),
      );
    }

    function SettlementDetails({ t, settlement }) {
      const profit = money(settlement.profitUsd, { sign: true });
      const tone =
        numberOrNull(settlement.profitUsd) === null
          ? null
          : settlement.profitUsd > 0
            ? "wab-tone-positive"
            : settlement.profitUsd < 0
              ? "wab-tone-negative"
              : null;
      return h(
        "div",
        { className: "wab-subsection" },
        h("h3", { className: "wab-subtitle" }, t("settlementTitle")),
        h(
          "dl",
          { className: "wab-kv" },
          h(KeyValue, {
            label: t("colResult"),
            value: settlementLabel(t, settlement.result),
          }),
          h(KeyValue, {
            label: t("settlementAt"),
            value: shown(t, absoluteTime(settlement.settledAt)),
            title: absoluteTime(settlement.settledAt) || undefined,
          }),
          h(KeyValue, {
            label: t("settlementProfit"),
            value: h(
              "span",
              { className: tone === null ? undefined : tone },
              shown(t, profit),
            ),
          }),
          h(KeyValue, {
            label: t("settlementPayout"),
            value: shown(t, money(settlement.payoutUsd)),
          }),
        ),
      );
    }

    function ProvenanceDetails({ t, provenance }) {
      const age = durationText(t, provenance.ageSeconds);
      const stale = booleanOrNull(provenance.stale);
      const fixture = booleanOrNull(provenance.fixture);
      const sources = asArray(provenance.sources).filter(
        (source) => typeof source === "string" && source.trim() !== "",
      );
      return h(
        "div",
        { className: "wab-subsection" },
        h("h3", { className: "wab-subtitle" }, t("provenanceTitle")),
        h(
          "dl",
          { className: "wab-kv" },
          h(KeyValue, {
            label: t("dataMode"),
            value: shown(t, stringOrNull(provenance.dataMode)),
          }),
          h(KeyValue, {
            label: t("asOf"),
            value: shown(
              t,
              absoluteTime(provenance.asOf) || stringOrNull(provenance.asOf),
            ),
            title: absoluteTime(provenance.asOf) || undefined,
          }),
          h(KeyValue, { label: t("ageLabel"), value: shown(t, age) }),
          h(KeyValue, {
            label: t("staleLabel"),
            value:
              stale === null
                ? t("unknown")
                : stale
                  ? h("span", { className: "wab-tone-warn" }, t("yes"))
                  : t("no"),
          }),
          h(KeyValue, {
            label: t("fixtureLabel"),
            value:
              fixture === null
                ? t("unknown")
                : fixture
                  ? h("span", { className: "wab-tone-warn" }, t("yes"))
                  : t("no"),
            title: fixture === true ? t("fixtureWarning") : undefined,
          }),
        ),
        sources.length === 0
          ? h("p", { className: "wab-prose" }, t("noSources"))
          : h(
              "ul",
              { className: "wab-sources", "aria-label": t("sourcesTitle") },
              sources.map((source) =>
                h(
                  "li",
                  { className: "wab-source wab-mono", key: source },
                  source,
                ),
              ),
            ),
      );
    }

    function AccountsTable({ t, accounts }) {
      if (accounts.length === 0) {
        return h(
          "div",
          { className: "wab-subsection" },
          h("h3", { className: "wab-subtitle" }, t("accountsTitle")),
          h("p", { className: "wab-prose" }, t("noAccounts")),
        );
      }
      return h(
        "div",
        { className: "wab-subsection" },
        h("h3", { className: "wab-subtitle" }, t("accountsTitle")),
        h(
          "div",
          { className: "wab-table-wrap" },
          h(
            "table",
            { className: "wab-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { scope: "col" }, t("colLogin")),
                h("th", { scope: "col" }, t("colAgent")),
                h("th", { scope: "col" }, t("colArchetype")),
                h("th", { scope: "col" }, t("colCategory")),
                h("th", { scope: "col" }, t("colRisk")),
              ),
            ),
            h(
              "tbody",
              null,
              accounts.map((account, index) =>
                h(
                  "tr",
                  {
                    key: `${stringOrNull(account.login) || "account"}-${index}`,
                  },
                  h("td", null, shown(t, stringOrNull(account.login))),
                  h("td", null, shown(t, stringOrNull(account.agentId))),
                  h("td", null, shown(t, stringOrNull(account.archetype))),
                  h("td", null, shown(t, stringOrNull(account.sourceCategory))),
                  h("td", null, shown(t, money(account.riskUsd))),
                ),
              ),
            ),
          ),
        ),
      );
    }

    function GatesList({ t, gates, labelChecks }) {
      if (gates.length === 0) {
        return h(
          "div",
          { className: "wab-subsection" },
          h("h3", { className: "wab-subtitle" }, t("gatesTitle")),
          h("p", { className: "wab-prose" }, t("noGates")),
        );
      }
      return h(
        "div",
        { className: "wab-subsection" },
        h("h3", { className: "wab-subtitle" }, t("gatesTitle")),
        h(
          "ul",
          { className: "wab-gates" },
          gates.map((gate, index) =>
            h(
              "li",
              {
                key: `${stringOrNull(gate.check) || "gate"}-${index}`,
                className: "wab-gate",
                "data-ok": gate.ok === true ? "true" : "false",
              },
              h(
                "span",
                { className: "wab-gate-check" },
                labelChecks === true
                  ? gateCheckLabel(t, gate.check)
                  : shown(t, stringOrNull(gate.check)),
              ),
              h(
                "span",
                { className: "wab-gate-result" },
                gate.ok === true ? t("gatePass") : t("gateFail"),
              ),
              h(
                "span",
                { className: "wab-gate-values" },
                h("code", null, compactJson(gate.actual)),
                " → ",
                h("code", null, compactJson(gate.required)),
              ),
              stringOrNull(gate.detail) === null
                ? null
                : h(
                    "span",
                    { className: "wab-gate-detail" },
                    stringOrNull(gate.detail),
                  ),
            ),
          ),
        ),
      );
    }

    /** The per-intent decision trail and the global recent feed share one list renderer. */
    const DecisionList = React.memo(function DecisionList(props) {
      const { t, decisions, emptyText, showMarket, now } = props;
      if (decisions.length === 0) {
        return h("p", { className: "wab-prose" }, emptyText);
      }
      return h(
        "ul",
        { className: "wab-decisions" },
        decisions.map((decision, index) => {
          const actor = shown(t, stringOrNull(decision.actor));
          const time =
            relativeTime(t, decision.at, now) ??
            absoluteTime(decision.at) ??
            t("notAvailable");
          const market = showMarket
            ? stringOrNull(decision.marketLabel) ||
              stringOrNull(decision.signalId) ||
              stringOrNull(decision.intentId)
            : null;
          const note = stringOrNull(decision.note);
          const reason = stringOrNull(decision.reason);
          return h(
            "li",
            {
              className: "wab-decision",
              key: `${stringOrNull(decision.intentId) || "intent"}-${stringOrNull(decision.type) || index}-${index}`,
            },
            h(
              "div",
              { className: "wab-decision-head" },
              h(
                "span",
                { className: "wab-decision-action" },
                shown(t, actionLabel(t, decision.action)),
              ),
              market === null
                ? null
                : h("span", { className: "wab-decision-market" }, market),
              h("span", null, t("decisionBy", { actor })),
              h(
                "span",
                { title: absoluteTime(decision.at) || undefined },
                time,
              ),
            ),
            note === null
              ? null
              : h(
                  "div",
                  { className: "wab-decision-text" },
                  h(
                    "span",
                    { className: "wab-decision-label" },
                    t("decisionNote"),
                  ),
                  ` ${note}`,
                ),
            reason === null
              ? null
              : h(
                  "div",
                  { className: "wab-decision-text" },
                  h(
                    "span",
                    { className: "wab-decision-label" },
                    t("decisionReason"),
                  ),
                  ` ${reason}`,
                ),
          );
        }),
      );
    });

    const ContextPanel = React.memo(function ContextPanel(props) {
      const { t, intent, decisions, decisionsKnown, now } = props;
      if (intent === null) {
        return h(
          "section",
          { className: "wab-panel", "aria-label": t("contextTitle") },
          h("h2", { className: "wab-panel-title" }, t("contextTitle")),
          h("p", { className: "wab-prose" }, t("noSelection")),
        );
      }
      const fill = asRecord(intent.fill);
      const settlement = asRecord(intent.settlement);
      const provenance = asRecord(intent.provenance);
      const accounts = asArray(intent.accounts).filter(
        (account) => asRecord(account) !== null,
      );
      const gates = asArray(intent.gates).filter(
        (gate) => asRecord(gate) !== null,
      );
      const trail = decisionsForIntent(
        { decisions },
        stringOrNull(intent.intentId) || "",
      );
      const accountsCount = Array.isArray(intent.accounts)
        ? intent.accounts.length
        : null;
      const created = relativeTime(t, intent.createdAt, now);
      const settledStatus = stringOrNull(intent.status) === "settled";

      return h(
        "section",
        { className: "wab-panel", "aria-label": t("contextTitle") },
        h(
          "div",
          { className: "wab-panel-head" },
          h("h2", { className: "wab-panel-title" }, t("contextTitle")),
          h(StatusBadge, { t, status: intent.status }),
        ),
        h("p", { className: "wab-context-market" }, intentMarketLabel(intent)),
        h(
          "dl",
          { className: "wab-kv" },
          h(KeyValue, {
            label: t("stakeDetail"),
            value: shown(t, money(intent.stakeUsd)),
          }),
          h(KeyValue, {
            label: t("statusDetail"),
            value: statusLabel(t, intent.status),
          }),
          h(KeyValue, {
            label: t("nextAction"),
            value: shown(t, actionLabel(t, intent.nextAction)),
          }),
          h(KeyValue, {
            label: t("referencePrice"),
            value: shown(t, referencePriceText(t, intent)),
          }),
          h(KeyValue, {
            label: t("riskDetail"),
            value: shown(t, money(intent.riskUsd)),
          }),
          h(KeyValue, {
            label: t("confidenceDetail"),
            value: shown(t, plainNumber(intent.confidence)),
          }),
          h(KeyValue, {
            label: t("accountsDetail"),
            value: shown(t, plainNumber(accountsCount)),
          }),
          h(KeyValue, {
            label: t("created"),
            value: shown(t, created),
          }),
          h(KeyValue, {
            label: t("expires"),
            value: expiryText(t, intent),
          }),
        ),
        fill === null
          ? h(
              "div",
              { className: "wab-subsection" },
              h("h3", { className: "wab-subtitle" }, t("paperFillTitle")),
              h("p", { className: "wab-prose" }, t("fillMissing")),
            )
          : h(PaperFillDetails, { t, intent, fill }),
        settlement === null
          ? settledStatus
            ? h(
                "div",
                { className: "wab-subsection" },
                h("h3", { className: "wab-subtitle" }, t("settlementTitle")),
                h("p", { className: "wab-prose" }, t("settlementMissing")),
              )
            : null
          : h(SettlementDetails, { t, settlement }),
        provenance === null
          ? h(
              "div",
              { className: "wab-subsection" },
              h("h3", { className: "wab-subtitle" }, t("provenanceTitle")),
              h("p", { className: "wab-prose" }, t("provenanceMissing")),
            )
          : h(ProvenanceDetails, { t, provenance }),
        h(AccountsTable, { t, accounts }),
        h(GatesList, { t, gates }),
        h(
          "div",
          { className: "wab-subsection" },
          h("h3", { className: "wab-subtitle" }, t("decisionTrailTitle")),
          h(DecisionList, {
            t,
            decisions: trail,
            emptyText:
              decisionsKnown === false ? t("decisionsUnknown") : t("noTrail"),
            showMarket: false,
            now,
          }),
        ),
      );
    });

    const RecentDecisions = React.memo(function RecentDecisions({
      t,
      decisions,
      decisionsKnown,
      now,
    }) {
      const recent = decisions.slice(0, RECENT_DECISIONS_LIMIT);
      return h(
        "section",
        { className: "wab-panel", "aria-label": t("recentDecisionsTitle") },
        h("h2", { className: "wab-panel-title" }, t("recentDecisionsTitle")),
        h("p", { className: "wab-prose" }, t("recentDecisionsSub")),
        h(
          "div",
          { style: { marginTop: 8 } },
          h(DecisionList, {
            t,
            decisions: recent,
            emptyText:
              decisionsKnown === false
                ? t("decisionsUnknown")
                : t("noDecisions"),
            showMarket: true,
            now,
          }),
        ),
      );
    });

    /* -------------------------------------------------------------------------- */
    /* Signals inspector                                                          */
    /* -------------------------------------------------------------------------- */

    /** Eligibility badge for one signal. */
    function SignalBadge({ t, eligible }) {
      return h(
        "span",
        { className: "wab-badge", "data-tone": eligible ? undefined : "error" },
        eligible ? t("signalsEligible") : t("signalsRefused"),
      );
    }

    /**
     * The capped account cohort of one signal. These are operator-only local data; the
     * first four rows render and the rest are summarized as a count.
     */
    function SignalAccounts({ t, accounts }) {
      if (accounts.length === 0) {
        return h("p", { className: "wab-prose" }, t("noAccounts"));
      }
      const cohort = accounts.slice(0, SIGNALS_ACCOUNT_ROWS);
      const extra = accounts.length - cohort.length;
      return h(
        "div",
        null,
        h("h4", { className: "wab-subtitle" }, t("accountsTitle")),
        h(
          "div",
          { className: "wab-table-wrap" },
          h(
            "table",
            { className: "wab-table" },
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                h("th", { scope: "col" }, t("colLogin")),
                h("th", { scope: "col" }, t("colAgent")),
                h("th", { scope: "col" }, t("colRisk")),
              ),
            ),
            h(
              "tbody",
              null,
              cohort.map((account, index) =>
                h(
                  "tr",
                  {
                    key: `${stringOrNull(account.login) || "account"}-${index}`,
                  },
                  h("td", null, shown(t, stringOrNull(account.login))),
                  h("td", null, shown(t, stringOrNull(account.agentId))),
                  h("td", null, shown(t, money(account.riskUsd))),
                ),
              ),
            ),
          ),
        ),
        extra > 0
          ? h(
              "p",
              { className: "wab-hint" },
              t("signalsMoreAccounts", { count: extra }),
            )
          : null,
      );
    }

    /**
     * One signal row in the Signals inspector: derived market label, eligibility, the
     * metrics behind the attention gates, refusal-reason chips, the account cohort and an
     * expandable list of every gate check with actual/required/detail.
     */
    const SignalCard = React.memo(function SignalCard(props) {
      const { t, entry, index, expanded, onToggle, now } = props;
      const signal = entrySignal(entry);
      const record = asRecord(signal);
      const gate = entryGate(entry);
      const eligible = gate !== null && gate.eligible === true;
      const checks = asArray(gate === null ? null : gate.checks).filter(
        (check) => asRecord(check) !== null,
      );
      const reasons = asArray(gate === null ? null : gate.reasons).filter(
        (reason) => typeof reason === "string" && reason.trim() !== "",
      );
      const confidenceCheck = findGateCheck(gate, "confidence");
      const accountsCheck = findGateCheck(gate, "distinct_accounts");
      const provenance = asRecord(record === null ? null : record.provenance);
      const accounts = asArray(record === null ? null : record.accounts).filter(
        (account) => asRecord(account) !== null,
      );
      const signalId = stringOrNull(record === null ? null : record.id);
      const rowId = sanitizeId(signalId === null ? `row-${index}` : signalId);
      const detailId = `wab-signal-checks-${rowId}`;
      const ageSeconds =
        provenance === null ? null : numberOrNull(provenance.ageSeconds);
      const age =
        ageSeconds === null
          ? relativeTime(t, provenance === null ? null : provenance.asOf, now)
          : durationText(t, ageSeconds);
      const confidenceActual =
        confidenceCheck === null ? null : numberOrNull(confidenceCheck.actual);
      const confidenceRequired =
        confidenceCheck === null
          ? null
          : numberOrNull(confidenceCheck.required);
      const accountsActual =
        accountsCheck === null ? null : numberOrNull(accountsCheck.actual);
      const accountsRequired =
        accountsCheck === null ? null : numberOrNull(accountsCheck.required);

      const meta = [
        h(
          "span",
          { key: "confidence" },
          t("signalsConfidence", {
            actual: shown(t, plainNumber(confidenceActual)),
            required: shown(t, plainNumber(confidenceRequired)),
          }),
        ),
        h(
          "span",
          { key: "accounts" },
          t("signalsAccounts", {
            actual: shown(t, plainNumber(accountsActual)),
            required: shown(t, plainNumber(accountsRequired)),
          }),
        ),
        h(
          "span",
          { key: "oneSided" },
          t("signalsOneSided", {
            value: shown(
              t,
              percent(record === null ? null : record.oneSidedShare),
            ),
          }),
        ),
        h(
          "span",
          { key: "fair" },
          t("metaFair", {
            value: shown(t, percent(record === null ? null : record.fairProb)),
          }),
        ),
        h(
          "span",
          { key: "ref" },
          t("signalsRefPrice", {
            value: shown(t, percent(record === null ? null : record.fairProb)),
          }),
        ),
        h(
          "span",
          { key: "risk" },
          t("metaRisk", {
            value: shown(t, money(record === null ? null : record.riskUsd)),
          }),
        ),
        h("span", { key: "age" }, t("signalsAge", { value: shown(t, age) })),
      ];

      const chips = [];
      if (provenance === null) {
        chips.push(
          h(
            "span",
            { className: "wab-chip", "data-tone": "warn", key: "provenance" },
            t("signalsProvenanceUnknown"),
          ),
        );
      } else {
        if (provenance.fixture === true) {
          chips.push(
            h(
              "span",
              {
                className: "wab-chip",
                "data-tone": "warn",
                key: "fixture",
                title: t("fixtureWarning"),
              },
              t("fixtureLabel"),
            ),
          );
        }
        if (provenance.stale === true) {
          chips.push(
            h(
              "span",
              { className: "wab-chip", "data-tone": "warn", key: "stale" },
              t("staleLabel"),
            ),
          );
        }
        const mode = stringOrNull(provenance.dataMode);
        if (mode !== null) {
          chips.push(
            h(
              "span",
              { className: "wab-chip", key: "dataMode" },
              t("signalsDataModeChip", { mode }),
            ),
          );
        }
      }
      if (signalId !== null) {
        chips.push(
          h(
            "span",
            { className: "wab-signal-id wab-mono", key: "signalId" },
            signalId,
          ),
        );
      }

      return h(
        "article",
        {
          className: "wab-card wab-signal",
          "data-eligible": eligible ? "true" : "false",
        },
        h(
          "div",
          { className: "wab-signal-head" },
          h("span", { className: "wab-card-title" }, signalMarketLabel(signal)),
          h(SignalBadge, { t, eligible }),
        ),
        h("div", { className: "wab-signal-meta" }, meta),
        h("div", { className: "wab-signal-chips" }, chips),
        reasons.length === 0
          ? null
          : h(
              "div",
              {
                className: "wab-signal-reasons",
                "aria-label": t("signalsReasonsTitle"),
              },
              h(
                "span",
                { className: "wab-signal-reasons-label" },
                t("signalsReasonsTitle"),
              ),
              reasons.map((reason, reasonIndex) =>
                h(
                  "span",
                  {
                    className: "wab-chip",
                    "data-tone": "error",
                    key: `${reason}-${reasonIndex}`,
                  },
                  gateCheckLabel(t, reason),
                ),
              ),
            ),
        h(
          "div",
          { className: "wab-signal-cohort" },
          h(SignalAccounts, { t, accounts }),
        ),
        h(
          "div",
          { className: "wab-signal-footer" },
          h(
            "button",
            {
              type: "button",
              className: "wab-btn",
              "aria-expanded": expanded ? "true" : "false",
              "aria-controls": detailId,
              onClick: () => onToggle(rowId),
            },
            expanded ? t("signalsDetailsHide") : t("signalsDetailsShow"),
          ),
        ),
        expanded
          ? h(
              "div",
              { className: "wab-signal-expanded", id: detailId },
              h(GatesList, { t, gates: checks, labelChecks: true }),
            )
          : null,
      );
    });

    /**
     * One unwatched-account row: who bet, how much the captures show, and when. It carries no
     * gate verdict on purpose — an account off the watchlist has no derived signal, and drawing
     * a verdict for it would be a fabricated contract.
     */
    const CandidateRow = React.memo(function CandidateRow(props) {
      const { t, candidate, index, now } = props;
      const record = asRecord(candidate) ?? {};
      const login = stringOrNull(record.login) || `#${index + 1}`;
      const risk = money(numberOrNull(record.riskUsd));
      const lastBet = relativeTime(t, stringOrNull(record.lastBetAt), now);
      const markets = asArray(record.sampleMarkets).filter(
        (market) => typeof market === "string" && market.trim() !== "",
      );
      const meta = candidateMeta(t, record);
      return h(
        "li",
        { className: "wab-candidate" },
        h(
          "div",
          { className: "wab-candidate-head" },
          h("span", { className: "wab-candidate-login" }, login),
          h(
            "span",
            { className: "wab-chip" },
            t("metaRisk", { value: shown(t, risk) }),
          ),
          h(
            "span",
            { className: "wab-chip" },
            lastBet === null
              ? t("signalsCandidateNoBet")
              : t("signalsCandidateLastBet", { age: lastBet }),
          ),
        ),
        meta === "" ? null : h("span", { className: "wab-hint" }, meta),
        markets.length === 0
          ? null
          : h("span", { className: "wab-candidate-markets" }, markets[0]),
      );
    });

    /**
     * The Signals tab body. Honest states: first load says loading (no fake zeros), a
     * 404 says the Host bundle is old, any other failure shows the reason + message with
     * Retry, and a failed refresh keeps the last payload visible and marked stale. The
     * enqueue control exists only when the payload reports eligible signals, requires the
     * operator name, and uses the shared two-step inline confirm + runAction wire format.
     */
    const SignalsPanel = React.memo(function SignalsPanel(props) {
      const {
        t,
        payload,
        receivedAt,
        error,
        fetching,
        actorMissing,
        actionBlock,
        busyKey,
        runAction,
        notify,
        onRetry,
        now,
      } = props;
      const [showRefused, setShowRefused] = React.useState(true);
      const [league, setLeague] = React.useState("all");
      const [expandedRows, setExpandedRows] = React.useState({});
      const [confirmOpen, setConfirmOpen] = React.useState(false);
      const [actionError, setActionError] = React.useState(null);
      const busy = busyKey !== null;
      const entries = signalEntries(payload);
      const known = entries !== null;
      const list = entries === null ? [] : entries;
      const total = signalCount(payload, "total");
      const eligibleCount = signalCount(payload, "eligible");
      const rejectedCount = signalCount(payload, "rejected");
      const leagues = signalLeagues(list);
      const activeLeague =
        league !== "all" && !leagues.includes(league) ? "all" : league;
      const visible = list.filter((entry) => {
        const gate = entryGate(entry);
        if (!showRefused && (gate === null || gate.eligible !== true)) {
          return false;
        }
        if (activeLeague !== "all") {
          const signal = entrySignal(entry);
          const entryLeague =
            signal === null ? null : stringOrNull(signal.league);
          if (entryLeague !== activeLeague) return false;
        }
        return true;
      });
      const generatedAt = payload === null ? null : payload.generatedAt;
      const generatedRelative = relativeTime(t, generatedAt, now);
      const receivedRelative =
        receivedAt === null
          ? null
          : relativeTime(t, new Date(receivedAt).toISOString(), now);
      const sources = asArray(payload === null ? null : payload.sources).filter(
        (source) => asRecord(source) !== null,
      );
      const sourcesKnown = payload !== null && Array.isArray(payload.sources);
      const staleSources = sources.filter(
        (source) => source.stale === true,
      ).length;
      const candidates = candidateEntries(payload);
      const candidateCount = signalCount(payload, "candidates");
      const enqueueBlocked = busy || actorMissing || actionBlock !== null;
      const enqueueTitle =
        actionBlock !== null
          ? actionBlock
          : actorMissing
            ? t("signalsActorRequired")
            : busy
              ? t("working")
              : undefined;

      const toggleRow = (rowId) => {
        setExpandedRows((current) => {
          const next = { ...current };
          if (next[rowId] === true) delete next[rowId];
          else next[rowId] = true;
          return next;
        });
      };

      const confirmEnqueue = async () => {
        const result = await runAction({
          key: "signals:enqueue",
          action: "enqueue",
        });
        if (result.ok) {
          setConfirmOpen(false);
          setActionError(null);
          notify({
            kind: "success",
            text: enqueueSuccessText(t, result.cli),
          });
        } else {
          setActionError(describeFailure(t, result));
        }
      };

      let view;
      if (payload === null) {
        view =
          error === null
            ? h(
                "p",
                {
                  className: "wab-prose",
                  role: "status",
                  "aria-live": "polite",
                },
                t("signalsLoading"),
              )
            : h(
                "div",
                { className: "wab-board-error", role: "alert" },
                h("h2", null, t("signalsErrorTitle")),
                h("p", { className: "wab-prose" }, t("signalsErrorBody")),
                h(
                  "p",
                  { className: "wab-form-error" },
                  signalsFailureText(t, error),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wab-btn wab-btn-primary",
                    onClick: onRetry,
                  },
                  t("retry"),
                ),
              );
      } else {
        const summary = h(
          "div",
          {
            className: "wab-signals-summary",
            role: "group",
            "aria-label": t("signalsSummaryLabel"),
            key: "summary",
          },
          h(
            "span",
            { className: "wab-chip" },
            t("signalsCountTotal", {
              count: shown(t, plainNumber(total)),
            }),
          ),
          h(
            "span",
            { className: "wab-chip", "data-tone": "success" },
            t("signalsCountEligible", {
              count: shown(t, plainNumber(eligibleCount)),
            }),
          ),
          h(
            "span",
            { className: "wab-chip", "data-tone": "warn" },
            t("signalsCountRejected", {
              count: shown(t, plainNumber(rejectedCount)),
            }),
          ),
          h(
            "span",
            {
              className: "wab-chip",
              title: absoluteTime(generatedAt) || t("notProvided"),
            },
            generatedRelative === null
              ? t("snapshotUnknown")
              : t("signalsGenerated", { age: generatedRelative }),
          ),
          h(
            "span",
            { className: "wab-chip" },
            receivedRelative === null
              ? t("notAvailable")
              : t("signalsReceived", { age: receivedRelative }),
          ),
          sourcesKnown
            ? staleSources > 0
              ? h(
                  "span",
                  { className: "wab-chip", "data-tone": "warn" },
                  t("staleSourcesChip", { count: staleSources }),
                )
              : h(
                  "span",
                  { className: "wab-chip", "data-tone": "success" },
                  t("sourcesFresh"),
                )
            : h("span", { className: "wab-chip" }, t("sourcesUnknown")),
          candidateCount !== null && candidateCount > 0
            ? h(
                "span",
                { className: "wab-chip", "data-tone": "warn" },
                t("signalsCandidatesCount", {
                  count: plainNumber(candidateCount),
                }),
              )
            : null,
        );
        const stale =
          error === null
            ? null
            : h(StaleBanner, {
                key: "stale",
                t,
                error,
                receivedAt,
                onRetry,
                failureText: signalsFailureText(t, error),
              });
        const controls = h(
          "div",
          {
            className: "wab-signals-controls",
            role: "group",
            "aria-label": t("signalsFiltersLabel"),
            key: "controls",
          },
          h(
            "label",
            { className: "wab-check" },
            h("input", {
              type: "checkbox",
              checked: showRefused,
              onChange: (event) =>
                setShowRefused(event.target.checked === true),
            }),
            t("signalsShowRefused"),
          ),
          h(
            "label",
            { className: "wab-field" },
            h("span", { className: "wab-label" }, t("signalsLeagueFilter")),
            h(
              "select",
              {
                className: "wab-select",
                value: activeLeague,
                onChange: (event) => setLeague(event.target.value),
              },
              h("option", { value: "all" }, t("signalsLeagueAll")),
              leagues.map((name) =>
                h("option", { key: name, value: name }, name),
              ),
            ),
          ),
          fetching
            ? h("span", { className: "wab-chip" }, t("refreshing"))
            : null,
        );
        const enqueue =
          eligibleCount !== null && eligibleCount > 0
            ? h(
                "div",
                { className: "wab-signals-enqueue", key: "enqueue" },
                h(
                  "div",
                  { className: "wab-signals-enqueue-actions" },
                  h(
                    "button",
                    {
                      type: "button",
                      className: "wab-btn wab-btn-primary",
                      disabled: enqueueBlocked,
                      title: enqueueTitle,
                      "aria-expanded": confirmOpen ? "true" : "false",
                      onClick: () => {
                        setActionError(null);
                        setConfirmOpen((open) => !open);
                      },
                    },
                    t("signalsEligibleEnqueue"),
                  ),
                  actorMissing
                    ? h(
                        "span",
                        { className: "wab-hint" },
                        t("signalsActorRequired"),
                      )
                    : null,
                ),
                confirmOpen
                  ? h(
                      "div",
                      { className: "wab-form" },
                      h(
                        "p",
                        { className: "wab-hint" },
                        t("signalsEnqueueHint"),
                      ),
                      actionError === null
                        ? null
                        : h(
                            "p",
                            { className: "wab-form-error", role: "alert" },
                            actionError,
                          ),
                      h(
                        "div",
                        { className: "wab-form-actions" },
                        h(
                          "button",
                          {
                            type: "button",
                            className: "wab-btn wab-btn-primary",
                            disabled:
                              busy || actorMissing || actionBlock !== null,
                            onClick: () => {
                              void confirmEnqueue();
                            },
                          },
                          busy ? t("working") : t("signalsConfirmEnqueue"),
                        ),
                        h(
                          "button",
                          {
                            type: "button",
                            className: "wab-btn",
                            disabled: busy,
                            onClick: () => {
                              setConfirmOpen(false);
                              setActionError(null);
                            },
                          },
                          t("cancel"),
                        ),
                      ),
                    )
                  : null,
              )
            : null;
        const listSection = !known
          ? h("p", { className: "wab-empty", key: "list" }, t("signalsUnknown"))
          : list.length === 0
            ? h("p", { className: "wab-empty", key: "list" }, t("signalsEmpty"))
            : visible.length === 0
              ? h(
                  "p",
                  { className: "wab-empty", key: "list" },
                  t("signalsNoMatches"),
                )
              : h(
                  "div",
                  { className: "wab-cards", key: "list" },
                  visible.map((entry, index) => {
                    const signal = entrySignal(entry);
                    const signalId =
                      signal === null ? null : stringOrNull(signal.id);
                    const rowId = sanitizeId(
                      signalId === null ? `row-${index}` : signalId,
                    );
                    return h(SignalCard, {
                      key: signalId === null ? `signal-${index}` : signalId,
                      t,
                      entry,
                      index,
                      expanded: expandedRows[rowId] === true,
                      onToggle: toggleRow,
                      now,
                    });
                  }),
                );
        const candidatesSection =
          candidates === null
            ? h(
                "p",
                { className: "wab-hint", key: "candidates" },
                t("signalsCandidatesUnknown"),
              )
            : h(
                "div",
                { className: "wab-candidates", key: "candidates" },
                h(
                  "div",
                  { className: "wab-candidates-head" },
                  h(
                    "h3",
                    { className: "wab-subtitle" },
                    t("signalsCandidatesTitle"),
                  ),
                  h(
                    "span",
                    { className: "wab-chip" },
                    t("signalsCandidatesCount", {
                      count: plainNumber(candidates.length),
                    }),
                  ),
                ),
                h("p", { className: "wab-hint" }, t("signalsCandidatesSub")),
                candidates.length === 0
                  ? h(
                      "p",
                      { className: "wab-empty" },
                      t("signalsCandidatesEmpty"),
                    )
                  : h(
                      "ul",
                      { className: "wab-candidates-list" },
                      candidates.map((candidate, index) =>
                        h(CandidateRow, {
                          key:
                            stringOrNull(candidate.login) ??
                            `candidate-${index}`,
                          t,
                          candidate,
                          index,
                          now,
                        }),
                      ),
                    ),
              );
        view = [
          summary,
          stale,
          controls,
          eligibleCount === 0
            ? h(
                "p",
                { className: "wab-hint", key: "noEligible" },
                t("signalsNoEligible"),
              )
            : null,
          enqueue,
          listSection,
          candidatesSection,
        ];
      }

      return h(
        "section",
        { className: "wab-signals", "aria-label": t("signalsTitle") },
        h(
          "div",
          { className: "wab-panel-head" },
          h("h2", { className: "wab-panel-title" }, t("signalsTitle")),
        ),
        h("p", { className: "wab-hint" }, t("signalsSub")),
        view,
      );
    });

    /* -------------------------------------------------------------------------- */
    /* The page                                                                   */
    /* -------------------------------------------------------------------------- */

    const ControlPlanePage = React.memo(function ControlPlanePage(props) {
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const boardState = useBoard();
      const [operator, setOperator] = useOperator();
      /** Body tab: Queue (default) or Signals. Only the Signals tab fetches signals. */
      const [tab, setTab] = React.useState("queue");
      const tabRefs = React.useRef({});
      const signals = useSignals(tab === "signals");
      const [notice, setNotice] = React.useState(null);
      const [selectedId, setSelectedId] = React.useState(null);
      const [busyKey, setBusyKey] = React.useState(null);
      const busyRef = React.useRef(null);
      const aliveRef = React.useRef(true);

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      /** Success notices are transient; error notices stay until dismissed. */
      React.useEffect(() => {
        if (notice === null || notice.kind !== "success") return undefined;
        const timer = setTimeout(() => {
          setNotice((current) => (current === notice ? null : current));
        }, NOTICE_MS);
        return () => {
          clearTimeout(timer);
        };
      }, [notice]);

      const notify = React.useCallback((next) => {
        if (aliveRef.current) setNotice(next);
      }, []);

      /**
       * Switch tabs and move focus to the newly selected tab (the click path naturally
       * focuses it already; the keyboard path needs this). Non-arrow keys are ignored so
       * Enter/Space keep their native button behaviour.
       */
      const selectTab = React.useCallback((next) => {
        setTab(next);
        const node = tabRefs.current[next];
        if (
          node !== null &&
          node !== undefined &&
          typeof node.focus === "function"
        ) {
          node.focus();
        }
      }, []);

      const onTabKeyDown = React.useCallback(
        (event, current) => {
          const index = TAB_ORDER.indexOf(current);
          if (index < 0) return;
          let nextIndex = null;
          if (event.key === "ArrowRight") {
            nextIndex = (index + 1) % TAB_ORDER.length;
          } else if (event.key === "ArrowLeft") {
            nextIndex = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = TAB_ORDER.length - 1;
          }
          if (nextIndex === null) return;
          if (typeof event.preventDefault === "function")
            event.preventDefault();
          selectTab(TAB_ORDER[nextIndex]);
        },
        [selectTab],
      );

      /** The signals inspector's Retry: one forced fetch, never a poll. */
      const retrySignals = React.useCallback(() => {
        void signals.load({ force: true });
      }, [signals.load]);

      /** Header Refresh: the board always, the signals payload only while that tab is active. */
      const refreshAll = React.useCallback(() => {
        boardState.refresh();
        if (tab === "signals") void signals.load({ force: true });
      }, [boardState.refresh, tab, signals.load]);

      const board = boardState.board;
      const decisions = boardDecisions(board);
      // A missing list is "unknown", never "empty": the page must not claim zero activity
      // just because a board snapshot omitted a field.
      const decisionsKnown = board !== null && Array.isArray(board.decisions);
      const intents = boardIntents(board);
      const intentsKnown = board !== null && Array.isArray(board.intents);
      const now = Date.now();
      const csrfReady = board !== null && typeof board.csrfToken === "string";
      const actionBlock =
        board === null ? t("loading") : csrfReady ? null : t("csrfUnavailable");
      const actorMissing = operator.trim() === "";

      // A stale selection is cleared when the refreshed board no longer contains it.
      React.useEffect(() => {
        if (selectedId === null || board === null) return;
        const stillThere = intents.some(
          (intent) => intent.intentId === selectedId,
        );
        if (!stillThere) setSelectedId(null);
      }, [board, selectedId, intents]);

      /**
       * Run exactly one mutation at a time. Always confirm:true in the body and the board's
       * CSRF header on the request. Refusals are returned to the caller for inline display;
       * they are never swallowed. The mutation is not aborted on unmount, because the server
       * may already have applied it — the UI just stops publishing state.
       */
      const runAction = React.useCallback(
        async (request) => {
          if (busyRef.current !== null) {
            return { ok: false, code: "busy", message: "" };
          }
          const needsActor =
            request.action === "approve" || request.action === "reject";
          const actor = operator.trim();
          if (needsActor && actor === "") {
            return { ok: false, code: "actor_required", message: "" };
          }
          const snapshot = boardState.board;
          const csrfToken =
            snapshot !== null && typeof snapshot.csrfToken === "string"
              ? snapshot.csrfToken
              : null;
          if (csrfToken === null) {
            return { ok: false, code: "csrf_unavailable", message: "" };
          }
          busyRef.current = request.key;
          if (aliveRef.current) setBusyKey(request.key);
          const controller = new AbortController();
          const timeout = setTimeout(() => {
            controller.abort();
          }, ACTION_TIMEOUT_MS);
          try {
            const payload = { action: request.action, confirm: true };
            if (actor !== "") payload.actor = actor;
            if (request.intentId !== undefined) {
              payload.intentId = request.intentId;
            }
            if (request.note !== undefined) payload.note = request.note;
            if (request.reason !== undefined) payload.reason = request.reason;
            if (request.result !== undefined) payload.result = request.result;
            const response = await postAction(
              payload,
              csrfToken,
              controller.signal,
            );
            const body = asRecord(response.body);
            const cli = body === null ? null : asRecord(body.cli);
            const serverBoard = body === null ? null : asRecord(body.board);
            if (serverBoard !== null) boardState.applyBoard(serverBoard);
            const succeeded =
              response.responseOk && body !== null && body.ok === true;
            if (succeeded) {
              // Enqueue changes the duplicate/cap gate inputs, so the signals inspector
              // must refetch even when its tab is not the visible one.
              if (request.action === "enqueue" && aliveRef.current) {
                void signals.load({ force: true });
              }
              if (serverBoard === null) {
                boardState.refresh();
              }
              return { ok: true, cli };
            }
            const cliError = cli === null ? null : asRecord(cli.error);
            const code =
              (cliError === null ? null : stringOrNull(cliError.code)) ??
              (body === null ? null : stringOrNull(body.reason)) ??
              `http_${response.status}`;
            const message =
              (cliError === null ? null : stringOrNull(cliError.message)) ??
              (body === null ? null : stringOrNull(body.message)) ??
              "";
            if (serverBoard === null || code === "csrf_refused") {
              boardState.refresh();
            }
            return { ok: false, code, message, status: response.status };
          } catch (error) {
            // The action may have been applied server-side even though the response was
            // lost, so refresh the board and say the outcome is unknown.
            boardState.refresh();
            const aborted =
              error !== null &&
              typeof error === "object" &&
              error.name === "AbortError";
            return {
              ok: false,
              code: aborted ? "action_timeout" : "network_error",
              message:
                aborted || error === null || typeof error !== "object"
                  ? ""
                  : stringOrNull(error.message) || "",
            };
          } finally {
            clearTimeout(timeout);
            busyRef.current = null;
            if (aliveRef.current) setBusyKey(null);
          }
        },
        [
          boardState.board,
          boardState.applyBoard,
          boardState.refresh,
          operator,
          signals.load,
        ],
      );

      const selectIntent = React.useCallback((intentId) => {
        setSelectedId((current) => (current === intentId ? null : intentId));
      }, []);

      const selectedIntent =
        selectedId === null
          ? null
          : (intents.find((intent) => intent.intentId === selectedId) ?? null);

      const queued = intents
        .filter((intent) => intent.status === "queued")
        .slice()
        .sort((left, right) => {
          const leftMinutes = minutesUntilExpiry(left);
          const rightMinutes = minutesUntilExpiry(right);
          if (leftMinutes === null && rightMinutes === null) return 0;
          if (leftMinutes === null) return 1;
          if (rightMinutes === null) return -1;
          return leftMinutes - rightMinutes;
        });
      const approved = intents.filter((intent) => intent.status === "approved");
      const filled = intents.filter((intent) => intent.status === "filled");
      const ledger = readLedger(board);
      const ledgerMissing = ledger.known && ledger.exists === false;

      let body;
      if (board === null) {
        body =
          boardState.error === null
            ? h(LoadingState, { t })
            : h(BoardErrorState, {
                t,
                error: boardState.error,
                onRetry: boardState.refresh,
              });
      } else {
        body = h(
          "div",
          null,
          h(StatStrip, { t, board }),
          h(AttentionBanner, {
            t,
            board,
            busyKey,
            runAction,
            notify,
          }),
          ledgerMissing
            ? h(
                "p",
                { className: "wab-ledger-note", role: "note" },
                t("ledgerMissingNote", {
                  path: ledger.path === null ? t("notAvailable") : ledger.path,
                }),
              )
            : null,
          h(
            "div",
            { className: "wab-tabs-wrap" },
            h(
              "div",
              {
                className: "wab-tabs",
                role: "tablist",
                "aria-label": t("tabsLabel"),
              },
              TAB_ORDER.map((tabId) =>
                h(
                  "button",
                  {
                    key: tabId,
                    type: "button",
                    role: "tab",
                    id: `wab-tab-${tabId}`,
                    className: "wab-tab",
                    "aria-selected": tab === tabId ? "true" : "false",
                    "aria-controls": `wab-panel-${tabId}`,
                    tabIndex: tab === tabId ? 0 : -1,
                    ref: (node) => {
                      tabRefs.current[tabId] = node;
                    },
                    onClick: () => selectTab(tabId),
                    onKeyDown: (event) => onTabKeyDown(event, tabId),
                  },
                  tabId === "queue" ? t("queueTitle") : t("tabSignals"),
                ),
              ),
            ),
            h(
              "div",
              {
                id: "wab-panel-queue",
                role: "tabpanel",
                className: "wab-tabpanel",
                "aria-labelledby": "wab-tab-queue",
                hidden: tab !== "queue",
              },
              h(
                "div",
                { className: "wab-layout" },
                h(
                  "section",
                  { className: "wab-main", "aria-label": t("queueTitle") },
                  h("h2", { className: "wab-main-title" }, t("queueTitle")),
                  intents.length === 0
                    ? h(
                        "p",
                        { className: "wab-empty" },
                        t(intentsKnown ? "noIntents" : "intentsUnknown"),
                      )
                    : [
                        h(QueueSection, {
                          key: "queued",
                          t,
                          titleKey: "sectionQueued",
                          emptyKey: "emptyQueued",
                          intents: queued,
                          selectedId,
                          onSelect: selectIntent,
                          actorMissing,
                          actionBlock,
                          busyKey,
                          runAction,
                          notify,
                          now,
                        }),
                        h(QueueSection, {
                          key: "approved",
                          t,
                          titleKey: "sectionApproved",
                          emptyKey: "emptyApproved",
                          intents: approved,
                          selectedId,
                          onSelect: selectIntent,
                          actorMissing,
                          actionBlock,
                          busyKey,
                          runAction,
                          notify,
                          now,
                        }),
                        h(QueueSection, {
                          key: "filled",
                          t,
                          titleKey: "sectionFilled",
                          emptyKey: "emptyFilled",
                          intents: filled,
                          selectedId,
                          onSelect: selectIntent,
                          actorMissing,
                          actionBlock,
                          busyKey,
                          runAction,
                          notify,
                          now,
                        }),
                      ],
                ),
                h(
                  "aside",
                  { className: "wab-aside" },
                  h(ContextPanel, {
                    t,
                    intent: selectedIntent,
                    decisions,
                    decisionsKnown,
                    now,
                  }),
                  h(RecentDecisions, { t, decisions, decisionsKnown, now }),
                ),
              ),
            ),
            h(
              "div",
              {
                id: "wab-panel-signals",
                role: "tabpanel",
                className: "wab-tabpanel",
                "aria-labelledby": "wab-tab-signals",
                hidden: tab !== "signals",
              },
              h(SignalsPanel, {
                t,
                payload: signals.payload,
                receivedAt: signals.receivedAt,
                error: signals.error,
                fetching: signals.fetching,
                actorMissing,
                actionBlock,
                busyKey,
                runAction,
                notify,
                onRetry: retrySignals,
                now,
              }),
            ),
          ),
        );
      }

      return h(
        "div",
        { className: "wab-page" },
        h("style", null, CSS),
        h(
          "div",
          { className: "wab-scroll" },
          h(
            "div",
            { className: "wab-content" },
            h(Header, {
              t,
              board,
              operator,
              onOperatorChange: setOperator,
              fetching:
                boardState.fetching || (tab === "signals" && signals.fetching),
              onRefresh: refreshAll,
            }),
            notice === null
              ? null
              : h(NoticeBar, {
                  t,
                  notice,
                  onDismiss: () => setNotice(null),
                }),
            boardState.error !== null && board !== null
              ? h(StaleBanner, {
                  t,
                  error: boardState.error,
                  receivedAt: boardState.receivedAt,
                  onRetry: boardState.refresh,
                })
              : null,
            body,
          ),
        ),
      );
    });

    /* -------------------------------------------------------------------------- */
    /* Plugin wiring                                                              */
    /* -------------------------------------------------------------------------- */

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        // Dictionaries are owned effects: they unregister with the plugin and the
        // sidebar label + every card re-render on a language switch.
        ctx.effect(
          () => ctx.locale.register(NS, DICTS),
          "watchlist autobet: locale dictionaries",
        );
        const t = ctx.locale.bind(NS);

        // The page and the sidebar entry share one id: the sidebar selects the panel
        // by this key, so both registrations must use PANEL_ID.
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              locale: NS,
            },
            ControlPlanePage,
          ),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 120,
              locale: NS,
              label: () => t("panel"),
            },
            ControlPlaneIcon,
          ),
        );
      },
    };
  },
});
