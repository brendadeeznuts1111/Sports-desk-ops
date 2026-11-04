/**
 * @file graph.js
 * @description Interactive controller for the SportsDesk & Fantasy402 ac5824d
 * ingestion data plane (5 bridges → Bun.cron scheduler → WS hub / R2 edge),
 * Phase 6C Surveillance Graph, Pending Bets Tab, 39-Wallet Polymarket & Customer
 * Profile Registry, 4-Week Full-Customer CFB & NBA Parlay/Combo Backtest Tab,
 * and Live Auto-Poller (`./graph-live-feed.json` / `/api/graph-feed`).
 * Externalized to comply with strict Cloudflare Pages CSP (`script-src 'self'`);
 * this file is the only controller and the page carries no inline script.
 */

import { buildWalletStats, planGsLiveLinks } from "./gslive-links.js";

(function () {
  // 1. Tab Switching (Topology vs. Pending Bets vs. 39-Wallet Profile Registry vs. 4-Week Parlay Backtest)
  const tabBtns = document.querySelectorAll("[data-tab-target]");
  const tabPanels = document.querySelectorAll("[data-tab-panel]");

  tabBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      const target = btn.getAttribute("data-tab-target");
      tabBtns.forEach(function (b) {
        const active = b.getAttribute("data-tab-target") === target;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      tabPanels.forEach(function (panel) {
        if (panel.getAttribute("data-tab-panel") === target) {
          panel.removeAttribute("hidden");
        } else {
          panel.setAttribute("hidden", "");
        }
      });
    });
  });

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

  // 7e. ac5824d data plane: bridge status filter + gate-evidence toggle.
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

  // 8. Live Poller Sync (`./graph-live-feed.json` / `/api/graph-feed`) + Relative Age Counter
  const lastUpdatedEl = document.getElementById("live-last-updated-ts");
  const lastUpdatedAgeEl = document.getElementById("live-last-updated-age");
  const pollSeqEl = document.getElementById("live-poll-seq");
  const dataModeEl = document.getElementById("live-data-mode");
  const liveTicksBody = document.getElementById("live-ticks-tbody");
  const kpiActiveWallets = document.getElementById("kpi-active-wallets");
  const kpiWalletProvenance = document.getElementById("kpi-wallet-provenance");
  const tabPendingLegs = document.getElementById("tab-pending-legs");
  const topologyExposure = document.getElementById("topology-exposure");
  const topologyLegs = document.getElementById("topology-legs");
  const pollNowBtn = document.getElementById("poll-now-btn");
  const cellSyncStamps = document.querySelectorAll(".live-sync-ts");

  let lastPollEpochMs = Date.now();
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
        data.activeSyndicateWalletsCount ?? 39,
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
          (data.configuredWalletsCount ?? 39) +
          " configured";
      }
    }
    if (tabPendingLegs)
      tabPendingLegs.textContent = String(data.totalOpenLegsCount ?? 222);
    if (topologyLegs)
      topologyLegs.textContent = String(data.totalOpenLegsCount ?? 222);
    if (topologyExposure) {
      topologyExposure.textContent = Number(
        data.totalOpenExposureUsd ?? 0,
      ).toLocaleString("en-US");
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
    if (!lastUpdatedAgeEl) return;
    const sec = Math.max(0, Math.floor((Date.now() - lastPollEpochMs) / 1000));
    lastUpdatedAgeEl.textContent = sec + "s ago";
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
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.lastUpdatedCdt) {
        lastPollEpochMs = data.pollEpochMs || Date.now();
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
        updateRelativeAge();
      }
    } catch {
      const now = new Date();
      lastPollEpochMs = now.getTime();
      if (lastUpdatedEl) {
        lastUpdatedEl.textContent =
          now.toISOString().replace("T", " ").slice(0, 19) + " UTC";
      }
      updateRelativeAge();
    }
  }

  if (pollNowBtn) {
    pollNowBtn.addEventListener("click", function () {
      pollLiveFeed();
    });
  }

  setInterval(updateRelativeAge, 1000);
  setInterval(pollLiveFeed, 15000);
  pollLiveFeed();
  hydrateValueArtifacts();
})();
