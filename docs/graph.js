/**
 * @file graph.js
 * @description Interactive controller for the SportsDesk & Fantasy402
 * ingestion data plane (bridges → Bun.cron scheduler → WS hub / R2 edge),
 * Surveillance Graph, Pending Bets Tab, Polymarket & Customer Profile
 * Registry, 4-Week Full-Customer CFB & NBA Parlay/Combo Backtest Tab, the
 * derived data API (`/api/graph/summary` + `/api/graph/stream`), and the
 * live fallback poller (`./graph-live-feed.json` / `/api/graph-feed`).
 * Externalized to comply with strict Cloudflare Pages CSP (`script-src 'self'`);
 * this file is the only controller and the page carries no inline script.
 */

import { buildWalletStats, planGsLiveLinks } from "./assets/gslive-links.js";
import {
  LIVE_WS_TOPICS,
  formatAgeMs,
  mergeTape,
  nextTabIndex,
  normalizeTickerRow,
  resolveLiveMode,
  resolvePollerState,
  summarizeBridgeFrame,
  summarizePendingBets,
  summarizePositions,
} from "./assets/live-ops.js";

(function () {
  // 1. Tab Switching (Topology vs. Pending Bets vs. 39-Wallet Profile Registry vs. 4-Week Parlay Backtest)
  const tabBtns = document.querySelectorAll("[data-tab-target]");
  const tabPanels = document.querySelectorAll("[data-tab-panel]");

  /**
   * One tab implementation for both tab groups. Adds what the markup alone cannot: ids and
   * `aria-controls` / `aria-labelledby` pairing, a roving tabindex (only the selected tab is
   * in the Tab order) and the WAI-ARIA arrow/Home/End keyboard model (see `nextTabIndex`).
   * Every lookup tolerates an empty list, so a page without the group is a no-op.
   */
  function wireTabs(buttonList, panelList, buttonAttr, panelAttr, onSelect) {
    const btns = Array.from(buttonList);
    const panels = Array.from(panelList);

    btns.forEach(function (btn) {
      const key = btn.getAttribute(buttonAttr);
      const panel = panels.find(function (p) {
        return p.getAttribute(panelAttr) === key;
      });
      if (!btn.id) btn.id = "tab-" + key;
      if (panel) {
        if (!panel.id) panel.id = "tabpanel-" + key;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", btn.id);
        btn.setAttribute("aria-controls", panel.id);
      }
      btn.setAttribute(
        "tabindex",
        btn.getAttribute("aria-selected") === "true" ? "0" : "-1",
      );
    });

    function select(target, moveFocus) {
      btns.forEach(function (b) {
        const active = b.getAttribute(buttonAttr) === target;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
        b.setAttribute("tabindex", active ? "0" : "-1");
        if (active && moveFocus && typeof b.focus === "function") b.focus();
      });
      panels.forEach(function (panel) {
        if (panel.getAttribute(panelAttr) === target) {
          panel.removeAttribute("hidden");
        } else {
          panel.setAttribute("hidden", "");
        }
      });
      // Tab 7 is the only tab that fetches on open (the daemon endpoints are
      // read-only and not part of the feed); the TTL guard prevents re-fetching
      // a snapshot younger than a minute.
      if (target === "TAB_KALSHI_SIGNALS") {
        loadKalshiSignals();
        loadGsliveWeblogs();
      }
      if (target === "TAB_EXECUTION") loadExecutionPlan();
      if (typeof onSelect === "function") onSelect(target);
    }

    btns.forEach(function (btn, index) {
      btn.addEventListener("click", function () {
        select(btn.getAttribute(buttonAttr), false);
      });
      btn.addEventListener("keydown", function (event) {
        const next = nextTabIndex(index, event.key, btns.length);
        if (next === null) return;
        event.preventDefault();
        select(btns[next].getAttribute(buttonAttr), true);
      });
    });
  }

  wireTabs(tabBtns, tabPanels, "data-tab-target", "data-tab-panel");

  // 2. Collapsible 1Q-4Q & Alt Ring Drawer
  const periodDrawerBtn = document.getElementById("toggle-period-drawer");
  const periodDrawer = document.getElementById("period-drawer-panel");
  if (periodDrawerBtn && periodDrawer) {
    periodDrawerBtn.addEventListener("click", function () {
      const isHidden = periodDrawer.hasAttribute("hidden");
      if (isHidden) {
        periodDrawer.removeAttribute("hidden");
        periodDrawerBtn.setAttribute("aria-expanded", "true");
        periodDrawerBtn.textContent = "Collapse 1Q–4Q & Alt Ring Drawer ▾";
      } else {
        periodDrawer.setAttribute("hidden", "");
        periodDrawerBtn.setAttribute("aria-expanded", "false");
        periodDrawerBtn.textContent = "Expand 1Q–4Q & Alt Ring Drawer ▸";
      }
    });
  }

  // 3. Canonical Integer Hundredths Slider (-50 to +50)
  const deltaSlider = document.getElementById("line-delta-slider");
  const deltaReadout = document.getElementById("line-delta-readout");
  if (deltaSlider && deltaReadout) {
    deltaSlider.addEventListener("input", function () {
      const val = Number(deltaSlider.value);
      const sign = val > 0 ? "+" : "";
      let verdict = "0 (Exact Consensus)";
      let color = "#e2e8f0";
      if (val < 0) {
        verdict = sign + val + " hundredths (F402 Internal Better Line)";
        color = "#22c55e";
      } else if (val > 0) {
        verdict =
          sign + val + " hundredths (Polymarket Better Line — Layoff Risk!)";
        color = "#ef4444";
      }
      deltaReadout.textContent = verdict;
      deltaReadout.style.color = color;
    });
  }

  // 4. Wallet & Customer Profile Registry Search
  const walletSearch = document.getElementById("wallet-filter-input");
  const walletRows = document.querySelectorAll("#wallet-registry-tbody tr");
  if (walletSearch) {
    walletSearch.addEventListener("input", function () {
      const q = walletSearch.value.trim().toLowerCase();
      walletRows.forEach(function (row) {
        const text = (row.textContent || "").toLowerCase();
        row.style.display = text.includes(q) ? "" : "none";
      });
    });
  }

  // 5. Cluster Overview Filter
  const betFilterBtns = document.querySelectorAll("[data-bet-filter]");
  const betRows = document.querySelectorAll("#open-bets-tbody tr");
  betFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const category = btn.getAttribute("data-bet-filter") || "ALL";
      betFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      betRows.forEach(function (row) {
        const rowCat = row.getAttribute("data-category") || "";
        row.style.display =
          category === "ALL" || rowCat === category ? "" : "none";
      });
    });
  });

  // 6. Pending Bets Tab Filter & Search
  const pendingFilterBtns = document.querySelectorAll("[data-pending-filter]");
  const pendingSearchInput = document.getElementById("pending-search-input");
  const pendingRows = document.querySelectorAll("#pending-legs-tbody tr");
  let activePendingVenue = "ALL";

  function filterPendingRows() {
    const q = pendingSearchInput
      ? pendingSearchInput.value.trim().toLowerCase()
      : "";
    pendingRows.forEach(function (row) {
      const venue = row.getAttribute("data-venue") || "";
      const text = (row.textContent || "").toLowerCase();
      const matchesVenue =
        activePendingVenue === "ALL" || venue === activePendingVenue;
      const matchesQuery = !q || text.includes(q);
      row.style.display = matchesVenue && matchesQuery ? "" : "none";
    });
  }

  pendingFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activePendingVenue = btn.getAttribute("data-pending-filter") || "ALL";
      pendingFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterPendingRows();
    });
  });

  if (pendingSearchInput) {
    pendingSearchInput.addEventListener("input", filterPendingRows);
  }

  // 7. 4-Week Parlay & Combo Backtest Tab Filter & Search (CFB & NBA)
  const btFilterBtns = document.querySelectorAll("[data-bt-filter]");
  const btSearchInput = document.getElementById("bt-customer-search");
  const btCustomerRows = document.querySelectorAll("#bt-customer-tbody tr");
  const btFamilyRows = document.querySelectorAll("#bt-family-tbody tr");
  let activeBtFilter = "ALL";

  function filterBacktestRows() {
    const q = btSearchInput ? btSearchInput.value.trim().toLowerCase() : "";
    btFamilyRows.forEach(function (row) {
      const sport = row.getAttribute("data-sport") || "";
      if (activeBtFilter === "CFB") {
        row.style.display = sport.includes("CFB") ? "" : "none";
      } else if (activeBtFilter === "NBA") {
        row.style.display = sport.includes("NBA") ? "" : "none";
      } else {
        row.style.display = "";
      }
    });

    btCustomerRows.forEach(function (row) {
      const sportDom = row.getAttribute("data-dominant-sport") || "";
      const seg = row.getAttribute("data-segment") || "";
      const text = (row.textContent || "").toLowerCase();
      let matchesFilter = true;
      if (activeBtFilter === "CFB") matchesFilter = sportDom === "CFB";
      else if (activeBtFilter === "NBA") matchesFilter = sportDom === "NBA";
      else if (activeBtFilter === "SHARP") matchesFilter = seg === "SHARP";
      else if (activeBtFilter === "REC") matchesFilter = seg === "REC";

      const matchesQuery = !q || text.includes(q);
      row.style.display = matchesFilter && matchesQuery ? "" : "none";
    });
  }

  btFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeBtFilter = btn.getAttribute("data-bt-filter") || "ALL";
      btFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterBacktestRows();
    });
  });

  if (btSearchInput) {
    btSearchInput.addEventListener("input", filterBacktestRows);
  }

  // 7b. Watchlist Bet-Ticker by ROT Filter & Search
  const rotFilterBtns = document.querySelectorAll("[data-rot-filter]");
  const rotChannelBtns = document.querySelectorAll("[data-rot-channel]");
  const rotSearchInput = document.getElementById("rot-ticker-search");
  const rotTickerRows = document.querySelectorAll("#rot-ticker-tbody tr");
  let activeRotFilter = "ALL";
  let activeRotChannel = "ALL";

  function filterRotTickerRows() {
    const q = rotSearchInput ? rotSearchInput.value.trim().toLowerCase() : "";
    rotTickerRows.forEach(function (row) {
      const rot = row.getAttribute("data-rot") || "";
      const ch = row.getAttribute("data-channel") || "";
      const text = (row.textContent || "").toLowerCase();
      const matchRot =
        activeRotFilter === "ALL" ||
        rot === activeRotFilter ||
        (activeRotFilter === "501" && (rot === "501" || rot === "5501"));
      const matchCh =
        activeRotChannel === "ALL" || ch.includes(activeRotChannel);
      const matchQ = !q || text.includes(q);
      row.style.display = matchRot && matchCh && matchQ ? "" : "none";
    });
  }

  rotFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeRotFilter = btn.getAttribute("data-rot-filter") || "ALL";
      rotFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterRotTickerRows();
    });
  });

  rotChannelBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeRotChannel = btn.getAttribute("data-rot-channel") || "ALL";
      rotChannelBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterRotTickerRows();
    });
  });

  if (rotSearchInput) {
    rotSearchInput.addEventListener("input", filterRotTickerRows);
  }

  // 7c. Per-Office IP-Tracker Cluster Filter in Tab 5
  const officeFilterBtns = document.querySelectorAll("[data-office-filter]");
  const officeRows = document.querySelectorAll("#office-ip-tbody tr");
  officeFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const f = btn.getAttribute("data-office-filter") || "ALL";
      officeFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      officeRows.forEach(function (row) {
        const cls = row.getAttribute("data-office-class") || "";
        const ag = row.getAttribute("data-office-agent") || "";
        if (f === "ALL") row.style.display = "";
        else if (f === "PER_OFFICE")
          row.style.display = cls.includes("PER_OFFICE") ? "" : "none";
        else if (f === "CROSS_OFFICE")
          row.style.display = cls.includes("CROSS_OFFICE") ? "" : "none";
        else row.style.display = ag === f ? "" : "none";
      });
    });
  });

  // 7d. 10-Mode Forensic, Risk, Cross-Market & Reconciliation Domain Filter in Tab 6
  const modeDomainBtns = document.querySelectorAll("[data-mode-domain-filter]");
  const modeCatalogRows = document.querySelectorAll(
    "#forensic-modes-catalog-tbody tr",
  );
  modeDomainBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const dom = btn.getAttribute("data-mode-domain-filter") || "ALL";
      modeDomainBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      modeCatalogRows.forEach(function (row) {
        const rowDom = row.getAttribute("data-mode-domain") || "";
        row.style.display = dom === "ALL" || rowDom === dom ? "" : "none";
      });
    });
  });

  // 7e. Data plane: bridge status filter + gate-evidence toggle.
  // The bridge rows are static in the HTML because their evidence is an
  // operator-run artifact, not something the 15s feed carries; the feed only
  // stamps the edge-sync time so a stale page is visible.
  const bridgeFilterBtns = document.querySelectorAll("[data-bridge-filter]");
  const bridgeRows = document.querySelectorAll(
    "#bridge-table-body tr[data-bridge-status]",
  );
  const bridgeDetails = document.querySelectorAll(
    "#bridge-table-body .bridge-detail",
  );
  const bridgeEvidenceToggle = document.getElementById(
    "bridge-evidence-toggle",
  );
  const dataPlaneSyncEl = document.getElementById("data-plane-sync-ts");
  let activeBridgeFilter = "ALL";
  let bridgeEvidenceVisible = false;

  function applyBridgeEvidence() {
    bridgeDetails.forEach(function (row) {
      if (bridgeEvidenceVisible) row.removeAttribute("hidden");
      else row.setAttribute("hidden", "");
    });
    if (bridgeEvidenceToggle) {
      bridgeEvidenceToggle.setAttribute(
        "aria-expanded",
        bridgeEvidenceVisible ? "true" : "false",
      );
      bridgeEvidenceToggle.textContent = bridgeEvidenceVisible
        ? "Hide evidence ▾"
        : "Show evidence ▸";
    }
  }

  function filterBridgeRows() {
    bridgeRows.forEach(function (row) {
      const status = row.getAttribute("data-bridge-status") || "";
      const visible =
        activeBridgeFilter === "ALL" || status === activeBridgeFilter;
      row.style.display = visible ? "" : "none";

      const detail = row.nextElementSibling;
      if (
        detail &&
        detail.classList &&
        detail.classList.contains("bridge-detail")
      ) {
        if (visible && bridgeEvidenceVisible) detail.removeAttribute("hidden");
        else detail.setAttribute("hidden", "");
      }
    });
  }

  bridgeFilterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activeBridgeFilter = btn.getAttribute("data-bridge-filter") || "ALL";
      bridgeFilterBtns.forEach(function (b) {
        b.classList.remove("active");
      });
      btn.classList.add("active");
      filterBridgeRows();
    });
  });

  if (bridgeEvidenceToggle) {
    bridgeEvidenceToggle.addEventListener("click", function () {
      bridgeEvidenceVisible = !bridgeEvidenceVisible;
      applyBridgeEvidence();
      filterBridgeRows();
    });
  }

  // 7f. Live wagers & our positions.
  // Two transports feed one panel: the same-origin bridge WebSocket (daemon-served pages)
  // and the 15s `graph-live-feed.json` poll (always available). The public Pages edge has
  // no daemon, so it polls and labels the mode POLL/SNAPSHOT; it never claims "WS LIVE".
  const liveOpsPanel = document.getElementById("live-ops-panel");
  const opsTabBtns = document.querySelectorAll("[data-ops-target]");
  const opsPanels = document.querySelectorAll("[data-ops-panel]");
  const liveTapeBody = document.getElementById("live-tape-tbody");
  const livePositionsBody = document.getElementById("positions-tbody");
  const liveDeskBookBody = document.getElementById("desk-book-tbody");
  const liveDeskSourceEl = document.getElementById("live-desk-source");
  const liveModeBadge = document.getElementById("live-mode-badge");
  const pollerStateEl = document.getElementById("live-poller-state");
  const pollerDotEl = document.getElementById("live-poller-dot");
  const pollerAnnounceEl = document.getElementById("live-status-announce");
  const liveFeedAgeEl = document.getElementById("live-feed-age");
  const liveWsStateEl = document.getElementById("live-ws-state");
  const livePauseBtn = document.getElementById("live-pause-btn");
  const liveClearBtn = document.getElementById("live-clear-btn");
  const liveRefreshBtn = document.getElementById("live-refresh-btn");
  const kpiDeskExposure = document.getElementById("live-desk-exposure");
  const kpiDeskSub = document.getElementById("live-desk-sub");
  const kpiPmValue = document.getElementById("live-pm-value");
  const kpiPmSub = document.getElementById("live-pm-sub");
  const kpiPmPnl = document.getElementById("live-pm-pnl");
  const kpiPmPnlSub = document.getElementById("live-pm-pnl-sub");
  const kpiOpenLegs = document.getElementById("live-open-legs");
  const kpiLegsSub = document.getElementById("live-legs-sub");

  const TAPE_LIMIT = 80;
  let liveTapeRows = [];
  let liveTapePaused = false;
  let liveFeedEpochMs = null;
  let liveFeedDataMode = "—";
  let liveWsState = "offline";
  // The banner's own feed state: the latest poll failure (null while polls succeed), and
  // whether the first poll has finished yet. `lastPollEpochMs` (section 8) is the feed's
  // publish time, or null when unknown; it is never set from the page's own clock.
  let feedFetchError = null;
  let feedAwaiting = true;
  let lastAnnouncedPollerLabel = "";
  let lastPollEpochMs = null;
  const lastUpdatedAgeEl = document.getElementById("live-last-updated-age");

  function fmtInt(value) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.round(number).toLocaleString("en-US")
      : "0";
  }

  function fmtUsd(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "$0";
    return (
      (number < 0 ? "-$" : "$") +
      Math.abs(Math.round(number)).toLocaleString("en-US")
    );
  }

  function setCellText(cell, text) {
    cell.textContent = text === null || text === undefined ? "—" : String(text);
  }

  function emptyTapeRow(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "tape-empty";
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  function renderLiveTape() {
    if (!liveTapeBody) return;
    if (liveTapeRows.length === 0) {
      liveTapeBody.replaceChildren(
        emptyTapeRow(
          "No bridge events in the tape yet — " +
            lastRelayText +
            ". The daemon hub streams individual F402 ticks and bridge rollups; the public edge fills this from the 15s feed, and a gsliveWagers rollup row is appended when the feed carries one.",
        ),
      );
      return;
    }
    const rows = liveTapeRows.slice(0, 60).map(function (row) {
      const tr = document.createElement("tr");
      const at = String(row.atIso || "")
        .replace("T", " ")
        .slice(0, 19);
      [
        at || "—",
        row.label || row.source || "—",
        row.login || "—",
        row.agent || "—",
        row.ticket || "—",
        row.summary || "—",
      ].forEach(function (value, index) {
        const td = document.createElement("td");
        if (index === 5) td.className = "wrap";
        setCellText(td, value);
        tr.appendChild(td);
      });
      return tr;
    });
    liveTapeBody.replaceChildren.apply(liveTapeBody, rows);
    setTextById(
      "eventlog-count",
      "events: " + liveTapeRows.length + " in tape",
    );
  }

  function renderLivePositions(summary) {
    if (!livePositionsBody) return;
    if (!summary || summary.rows.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 10;
      cell.className = "tape-empty";
      cell.textContent =
        "No position rows yet — the poller publishes walletProfiles into the feed.";
      row.appendChild(cell);
      livePositionsBody.replaceChildren(row);
      return;
    }
    const rows = summary.rows.map(function (row) {
      const tr = document.createElement("tr");
      const cells = [
        row.rank || "—",
        row.shortWallet || row.proxyWallet || "—",
        row.customerId,
        row.agentOwner,
        fmtInt(row.legs),
        fmtUsd(row.costUsd),
        fmtUsd(row.valueUsd),
        fmtUsd(row.pnlUsd),
        row.source,
        row.error ? "error: " + row.error : row.summary || "—",
      ];
      cells.forEach(function (value, index) {
        const td = document.createElement("td");
        if (index === 9) td.className = "wrap";
        if (index === 8) td.className = "source-" + String(row.source);
        setCellText(td, value);
        tr.appendChild(td);
      });
      return tr;
    });
    const totals = document.createElement("tr");
    totals.className = "ops-totals";
    [
      "Σ",
      summary.walletCount + " wallets",
      "",
      "",
      fmtInt(summary.openLegs),
      fmtUsd(summary.openCostUsd),
      fmtUsd(summary.openValueUsd),
      fmtUsd(summary.openPnlUsd),
      summary.liveCount + " live",
      "sync " +
        (summary.latestSyncIso
          ? String(summary.latestSyncIso).slice(0, 19).replace("T", " ")
          : "—"),
    ].forEach(function (value, index) {
      const td = document.createElement("td");
      if (index === 9) td.className = "wrap";
      setCellText(td, value);
      totals.appendChild(td);
    });
    livePositionsBody.replaceChildren.apply(livePositionsBody, [
      ...rows,
      totals,
    ]);
  }

  function renderLiveDeskBook(summary) {
    if (!liveDeskBookBody) return;
    if (!summary || summary.rows.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 8;
      cell.className = "tape-empty";
      cell.textContent = "No desk clusters yet — pendingBets feeds this table.";
      row.appendChild(cell);
      liveDeskBookBody.replaceChildren(row);
      return;
    }
    const rows = summary.rows.map(function (row) {
      const tr = document.createElement("tr");
      [
        row.venue,
        row.customerId,
        row.agentOwner,
        row.market,
        fmtUsd(row.riskUsd),
        fmtUsd(row.toWinUsd),
        row.verdict || "—",
        row.placedAtUtc || "—",
      ].forEach(function (value, index) {
        const td = document.createElement("td");
        if (index === 3 || index === 6) td.className = "wrap";
        setCellText(td, value);
        tr.appendChild(td);
      });
      return tr;
    });
    const totals = document.createElement("tr");
    totals.className = "ops-totals";
    [
      "Σ",
      summary.clusterCount + " clusters",
      "",
      summary.venues
        .map(function (v) {
          return v.venue + " ×" + v.count;
        })
        .join(" · "),
      fmtUsd(summary.riskUsd),
      fmtUsd(summary.toWinUsd),
      "",
      "",
    ].forEach(function (value, index) {
      const td = document.createElement("td");
      if (index === 3) td.className = "wrap";
      setCellText(td, value);
      totals.appendChild(td);
    });
    liveDeskBookBody.replaceChildren.apply(liveDeskBookBody, [...rows, totals]);
  }

  function renderLiveKpis(positions, desk) {
    if (kpiDeskExposure) kpiDeskExposure.textContent = fmtUsd(desk.riskUsd);
    if (kpiDeskSub) {
      kpiDeskSub.textContent =
        desk.clusterCount + " clusters · to-win " + fmtUsd(desk.toWinUsd);
    }
    if (kpiPmValue) kpiPmValue.textContent = fmtUsd(positions.openValueUsd);
    if (kpiPmSub) {
      kpiPmSub.textContent =
        positions.walletCount +
        " wallets · " +
        positions.liveCount +
        " live / " +
        positions.staleCount +
        " stale / " +
        positions.fixtureCount +
        " fixture · cost " +
        fmtUsd(positions.openCostUsd);
    }
    if (kpiPmPnl) kpiPmPnl.textContent = fmtUsd(positions.openPnlUsd);
    if (kpiPmPnlSub) {
      kpiPmPnlSub.textContent = positions.latestSyncIso
        ? "mark vs cost · sync " +
          String(positions.latestSyncIso).slice(0, 19).replace("T", " ")
        : "mark vs cost · no observed sync";
    }
    if (kpiOpenLegs) kpiOpenLegs.textContent = fmtInt(positions.openLegs);
    if (kpiLegsSub) {
      kpiLegsSub.textContent =
        positions.walletCount +
        " PM wallets · " +
        desk.clusterCount +
        " desk clusters";
    }
  }

  /** Paint the top banner (label, dot, age pill) from one resolved state. */
  function renderPollerState(state) {
    if (pollerStateEl) {
      pollerStateEl.textContent = state.label;
      pollerStateEl.title = state.detail;
    }
    if (pollerDotEl)
      pollerDotEl.className = "pulse-dot pulse-dot-" + state.tone;
    if (lastUpdatedAgeEl)
      lastUpdatedAgeEl.className = "pill pill-" + state.tone;
    // Announce only when the state changes; the age counter ticks every second and must
    // never reach a screen reader.
    if (pollerAnnounceEl && state.label !== lastAnnouncedPollerLabel) {
      lastAnnouncedPollerLabel = state.label;
      pollerAnnounceEl.textContent =
        "Feed status: " + state.label + ". " + state.detail;
    }
  }

  function updateLiveBadges() {
    renderPollerState(
      resolvePollerState({
        wsState: liveWsState,
        feedAgeMs:
          lastPollEpochMs === null ? null : Date.now() - lastPollEpochMs,
        feedDataMode: liveFeedDataMode,
        fetchError: feedFetchError,
        awaiting: feedAwaiting,
      }),
    );
    const mode = resolveLiveMode({
      wsState: liveWsState,
      feedAgeMs: liveFeedEpochMs === null ? null : Date.now() - liveFeedEpochMs,
      feedDataMode: liveFeedDataMode,
    });
    if (liveModeBadge) {
      liveModeBadge.textContent = "mode: " + mode.label;
      liveModeBadge.className = "pill pill-" + mode.tone;
      liveModeBadge.title = mode.detail;
    }
    if (liveFeedAgeEl) {
      liveFeedAgeEl.textContent =
        liveFeedEpochMs === null
          ? "feed: awaiting"
          : "feed: " +
            formatAgeMs(Date.now() - liveFeedEpochMs) +
            " · " +
            liveFeedDataMode;
    }
    if (liveWsStateEl) {
      liveWsStateEl.textContent = "WS: " + liveWsState;
      liveWsStateEl.className =
        "pill pill-" +
        (liveWsState === "connected"
          ? "emerald"
          : liveWsState === "connecting"
            ? "cyan"
            : "amber");
    }
  }

  function hydrateLiveOps(data) {
    if (!liveOpsPanel || !data) return;
    const positions = summarizePositions(data.walletProfiles);
    const desk = summarizePendingBets(data.pendingBets);
    renderLiveKpis(positions, desk);
    renderLivePositions(positions);
    renderLiveDeskBook(desk);
    // Age the feed by its own publish time, not by when this page fetched it: a stale
    // published feed must never render as fresh.
    const feedEpochMs =
      typeof data.pollEpochMs === "number" && Number.isFinite(data.pollEpochMs)
        ? data.pollEpochMs
        : Date.parse(String(data.lastUpdatedIso ?? ""));
    liveFeedEpochMs = Number.isFinite(feedEpochMs) ? feedEpochMs : Date.now();
    liveFeedDataMode = data.dataMode || "—";
    // Desk-book rows come from the pending-bet feed; label that table with its own
    // source so a fixture book cannot pass as observed desk exposure.
    if (liveDeskSourceEl) {
      const f402 = data.provenance && data.provenance.f402;
      const deskSource = f402 && f402.source === "live" ? "LIVE" : "FIXTURE";
      liveDeskSourceEl.textContent = "rows: " + deskSource;
      liveDeskSourceEl.className =
        "pill pill-" + (deskSource === "LIVE" ? "emerald" : "amber");
    }
    if (!liveTapePaused) {
      const ticks = (Array.isArray(data.liveTicks) ? data.liveTicks : [])
        .map(function (tick, index) {
          return normalizeTickerRow(tick, index);
        })
        .filter(Boolean);
      if (ticks.length > 0) {
        liveTapeRows = mergeTape(liveTapeRows, ticks, TAPE_LIMIT);
        renderLiveTape();
      }
      // A rollup is itself a bridge event: show it even when there are zero
      // individual ticks, so an empty tape never hides a moving bridge.
      const rollupRow = gsliveWagersTapeRow(data);
      if (rollupRow) {
        liveTapeRows = mergeTape(liveTapeRows, [rollupRow], TAPE_LIMIT);
        renderLiveTape();
      }
    }
    updateLiveBadges();
  }

  wireTabs(
    opsTabBtns,
    opsPanels,
    "data-ops-target",
    "data-ops-panel",
    function (target) {
      // Game state is fetched on demand by its own transport (/api/live-bets),
      // so opening the tab is the natural moment to (re)load it.
      if (target === "OPS_GAMES" && gameStateDaemonAvailable !== false) {
        loadGameState();
      }
    },
  );

  if (livePauseBtn) {
    livePauseBtn.addEventListener("click", function () {
      liveTapePaused = !liveTapePaused;
      livePauseBtn.setAttribute(
        "aria-pressed",
        liveTapePaused ? "true" : "false",
      );
      livePauseBtn.textContent = liveTapePaused ? "Resume tape" : "Pause tape";
    });
  }

  if (liveClearBtn) {
    liveClearBtn.addEventListener("click", function () {
      liveTapeRows = [];
      renderLiveTape();
    });
  }

  if (liveRefreshBtn) {
    liveRefreshBtn.addEventListener("click", function () {
      pollLiveFeed();
    });
  }

  function appendLiveTape(entry) {
    if (!entry || liveTapePaused) return;
    liveTapeRows = mergeTape(liveTapeRows, [entry], TAPE_LIMIT);
    renderLiveTape();
  }

  // The hub upgrades an already-guarded route; a browser cannot set an Authorization
  // header on a handshake, so the admin token (when the operator puts it in a
  // `<meta name="sportsdesk-admin-token">`) travels as a `bearer-<token>` subprotocol.
  // Loopback peers need no token. A static Pages edge has no hub: after bounded
  // attempts the panel stays on polling and says so.
  function connectLiveOpsSocket() {
    if (!liveOpsPanel) return;
    const nav = globalThis.location;
    if (!nav || (nav.protocol !== "http:" && nav.protocol !== "https:")) return;
    const Socket = globalThis.WebSocket;
    if (typeof Socket !== "function") return;

    const endpoint =
      (nav.protocol === "https:" ? "wss:" : "ws:") +
      "//" +
      nav.host +
      "/api/live-bets";
    const protocols = ["sportsdesk.bridge.v1"];
    let meta = null;
    if (typeof document.querySelector === "function") {
      meta = document.querySelector('meta[name="sportsdesk-admin-token"]');
    }
    const token =
      meta && typeof meta.getAttribute === "function"
        ? String(meta.getAttribute("content") || "").trim()
        : "";
    if (token !== "") protocols.push("bearer-" + token);
    const loopback =
      nav.hostname === "localhost" ||
      nav.hostname === "127.0.0.1" ||
      nav.hostname === "[::1]";

    let socket = null;
    let pingTimer = null;
    let reconnectTimer = null;
    let backoffMs = 1_000;
    let attempts = 0;

    function setWsState(state) {
      liveWsState = state;
      updateLiveBadges();
    }

    function scheduleReconnect() {
      if (reconnectTimer !== null) return;
      setWsState("polling");
      if (attempts >= 6) return;
      connectRetry();
    }

    function connectRetry() {
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        attempts += 1;
        connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }

    function connect() {
      setWsState("connecting");
      try {
        socket = new Socket(endpoint, protocols);
      } catch {
        setWsState("polling");
        return;
      }
      socket.addEventListener("open", function () {
        backoffMs = 1_000;
        setWsState("connected");
        LIVE_WS_TOPICS.forEach(function (topic) {
          try {
            socket.send(JSON.stringify({ type: "SUBSCRIBE", channel: topic }));
          } catch {
            // a closed socket surfaces on `close`
          }
        });
        if (pingTimer !== null) clearInterval(pingTimer);
        pingTimer = setInterval(function () {
          try {
            socket.send(JSON.stringify({ type: "PING" }));
          } catch {
            // a closed socket surfaces on `close`
          }
        }, 25_000);
      });
      socket.addEventListener("message", function (event) {
        let frame = null;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!frame || typeof frame !== "object") return;
        if (frame.type === "SUBSCRIBED" || frame.type === "UNSUBSCRIBED") {
          setWsState("connected");
          return;
        }
        if (frame.type === "PONG" || frame.type === "ERROR") return;
        const entry = summarizeBridgeFrame(frame, new Date().toISOString());
        if (!entry) return;
        setWsState("connected");
        appendLiveTape(entry);
      });
      socket.addEventListener("close", function () {
        if (pingTimer !== null) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        scheduleReconnect();
      });
      socket.addEventListener("error", function () {
        // close follows; scheduleReconnect owns the state
      });
    }

    // A browser cannot tell "no hub" from "hub rejected us" until it tries, and every
    // failed upgrade logs a network error. Probe the daemon's feed route first: it is
    // same-origin, oks on loopback, and 404s on the static Pages edge, so the public
    // page never emits a doomed WebSocket attempt. With an operator token we skip the
    // probe (a non-loopback peer needs the token for both paths anyway).
    function probeHub() {
      if (token !== "") return Promise.resolve(true);
      if (!loopback) return Promise.resolve(false);
      if (typeof fetch !== "function") return Promise.resolve(false);
      return fetch("/api/graph-feed", { method: "HEAD", cache: "no-store" })
        .then(function (res) {
          return res.ok;
        })
        .catch(function () {
          return false;
        });
    }

    probeHub().then(function (reachable) {
      if (!reachable) {
        setWsState("polling");
        return;
      }
      connect();
    });
  }

  connectLiveOpsSocket();

  // 8. Live Poller Sync (`./graph-live-feed.json` / `/api/graph-feed`) + Relative Age Counter
  const lastUpdatedEl = document.getElementById("live-last-updated-ts");
  const pollSeqEl = document.getElementById("live-poll-seq");
  const dataModeEl = document.getElementById("live-data-mode");
  const liveTicksBody = document.getElementById("live-ticks-tbody");
  const kpiActiveWallets = document.getElementById("kpi-active-wallets");
  const kpiWalletProvenance = document.getElementById("kpi-wallet-provenance");
  const tabPendingLegs = document.getElementById("tab-pending-legs");
  const clustersExposureHeading = document.getElementById(
    "clusters-exposure-heading",
  );
  const topologyLegs = document.getElementById("topology-legs");
  const pollNowBtn = document.getElementById("poll-now-btn");
  const cellSyncStamps = document.querySelectorAll(".live-sync-ts");

  let localPollCount = 1;

  // 8b. GSLive link hydration: every [data-gslive] anchor is rebuilt from the live feed so the
  // desk-day window and `t` cache-buster roll forward without redeploying the portal.
  let lastFeed = null;
  let activeReportWindow = "14";

  function hydrateGsLiveLinks(data) {
    if (data) lastFeed = data;
    if (!lastFeed) return;

    const updates = planGsLiveLinks(
      Array.from(document.querySelectorAll("[data-gslive]")),
      {
        feed: lastFeed,
        activeReportWindow: activeReportWindow,
        tickEpochMs: Date.now(),
      },
    );

    updates.forEach(function (update) {
      update.element.setAttribute("href", update.url);
      update.element.setAttribute("data-gslive-hydrated", "1");
    });

    document
      .querySelectorAll("[data-gslive-window-choice]")
      .forEach(function (btn) {
        const active =
          btn.getAttribute("data-gslive-window-choice") === activeReportWindow;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
  }

  // 8c. Wallet registry hydration: replace the static per-wallet numbers with the feed's live
  // aggregates and label the provenance (LIVE / STALE / FIXTURE) on each row.
  function hydrateWalletRows(data) {
    const stats = buildWalletStats(data);

    document.querySelectorAll("[data-f402-id]").forEach(function (row) {
      const id = (row.getAttribute("data-f402-id") || "").toUpperCase();
      const wallet = stats[id];
      if (!wallet) return;
      const cell = row.querySelector("[data-wallet-stats]");
      if (!cell) return;

      const volume = document.createElement("strong");
      volume.textContent =
        "$" + Math.round(wallet.volumeUsd).toLocaleString("en-US");

      const mode = document.createElement("span");
      mode.className =
        "pill " +
        (wallet.dataSource === "LIVE"
          ? "pill-emerald"
          : wallet.dataSource === "STALE"
            ? "pill-amber"
            : "pill-rose");
      mode.style.marginLeft = "0.3rem";
      mode.textContent = wallet.dataSource;
      if (wallet.lastError) mode.title = wallet.lastError;

      const summary = document.createElement("span");
      summary.style.fontSize = "0.72rem";
      summary.style.color = "#cbd5e1";
      summary.textContent = wallet.summary;

      cell.replaceChildren(
        volume,
        document.createTextNode(" (" + wallet.legs + " legs) "),
        mode,
        document.createElement("br"),
        summary,
      );
    });

    if (dataModeEl) {
      const mode = data.dataMode || "FIXTURE";
      dataModeEl.textContent = "data: " + mode;
      dataModeEl.className =
        "pill " +
        (mode === "LIVE"
          ? "pill-emerald"
          : mode === "PARTIAL"
            ? "pill-amber"
            : "pill-rose");
    }

    if (kpiActiveWallets) {
      kpiActiveWallets.textContent = String(
        data.activeSyndicateWalletsCount ?? "—",
      );
    }
    if (kpiWalletProvenance) {
      const pm = data.provenance && data.provenance.polymarket;
      if (pm && pm.source !== "fixture") {
        kpiWalletProvenance.textContent =
          pm.walletsOk +
          " live · " +
          (pm.walletsInvalid ?? 0) +
          " quarantined · " +
          (data.configuredWalletsCount ?? "—") +
          " configured";
      }
    }
    if (tabPendingLegs)
      tabPendingLegs.textContent = String(data.totalOpenLegsCount ?? "—");
    if (topologyLegs)
      topologyLegs.textContent = String(data.totalOpenLegsCount ?? "—");
    if (clustersExposureHeading) {
      const exposure = Number(data.totalOpenExposureUsd);
      clustersExposureHeading.textContent = Number.isFinite(exposure)
        ? exposure.toLocaleString("en-US")
        : "—";
    }
  }

  // 8d. F402 tick preview: identity/timing only, no money columns until units are captured.
  function hydrateLiveTicks(data) {
    if (!liveTicksBody) return;
    const ticks = (data && data.liveTicks) || [];
    if (ticks.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.textContent =
        "No live F402 ticks — run ./bin/dx poll --live-f402 with a cached session.";
      row.appendChild(cell);
      liveTicksBody.replaceChildren(row);
      return;
    }
    const rows = ticks.slice(0, 20).map(function (tick) {
      const row = document.createElement("tr");
      [
        tick.insertedAt,
        tick.login,
        tick.agentLogin || tick.agentId,
        tick.ticketWriter,
        tick.wagerNumber,
        tick.shortDesc,
      ].forEach(function (value) {
        const cell = document.createElement("td");
        cell.textContent = value || "—";
        row.appendChild(cell);
      });
      return row;
    });
    liveTicksBody.replaceChildren.apply(liveTicksBody, rows);
  }

  document
    .querySelectorAll("[data-gslive-window-choice]")
    .forEach(function (btn) {
      btn.addEventListener("click", function () {
        activeReportWindow =
          btn.getAttribute("data-gslive-window-choice") || "14";
        hydrateGsLiveLinks(null);
      });
    });

  function updateRelativeAge() {
    updateLiveBadges();
    if (!lastUpdatedAgeEl) return;
    // formatAgeMs ("1h", "2d") instead of raw seconds; "—" until the feed's age is known.
    const text =
      lastPollEpochMs === null
        ? "—"
        : formatAgeMs(Math.max(0, Date.now() - lastPollEpochMs)) + " ago";
    if (lastUpdatedAgeEl.textContent !== text)
      lastUpdatedAgeEl.textContent = text;
  }

  async function hydrateValueArtifacts() {
    function setText(id, text) {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    }
    function fmtUsd(value) {
      if (value === null || value === undefined || Number.isNaN(value))
        return "n/a";
      return (
        (value < 0 ? "-$" : "$") +
        Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 0 })
      );
    }
    try {
      const [comboRes, bridgeRes] = await Promise.all([
        fetch("./combo-uniqueness.json", { cache: "no-store" }),
        fetch("./cross-domain-bridge.json", { cache: "no-store" }),
      ]);
      if (comboRes.ok) {
        const combo = await comboRes.json();
        const gates = combo.gates || {};
        const permissive = gates.permissive || {};
        const allCfb = gates["all-legs-cfb"] || {};
        const fullGame = gates["full-game"] || {};
        setText("combo-all-cfb", String(allCfb.kept ?? "—"));
        setText(
          "combo-all-cfb-sub",
          "of " +
            (permissive.kept ?? "—") +
            " permissive · " +
            (combo.index && combo.index.games ? combo.index.games : "—") +
            " games",
        );
        setText("combo-full-game", String(fullGame.kept ?? "—"));
        setText(
          "combo-index-sub",
          combo.index && combo.index.activeOnly
            ? "open-only index"
            : "active+closed · whole series",
        );
        const tbody = document.getElementById("combo-gate-rows");
        if (tbody) {
          tbody.textContent = "";
          ["permissive", "all-legs-cfb", "full-game"].forEach(function (gate) {
            const row = gates[gate] || {};
            const ex = row.exclusions || {};
            const cross =
              gate === "full-game" ? (ex.CROSS_GAME ?? "—") : "included";
            const tr = document.createElement("tr");
            const gateCell = document.createElement("td");
            const code = document.createElement("code");
            code.textContent = gate;
            gateCell.appendChild(code);
            tr.appendChild(gateCell);
            [
              row.kept,
              ex.UNRESOLVED_LEGS,
              cross,
              ex.INELIGIBLE_LEG_TYPE,
              row.includedCrossGame,
            ].forEach(function (value) {
              const td = document.createElement("td");
              td.textContent = String(value ?? "—");
              tr.appendChild(td);
            });
            tbody.appendChild(tr);
          });
        }
      }
      if (bridgeRes.ok) {
        const bridge = await bridgeRes.json();
        const value = bridge.value || {};
        const coverage = bridge.coverage || {};
        setText(
          "bridge-linked",
          (coverage.linkedCustomers ?? "—") +
            " / " +
            (coverage.customersInBook ?? "—"),
        );
        setText(
          "bridge-linked-sub",
          (coverage.wallets ?? "—") +
            " wallets · " +
            (coverage.invalidWallets ?? 0) +
            " quarantined · " +
            bridge.evidence,
        );
        setText("bridge-poly-pnl", fmtUsd(value.polyGrossPnlUsd));
        setText(
          "bridge-poly-sub",
          "net " +
            fmtUsd(value.polyNetPnlUsd) +
            " · " +
            (value.netCoveragePct ?? 0) +
            "% replayed · " +
            bridge.evidence,
        );
        setText("bridge-poly-only-up", String(value.polyOnlyUp ?? "—"));
        setText(
          "value-bridge-evidence",
          bridge.evidence +
            " · generated " +
            String(bridge.generatedAtIso || "").slice(0, 10),
        );
      }
    } catch {
      // artifacts are optional; static placeholders stay visible
    }
  }

  async function pollLiveFeed() {
    try {
      const res = await fetch("./graph-live-feed.json?t=" + Date.now(), {
        cache: "no-store",
      });
      if (!res.ok) {
        // Keep the last good timestamp: only the failure is news.
        feedFetchError = "HTTP " + res.status;
        feedAwaiting = false;
        updateRelativeAge();
        return;
      }
      const data = await res.json();
      if (data && data.lastUpdatedCdt) {
        feedFetchError = null;
        feedAwaiting = false;
        // The feed's own publish time, never "now": a feed that cannot say when it was
        // written must read as undated, not as fresh.
        const publishedMs =
          typeof data.pollEpochMs === "number" &&
          Number.isFinite(data.pollEpochMs)
            ? data.pollEpochMs
            : Date.parse(String(data.lastUpdatedIso ?? ""));
        lastPollEpochMs = Number.isFinite(publishedMs) ? publishedMs : null;
        localPollCount = data.pollSequence || localPollCount;
        if (lastUpdatedEl) {
          lastUpdatedEl.textContent =
            data.lastUpdatedCdt +
            " (" +
            data.lastUpdatedIso.slice(11, 19) +
            " UTC)";
        }
        if (pollSeqEl) {
          pollSeqEl.textContent = "Poll #" + localPollCount;
        }
        cellSyncStamps.forEach(function (el) {
          el.textContent = data.lastUpdatedCdt;
        });
        if (dataPlaneSyncEl) {
          dataPlaneSyncEl.textContent = "edge sync: " + data.lastUpdatedCdt;
        }
        hydrateGsLiveLinks(data);
        hydrateWalletRows(data);
        hydrateLiveTicks(data);
        hydrateLiveOps(data);
        hydrateFeedLabels(data);
        // A moved feed is the contract's cue to re-ask /api/live-bets; a static
        // edge (404/401 already seen) is not retried on every tick.
        const sequence =
          data.pollSequence === undefined ? null : data.pollSequence;
        if (
          sequence !== null &&
          sequence !== gameStateLastSequence &&
          gameStateDaemonAvailable !== false
        ) {
          gameStateLastSequence = sequence;
          loadGameState();
        }
        updateRelativeAge();
      } else {
        feedFetchError = "feed has no lastUpdatedCdt";
        feedAwaiting = false;
        updateRelativeAge();
      }
    } catch {
      // This used to restamp "Last Updated" with the page's own clock, so an outage read as
      // "0s ago". Leave the last good timestamp alone and report the failure instead.
      feedFetchError = "network error";
      feedAwaiting = false;
      updateRelativeAge();
    }
  }

  if (pollNowBtn) {
    pollNowBtn.addEventListener("click", function () {
      pollLiveFeed();
    });
  }

  // 9. Derived data API (`/api/graph/summary`) + SSE stream (`/api/graph/stream`).
  // The stream replaces the 15s feed poll while it is live. The static Pages edge
  // has no daemon route, so a 404 falls back to the feed poll and says so; every
  // daemon-only value stays "unavailable — daemon-only" there. No value is ever
  // invented: an unmeasured bridge or gate renders its reason + command instead.
  const dataStreamStateEl = document.getElementById("data-stream-state");
  const STREAM_POLL_FALLBACK_MS = 15_000;
  const STREAM_HEARTBEAT_TIMEOUT_MS = 45_000;
  const STREAM_MAX_ATTEMPTS = 6;
  let dashboardSummary = null;
  let streamController = null;
  let streamReconnectTimer = null;
  let streamBackoffMs = 1_000;
  let streamAttempts = 0;
  let streamLive = false;
  let lastStreamFrameMs = 0;
  let lastSummaryFeedStamp = "";

  function setTextById(id, text) {
    if (!document || typeof document.getElementById !== "function") return;
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text === null || text === undefined ? "—" : String(text);
  }

  function fmtMetricInt(value) {
    const number = Number(value);
    return Number.isFinite(number) ? fmtInt(number) : "—";
  }

  // Age in one short token ("3h"); callers add the "age"/"measured … ago" wording.
  function fmtAgeShort(seconds) {
    const sec = Number(seconds);
    if (!Number.isFinite(sec) || sec < 0) return null;
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3_600) return Math.round(sec / 60) + "m";
    if (sec < 86_400) return Math.round(sec / 3_600) + "h";
    return Math.round(sec / 86_400) + "d";
  }

  function asOfDay(value) {
    const text = String(value === null || value === undefined ? "" : value);
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text || "—";
  }

  function fmtUsdCompact(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const sign = number < 0 ? "-" : "+";
    const abs = Math.abs(number);
    if (abs >= 1_000_000)
      return sign + "$" + (abs / 1_000_000).toFixed(2) + "M";
    if (abs >= 1_000) return sign + "$" + Math.round(abs / 1_000) + "K";
    return sign + "$" + Math.round(abs);
  }

  // Full-dollar amounts keep their sign ("+$762,280"), the short form is the
  // KPI-card style ("-$203.4K → +$384.1K").
  function fmtUsdSigned(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    return (
      (number < 0 ? "-$" : "+$") +
      Math.abs(Math.round(number)).toLocaleString("en-US")
    );
  }

  function fmtUsdSignedShort(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const sign = number < 0 ? "-$" : "+$";
    const abs = Math.abs(number);
    if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(2) + "M";
    if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + "K";
    return sign + Math.round(abs);
  }

  function fmtPct(value, signed) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    const rounded = Math.round(number * 100) / 100;
    return (signed && rounded > 0 ? "+" : "") + rounded + "%";
  }

  const MONTH_LABELS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  function fmtMonthDay(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(
      String(iso === null || iso === undefined ? "" : iso),
    );
    if (!match) return "—";
    const month = MONTH_LABELS[Number(match[2]) - 1];
    return month ? month + " " + match[3] : "—";
  }

  function fmtWindow(startIso, endIso) {
    const start = fmtMonthDay(startIso);
    const end = fmtMonthDay(endIso);
    if (start === "—" || end === "—") return "—";
    const year = /^(\d{4})/.exec(
      String(endIso === null || endIso === undefined ? "" : endIso),
    );
    return start + " – " + end + (year ? ", " + year[1] : "");
  }

  // The 4-week backtest tab's aggregate cards + headings come from
  // feed.backtest4Wk. Table rows stay the committed artifact sample; these
  // cards are the re-measured claims, so they hydrate.
  function hydrateBacktestLabels(backtest) {
    if (!backtest || typeof backtest !== "object") return;
    setTextById(
      "bt-customers",
      fmtMetricInt(backtest.totalProvisionedCustomers),
    );
    setTextById(
      "bt-customers-sub",
      fmtMetricInt(backtest.totalActiveSportsBettors) +
        " Active Bettors • " +
        fmtMetricInt(backtest.totalEnrichedProfilesScanned) +
        " Enriched • " +
        fmtMetricInt(backtest.totalBridgedPolymarketWallets) +
        " Valid 0x Wallets",
    );
    setTextById("bt-cfb-handle", fmtMetricInt(backtest.cfbTotalHandleUsd4Wk));
    setTextById(
      "bt-cfb-sub",
      fmtMetricInt(backtest.cfbTotalTickets4Wk) +
        " Tickets (" +
        fmtMetricInt(backtest.cfbTotalLegs4Wk) +
        " Legs) • " +
        fmtUsdSignedShort(backtest.cfbBaselineDeskNetUsd4Wk) +
        " → " +
        fmtUsdSignedShort(backtest.cfbProtectedDeskNetUsd4Wk),
    );
    setTextById("bt-cfb-tix", fmtMetricInt(backtest.cfbTotalTickets4Wk));
    setTextById("bt-nba-handle", fmtMetricInt(backtest.nbaTotalHandleUsd4Wk));
    setTextById(
      "bt-nba-sub",
      fmtMetricInt(backtest.nbaTotalTickets4Wk) +
        " Tickets (" +
        fmtMetricInt(backtest.nbaTotalLegs4Wk) +
        " Legs) • " +
        fmtUsdSignedShort(backtest.nbaBaselineDeskNetUsd4Wk) +
        " → " +
        fmtUsdSignedShort(backtest.nbaProtectedDeskNetUsd4Wk),
    );
    setTextById("bt-nba-tix", fmtMetricInt(backtest.nbaTotalTickets4Wk));
    setTextById(
      "bt-desk-net",
      fmtUsdSigned(backtest.protectedTotalDeskNetUsd4Wk) +
        " (" +
        fmtPct(backtest.protectedTotalHoldPct4Wk, true) +
        ")",
    );
    setTextById(
      "bt-desk-net-sub",
      "vs Baseline Unprotected " +
        fmtUsdSigned(backtest.baselineTotalDeskNetUsd4Wk) +
        " (" +
        fmtPct(backtest.baselineTotalHoldPct4Wk, true) +
        " Hold)",
    );
    const savings = Number(backtest.totalCounterfactualSavingsUsd4Wk);
    setTextById(
      "bt-savings",
      Number.isFinite(savings) ? "+$" + fmtInt(savings) + " Saved" : "—",
    );
    const swing =
      Number(backtest.protectedTotalHoldPct4Wk) -
      Number(backtest.baselineTotalHoldPct4Wk);
    setTextById(
      "bt-savings-sub",
      (Number.isFinite(swing)
        ? fmtPct(swing, true) + " Hold Swing"
        : "— Hold Swing") +
        " • " +
        fmtPct(backtest.recreationalRetentionPct, false) +
        " Rec Flow Retained",
    );
    setTextById(
      "bt-window",
      fmtWindow(backtest.windowStartIso, backtest.windowEndIso),
    );
    setTextById("bt-tickets", fmtMetricInt(backtest.totalParlayTickets4Wk));
    setTextById("bt-legs", fmtMetricInt(backtest.totalParlayLegs4Wk));
    setTextById(
      "tab-customers",
      fmtMetricInt(backtest.totalProvisionedCustomers),
    );
    const compactSavings = Number.isFinite(
      Number(backtest.totalCounterfactualSavingsUsd),
    )
      ? Number(backtest.totalCounterfactualSavingsUsd)
      : Number(backtest.totalCounterfactualSavingsUsd4Wk);
    setTextById(
      "tab-savings",
      Number.isFinite(compactSavings) ? fmtUsdCompact(compactSavings) : "—",
    );
  }

  // Repo checks carry their own status: a measured row states when, an unrun row
  // states the command. "not measured" is never rendered as 0.
  function checkValueText(check) {
    if (!check || typeof check !== "object") return "—";
    if (check.status === "measured") {
      const age = check.stale ? "stale" : fmtAgeShort(check.ageSeconds);
      const when = age ? "measured " + age + " ago" : "measured";
      if (Number.isFinite(Number(check.tests))) {
        return (
          fmtMetricInt(check.tests) +
          " tests · " +
          fmtMetricInt(check.failures === undefined ? 0 : check.failures) +
          " fail · " +
          when
        );
      }
      return (
        (Number.isFinite(Number(check.value))
          ? fmtMetricInt(check.value) + " · "
          : "") + when
      );
    }
    if (check.status === "derived") {
      return (
        "derived" +
        (Number.isFinite(Number(check.value))
          ? " · " + fmtMetricInt(check.value)
          : "") +
        (check.source ? " · " + check.source : "")
      );
    }
    return "not measured" + (check.command ? " · " + check.command : "");
  }

  function bridgeValueText(bridge) {
    if (!bridge) return "—";
    if (bridge.state !== "measured" || !bridge.value) return "not measured";
    const value = bridge.value;
    if (Number.isFinite(Number(value.legs))) {
      const second = Number.isFinite(Number(value.tickets))
        ? fmtMetricInt(value.tickets) + " tickets"
        : Number.isFinite(Number(value.groups))
          ? fmtMetricInt(value.groups) + " tickets"
          : "— tickets";
      return fmtMetricInt(value.legs) + " legs · " + second;
    }
    if (Number.isFinite(Number(value.rows))) {
      return (
        fmtMetricInt(value.rows) +
        " rows" +
        (Number.isFinite(Number(value.matched))
          ? " · " + fmtMetricInt(value.matched) + " matched"
          : "")
      );
    }
    if (Number.isFinite(Number(value.pendingCount))) {
      return fmtMetricInt(value.pendingCount) + " pending";
    }
    if (Number.isFinite(Number(value.archive))) {
      return fmtMetricInt(value.archive) + " archived";
    }
    return "measured · see bridge table";
  }

  // The whole provenance sentence: basis + as-of + age, or the reason it is absent.
  function bridgeProvenanceText(bridge) {
    if (!bridge) return "unavailable — daemon-only";
    if (bridge.state !== "measured") {
      return (
        "not measured" + (bridge.command ? " · run " + bridge.command : "")
      );
    }
    const basis =
      bridge.basis === "capture"
        ? "captured"
        : bridge.basis === "census"
          ? "census"
          : bridge.basis || "measured";
    const asOf = bridge.asOf ? " " + asOfDay(bridge.asOf) : "";
    const age = bridge.stale ? " · stale" : "";
    const ageText =
      age ||
      (fmtAgeShort(bridge.ageSeconds)
        ? " · age " + fmtAgeShort(bridge.ageSeconds)
        : "");
    return basis + asOf + ageText;
  }

  function measuredField(bridge, keys) {
    if (!bridge || bridge.state !== "measured" || !bridge.value) return "—";
    for (let index = 0; index < keys.length; index += 1) {
      const raw = bridge.value[keys[index]];
      // `Number(null)` is 0: an absent optional count must read "—", not a fabricated zero.
      if (raw === null || raw === undefined) continue;
      const number = Number(raw);
      if (Number.isFinite(number)) return fmtInt(number);
    }
    return "—";
  }

  // Every [data-bridge-metric] evidence span resolves through here, so one
  // unmeasured bridge cannot leave a stale number standing in the prose.
  function bridgeMetricText(metric, byId) {
    const bridge1 = byId["bridge-1"];
    const bridge3a = byId["bridge-3a"];
    const weblog = byId["weblog"];
    switch (metric) {
      case "census.rows":
        return measuredField(bridge1, ["legs", "rows", "count"]);
      case "census.tickets":
        return measuredField(bridge1, ["tickets", "groups"]);
      case "census.asOf":
        return bridge1 && bridge1.asOf ? asOfDay(bridge1.asOf) : "—";
      case "ticker.archive":
        return measuredField(bridge3a, ["archive", "wagers", "total", "rows"]);
      case "ticker.window":
        return measuredField(bridge3a, [
          "window",
          "window7d",
          "inWindow",
          "wagersWindow",
        ]);
      case "weblog.rows":
        return measuredField(weblog, ["rows"]);
      case "weblog.matched":
        return measuredField(weblog, ["matched"]);
      case "weblog.window":
        return measuredField(weblog, ["windowWagers", "window"]);
      case "weblog.matchedPct": {
        const pct =
          weblog && weblog.value ? Number(weblog.value.matchedPct) : NaN;
        return Number.isFinite(pct) ? String(pct) + "%" : "—";
      }
      case "weblog.executionSnipers":
        return measuredField(weblog, ["executionSnipers"]);
      case "weblog.sniperTwins":
        return measuredField(weblog, ["sniperTwins"]);
      case "weblog.crossOfficeBeards":
        return measuredField(weblog, ["crossOfficeBeards"]);
      case "weblog.botRingAccounts":
        return measuredField(weblog, ["botRingAccounts"]);
      case "weblog.falsePositiveFlags":
        return measuredField(weblog, ["falsePositiveFlags"]);
      case "weblog.negativeControls":
        return measuredField(weblog, ["negativeControls"]);
      default:
        return "—";
    }
  }

  // Column definitions: `aria-label` (or `id`) of the table → exact <th> text →
  // one-line meaning. Applied as `th.title` + `.col-help` so every column answers
  // "what is this for" without a second DOM or a tooltip library.
  const COLUMN_HELP = {
    "source bridges": {
      Bridge: "Bridge number and its implementation slug.",
      "Source / implementation":
        "Files that produce and sink this bridge's data.",
      Status:
        "The bridge's own evidence state (LIVE / WIRED), not the feed's dataMode.",
      "Measured evidence":
        "Latest measured counts; the value spans carry their source and age.",
      Gates:
        "Repository gates that constrain this bridge, and what they actually enforce.",
    },
    "Gateway, WebSocket hub and scheduler": {
      Node: "One process or committed artifact on the distribution path.",
      Implementation: "Source file or env key that provides the node.",
      "Verified behavior":
        "What the code actually enforces as shipped, not the intended design.",
    },
    "Verified repo metrics": {
      Gate: "Verification step.",
      "Measured value":
        "Value measured at request time with its age; an unrun check says 'not measured'.",
      "Command / source":
        "Exact command or artifact that produces the measurement.",
    },
    "Live wager and bridge tape": {
      "Time (UTC)": "When the event was observed (UTC).",
      Source:
        "Transport/origin of the row: F402 ticker tick, bridge rollup, or gslive-wagers.",
      Login: "F402 customer login for a tick row.",
      Agent: "F402 agent that wrote the wager.",
      "Ticket/Wager": "Portal ticket number / wager number.",
      "Market / rollup": "Ticker short description, or a rollup's own totals.",
    },
    "Our Polymarket positions": {
      "#": "Rank by open position value.",
      Wallet: "Proxy wallet address (shortened).",
      Customer: "Bridged F402 customer id.",
      Agent: "Agent that owns the wallet.",
      Legs: "Open legs in this wallet's positions.",
      Cost: "Open position cost basis in USD.",
      Mark: "Current mark value in USD.",
      PnL: "Unrealized mark-minus-cost in USD.",
      Provenance:
        "LIVE / STALE / FIXTURE from the wallet's own capture, never inferred.",
      "Top open": "Largest single open position for this wallet.",
    },
    "Desk open book": {
      Venue: "Polymarket shadow leg vs Fantasy402 desk leg.",
      Customer: "Customer login behind the desk game.",
      Agent: "Agent that placed it.",
      Market: "Market / selection description.",
      Risk: "Open risk in USD.",
      "To win": "Potential win in USD.",
      "Desk verdict": "Desk read: matched parlay, shadow, layered, or trap.",
      "Placed (UTC)": "Placement timestamp (UTC).",
    },
    "Game state": {
      Game: "Team 1 vs Team 2, with the board rotation number when known.",
      "Sport / Period":
        "Sport • sub-sport • live period as the capture reports them.",
      Score:
        "Transcribed scoreboard score, else the ticket's team score fields, else '—'.",
      Status: "Scoreboard status/period when matched, else the ticket status.",
      "Pending risk / to-win":
        "Wagered and to-win (cents → USD) for the pending games.",
      "Source & age":
        "Capture source and timestamp; 'stale' once the capture is older than an hour.",
    },
    "Cluster summary": {
      "Cluster ID":
        "Internal cluster identity (positions that moved together).",
      Stream: "Which shadow stream the cluster belongs to.",
      "Canonical Market (condition_id / link_id)":
        "Canonical market key shared across venues.",
      "Lead Polymarket Profile & F402 Account":
        "Lead wallet and its bridged F402 customer.",
      "Open Stake": "Open stake in USD.",
      "PM Entry vs. F402 / Fair":
        "Polymarket entry price vs the F402 / fair line.",
      "Live Desk Status & Action": "Current desk verdict and the action taken.",
    },
    "F402 tick preview": {
      "Time (raw)": "insertedAt exactly as the F402 feed reported it.",
      Login: "Customer login from the raw tick.",
      Agent: "agentLogin, else agentId.",
      Writer: "Ticket writer from the raw tick.",
      "Wager #": "Wager number from the raw tick.",
      Description: "shortDesc from the raw tick.",
    },
    "Pending bets ledger": {
      "Ticket / Order ID": "Portal ticket/order identity.",
      "Venue Stream": "Stream the leg came from.",
      "Polymarket Profile & F402 Customer Profile":
        "Deep links for the wallet and the customer.",
      "Sport & Period": "Sport and period code.",
      "Canonical Market & Line (Hundredths)":
        "Market key and line in integer hundredths.",
      "Risk / To-Win (USD)": "Risk and potential win in USD.",
      "Placed Timestamp (UTC)": "When the wager was placed (UTC).",
      "Last Updated / Synced": "When the row was last refreshed.",
      "Live Desk Verdict": "Desk read and the guard/action applied.",
    },
    "Wallet registry": {
      "#": "Row number in the registry.",
      "Polymarket Proxy Wallet (0x)": "Proxy wallet address.",
      "Polymarket & Customer Profile Links":
        "Direct Polymarket profile and portal customer links.",
      "Bridged F402 ID & Sub-Agent":
        "F402 id and the sub-agent that carries it.",
      "Syndicate Cluster / Archetype": "Cluster and behavioural archetype.",
      "Today's Open Bets (Matched + Shadow)":
        "Open legs split matched vs shadow.",
      "Last Synced & Guard": "Last sync and the guard currently applied.",
    },
    "Combo uniqueness gates": {
      Gate: "Identity gate name.",
      Kept: "Combos that survive this gate.",
      "Unresolved legs": "Combos dropped for unresolvable legs.",
      "Cross-game": "Cross-game exclusions applied by this gate.",
      "Ineligible type": "Dropped for ineligible leg type.",
      "Included cross-game": "Cross-game combos this gate deliberately keeps.",
    },
    "Week-by-week backtest": {
      "Backtest Week": "Backtest week code and calendar window.",
      "Window (UTC)": "UTC date range covered by the week.",
      "CFB Parlays & Handle": "CFB parlay tickets (legs) and handle.",
      "CFB Desk Net (Base → Protected)":
        "CFB desk net unprotected → protected.",
      "NBA Parlays & Handle": "NBA parlay tickets (legs) and handle.",
      "NBA Desk Net (Base → Protected)":
        "NBA desk net unprotected → protected.",
      "Combined Handle": "Combined handle across all tickets.",
      "Combined Net & Hold %":
        "Combined net and hold % unprotected → protected.",
      "Desk Saved": "Counterfactual desk savings from the guards.",
      "Primary Weekly Catalyst": "The week's main combo catalyst.",
    },
    "Combo family performance": {
      Sport: "Sport the combo family belongs to.",
      "Combo / Parlay Family": "Family code and description.",
      "4-Wk Tickets (Legs)": "Tickets (legs) in the 4-week window.",
      "4-Wk Handle": "Handle in USD.",
      "Avg CLV (Win %)": "Average CLV in bps and hit rate.",
      "Baseline Unprotected Net": "Net if the guards had not blocked.",
      "Phase 6 Protected Net": "Net with the guards applied.",
      "Counterfactual Saved": "Baseline minus protected.",
      "Primary Guard & Mechanism": "Guard that fires and why.",
    },
    "Customer leaderboard": {
      Rank: "Rank by desk savings.",
      "Customer Profile & Bridged Polymarket 0x Links":
        "Customer and wallet deep links.",
      Archetype: "Behavioural archetype for the customer.",
      "4-Wk CFB Parlays": "CFB parlay count, handle and net.",
      "4-Wk NBA Parlays": "NBA parlay count, handle and net.",
      "Combined 4-Wk Handle": "Total 4-week handle.",
      "CLV & Sharp Score": "Average CLV and sharp score.",
      "Baseline Desk Net": "Desk net unprotected.",
      "Protected Desk Net": "Desk net with the guards.",
      "Desk Saved": "Savings attributed to the guards.",
      "Dominant Combo Family & Sample Ticket":
        "Most common combo family and a sample ticket.",
    },
    "Office IP tracker": {
      "Office / Sub-Agent & Wire Query":
        "Office agent and the wire query used.",
      "Match Classification": "PER_OFFICE / CROSS_OFFICE classification.",
      "Shared IP / /24 Subnet": "Shared IP address and its /24.",
      "Matched Customer Logins in Office (F402 + GSLive player_)":
        "Customers mapped to the office IP set.",
      "Cross-Office Beard Collisions": "Same owner seen across two offices.",
      "Bridged Polymarket 0x Wallets": "Wallets linked to that office.",
      "Mode A Dwell & MFCS Score": "Login-to-wager dwell and MFCS toxicity.",
      "Active ROTs & Auto-Enforcement":
        "ROTs seen and the enforcement applied.",
    },
    "ROT watchlist": {
      "Board ROT & Period": "Board rotation number and period.",
      "Signal Channel & Twin State": "Signal channel and twin/stepped state.",
      "Watchlist Customer Login & Poly 0x Profile":
        "Customer and proxy-wallet profile.",
      "Selection & Cross-Venue Line Delta":
        "Selection and the F402↔Poly line delta.",
      "Risk / To-Win & Type": "Risk/to-win and wager type.",
      "Real-Time Alert Fired & Desk Action":
        "Alert fired and the desk action taken.",
      "Placed & Last Synced": "Placement and last-sync timestamps.",
    },
    "Forensic modes catalog": {
      Domain: "Risk & exposure, identity & network, or reconciliation domain.",
      Mode: "Mode number and label.",
      "Checks Performed": "What the mode checks.",
      "Contracted Output": "Output the mode is contracted to return.",
      "Upstream Endpoints & Wire Rules":
        "Endpoints and wire rules the mode reads.",
      "Live Telemetry Snapshot & Drill-Down":
        "Latest telemetry sample and its drill-down.",
    },
    "Kalshi signals": {
      Signal:
        "Watchlist flow aggregated into a side: side team, market kind, line and league.",
      "Watchlist flow":
        "Distinct accounts, risk in USD and their archetypes; FIXTURE when the source rows are fixtures.",
      "Kalshi market":
        "Matched event/market ticker and title, or why no market was matched.",
      "Kalshi price":
        "Bid / ask in cents for the chosen side and the spread; '—' when unmatched or degraded.",
      Liquidity:
        "Top size, contracts fillable inside the reference notional, VWAP and the book verdict.",
      Edge: "Fair probability minus executable probability, in basis points; '—' when there is no fair price.",
      Verdict:
        "actionable / thin_liquidity / no_edge / stale / no_market / fixture_only, in that precedence.",
      "Source & age":
        "Kalshi fetch time and age plus the signal source as-of and stale flag.",
    },
    "GSLive weblogs": {
      Account: "Watchlist customer login (or GSLive player id).",
      Agent: "Agent that owns the account.",
      "Bets audited": "Bets whose bet/event log was parsed and audited.",
      Flags: "Audit flag codes with severity and occurrence count.",
      "Last log": "Timestamp of the most recent parsed log line.",
      Provenance:
        "Artifact source, as-of and age; an unmeasured artifact says so instead of '0'.",
    },
    "Execution decisions": {
      Signal:
        "Watchlist signal routed by the planner: side team, market kind, line and league.",
      "Venue & style":
        "Venue and execution style (taker emerald / maker cyan / blocked rose) plus the order action.",
      "Size / limit":
        "Planned notional and contracts at the rounded limit price; the cap is the policy.",
      "Edge / slippage":
        "Fair minus executable edge in bps and the modelled slippage vs mid.",
      "Verdict & reasons":
        "blocked with its reason, or the style; the small line lists the planner's reasons.",
      Provenance:
        "Paper/fixture/stale markers, signal data mode and the signal as-of date.",
    },
    "Paper fills": {
      Intent: "Execution intent (or quote id) this fill belongs to.",
      "Venue/ticker": "Venue and the market ticker/token the intent targets.",
      Side: "Order action and YES/NO position, as planned.",
      Price:
        "Average fill price (takers) or quote limit price (makers), in cents.",
      Size: "Notional and contract count for the fill or resting quote.",
      Status:
        "filled / partial / rejected, or 'resting' with the quote's expiry.",
      Age: "How long ago the fill or quote was recorded.",
    },
  };

  function applyColumnHelp() {
    if (!document || typeof document.querySelectorAll !== "function") return 0;
    let applied = 0;
    document.querySelectorAll("table").forEach(function (table) {
      const key = table.getAttribute("aria-label") || table.id || "";
      const help = COLUMN_HELP[key];
      if (!help || typeof table.querySelectorAll !== "function") return;
      table.querySelectorAll("th").forEach(function (th) {
        const label = String(th.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const meaning = help[label];
        if (!meaning) return;
        th.title = meaning;
        if (th.classList && typeof th.classList.add === "function") {
          th.classList.add("col-help");
        }
        applied += 1;
      });
    });
    return applied;
  }

  function setPill(id, text, tone) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "pill pill-" + tone;
  }

  function setTitleById(id, text) {
    const el = document.getElementById(id);
    if (el) el.title = text;
  }

  // The automation panel: feed (feed-file derivable) plus relay/cron/telegram
  // (daemon-only). Missing services are "daemon-only", never 0.
  let lastRelayText = "relay: daemon-only";
  // Once a summary frame has supplied feed.stale/ageSeconds those values are
  // authoritative; the bare feed file only supplies the heuristic fallback.
  let feedCardStrict = false;

  function relayStateText(relay) {
    if (!relay || typeof relay !== "object") return "relay: daemon-only";
    const status = String(relay.status || "unavailable");
    const age = Number(relay.lastFrameAgeSeconds);
    if (status === "connected") {
      return (
        "relay: connected" +
        (Number.isFinite(age) ? " · last frame " + fmtAgeShort(age) : "")
      );
    }
    if (status === "no_token") return "relay: no token";
    return "relay: " + status.replace(/_/g, " ");
  }

  function hydrateFeedCard(feed, strict) {
    if (!feed || typeof feed !== "object") return;
    if (strict === true) {
      feedCardStrict = true;
    } else if (feedCardStrict && feed.stale === undefined) {
      // A summary already stated the feed's freshness; do not replace it with
      // the file-age heuristic.
      return;
    }
    const mode = String(feed.dataMode || "").toUpperCase() || "—";
    let ageSeconds = Number(feed.ageSeconds);
    if (!Number.isFinite(ageSeconds) && feed.lastUpdatedIso) {
      const epoch = Date.parse(String(feed.lastUpdatedIso));
      if (Number.isFinite(epoch)) {
        ageSeconds = Math.max(0, (Date.now() - epoch) / 1_000);
      }
    }
    // The summary's own `stale` flag is authoritative; only a bare feed file
    // (no flag) falls back to the 5-minute poll-cadence heuristic.
    const stale =
      feed.stale === true ||
      (feed.stale === undefined &&
        Number.isFinite(ageSeconds) &&
        ageSeconds > 300);
    const ageText = stale
      ? "stale"
      : fmtAgeShort(ageSeconds)
        ? "age " + fmtAgeShort(ageSeconds)
        : "age unknown";
    const pollText =
      feed.pollSequence === undefined || feed.pollSequence === null
        ? "poll #—"
        : "poll #" + fmtMetricInt(feed.pollSequence);
    setTextById("auto-feed-value", mode);
    setTextById("auto-feed-sub", pollText + " · " + ageText);
    setPill(
      "auto-feed-state",
      "feed: " +
        (mode === "—" ? "—" : mode.toLowerCase()) +
        (stale ? " (stale)" : ""),
      stale
        ? "rose"
        : mode === "LIVE"
          ? "emerald"
          : mode === "FIXTURE"
            ? "rose"
            : "amber",
    );
  }

  function schedulesTitle(schedules) {
    if (!Array.isArray(schedules) || schedules.length === 0) return "";
    return schedules
      .map(function (schedule) {
        if (!schedule || typeof schedule !== "object") return null;
        const name = schedule.name || schedule.id || "schedule";
        const when = schedule.scheduleTime || "?";
        return name + " @ " + when;
      })
      .filter(Boolean)
      .join(" · ");
  }

  function hydrateAutomation(automation, feed) {
    if (feed && typeof feed === "object") hydrateFeedCard(feed, true);
    if (!automation || typeof automation !== "object") {
      setPill("auto-relay-state", "relay: daemon-only", "amber");
      setPill("auto-cron-state", "cron: daemon-only", "amber");
      setPill("auto-telegram-state", "telegram: daemon-only", "amber");
      setPill("auto-overall-state", "automation: daemon-only", "amber");
      setPill("eventlog-source", "relay: daemon-only", "amber");
      lastRelayText = "relay: daemon-only";
      return;
    }
    const relay = automation.wsRelay || {};
    const cron = automation.cron || {};
    const telegram = automation.telegram || {};
    const tones = [];

    // Relay: the daemon's upstream gateway socket, host-only.
    const relayStatus = String(relay.status || "unavailable");
    const relayText = relayStateText(relay);
    const relayTone =
      relayStatus === "connected"
        ? "emerald"
        : relayStatus === "no_token"
          ? "amber"
          : "rose";
    const relayParts = [];
    // `Number(null)` is 0: a relay that has never delivered a frame must not claim
    // "last frame 0s". Only a real number gets a last-frame age.
    const lastFrameAge = relay.lastFrameAgeSeconds;
    if (
      lastFrameAge !== null &&
      lastFrameAge !== undefined &&
      Number.isFinite(Number(lastFrameAge))
    ) {
      relayParts.push("last frame " + fmtAgeShort(lastFrameAge));
    }
    if (Array.isArray(relay.topics)) {
      relayParts.push(relay.topics.length + " topics");
    }
    if (relay.gatewayHost) relayParts.push(String(relay.gatewayHost));
    setTextById(
      "auto-relay-value",
      relayStatus === "no_token" ? "no token" : relayStatus,
    );
    setTextById("auto-relay-sub", relayParts.join(" · ") || "—");
    setPill("auto-relay-state", relayText, relayTone);
    setPill("eventlog-source", relayText, relayTone);
    lastRelayText = relayText;
    tones.push(relayTone);

    // Cron: enabled/total, with the schedule list in the value's title.
    const cronTotal = Number(cron.total);
    const cronEnabled = Number(cron.enabled);
    const cronKnown = Number.isFinite(cronTotal) && cronTotal > 0;
    setTextById(
      "auto-cron-value",
      cronKnown
        ? fmtMetricInt(cronEnabled) + "/" + fmtMetricInt(cronTotal)
        : "—",
    );
    setTextById(
      "auto-cron-sub",
      cron.engine
        ? String(cron.engine)
        : cronKnown
          ? fmtMetricInt(cronTotal) + " registered schedules"
          : "daemon-only",
    );
    const cronTone = cronKnown
      ? cronEnabled === cronTotal
        ? "emerald"
        : cronEnabled > 0
          ? "amber"
          : "rose"
      : "amber";
    setPill(
      "auto-cron-state",
      cronKnown
        ? "cron: " +
            fmtMetricInt(cronEnabled) +
            " of " +
            fmtMetricInt(cronTotal) +
            " enabled"
        : "cron: daemon-only",
      cronTone,
    );
    setTitleById("auto-cron-value", schedulesTitle(cron.schedules));
    tones.push(cronTone);

    // Telegram digest: mode + token/chat/inbound state; never the token itself.
    const tgMode = String(telegram.mode || "—");
    const tokenOk = telegram.tokenConfigured === true;
    const tgTone =
      telegram.error !== null && telegram.error !== undefined
        ? "rose"
        : tgMode === "live" && tokenOk
          ? "emerald"
          : "amber";
    const tgParts = [];
    tgParts.push(tokenOk ? "token set" : "no token");
    tgParts.push(
      fmtMetricInt(telegram.authorizedChatCount) + " authorized chats",
    );
    tgParts.push("inbound " + String(telegram.inbound || "none"));
    if (cronKnown) {
      tgParts.push(
        fmtMetricInt(cronEnabled) +
          "/" +
          fmtMetricInt(cronTotal) +
          " schedules enabled",
      );
    }
    setTextById("auto-telegram-value", tgMode);
    setTextById("auto-telegram-sub", tgParts.join(" · "));
    setPill(
      "auto-telegram-state",
      "telegram: " + tgMode + (tokenOk ? "" : " (no token)"),
      tgTone,
    );
    setTitleById(
      "auto-telegram-value",
      String(telegram.modeReason || telegram.error || "telegram digest mode"),
    );
    tones.push(tgTone);

    const overall = tones.includes("rose")
      ? "rose"
      : tones.includes("amber")
        ? "amber"
        : "emerald";
    setPill(
      "auto-overall-state",
      "automation: " +
        (overall === "emerald"
          ? "ok"
          : overall === "amber"
            ? "degraded"
            : "off"),
      overall,
    );
  }

  // Game state: the per-game view of /api/live-bets, daemon-only. The capture is a
  // snapshot, so every row carries its source + age and says "stale" past one hour.
  const GAME_STATE_STALE_MS = 60 * 60 * 1_000;
  const gameStateBody = document.getElementById("game-state-tbody");
  const gameStateSourceEl = document.getElementById("game-state-source");
  const gameStateAgeEl = document.getElementById("game-state-age");
  const gameStateRefreshBtn = document.getElementById("game-state-refresh");
  let gameStateLoading = false;
  let gameStateDaemonAvailable = null;
  let gameStateLastSequence = null;

  function fmtCentsUsd(cents) {
    const number = Number(cents);
    if (!Number.isFinite(number)) return "—";
    return fmtUsd(number / 100);
  }

  function gameStateMessage(message) {
    if (!gameStateBody) return;
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 6;
    cell.className = "tape-empty";
    cell.textContent = message;
    row.appendChild(cell);
    gameStateBody.replaceChildren(row);
  }

  function gameStateCell(text, className) {
    const cell = document.createElement("td");
    if (className) cell.className = className;
    cell.textContent = text === null || text === undefined ? "—" : String(text);
    return cell;
  }

  function gameTeamLabel(game) {
    const team1 = game && game.team1 ? game.team1 : {};
    const team2 = game && game.team2 ? game.team2 : {};
    const name1 = String(team1.name || team1.shortName || "").trim();
    const name2 = String(team2.name || team2.shortName || "").trim();
    if (name1 === "" && name2 === "") return "—";
    const rots = [team1.rotationNumber, team2.rotationNumber].filter(
      function (value) {
        return Number.isFinite(Number(value));
      },
    );
    return (
      (name1 || "—") +
      " vs " +
      (name2 || "—") +
      (rots.length > 0 ? " · ROT " + rots.join("/") : "")
    );
  }

  function gameScoreText(game) {
    const board = game && game.scoreboard ? game.scoreboard : null;
    if (board && Number.isFinite(Number(board.team1Score))) {
      return (
        fmtMetricInt(board.team1Score) + "–" + fmtMetricInt(board.team2Score)
      );
    }
    const team1 = game && game.team1 ? game.team1 : {};
    const team2 = game && game.team2 ? game.team2 : {};
    if (
      Number.isFinite(Number(team1.score)) &&
      Number.isFinite(Number(team2.score))
    ) {
      return fmtMetricInt(team1.score) + "–" + fmtMetricInt(team2.score);
    }
    return "—";
  }

  function gameStatusText(game) {
    const board = game && game.scoreboard ? game.scoreboard : null;
    if (board && (board.status || board.period)) {
      return [board.status, board.period].filter(Boolean).join(" · ");
    }
    return String((game && game.status) || "—");
  }

  function ageFromIso(iso) {
    const epoch = Date.parse(String(iso || ""));
    if (!Number.isFinite(epoch)) return null;
    return Math.max(0, Date.now() - epoch);
  }

  function renderGameState(payload) {
    if (!gameStateBody) return;
    const games = Array.isArray(payload && payload.games) ? payload.games : [];
    const summary = (payload && payload.summary) || {};
    const dataSource = String(summary.dataSource || "—");
    const capturedAt = summary.capturedAt || null;
    const ageMs = ageFromIso(capturedAt);
    const stale = Number.isFinite(ageMs) && ageMs > GAME_STATE_STALE_MS;
    const ageText = stale
      ? "stale"
      : Number.isFinite(ageMs)
        ? fmtAgeShort(ageMs / 1_000)
        : "unknown";
    if (gameStateSourceEl) {
      gameStateSourceEl.textContent = "source: " + dataSource;
      gameStateSourceEl.className =
        "pill pill-" +
        (dataSource === "—" ? "amber" : stale ? "rose" : "emerald");
    }
    if (gameStateAgeEl) {
      gameStateAgeEl.textContent = "age: " + ageText;
      gameStateAgeEl.className = "pill pill-" + (stale ? "rose" : "amber");
      gameStateAgeEl.title = capturedAt
        ? "captured " + capturedAt
        : "no capture timestamp";
    }
    if (games.length === 0) {
      gameStateMessage(
        "0 games in the capture — the pending wager set is empty for this source (" +
          dataSource +
          "). The row list is complete; this is a measured zero, not a failure.",
      );
      return;
    }
    const rows = games.map(function (game) {
      const row = document.createElement("tr");
      row.appendChild(gameStateCell(gameTeamLabel(game)));
      const sport = [game.sport, game.subSport, game.period]
        .filter(Boolean)
        .join(" • ");
      row.appendChild(gameStateCell(sport || "—"));
      row.appendChild(gameStateCell(gameScoreText(game)));
      row.appendChild(gameStateCell(gameStatusText(game)));
      row.appendChild(
        gameStateCell(
          fmtCentsUsd(game.wagered) + " / " + fmtCentsUsd(game.toWin),
        ),
      );
      row.appendChild(
        gameStateCell(
          dataSource +
            (capturedAt ? " · captured " + capturedAt : " · no capture time") +
            (stale ? " · stale" : ""),
          "wrap",
        ),
      );
      return row;
    });
    gameStateBody.replaceChildren.apply(gameStateBody, rows);
  }

  function renderGameStateUnavailable(reason) {
    gameStateMessage(reason);
    if (gameStateSourceEl) {
      gameStateSourceEl.textContent = "source: daemon-only";
      gameStateSourceEl.className = "pill pill-amber";
    }
    if (gameStateAgeEl) {
      gameStateAgeEl.textContent = "age: —";
      gameStateAgeEl.className = "pill pill-amber";
    }
  }

  async function loadGameState() {
    if (gameStateLoading || !gameStateBody) return;
    gameStateLoading = true;
    try {
      const token = adminToken();
      const headers = { Accept: "application/json" };
      if (token !== "") headers.Authorization = "Bearer " + token;
      const res = await fetch("/api/live-bets", {
        headers: headers,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        gameStateDaemonAvailable = false;
        renderGameStateUnavailable(
          "Refused (" +
            res.status +
            ") — /api/live-bets requires the operator token in <meta name=sportsdesk-admin-token>.",
        );
        return;
      }
      if (res.status === 404) {
        gameStateDaemonAvailable = false;
        renderGameStateUnavailable(
          "No /api/live-bets here (404) — game state is daemon-only; this edge serves the committed feed instead.",
        );
        return;
      }
      if (!res.ok) {
        gameStateDaemonAvailable = false;
        renderGameStateUnavailable(
          "HTTP " +
            res.status +
            " from /api/live-bets — game state unavailable.",
        );
        return;
      }
      const payload = await res.json();
      gameStateDaemonAvailable = true;
      renderGameState(payload);
    } catch {
      gameStateDaemonAvailable = false;
      renderGameStateUnavailable(
        "Network error — the daemon is not reachable here, so game state is daemon-only.",
      );
    } finally {
      gameStateLoading = false;
    }
  }

  // The tape is the bridge event log; a feed that carries a gsliveWagers rollup
  // still produces a visible event even when there are zero individual ticks.
  function gsliveWagersTapeRow(data) {
    const rollup = data && data.gsliveWagers;
    if (!rollup || typeof rollup !== "object" || Array.isArray(rollup)) {
      return null;
    }
    const parts = [];
    const legs = Number(
      rollup.legCount === undefined ? rollup.legs : rollup.legCount,
    );
    const wagers = Number(
      rollup.wagerCount === undefined ? rollup.wagers : rollup.wagerCount,
    );
    const tickets = Number(
      rollup.ticketCount === undefined ? rollup.tickets : rollup.ticketCount,
    );
    const riskCents = Number(rollup.riskCents);
    const riskUsd = Number(rollup.riskUsd);
    const toWinCents = Number(rollup.toWinCents);
    const toWinUsd = Number(rollup.toWinUsd);
    if (Number.isFinite(legs)) parts.push("legs " + fmtMetricInt(legs));
    if (Number.isFinite(wagers)) parts.push("wagers " + fmtMetricInt(wagers));
    if (Number.isFinite(tickets))
      parts.push("tickets " + fmtMetricInt(tickets));
    if (Number.isFinite(riskUsd)) parts.push("risk " + fmtUsd(riskUsd));
    else if (Number.isFinite(riskCents))
      parts.push("risk " + fmtUsd(riskCents / 100));
    if (Number.isFinite(toWinUsd)) parts.push("to-win " + fmtUsd(toWinUsd));
    else if (Number.isFinite(toWinCents)) {
      parts.push("to-win " + fmtUsd(toWinCents / 100));
    }
    if (parts.length === 0) return null;
    const atIso = String(data.lastUpdatedIso || "");
    return {
      id:
        "gslive-wagers|" +
        atIso +
        "|" +
        String(data.pollSequence === undefined ? "" : data.pollSequence),
      atIso: atIso,
      source: "gslive-wagers",
      label: "GSLive wagers rollup",
      login: "—",
      agent: "—",
      ticket: "—",
      summary: parts.join(" · "),
      kind: "rollup",
    };
  }

  function formatClock(value) {
    const match = /(\d{2}):(\d{2})/.exec(
      String(value === undefined ? "" : value),
    );
    return match ? match[1] + ":" + match[2] : "—";
  }

  // Feed-derived labels work on the static Pages edge too: they need only
  // ./graph-live-feed.json, never the daemon.
  function hydrateFeedLabels(data) {
    if (!data || typeof data !== "object") return;
    const counts = data.counts || {};
    hydrateFeedCard(data);
    setTextById(
      "tab-pending-updated",
      formatClock(data.lastUpdatedCdt || data.lastUpdatedIso),
    );
    const ten =
      data.tenModeSnapshot && data.tenModeSnapshot.mode3SharedIpOverview;
    const ipClusters = Number.isFinite(Number(counts.ipClusters))
      ? Number(counts.ipClusters)
      : ten && Number.isFinite(Number(ten.totalAccountGroups))
        ? Number(ten.totalAccountGroups)
        : null;
    const clusterText = ipClusters === null ? "—" : fmtInt(ipClusters);
    [
      "tab-cluster-count",
      "tab-ip-clusters",
      "clusters-heading",
      "clusters-all-count",
    ].forEach(function (id) {
      setTextById(id, clusterText);
    });

    const walletCount = Number.isFinite(Number(counts.walletProfiles))
      ? Number(counts.walletProfiles)
      : Number.isFinite(Number(counts.configuredWallets))
        ? Number(counts.configuredWallets)
        : Number.isFinite(Number(data.configuredWalletsCount))
          ? Number(data.configuredWalletsCount)
          : Array.isArray(data.walletProfiles)
            ? data.walletProfiles.length
            : null;
    setTextById(
      "tab-wallet-count",
      walletCount === null ? "—" : fmtInt(walletCount),
    );
    setTextById(
      "wallet-registry-count",
      walletCount === null ? "—" : fmtInt(walletCount),
    );

    const openLegs = Number.isFinite(Number(counts.openLegs))
      ? Number(counts.openLegs)
      : Number.isFinite(Number(data.totalOpenLegsCount))
        ? Number(data.totalOpenLegsCount)
        : null;
    const legsText = openLegs === null ? "—" : fmtInt(openLegs);
    setTextById("tab-pending-legs", legsText);
    setTextById("topology-legs", legsText);
    setTextById("pending-heading", legsText);

    const exposure = Number.isFinite(Number(data.totalOpenExposureUsd))
      ? Number(data.totalOpenExposureUsd)
      : Number.isFinite(Number(counts.openExposureUsd))
        ? Number(counts.openExposureUsd)
        : null;
    setTextById(
      "clusters-exposure-heading",
      exposure === null ? "—" : fmtInt(exposure),
    );

    // The backtest aggregates only move when the feed carries backtest4Wk;
    // a summary frame without it must not wipe the last honest value.
    if (data.backtest4Wk) hydrateBacktestLabels(data.backtest4Wk);

    if (data.wssIngestion) {
      setTextById(
        "wss-state",
        "WSS: " +
          String(data.wssIngestion).replace(/_/g, " ") +
          (Number.isFinite(Number(data.wsStreamSlaMsFixture))
            ? " · " + fmtInt(data.wsStreamSlaMsFixture) + "ms fixture sample"
            : ""),
      );
    }
  }

  // One hydration path for the whole contract envelope. textContent only.
  function hydrateDashboardSummary(summary) {
    if (!summary || typeof summary !== "object") return;
    dashboardSummary = summary;
    const feed = summary.feed || {};
    const repo = summary.repo || {};
    const bridges = Array.isArray(summary.bridges) ? summary.bridges : [];
    const routes = repo.routes || {};
    const citations = repo.citations || {};
    const checks = repo.checks || {};
    const counts = feed.counts || {};
    const byId = {};
    bridges.forEach(function (bridge) {
      if (bridge && typeof bridge.id === "string") byId[bridge.id] = bridge;
    });

    const head =
      typeof repo.head === "string" && repo.head !== "" ? repo.head : null;
    setTextById("head-commit", head || "local checkout");
    if (document && typeof document.title === "string") {
      document.title =
        "SportsDesk — Ingestion Data Plane & Surveillance Graph" +
        (head ? " · " + head : "");
    }
    const measured = bridges.filter(function (bridge) {
      return bridge && bridge.state === "measured";
    }).length;
    setTextById(
      "bridge-counts",
      bridges.length === 0
        ? "bridges: —"
        : "bridges: " +
            measured +
            " measured · " +
            (bridges.length - measured) +
            " not measured",
    );

    hydrateFeedLabels(feed);
    // v2 extension: relay/cron/telegram state (daemon-only) + the feed card.
    hydrateAutomation(summary.automation, feed);

    setTextById("kpi-active-wallets", fmtMetricInt(counts.activeWallets));
    const feedAge = feed.stale
      ? "stale"
      : fmtAgeShort(feed.ageSeconds)
        ? "age " + fmtAgeShort(feed.ageSeconds)
        : "age unknown";
    setTextById(
      "kpi-wallet-provenance",
      fmtMetricInt(counts.configuredWallets) +
        " configured · " +
        (feed.dataMode || "—") +
        " · " +
        feedAge,
    );

    ["bridge-1", "bridge-3a", "bridge-3b", "bridge-3c"].forEach(function (id) {
      setTextById("kpi-" + id, bridgeValueText(byId[id]));
      setTextById("kpi-" + id + "-sub", bridgeProvenanceText(byId[id]));
    });
    setTextById("kpi-weblog", bridgeValueText(byId.weblog));
    setTextById("kpi-weblog-sub", bridgeProvenanceText(byId.weblog));

    setTextById(
      "kpi-repo",
      Number.isFinite(Number(routes.served))
        ? fmtMetricInt(routes.served) + " routes"
        : "—",
    );
    const citationsText = Number.isFinite(Number(citations.checked))
      ? fmtMetricInt(citations.checked) +
        " citations / " +
        fmtMetricInt(citations.anchors) +
        " anchors"
      : null;
    const testsText = checkValueText(checks.tests);
    setTextById(
      "kpi-repo-sub",
      citationsText ? testsText + " · " + citationsText : testsText,
    );

    setTextById("gate-tests-value", testsText);
    setTextById("gate-typecheck-value", checkValueText(checks.typecheck));
    setTextById(
      "gate-routes-value",
      Number.isFinite(Number(routes.served))
        ? fmtMetricInt(routes.served) +
            " routes (" +
            fmtMetricInt(routes.exact) +
            " exact + " +
            fmtMetricInt(routes.prefix) +
            " prefix)"
        : "not measured · bun run check:route-surface",
    );
    setTextById(
      "gate-citations-value",
      citationsText || "not measured · bun run check:spec-citations",
    );
    setTextById("gate-docs-value", checkValueText(checks.docs));

    ["bridge-1", "bridge-3a", "bridge-3b", "bridge-3c"].forEach(function (id) {
      setTextById(id + "-value", bridgeValueText(byId[id]));
      setTextById(id + "-sub", bridgeProvenanceText(byId[id]));
    });
    setTextById("weblog-value", bridgeValueText(byId.weblog));
    setTextById("weblog-sub", bridgeProvenanceText(byId.weblog));

    document.querySelectorAll("[data-bridge-metric]").forEach(function (el) {
      el.textContent = bridgeMetricText(
        el.getAttribute("data-bridge-metric"),
        byId,
      );
    });
  }

  // With no daemon the repo/bridge/gate values cannot be measured from here.
  // Say that instead of leaving a number from a previous deployment on screen.
  function markDashboardDaemonOnly() {
    if (dashboardSummary) return;
    const daemonOnly = "unavailable — daemon-only";
    [
      "head-commit",
      "bridge-counts",
      "kpi-bridge-1",
      "kpi-bridge-1-sub",
      "kpi-bridge-3a",
      "kpi-bridge-3a-sub",
      "kpi-bridge-3b",
      "kpi-bridge-3b-sub",
      "kpi-bridge-3c",
      "kpi-bridge-3c-sub",
      "kpi-weblog",
      "kpi-weblog-sub",
      "kpi-repo",
      "kpi-repo-sub",
      "bridge-1-value",
      "bridge-1-sub",
      "bridge-3a-value",
      "bridge-3a-sub",
      "bridge-3b-value",
      "bridge-3b-sub",
      "bridge-3c-value",
      "bridge-3c-sub",
      "weblog-value",
      "weblog-sub",
      "gate-tests-value",
      "gate-typecheck-value",
      "gate-routes-value",
      "gate-citations-value",
      "gate-docs-value",
    ].forEach(function (id) {
      setTextById(id, daemonOnly);
    });
    // Automation relay/cron/telegram need the daemon; the feed card does not.
    [
      "auto-relay-value",
      "auto-relay-sub",
      "auto-cron-value",
      "auto-cron-sub",
      "auto-telegram-value",
      "auto-telegram-sub",
    ].forEach(function (id) {
      setTextById(id, daemonOnly);
    });
    setPill("auto-relay-state", "relay: daemon-only", "amber");
    setPill("auto-cron-state", "cron: daemon-only", "amber");
    setPill("auto-telegram-state", "telegram: daemon-only", "amber");
    setPill("auto-overall-state", "automation: daemon-only", "amber");
    setPill("eventlog-source", "relay: daemon-only", "amber");
    lastRelayText = "relay: daemon-only";
    renderGameStateUnavailable(
      "No /api/live-bets on this edge — game state is daemon-only; the committed feed is still polled.",
    );
    document.querySelectorAll("[data-bridge-metric]").forEach(function (el) {
      el.textContent = "—";
    });
  }

  function setStreamState(state) {
    streamLive = state === "live";
    if (!dataStreamStateEl) return;
    dataStreamStateEl.textContent = "stream: " + state;
    dataStreamStateEl.className =
      "pill pill-" +
      (state === "live"
        ? "emerald"
        : state === "reconnecting"
          ? "cyan"
          : state === "polling"
            ? "amber"
            : "rose");
    dataStreamStateEl.title =
      state === "live"
        ? "SSE /api/graph/stream — summary frames push, and the full feed is refetched when it moves"
        : state === "reconnecting"
          ? "SSE stream dropped; reconnecting with capped exponential backoff"
          : state === "polling"
            ? "No stream on this edge — falling back to the 15s graph-live-feed.json poll"
            : "Stream unreachable and the feed poll is not answering; last rendered values stay on screen";
  }

  function adminToken() {
    try {
      if (!document || typeof document.querySelector !== "function") return "";
      const meta = document.querySelector(
        'meta[name="sportsdesk-admin-token"]',
      );
      if (!meta || typeof meta.getAttribute !== "function") return "";
      return String(meta.getAttribute("content") || "").trim();
    } catch {
      return "";
    }
  }

  function scheduleStreamReconnect() {
    if (streamReconnectTimer !== null) return;
    if (streamAttempts >= STREAM_MAX_ATTEMPTS) {
      setStreamState("polling");
      return;
    }
    streamReconnectTimer = setTimeout(function () {
      streamReconnectTimer = null;
      streamAttempts += 1;
      connectDashboardStream();
    }, streamBackoffMs);
    streamBackoffMs = Math.min(streamBackoffMs * 2, 30_000);
  }

  function dispatchStreamFrame(frame) {
    if (typeof frame !== "string" || frame === "") return;
    lastStreamFrameMs = Date.now();
    let eventName = "message";
    const dataLines = [];
    frame.split("\n").forEach(function (line) {
      if (line === "" || line.indexOf(":") === 0) return; // SSE heartbeat comment
      if (line.indexOf("event:") === 0) {
        eventName = line.slice(6).trim();
        return;
      }
      if (line.indexOf("data:") === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    });
    if (dataLines.length === 0 || eventName !== "summary") return;
    let summary = null;
    try {
      summary = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (!summary || typeof summary !== "object") return;
    hydrateDashboardSummary(summary);
    // Only refetch the whole feed when the summary says the feed actually moved.
    const feed = summary.feed || {};
    const stamp =
      String(feed.pollSequence === undefined ? "" : feed.pollSequence) +
      "|" +
      String(feed.lastUpdatedIso === undefined ? "" : feed.lastUpdatedIso);
    if (stamp !== lastSummaryFeedStamp) {
      lastSummaryFeedStamp = stamp;
      pollLiveFeed();
    }
  }

  async function consumeDashboardStream(body, controller) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const watchdog = setInterval(function () {
      if (Date.now() - lastStreamFrameMs > STREAM_HEARTBEAT_TIMEOUT_MS) {
        setStreamState("reconnecting");
        if (controller) controller.abort();
      }
    }, 15_000);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        lastStreamFrameMs = Date.now();
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          dispatchStreamFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
      }
      setStreamState("reconnecting");
    } catch {
      setStreamState(
        controller && controller.signal && controller.signal.aborted
          ? "reconnecting"
          : "offline",
      );
    } finally {
      clearInterval(watchdog);
      streamController = null;
      try {
        reader.releaseLock();
      } catch {
        // the reader is already released
      }
    }
    scheduleStreamReconnect();
  }

  function connectDashboardStream() {
    if (typeof fetch !== "function" || typeof TextDecoder !== "function") {
      setStreamState("offline");
      return;
    }
    const nav = globalThis.location;
    if (!nav || (nav.protocol !== "http:" && nav.protocol !== "https:")) {
      setStreamState("offline");
      return;
    }
    if (streamController !== null) return;
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    streamController = controller;
    const token = adminToken();
    const headers = { Accept: "text/event-stream" };
    if (token !== "") headers.Authorization = "Bearer " + token;
    setStreamState("reconnecting");
    Promise.resolve()
      .then(function () {
        return fetch("/api/graph/stream", {
          method: "GET",
          headers: headers,
          cache: "no-store",
          signal: controller ? controller.signal : undefined,
        });
      })
      .then(function (res) {
        if (
          !res ||
          !res.ok ||
          !res.body ||
          typeof res.body.getReader !== "function"
        ) {
          streamController = null;
          if (res && (res.status === 404 || res.status === 401)) {
            // Static Pages edge (404) or a daemon that rejected the operator
            // token (401): no stream here, so poll the committed feed.
            markDashboardDaemonOnly();
            setStreamState("polling");
            return;
          }
          setStreamState("polling");
          scheduleStreamReconnect();
          return;
        }
        streamAttempts = 0;
        streamBackoffMs = 1_000;
        lastStreamFrameMs = Date.now();
        setStreamState("live");
        consumeDashboardStream(res.body, controller);
      })
      .catch(function () {
        streamController = null;
        setStreamState("offline");
        scheduleStreamReconnect();
      });
  }

  // 10. Tab 7 — Kalshi signals + GSLive WebLog activity (read-only).
  // The page only reads the two daemon endpoints; it never calls Kalshi and
  // never holds a Kalshi credential. Every failure renders its reason: a
  // missing market or degraded fetch is "—", never an invented number.
  const KALSHI_REFRESH_MS = 60_000;
  const kalshiSignalsTbody = document.getElementById("kalshi-signals-tbody");
  const weblogsTbody = document.getElementById("gslive-weblogs-tbody");
  let kalshiLoadedMs = 0;
  let kalshiLoading = false;
  let kalshiDaemonAvailable = null;
  let weblogsLoadedMs = 0;
  let weblogsLoading = false;
  let weblogsDaemonAvailable = null;

  function kalshiPanelVisible() {
    const panel = document.getElementById("kalshi-signals-panel");
    return panel !== null && !panel.hasAttribute("hidden");
  }

  function firstNumber() {
    for (let index = 0; index < arguments.length; index += 1) {
      const raw = arguments[index];
      if (raw === null || raw === undefined || raw === "") continue;
      const number = Number(raw);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function firstText() {
    for (let index = 0; index < arguments.length; index += 1) {
      const raw = arguments[index];
      if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
    }
    return null;
  }

  function flatValue(container, names) {
    if (!container || typeof container !== "object") return null;
    for (let index = 0; index < names.length; index += 1) {
      const value = container[names[index]];
      if (value !== undefined && value !== null) return value;
    }
    return null;
  }

  // Join fields may be flat or nested under `market` / `price` / `liquidity`;
  // try the join object first, then the named sub-object.
  function signalValue(signal, sub, names) {
    const join =
      signal && signal.kalshi && typeof signal.kalshi === "object"
        ? signal.kalshi
        : signal || {};
    const flat = flatValue(join, names);
    if (flat !== null) return flat;
    return sub ? flatValue(join[sub], names) : null;
  }

  function priceCents(raw) {
    const number = firstNumber(raw);
    if (number === null) return null;
    return number <= 1 ? Math.round(number * 100) : Math.round(number);
  }

  function cellText(value) {
    if (value === null || value === undefined || value === "") return "—";
    return String(value);
  }

  function makeRow(values, wrapIndex) {
    const row = document.createElement("tr");
    values.forEach(function (value, index) {
      const cell = document.createElement("td");
      if (index === wrapIndex) cell.className = "wrap";
      cell.textContent = cellText(value);
      row.appendChild(cell);
    });
    return row;
  }

  function pillRow(values, pillIndex, tone, wrapIndex) {
    const row = document.createElement("tr");
    values.forEach(function (value, index) {
      const cell = document.createElement("td");
      if (index === wrapIndex) cell.className = "wrap";
      if (index === pillIndex) {
        const pill = document.createElement("span");
        pill.className = "pill pill-" + tone;
        pill.textContent = cellText(value);
        cell.appendChild(pill);
      } else {
        cell.textContent = cellText(value);
      }
      row.appendChild(cell);
    });
    return row;
  }

  function messageRow(span, message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = span;
    cell.className = "tape-empty";
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  function replaceRows(tbody, rows) {
    if (!tbody) return;
    tbody.replaceChildren.apply(tbody, rows);
  }

  function verdictTone(verdict) {
    if (verdict === "actionable") return "emerald";
    if (verdict === "no_market" || verdict === "error") return "rose";
    if (verdict === "fixture_only") return "slate";
    return "amber";
  }

  function normalizeVerdict(signal) {
    const raw = firstText(
      signal && signal.verdict,
      signal && signal.kalshiVerdict,
      signal && signal.kalshi && signal.kalshi.verdict,
    );
    return raw === null ? null : raw.toLowerCase().replace(/\s+/g, "_");
  }

  function signalLabel(signal) {
    const league = firstText(signal && signal.league);
    const kind = firstText(signal && (signal.marketKind || signal.kind));
    const side = firstText(signal && signal.sideTeam);
    const teams = Array.isArray(signal && signal.teams)
      ? signal.teams.filter(Boolean).join(" / ")
      : null;
    const line = firstNumber(signal && signal.line);
    const head = side || teams || "—";
    const sideText = head + (kind ? " " + kind : "");
    const lineText = line === null ? "" : " " + (line > 0 ? "+" : "") + line;
    return [sideText + lineText, league].filter(Boolean).join(" · ");
  }

  function flowText(signal) {
    const accounts = Array.isArray(signal && signal.accounts)
      ? signal.accounts
      : [];
    const count =
      firstNumber(signal && signal.distinctAccounts) ??
      (accounts.length > 0 ? accounts.length : null);
    let risk = firstNumber(
      signal && signal.riskUsd,
      signal && signal.totalRiskUsd,
    );
    if (risk === null && accounts.length > 0) {
      risk = accounts.reduce(function (sum, account) {
        const value = Number(account && account.riskUsd);
        return sum + (Number.isFinite(value) ? value : 0);
      }, 0);
    }
    const archetypes = [];
    accounts.forEach(function (account) {
      const label = firstText(
        account && account.archetype,
        account && account.sourceCategory,
      );
      if (label !== null && archetypes.indexOf(label) === -1) {
        archetypes.push(label);
      }
    });
    const parts = [];
    if (count !== null)
      parts.push(fmtInt(count) + (count === 1 ? " account" : " accounts"));
    if (risk !== null) parts.push("risk " + fmtUsd(risk));
    if (archetypes.length > 0) parts.push(archetypes.slice(0, 3).join(", "));
    const provenance = (signal && signal.provenance) || {};
    if (provenance.fixture === true) parts.push("FIXTURE");
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function marketText(signal) {
    const ticker = firstText(
      signalValue(signal, "market", ["marketTicker", "ticker"]),
    );
    const eventTicker = firstText(
      signalValue(signal, "market", ["eventTicker", "event_ticker"]),
      signalValue(signal, null, ["eventTicker"]),
    );
    const title = firstText(
      signalValue(signal, "market", [
        "title",
        "marketTitle",
        "name",
        "yesSubTitle",
      ]),
    );
    if (ticker === null && eventTicker === null && title === null) {
      const reason = firstText(
        signalValue(signal, null, ["reason"]),
        signal && signal.reason,
      );
      return reason === null ? "no market matched" : "no market · " + reason;
    }
    const parts = [];
    if (eventTicker !== null) parts.push(eventTicker);
    if (ticker !== null && ticker !== eventTicker) parts.push(ticker);
    if (title !== null) parts.push(title);
    return parts.join(" · ");
  }

  function priceText(signal) {
    const bid = priceCents(
      signalValue(signal, "price", ["bidCents", "bid", "yesBid", "yes_bid"]),
    );
    const ask = priceCents(
      signalValue(signal, "price", ["askCents", "ask", "yesAsk", "yes_ask"]),
    );
    const spreadCents = firstNumber(
      signalValue(signal, "price", ["spreadCents"]),
      signalValue(signal, "liquidity", ["spreadCents"]),
    );
    if (bid !== null || ask !== null) {
      return (
        (bid === null ? "—" : bid + "¢") +
        " / " +
        (ask === null ? "—" : ask + "¢") +
        (spreadCents === null
          ? ""
          : " · spread " + Math.round(spreadCents) + "¢")
      );
    }
    // The join reports the executable price for the chosen side plus the
    // book-walked vwap; show those instead of a bare "—" when a market matched.
    const executable = firstNumber(
      signalValue(signal, "market", ["executablePrice"]),
      signalValue(signal, null, ["executablePrice"]),
    );
    if (executable === null) return "—";
    const side = firstText(
      signalValue(signal, "market", ["side"]),
      signalValue(signal, null, ["side"]),
    );
    const vwap = priceCents(
      signalValue(signal, "liquidity", ["vwap", "vwapPrice"]),
    );
    const parts = [
      (side === null ? "" : side + " ") + priceCents(executable) + "¢",
    ];
    if (spreadCents !== null)
      parts.push("spread " + Math.round(spreadCents) + "¢");
    if (vwap !== null && vwap !== priceCents(executable)) {
      parts.push("vwap " + vwap + "¢");
    }
    return parts.join(" · ");
  }

  function liquidityText(signal, config) {
    const topSize = firstNumber(
      signalValue(signal, "liquidity", ["topSize", "topSizeContracts"]),
    );
    const depth = firstNumber(
      signalValue(signal, "liquidity", ["depthContracts", "depth"]),
    );
    const referenceNotional = firstNumber(
      signalValue(signal, "liquidity", ["referenceNotionalUsd"]),
      config && config.referenceNotionalUsd,
    );
    const vwap = priceCents(
      signalValue(signal, "liquidity", ["vwap", "vwapPrice"]),
    );
    const verdict = firstText(signalValue(signal, "liquidity", ["verdict"]));
    const parts = [];
    if (topSize !== null) parts.push("top " + fmtInt(topSize));
    if (depth !== null) {
      parts.push(
        fmtInt(depth) +
          " deep" +
          (referenceNotional === null
            ? ""
            : " within " + fmtUsd(referenceNotional)),
      );
    }
    if (vwap !== null) parts.push("vwap " + vwap + "¢");
    if (verdict !== null) parts.push(verdict);
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function edgeText(signal) {
    const bps = firstNumber(
      signal && signal.edgeBps,
      signal && signal.edge_bps,
      signal && signal.kalshi && signal.kalshi.edgeBps,
    );
    return bps === null ? "—" : Math.round(bps) + " bps";
  }

  function payloadAge(payload) {
    const provenance = (payload && payload.provenance) || {};
    let ageSeconds = firstNumber(provenance.ageSeconds);
    if (ageSeconds === null && payload && payload.generatedAt) {
      const epoch = Date.parse(String(payload.generatedAt));
      if (Number.isFinite(epoch)) {
        ageSeconds = Math.max(0, (Date.now() - epoch) / 1_000);
      }
    }
    return {
      ageSeconds: ageSeconds,
      stale: provenance.stale === true,
      asOf: firstText(provenance.asOf),
    };
  }

  function agePill(info) {
    if (info.ageSeconds === null) return "age: —";
    return (
      "age: " + (info.stale ? "stale · " : "") + fmtAgeShort(info.ageSeconds)
    );
  }

  function sourceAgeText(signal, payload) {
    const join = (signal && signal.kalshi) || {};
    const provenance = (signal && signal.provenance) || {};
    const fetchedAt = firstText(join.fetchedAtIso, join.fetchedAt);
    const kalshiAge = firstNumber(join.ageSeconds);
    const feedAge = firstNumber(provenance.ageSeconds);
    const stamp = function (value) {
      return String(value).replace("T", " ").slice(0, 19);
    };
    const parts = [];
    // The Kalshi fetch is the signal's own probe; the endpoint's generatedAt is
    // a join time, not a Kalshi call, so the two are labelled differently.
    parts.push(fetchedAt === null ? "kalshi —" : "kalshi " + stamp(fetchedAt));
    if (fetchedAt === null && payload && payload.generatedAt) {
      parts.push("joined " + stamp(payload.generatedAt));
    }
    if (kalshiAge !== null) parts.push("kalshi age " + fmtAgeShort(kalshiAge));
    else if (feedAge !== null) parts.push("age " + fmtAgeShort(feedAge));
    if (provenance.asOf) parts.push("feed " + asOfDay(provenance.asOf));
    if (provenance.stale === true) parts.push("stale");
    if (provenance.fixture === true) parts.push("fixture");
    return parts.join(" · ");
  }

  function configText(config) {
    if (!config || typeof config !== "object") return "thresholds: —";
    const parts = [];
    const minEdge = firstNumber(config.minEdgeBps);
    const minContracts = firstNumber(config.minContracts);
    const maxSpread = firstNumber(config.maxSpreadCents);
    const notional = firstNumber(config.referenceNotionalUsd);
    if (minEdge !== null)
      parts.push("min edge " + Math.round(minEdge) + " bps");
    if (minContracts !== null)
      parts.push("min " + Math.round(minContracts) + " contracts");
    if (maxSpread !== null)
      parts.push("max spread " + Math.round(maxSpread) + "¢");
    if (notional !== null) parts.push("ref " + fmtUsd(notional));
    return parts.length > 0
      ? "thresholds: " + parts.join(" · ")
      : "thresholds: —";
  }

  function degradeReason(kalshi) {
    if (!kalshi || typeof kalshi !== "object") return "no market data reported";
    const errors = Array.isArray(kalshi.errors) ? kalshi.errors : [];
    const rendered = errors
      .map(function (error) {
        if (typeof error === "string") return error;
        if (error && typeof error === "object") {
          return firstText(error.message, error.error, error.reason) || null;
        }
        return null;
      })
      .filter(Boolean);
    if (rendered.length > 0) return rendered.slice(0, 3).join(" · ");
    return "fetch degraded with no reported reason";
  }

  const KALSHI_VERDICT_RANK = {
    actionable: 0,
    stale: 1,
    thin_liquidity: 2,
    no_edge: 3,
    no_fair_price: 4,
    fixture_only: 5,
    no_market: 6,
    error: 7,
  };

  function kalshiSortKey(signal) {
    const join = (signal && signal.kalshi) || {};
    const matched = firstText(join.marketTicker, join.market) === null ? 1 : 0;
    const verdict = normalizeVerdict(signal);
    const rank =
      verdict !== null && KALSHI_VERDICT_RANK[verdict] !== undefined
        ? KALSHI_VERDICT_RANK[verdict]
        : 8;
    const risk = firstNumber(signal && signal.riskUsd) ?? 0;
    return { matched: matched, rank: rank, risk: -risk };
  }

  function renderKalshiSignals(payload) {
    if (!kalshiSignalsTbody) return;
    const signals = Array.isArray(payload && payload.signals)
      ? payload.signals
          .filter(function (signal) {
            return signal && typeof signal === "object";
          })
          .sort(function (left, right) {
            const a = kalshiSortKey(left);
            const b = kalshiSortKey(right);
            return a.matched - b.matched || a.rank - b.rank || a.risk - b.risk;
          })
      : [];
    const kalshi =
      payload && payload.kalshi && typeof payload.kalshi === "object"
        ? payload.kalshi
        : null;
    const degraded = kalshi !== null && kalshi.degraded === true;
    const config = (payload && payload.config) || {};
    const rows = [];
    if (degraded) {
      rows.push(
        messageRow(
          8,
          "degraded — Kalshi market data unavailable: " +
            degradeReason(kalshi) +
            ". Prices, liquidity and edge stay '—'; no number is invented.",
        ),
      );
    }
    if (signals.length === 0 && !degraded) {
      rows.push(
        messageRow(
          8,
          "0 signals — watchlist flow produced no matched joins in this snapshot. This is a measured zero, not a missing table.",
        ),
      );
    } else if (signals.length > 0) {
      signals.forEach(function (signal) {
        const verdict = normalizeVerdict(signal);
        rows.push(
          pillRow(
            [
              signalLabel(signal),
              flowText(signal),
              marketText(signal),
              priceText(signal),
              liquidityText(signal, config),
              edgeText(signal),
              verdict === null ? "—" : verdict,
              sourceAgeText(signal, payload),
            ],
            6,
            verdictTone(verdict),
            7,
          ),
        );
      });
    }
    replaceRows(kalshiSignalsTbody, rows);
    setTextById("kalshi-config", configText(config));
    const info = payloadAge(payload);
    setTextById("kalshi-signals-age", agePill(info));
    setPill(
      "kalshi-signals-state",
      "state: " + (degraded ? "degraded" : "live"),
      degraded ? "amber" : "emerald",
    );
  }

  function kalshiMessage(message, state, tone) {
    if (!kalshiSignalsTbody) return;
    replaceRows(kalshiSignalsTbody, [messageRow(8, message)]);
    setPill("kalshi-signals-state", "state: " + state, tone);
    setTextById("kalshi-signals-age", "age: —");
    setTextById("kalshi-config", "thresholds: —");
  }

  async function loadKalshiSignals(options) {
    const force = options && options.force === true;
    if (kalshiLoading) return;
    if (force) kalshiDaemonAvailable = null;
    if (kalshiDaemonAvailable === false) return;
    if (
      !force &&
      kalshiLoadedMs !== 0 &&
      Date.now() - kalshiLoadedMs < KALSHI_REFRESH_MS
    ) {
      return;
    }
    kalshiLoading = true;
    try {
      const token = adminToken();
      const headers = { Accept: "application/json" };
      if (token !== "") headers.Authorization = "Bearer " + token;
      const res = await fetch("/api/signals/kalshi", {
        headers: headers,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        kalshiDaemonAvailable = true;
        kalshiMessage(
          "Refused (" +
            res.status +
            ") — /api/signals/kalshi requires the operator token in <meta name=sportsdesk-admin-token>.",
          "degraded",
          "amber",
        );
        return;
      }
      if (res.status === 404) {
        kalshiDaemonAvailable = false;
        kalshiLoadedMs = Date.now();
        kalshiMessage(
          "No /api/signals/kalshi on this edge (404) — Kalshi signals are daemon-only; the page never calls Kalshi itself.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (!res.ok) {
        kalshiDaemonAvailable = true;
        kalshiMessage(
          "HTTP " +
            res.status +
            " from /api/signals/kalshi — signal fetch degraded.",
          "degraded",
          "amber",
        );
        return;
      }
      const payload = await res.json();
      kalshiDaemonAvailable = true;
      kalshiLoadedMs = Date.now();
      renderKalshiSignals(payload);
    } catch {
      kalshiDaemonAvailable = null;
      kalshiMessage(
        "Network error — the daemon is not reachable, so Kalshi signals are unavailable (daemon-only).",
        "degraded",
        "amber",
      );
    } finally {
      kalshiLoading = false;
    }
  }

  function weblogFlagsText(account) {
    const flags = Array.isArray(account && account.flags) ? account.flags : [];
    if (flags.length === 0) return "no flags";
    return flags
      .map(function (flag) {
        if (!flag || typeof flag !== "object") return null;
        const code = firstText(flag.code) || "FLAG";
        const count = firstNumber(flag.count);
        const severity = firstText(flag.severity);
        return (
          code +
          (count === null ? "" : " ×" + fmtInt(count)) +
          (severity === null ? "" : " (" + severity + ")")
        );
      })
      .filter(Boolean)
      .join(" · ");
  }

  function weblogLastLogText(account) {
    const iso = firstText(
      account && account.lastLogIso,
      account && account.placedAtIso,
    );
    if (iso === null) return "—";
    const ageMs = ageFromIso(iso);
    return (
      String(iso).replace("T", " ").slice(0, 19) +
      (Number.isFinite(ageMs) ? " · " + fmtAgeShort(ageMs / 1_000) : "")
    );
  }

  function weblogProvenanceText(payload) {
    const parts = [];
    if (payload && payload.source) parts.push(String(payload.source));
    const asOf = firstText(payload && payload.asOf);
    if (asOf !== null) parts.push("asOf " + asOf);
    const ageSeconds = firstNumber(payload && payload.ageSeconds);
    if (ageSeconds !== null) parts.push("age " + fmtAgeShort(ageSeconds));
    if (payload && payload.stale === true) parts.push("stale");
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function renderGsliveWeblogs(payload) {
    if (!weblogsTbody) return;
    const status = firstText(payload && payload.status) || "not_measured";
    const ageSeconds = firstNumber(payload && payload.ageSeconds);
    setTextById(
      "gslive-weblogs-age",
      ageSeconds === null
        ? "age: —"
        : "age: " +
            (payload && payload.stale === true ? "stale · " : "") +
            fmtAgeShort(ageSeconds),
    );
    if (status !== "measured") {
      const reason =
        firstText(payload && payload.reason) ||
        "the GSLive weblog artifact has not been refreshed in this checkout";
      const command =
        firstText(payload && payload.command) ||
        "bun run gslive:weblogs:refresh";
      setPill("gslive-weblogs-state", "state: not_measured", "amber");
      replaceRows(weblogsTbody, [
        messageRow(6, "not measured — " + reason + " · run " + command),
      ]);
      return;
    }
    const accounts = Array.isArray(payload && payload.accounts)
      ? payload.accounts.filter(function (account) {
          return account && typeof account === "object";
        })
      : [];
    const summary = (payload && payload.summary) || {};
    const accountsCount = firstNumber(summary.accounts);
    const betsCount = firstNumber(summary.bets);
    setPill(
      "gslive-weblogs-state",
      "state: measured" +
        (accountsCount === null
          ? ""
          : " · " + fmtInt(accountsCount) + " accounts") +
        (betsCount === null ? "" : " · " + fmtInt(betsCount) + " bets"),
      "emerald",
    );
    if (accounts.length === 0) {
      replaceRows(weblogsTbody, [
        messageRow(
          6,
          "measured · 0 accounts in the artifact — the refresh ran and audited nothing; this is a measured zero.",
        ),
      ]);
      return;
    }
    const provenance = weblogProvenanceText(payload);
    replaceRows(
      weblogsTbody,
      accounts.map(function (account) {
        return makeRow(
          [
            firstText(
              account.customerLogin,
              account.gsLivePlayerId,
              account.login,
            ) || "—",
            firstText(account.agentId, account.agent) || "—",
            fmtMetricInt(account.betCount),
            weblogFlagsText(account),
            weblogLastLogText(account),
            provenance,
          ],
          5,
        );
      }),
    );
  }

  function weblogsMessage(message, state, tone) {
    if (!weblogsTbody) return;
    replaceRows(weblogsTbody, [messageRow(6, message)]);
    setPill("gslive-weblogs-state", "state: " + state, tone);
    setTextById("gslive-weblogs-age", "age: —");
  }

  async function loadGsliveWeblogs(options) {
    const force = options && options.force === true;
    if (weblogsLoading) return;
    if (force) weblogsDaemonAvailable = null;
    if (weblogsDaemonAvailable === false) return;
    if (
      !force &&
      weblogsLoadedMs !== 0 &&
      Date.now() - weblogsLoadedMs < KALSHI_REFRESH_MS
    ) {
      return;
    }
    weblogsLoading = true;
    try {
      const token = adminToken();
      const headers = { Accept: "application/json" };
      if (token !== "") headers.Authorization = "Bearer " + token;
      const res = await fetch("/api/gslive/weblogs", {
        headers: headers,
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        weblogsDaemonAvailable = true;
        weblogsMessage(
          "Refused (" +
            res.status +
            ") — /api/gslive/weblogs requires the operator token in <meta name=sportsdesk-admin-token>.",
          "degraded",
          "amber",
        );
        return;
      }
      if (res.status === 404) {
        weblogsDaemonAvailable = false;
        weblogsLoadedMs = Date.now();
        weblogsMessage(
          "No /api/gslive/weblogs on this edge (404) — weblog activity is daemon-only.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (!res.ok) {
        weblogsDaemonAvailable = true;
        weblogsMessage(
          "HTTP " +
            res.status +
            " from /api/gslive/weblogs — weblog activity unavailable.",
          "degraded",
          "amber",
        );
        return;
      }
      const payload = await res.json();
      weblogsDaemonAvailable = true;
      weblogsLoadedMs = Date.now();
      renderGsliveWeblogs(payload);
    } catch {
      weblogsDaemonAvailable = null;
      weblogsMessage(
        "Network error — the daemon is not reachable, so weblog activity is unavailable (daemon-only).",
        "degraded",
        "amber",
      );
    } finally {
      weblogsLoading = false;
    }
  }

  function kalshiAutoRefresh() {
    if (!kalshiPanelVisible()) return;
    if (kalshiLoading || weblogsLoading) return;
    loadKalshiSignals();
    loadGsliveWeblogs();
  }

  // 11. Tab 8 — execution plan (paper by default; live gated by the daemon).
  // The page posts only to /api/execution/*; a planning call never places an
  // order, and the live path requires the daemon to report Kalshi live-ready
  // plus two operator confirmations.
  const EXEC_REFRESH_MS = 60_000;
  const EXEC_LIVE_CONFIRM = "PLACE LIVE ORDERS";
  const execDecisionsTbody = document.getElementById("exec-decisions-tbody");
  const execFillsTbody = document.getElementById("exec-fills-tbody");
  let execLoading = false;
  let execModeBusy = false;
  let execRunBusy = false;
  let execDaemonAvailable = null;
  let execLiveReady = false;

  function execPanelVisible() {
    const panel = document.getElementById("execution-panel");
    return panel !== null && !panel.hasAttribute("hidden");
  }

  function execBarText(text, tone) {
    setPill("exec-state-detail", text, tone);
  }

  function simpleCell(text, wrap) {
    const cell = document.createElement("td");
    if (wrap) cell.className = "wrap";
    cell.textContent = cellText(text);
    return cell;
  }

  function venueStyleCell(decision) {
    const cell = document.createElement("td");
    const blocked = decision && decision.blocked === true;
    const style = firstText(decision && decision.style);
    const venue = firstText(decision && decision.venue);
    const pill = document.createElement("span");
    pill.className =
      "pill pill-" +
      (blocked ? "rose" : style === "maker" ? "cyan" : "emerald");
    // A blocked decision has no venue/style: print the verdict once instead of "-- · --".
    pill.textContent = blocked
      ? "blocked"
      : venue === null || style === null
        ? "—"
        : venue + " · " + style;
    cell.appendChild(pill);
    const action = blocked
      ? ""
      : [
          firstText(decision && decision.orderAction),
          firstText(decision && decision.position),
        ]
          .filter(Boolean)
          .join(" / ");
    if (action !== "") {
      const detail = document.createElement("span");
      detail.style.display = "block";
      detail.style.fontSize = "0.7rem";
      detail.style.color = "#94a3b8";
      detail.textContent = action;
      cell.appendChild(detail);
    }
    return cell;
  }

  function decisionSizeText(decision) {
    const sizeUsd = firstNumber(decision && decision.sizeUsd);
    const contracts = firstNumber(decision && decision.contracts);
    let limit = firstNumber(decision && decision.limitPrice);
    if (limit !== null && limit <= 1) limit = Math.round(limit * 100);
    const head = [];
    if (sizeUsd !== null) head.push(fmtUsd(sizeUsd));
    if (contracts !== null) head.push(fmtInt(contracts) + " contracts");
    const parts = head.length > 0 ? [head.join(" / ")] : [];
    if (limit !== null) parts.push("@ " + Math.round(limit) + "¢");
    return parts.length > 0 ? parts.join(" ") : "—";
  }

  function decisionEdgeText(decision) {
    const edge = firstNumber(decision && decision.edgeAfterSlippageBps);
    const slip = firstNumber(decision && decision.slippageBps);
    const parts = [];
    if (edge !== null) parts.push("edge " + Math.round(edge) + " bps");
    if (slip !== null) parts.push("slip " + Math.round(slip) + " bps");
    return parts.length > 0 ? parts.join(" / ") : "—";
  }

  function verdictCell(decision) {
    const cell = document.createElement("td");
    cell.className = "wrap";
    const blocked = decision && decision.blocked === true;
    const style = firstText(decision && decision.style) || "—";
    const pill = document.createElement("span");
    pill.className =
      "pill pill-" +
      (blocked ? "rose" : style === "maker" ? "cyan" : "emerald");
    const reason = firstText(decision && decision.blockReason);
    pill.textContent = blocked
      ? "blocked" + (reason === null ? "" : " · " + reason)
      : style + (decision && decision.paper === true ? " · paper" : "");
    cell.appendChild(pill);
    const reasons = Array.isArray(decision && decision.reasons)
      ? decision.reasons.filter(function (item) {
          // The pill already carries blockReason; do not repeat it in the detail line.
          return (
            Boolean(item) &&
            item !== reason &&
            !(reason !== null && String(item).startsWith(reason + ":"))
          );
        })
      : [];
    if (reasons.length > 0) {
      const detail = document.createElement("span");
      detail.style.display = "block";
      detail.style.fontSize = "0.7rem";
      detail.style.color = "#94a3b8";
      detail.textContent = reasons.slice(0, 3).join(" · ");
      cell.appendChild(detail);
    }
    return cell;
  }

  function decisionProvenanceText(decision) {
    const provenance = (decision && decision.provenance) || {};
    const parts = [];
    if (provenance.fixture === true) parts.push("FIXTURE");
    if (provenance.stale === true) parts.push("STALE");
    if (provenance.dataMode) {
      const dataMode = String(provenance.dataMode);
      // "FIXTURE" already appeared as the fixture marker; do not print it twice.
      if (!(
        provenance.fixture === true && dataMode.toUpperCase() === "FIXTURE"
      )) {
        parts.push(dataMode);
      }
    }
    if (provenance.signalAsOf) {
      parts.push("signal " + asOfDay(provenance.signalAsOf));
    }
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function policyText(policy) {
    if (!policy || typeof policy !== "object") return "policy: —";
    const parts = [];
    const order = firstNumber(policy.maxOrderUsd);
    const market = firstNumber(policy.maxMarketUsd);
    const daily = firstNumber(policy.maxDailyPlannedUsd);
    const edge = firstNumber(policy.minEdgeBps);
    const slip = firstNumber(policy.maxSlippageBps);
    const hedge = firstNumber(policy.hedgeRatio);
    if (order !== null) parts.push(fmtUsd(order) + "/order");
    if (market !== null) parts.push(fmtUsd(market) + "/market");
    if (daily !== null) parts.push(fmtUsd(daily) + "/day");
    if (edge !== null) parts.push("edge ≥" + Math.round(edge) + " bps");
    if (slip !== null) parts.push("slip ≤" + Math.round(slip) + " bps");
    if (hedge !== null) parts.push("hedge " + hedge);
    return parts.length > 0 ? "policy: " + parts.join(" · ") : "policy: —";
  }

  function riskMainText(risk) {
    if (!risk || typeof risk !== "object") return "—";
    const planned = firstNumber(risk.dailyPlannedUsd);
    const cap = firstNumber(risk.dailyCapUsd);
    const intents = firstNumber(risk.openIntents);
    const parts = [];
    if (planned !== null) {
      parts.push(
        "planned " +
          fmtUsd(planned) +
          (cap === null ? "" : " / " + fmtUsd(cap)) +
          " today",
      );
    }
    if (intents !== null) parts.push(fmtInt(intents) + " open intents");
    return parts.length > 0 ? parts.join(" · ") : "—";
  }

  function riskSubText(risk, policy) {
    if (!risk || typeof risk !== "object") {
      return "daily planned · open intents · market exposure · caps";
    }
    const exposure = firstNumber(risk.marketExposureUsd);
    const marketCap = firstNumber(policy && policy.maxMarketUsd);
    const parts = [];
    if (exposure !== null) {
      parts.push(
        "market " +
          fmtUsd(exposure) +
          (marketCap === null ? "" : " / " + fmtUsd(marketCap) + " cap"),
      );
    }
    const intentsCap = firstNumber(policy && policy.maxOpenIntents);
    if (intentsCap !== null)
      parts.push("max " + fmtInt(intentsCap) + " intents");
    return parts.length > 0
      ? parts.join(" · ")
      : "daily planned · open intents · market exposure · caps";
  }

  function liveReason(venue) {
    if (!venue || typeof venue !== "object") return "no reason reported";
    return firstText(venue.reason, venue.error) || "no reason reported";
  }

  function renderExecutionPlan(payload) {
    if (!execDecisionsTbody) return;
    const mode = firstText(payload && payload.mode) || "paper";
    const paused =
      mode === "paused" || (payload && payload.killSwitch === true);
    const venues = (payload && payload.venues) || {};
    const kalshiVenue = venues.kalshi || {};
    const polyVenue = venues.polymarket || {};
    const policy = (payload && payload.policy) || {};
    const risk = (payload && payload.risk) || {};
    const decisions = Array.isArray(payload && payload.decisions)
      ? payload.decisions.filter(function (decision) {
          return decision && typeof decision === "object";
        })
      : [];

    setPill(
      "exec-state",
      "state: " + (paused ? "paused" : "paper"),
      paused ? "amber" : "emerald",
    );
    execBarText(
      "mode: " +
        (paused ? "paused (kill switch)" : "paper") +
        (payload && payload.generatedAt
          ? " · " + String(payload.generatedAt).slice(11, 19) + " UTC"
          : ""),
      paused ? "amber" : "cyan",
    );

    execLiveReady = kalshiVenue.liveReady === true;
    setPill(
      "exec-kalshi-live",
      "kalshi: " +
        (execLiveReady ? "live-ready" : "unavailable") +
        " — " +
        liveReason(kalshiVenue),
      execLiveReady ? "emerald" : "amber",
    );
    const polyLive = polyVenue.liveReady === true;
    setPill(
      "exec-polymarket-live",
      "polymarket: " +
        (polyLive ? "live-ready" : "paper-only") +
        " — " +
        liveReason(polyVenue),
      polyLive ? "emerald" : "amber",
    );
    const liveControls = document.getElementById("exec-live-controls");
    if (liveControls) {
      if (execLiveReady) liveControls.removeAttribute("hidden");
      else liveControls.setAttribute("hidden", "");
    }
    updateExecLiveButton();

    setTextById("exec-policy", policyText(policy));
    setTextById("exec-risk", riskMainText(risk));
    setTextById("exec-risk-sub", riskSubText(risk, policy));

    const rows = [];
    if (paused) {
      rows.push(
        messageRow(
          6,
          "paused — kill switch on; every decision is blocked until Resume paper is confirmed by the daemon.",
        ),
      );
    }
    if (decisions.length === 0) {
      const blockedReasons = Array.isArray(payload && payload.blockedReasons)
        ? payload.blockedReasons.filter(Boolean)
        : [];
      rows.push(
        messageRow(
          6,
          "0 decisions — the planning pass produced no executable intents" +
            (blockedReasons.length > 0
              ? ": " + blockedReasons.slice(0, 3).join(" · ")
              : " (no eligible books or no signals in this snapshot)."),
        ),
      );
    } else {
      decisions.forEach(function (decision) {
        const row = document.createElement("tr");
        row.appendChild(simpleCell(signalLabel(decision), true));
        row.appendChild(venueStyleCell(decision));
        row.appendChild(simpleCell(decisionSizeText(decision)));
        row.appendChild(simpleCell(decisionEdgeText(decision)));
        row.appendChild(verdictCell(decision));
        row.appendChild(simpleCell(decisionProvenanceText(decision), true));
        rows.push(row);
      });
    }
    replaceRows(execDecisionsTbody, rows);
  }

  function fillPriceText(fill) {
    const cents = priceCents(
      firstNumber(
        fill && fill.avgPrice,
        fill && fill.fillPrice,
        fill && fill.price,
      ),
    );
    return cents === null ? "—" : cents + "¢";
  }

  function fillSizeText(fill) {
    const sizeUsd = firstNumber(fill && fill.sizeUsd);
    const contracts = firstNumber(fill && fill.contracts);
    const parts = [];
    if (sizeUsd !== null) parts.push(fmtUsd(sizeUsd));
    if (contracts !== null) parts.push(fmtInt(contracts) + " contracts");
    return parts.length > 0 ? parts.join(" / ") : "—";
  }

  function fillAgeText(fill) {
    const iso = firstText(
      fill && fill.createdAtIso,
      fill && fill.createdAt,
      fill && fill.postedAtIso,
    );
    if (iso === null) return "—";
    const ageMs = ageFromIso(iso);
    return Number.isFinite(ageMs) ? fmtAgeShort(ageMs / 1_000) : "—";
  }

  function quoteStatusText(quote) {
    const iso = firstText(
      quote && quote.expiresAtIso,
      quote && quote.expiresAt,
    );
    if (iso === null) return "resting";
    const epoch = Date.parse(String(iso));
    if (!Number.isFinite(epoch)) return "resting";
    const deltaSeconds = (epoch - Date.now()) / 1_000;
    if (deltaSeconds >= 0) {
      return "resting · expires in " + fmtAgeShort(deltaSeconds);
    }
    return "resting · expired " + fmtAgeShort(-deltaSeconds) + " ago";
  }

  function renderExecutionFills(payload) {
    if (!execFillsTbody) return;
    const paper = (payload && payload.paper) || {};
    const fills = Array.isArray(paper.fills) ? paper.fills.filter(Boolean) : [];
    const quotes = Array.isArray(paper.quotes)
      ? paper.quotes.filter(Boolean)
      : [];
    const rows = [];
    fills.forEach(function (fill) {
      rows.push(
        makeRow(
          [
            firstText(fill.intentId, fill.id) || "—",
            [firstText(fill.venue), firstText(fill.tickerToken, fill.ticker)]
              .filter(Boolean)
              .join(" · ") || "—",
            [firstText(fill.orderAction), firstText(fill.position)]
              .filter(Boolean)
              .join(" ") || "—",
            fillPriceText(fill),
            fillSizeText(fill),
            firstText(fill.status) || "filled",
            fillAgeText(fill),
          ],
          null,
        ),
      );
    });
    quotes.forEach(function (quote) {
      rows.push(
        makeRow(
          [
            firstText(quote.quoteId, quote.id, quote.intentId) || "—",
            [firstText(quote.venue), firstText(quote.tickerToken, quote.ticker)]
              .filter(Boolean)
              .join(" · ") || "—",
            [
              firstText(quote.orderAction, quote.side),
              firstText(quote.position),
            ]
              .filter(Boolean)
              .join(" ") || "—",
            fillPriceText(quote),
            fillSizeText(quote),
            quoteStatusText(quote),
            fillAgeText(quote),
          ],
          null,
        ),
      );
    });
    if (rows.length === 0) {
      rows.push(
        messageRow(
          7,
          "No paper fills or resting quotes in this snapshot — a maker quote only fills when the book crosses its price, and it expires rather than being invented as filled.",
        ),
      );
    }
    replaceRows(execFillsTbody, rows);
  }

  function execMessage(message, state, tone) {
    replaceRows(execDecisionsTbody, [messageRow(6, message)]);
    replaceRows(execFillsTbody, [messageRow(7, "—")]);
    setPill("exec-state", "state: " + state, tone);
    execBarText("mode: " + state, tone);
    setTextById("exec-risk", "—");
    setTextById(
      "exec-risk-sub",
      "daily planned · open intents · market exposure · caps",
    );
    setTextById("exec-policy", "policy: —");
    setPill("exec-kalshi-live", "kalshi: —", "amber");
    setPill("exec-polymarket-live", "polymarket: —", "amber");
    execLiveReady = false;
    const liveControls = document.getElementById("exec-live-controls");
    if (liveControls) liveControls.setAttribute("hidden", "");
  }

  function execHeaders() {
    const token = adminToken();
    const headers = { Accept: "application/json" };
    if (token !== "") headers.Authorization = "Bearer " + token;
    return headers;
  }

  async function readJsonSafe(res) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  function refusalText(payload) {
    if (!payload) return "refused by the daemon";
    if (typeof payload.error === "string" && payload.error !== "") {
      return payload.error;
    }
    if (Array.isArray(payload.reasons)) {
      const reasons = payload.reasons.filter(Boolean);
      if (reasons.length > 0) return reasons.slice(0, 3).join(" · ");
    }
    return "refused by the daemon";
  }

  async function loadExecutionPlan(options) {
    const force = options && options.force === true;
    if (execLoading) return;
    if (force) execDaemonAvailable = null;
    if (execDaemonAvailable === false) return;
    execLoading = true;
    try {
      const res = await fetch("/api/execution/plan", {
        headers: execHeaders(),
        cache: "no-store",
      });
      if (res.status === 401 || res.status === 403) {
        execDaemonAvailable = true;
        execMessage(
          "Refused (" +
            res.status +
            ") — /api/execution/plan requires the operator token in <meta name=sportsdesk-admin-token>.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (res.status === 404) {
        execDaemonAvailable = false;
        execMessage(
          "No /api/execution/plan on this edge (404) — execution planning is daemon-only; the page never calls a venue.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (!res.ok) {
        execDaemonAvailable = true;
        execMessage(
          "HTTP " +
            res.status +
            " from /api/execution/plan — the plan is unavailable.",
          "daemon-only",
          "amber",
        );
        return;
      }
      const payload = await res.json();
      execDaemonAvailable = true;
      renderExecutionPlan(payload);
      renderExecutionFills(payload);
    } catch {
      execDaemonAvailable = null;
      execMessage(
        "Network error — the daemon is not reachable, so execution planning is unavailable (daemon-only).",
        "daemon-only",
        "amber",
      );
    } finally {
      execLoading = false;
    }
  }

  async function setExecutionMode(mode) {
    if (execModeBusy) return;
    execModeBusy = true;
    try {
      const res = await fetch("/api/execution/mode", {
        method: "POST",
        headers: Object.assign(execHeaders(), {
          "Content-Type": "application/json",
        }),
        cache: "no-store",
        body: JSON.stringify({ mode: mode }),
      });
      if (res.status === 401 || res.status === 403) {
        execBarText(
          "mode change refused (" + res.status + ") — operator token required",
          "rose",
        );
        return;
      }
      if (res.status === 404) {
        execDaemonAvailable = false;
        execMessage(
          "No /api/execution/mode on this edge (404) — execution control is daemon-only.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (!res.ok) {
        const payload = await readJsonSafe(res);
        execBarText("mode change refused — " + refusalText(payload), "rose");
        return;
      }
      await loadExecutionPlan({ force: true });
    } catch {
      execMessage(
        "Network error — the daemon is not reachable, so the mode change was not sent.",
        "daemon-only",
        "amber",
      );
    } finally {
      execModeBusy = false;
    }
  }

  async function runExecutionPlan(live) {
    if (execRunBusy) return;
    execRunBusy = true;
    try {
      const body = live ? { live: true, confirm: EXEC_LIVE_CONFIRM } : {};
      const res = await fetch("/api/execution/run", {
        method: "POST",
        headers: Object.assign(execHeaders(), {
          "Content-Type": "application/json",
        }),
        cache: "no-store",
        body: JSON.stringify(body),
      });
      if (res.status === 401 || res.status === 403) {
        execMessage(
          "Refused (" +
            res.status +
            ") — /api/execution/run requires the operator token in <meta name=sportsdesk-admin-token>.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (res.status === 404) {
        execDaemonAvailable = false;
        execMessage(
          "No /api/execution/run on this edge (404) — execution is daemon-only.",
          "daemon-only",
          "amber",
        );
        return;
      }
      if (!res.ok) {
        const payload = await readJsonSafe(res);
        execBarText(
          "run refused (" + res.status + ") — " + refusalText(payload),
          "rose",
        );
        await loadExecutionPlan({ force: true });
        return;
      }
      await loadExecutionPlan({ force: true });
    } catch {
      execMessage(
        "Network error — the daemon is not reachable, so the plan was not run.",
        "daemon-only",
        "amber",
      );
    } finally {
      execRunBusy = false;
    }
  }

  function updateExecLiveButton() {
    const button = document.getElementById("exec-live");
    const first = document.getElementById("exec-live-confirm-1");
    const second = document.getElementById("exec-live-confirm-2");
    if (!button || !first || !second) return;
    const ready =
      execLiveReady &&
      first.value === EXEC_LIVE_CONFIRM &&
      second.value === EXEC_LIVE_CONFIRM;
    if (ready) button.removeAttribute("disabled");
    else button.setAttribute("disabled", "");
  }

  function execAutoRefresh() {
    if (!execPanelVisible()) return;
    if (execLoading || execModeBusy || execRunBusy) return;
    loadExecutionPlan();
  }

  // While the stream is live it already pushes summary frames and refetches the
  // feed when it moves, so the 15s poll is only the fallback (and the whole
  // transport on the static Pages edge).
  function pollTick() {
    if (streamLive) return;
    pollLiveFeed();
  }

  if (gameStateRefreshBtn) {
    gameStateRefreshBtn.addEventListener("click", function () {
      // A manual refresh is allowed to retry after a 404/401 (the daemon may
      // have come up or the operator token may have been added).
      gameStateDaemonAvailable = null;
      loadGameState();
    });
  }

  if (document.getElementById("kalshi-signals-refresh")) {
    document
      .getElementById("kalshi-signals-refresh")
      .addEventListener("click", function () {
        loadKalshiSignals({ force: true });
        loadGsliveWeblogs({ force: true });
      });
  }

  if (document.getElementById("gslive-weblogs-refresh")) {
    document
      .getElementById("gslive-weblogs-refresh")
      .addEventListener("click", function () {
        loadGsliveWeblogs({ force: true });
      });
  }

  if (document.getElementById("exec-run")) {
    document.getElementById("exec-run").addEventListener("click", function () {
      // Run plan = one planning pass (POST run, no live flag) then re-read it.
      runExecutionPlan(false);
    });
  }
  if (document.getElementById("exec-pause")) {
    document
      .getElementById("exec-pause")
      .addEventListener("click", function () {
        setExecutionMode("paused");
      });
  }
  if (document.getElementById("exec-resume")) {
    document
      .getElementById("exec-resume")
      .addEventListener("click", function () {
        setExecutionMode("paper");
      });
  }
  if (document.getElementById("exec-live")) {
    document.getElementById("exec-live").addEventListener("click", function () {
      // Two operator confirmations plus the daemon's own live-ready gate.
      if (!execLiveReady) return;
      const first = document.getElementById("exec-live-confirm-1");
      const second = document.getElementById("exec-live-confirm-2");
      const confirmed =
        first &&
        second &&
        first.value === EXEC_LIVE_CONFIRM &&
        second.value === EXEC_LIVE_CONFIRM;
      if (!confirmed) return;
      runExecutionPlan(true);
    });
  }
  ["exec-live-confirm-1", "exec-live-confirm-2"].forEach(function (id) {
    const input = document.getElementById(id);
    if (input) input.addEventListener("input", updateExecLiveButton);
  });

  // Column definitions are static, so they are applied once at load.
  applyColumnHelp();

  setInterval(updateRelativeAge, 1_000);
  setInterval(pollTick, STREAM_POLL_FALLBACK_MS);
  // Tab 7 refreshes at most once a minute, and only while it is the visible tab.
  setInterval(kalshiAutoRefresh, KALSHI_REFRESH_MS);
  // Tab 8 refreshes at most once a minute, and only while it is visible.
  setInterval(execAutoRefresh, EXEC_REFRESH_MS);
  pollLiveFeed();
  connectDashboardStream();
  loadGameState();
  hydrateValueArtifacts();
})();
