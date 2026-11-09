/**
 * Client half of the SportsDesk desk-panel bundle.
 *
 * WHAT THIS IS
 *
 * A left-sidebar entry (`sidebar.panellist`, the global panel-icon list that
 * already holds Plugins and Schedules) plus the main-column page that entry
 * selects (`main`, keyed by the same id — the sidebar owns the button, its
 * hover tooltip, and the selected state; the plugin owns the glyph and the
 * page). The glyph also carries a small status dot, so the desk's health is
 * visible from the sidebar without opening the page. The dot tracks the
 * service phase only; the overview cards never move it.
 *
 * ONE MEASURED SNAPSHOT, FIVE SOURCES
 *
 * A single module-level store probes five read-only desk routes on every tick
 * and keeps each source's own measured state:
 *
 *   health    /health              status, uptimeSeconds, runtime, ingress, nodeEnv
 *   status    /api/status          checks, memory/pid, Telegram mode, report schedules
 *   graph     /api/graph/summary   market feed, repo head/branch/routes, evidence ages
 *   kpis      /api/kpis            agents, pending, ticker, customer book (+ provenance)
 *   execution /api/execution/plan  paper mode, kill switch, live policy, risk, venues,
 *                                  decisions and blocked reasons
 *
 * Every source is probed independently and the snapshot keeps, per source:
 * `{ status: "ok"|"error"|"missing", httpStatus, body, latencyMs, url, transport,
 * error, receivedAt, checkedAt }`. A failed source keeps the last good payload it
 * received (labelled with `receivedAt`) and never blanks another source's card.
 * A source that previously loaded therefore stays visible, marked stale, instead
 * of collapsing to a zero. A source that never answered renders its explicit
 * state and reason — never a fake 0 or "—" as if measured.
 *
 * CLASSIFICATION (unchanged from v1)
 *
 *   fetch rejected / non-2xx /health        -> "service down"
 *   /health ok AND (/api/status 404 OR the
 *   /health body has no `ingress` field)    -> "stale build"
 *   /health ok AND /api/status answers 2xx  -> "current"
 *   /health ok AND the /api/status probe
 *   rejected or answered non-2xx (not 404)  -> "status probe failed" (unknown)
 *
 * The /api/status probe and the `ingress` field check exist because the running
 * service can answer /health while predating the checkout: measured on
 * 2026-11-02, /health answered with uptimeSeconds 457596 and no `ingress`, and
 * /api/status returned 404 — a naive health check says "healthy"; this page
 * says "stale build". When it is stale or down, the page names what is missing
 * and the exact command that restarts the service from the checkout.
 *
 * THE LIVE VIEW (Server-Sent Events)
 *
 * Above the overview cards, a **Live stream** card reads the desk's own
 * `/api/graph/stream` route through a streaming same-origin proxy: the desk
 * pushes an `event: summary` frame whenever its stat fingerprint changes (at
 * most every 5 s) and a `: heartbeat` comment every 5 s. The card renders only
 * what arrived — connection state (connecting/streaming/reconnecting/paused/
 * unavailable/error), HTTP status, frames, heartbeats, bytes, the latest
 * frame's counters, and the counter deltas between frames. A first frame
 * establishes values without inventing deltas; a counter absent from a frame is
 * never diffed; a parse failure is counted, not rendered. The stream is opened
 * by the desk page (not the sidebar glyph) and closes when the page unmounts,
 * when the tab hides, or on bundle disposal.
 *
 * THE OVERVIEW (read-only, measured)
 *
 * Three overview cards render the desk: **Market feed** (feed status/data mode/
 * WSS/poll sequence/last updated/age/stale + counts + repo head/branch/routes
 * and evidence ages), **Book** (agents, pending, ticker, customer book, each with
 * its provenance age/stale) and **Paper execution** (mode, kill switch, live
 * policy, risk vs caps with a meter, venues' liveReady + reason, decisions
 * blocked/not blocked, blocked reasons, plan provenance). An attention banner
 * above the cards names only conditions the payloads actually measured: service
 * phase, market-feed staleness/WSS/status, kill switch, non-paper mode, live
 * execution enabled, and a failed/missing overview source. Each card carries a
 * `live`/`stale`/`error`/`missing` chip plus its measurement time and age.
 *
 * EVIDENCE (measured 2026-11-04 18:13 UTC on the desk host, the captured
 * payloads in Scratch/plugin-v2/desk-panel/):
 *   /health            200, uptimeSeconds 1038, runtime "Bun v1.4.4 (arm64-darwin)",
 *                      ingress {"proxied":false,"trustProxy":false}, nodeEnv "development"
 *   /api/status        200, {"ok":true,"status":"serving","checks":{"telegram":"ok"},
 *                      "telegram":{"status":{"mode":"simulation",...},"schedules":[6 rows]}}
 *   /api/graph/summary 200 (~12.7 KB), feed.status "measured", dataMode "PARTIAL",
 *                      wssIngestion "not_ingested", ageSeconds 23339, stale true,
 *                      repo.head "d3a10ed", repo.branch "main", repo.routes.served 63
 *   /api/kpis          200 (~4.2 KB), agents 2276/1679/596, pending 2/2,
 *                      ticker 16 wagers, customer book 220 customers / 1100 tickets
 *   /api/execution/plan 200 (~10 KB), mode "paper", killSwitch false,
 *                      policy.liveEnabled false, both venues liveReady false,
 *                      13 decisions all blocked (no_book, maker_edge_below_min)
 *
 * TRANSPORT / CORS
 *
 * The Harness Web UI is tunnel-served (`--public-url`, Cloudflare Access), so
 * the browser's `127.0.0.1` is the VIEWER's machine, not the desk host. Every
 * source therefore probes the same-origin proxy first —
 * `/api/sportsdesk-desk/{health,status,graph,kpis,execution,stream}`, which the
 * Host half (`index.js`) forwards to the loopback service — and falls back to
 * the direct loopback URL (a Harness without the Host half, or a browser on the
 * desk host). A 404 carrying the Host half's `x-sportsdesk-desk-proxy` marker is
 * authoritative ("the desk service itself answered", so the source is missing
 * from this build); an unmarked 404 is the generic Harness 404 and may fall
 * back. Each card shows which transport answered and the raw URL, so a transport
 * problem is visible instead of looking like a dead service. The JSON routes
 * are buffered by the proxy; the stream route is forwarded chunk by chunk, so
 * frames arrive as the desk emits them.
 *
 * RULES FOLLOWED
 *
 * - The factory is side-effect free: it only builds components, the store and
 *   constants. Probing starts from a component mount and its disposal is an
 *   owned effect created in `apply`.
 * - The poll loop is owned by `apply`'s effect: disposal clears the timer,
 *   removes the visibility listener, aborts the in-flight probe (and every
 *   request it started), and forbids any later publish. A superseded request
 *   (manual Refresh) never publishes.
 * - The stream connection is owned by the desk page's mount effect and by the
 *   same disposal: hiding the tab pauses it, unmounting or disposing aborts it,
 *   and a stopped connection can never publish another frame.
 * - Visible copy goes through the Client locale service (`ctx.locale.register`
 *   plus the `locale:` registration option, which supplies `t`), in both
 *   built-in locales, with a dictionary fallback so a missing seat renders
 *   English instead of a key.
 * - Chrome uses only host `--dsw-alias-*` color tokens; the sidebar glyph uses
 *   `currentColor`, so the host owns its color in every theme. No literal
 *   colors, no `innerHTML`, no app-root or page-body writes.
 * - React comes from the browser module table. No Harness Client package is
 *   imported and no DOM outside the slot entries is read or written.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-sportsdesk-desk-panel",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this bundle (also the `locale:` registration option). */
    const NS = "sportsdesk-desk-panel";
    /** The id shared by the sidebar entry and the main panel it opens. */
    const PANEL_ID = "sportsdesk";
    /** The local webview service the desk runs with `bun run serve`. */
    const SERVICE_URL = "http://127.0.0.1:4020";
    /** Same-origin proxy routes registered by the Host half (`index.js`). */
    const PROXY_BASE = "/api/sportsdesk-desk";
    /**
     * The Harness Web UI is tunnel-served (`--public-url`), so `127.0.0.1` in the
     * browser is the VIEWER's machine, not the desk host. Probe the same-origin
     * proxy first — the Harness server runs on the desk host — and fall back to the
     * loopback URL for a browser that is on the desk host itself.
     */
    const HEALTH_URLS = [`${PROXY_BASE}/health`, `${SERVICE_URL}/health`];
    const STATUS_URLS = [`${PROXY_BASE}/status`, `${SERVICE_URL}/api/status`];
    const GRAPH_URLS = [
      `${PROXY_BASE}/graph`,
      `${SERVICE_URL}/api/graph/summary`,
    ];
    const KPIS_URLS = [`${PROXY_BASE}/kpis`, `${SERVICE_URL}/api/kpis`];
    const EXECUTION_URLS = [
      `${PROXY_BASE}/execution`,
      `${SERVICE_URL}/api/execution/plan`,
    ];
    /**
     * The desk's own Server-Sent Events route (`event: summary` frames plus
     * `: heartbeat` comments), proxied same-origin like the JSON sources and
     * falling back to loopback for a browser on the desk host.
     */
    const STREAM_URLS = [
      `${PROXY_BASE}/stream`,
      `${SERVICE_URL}/api/graph/stream`,
    ];
    /** Per-request bound; the service answers in a few milliseconds when up. */
    const PROBE_TIMEOUT_MS = 4_000;
    /** Live cadence while the tab is visible. Hidden tabs stop probing. */
    const POLL_MS = 15_000;
    /** The exact restart the stale-build callout asks for. */
    const RESTART_COMMAND = "PORT=4020 bun run serve";
    /** Bound the rendered schedule list; the service currently reports six. */
    const MAX_SCHEDULES = 12;
    /** Rolling /health latency samples for the sparkline (oldest first). */
    const LATENCY_HISTORY_MAX = 30;
    let healthLatencyHistory = [];
    /** Reconnect backoff for the live stream; the last delay repeats. */
    const LIVE_RETRY_MS = Object.freeze([2_000, 5_000, 10_000, 30_000]);
    /** Newest-first bound on the rendered counter-change list. */
    const LIVE_CHANGES_MAX = 8;
    /** The stream counts this card diffs; each is a locale key too. */
    const LIVE_COUNTER_KEYS = Object.freeze([
      "pendingBets",
      "activeWallets",
      "openLegs",
      "openExposureUsd",
      "ipClusters",
    ]);
    /** Payload counter name -> the visible label's locale key. */
    const LIVE_COUNTER_LABELS = Object.freeze({
      pendingBets: "pendingBets",
      activeWallets: "activeWallets",
      openLegs: "openLegs",
      openExposureUsd: "openExposure",
      ipClusters: "ipClusters",
    });

    /**
     * Visible copy. Both built-in locales are supplied because the locale
     * service's object form expects a dictionary per locale; a language switch
     * re-renders the page and the sidebar label without re-registering.
     */
    const DICTS = {
      en: {
        panel: "SportsDesk",
        title: "SportsDesk desk",
        description:
          "Read-only view of the local SportsDesk webview service the desk runs with bun run serve: live Server-Sent Events frames through a same-origin proxy, service phase, market feed, book KPIs and the paper execution plan, measured from its own read-only routes.",
        refresh: "Refresh",
        open: "Open desk",
        retry: "Retry",
        lastMeasured: "Last measured",
        latency: "Health latency",
        latencySummary: "{count} probes · p50 {p50} ms · max {max} ms",
        latencyEmpty: "No successful probes yet",
        copyDiagnostics: "Copy diagnostics",
        copied: "Copied",
        copyFailed: "Copy failed",
        checking: "checking…",
        current: "current",
        degraded: "degraded",
        degradedHint:
          "The daemon is up, but auth or pipeline checks failed: {reasons}",
        degradedActionCopy: "Click to copy fix command",
        stale: "stale build (uptime {uptime})",
        staleUnknown: "stale build",
        down: "service down",
        unknown: "status probe failed",
        endpoint: "Endpoint",
        http: "HTTP",
        uptime: "Uptime",
        checked: "Checked",
        never: "—",
        justNow: "just now",
        agoSeconds: "{seconds}s ago",
        agoMinutes: "{minutes}m ago",
        agoHours: "{hours}h ago",
        source: "Source",
        sourceProxy: "Harness proxy",
        sourceDirect: "direct loopback",
        service: "Service",
        runtime: "Runtime",
        memory: "Memory",
        pid: "PID",
        environment: "Environment",
        telegram: "Telegram",
        checks: "Checks",
        probes: "Probes",
        reports: "Scheduled reports",
        enabledCount: "{enabled} of {total} enabled",
        off: "off",
        on: "on",
        what: "What this checks",
        explain:
          "/health answers first. /api/status is a route the current checkout defines, so a 404 there — or a /health body without an ingress field — means the running service predates this checkout, and the page shows “stale build” rather than “healthy”. Each overview card measures its own source, so one failed source never blanks the others.",
        staleFixTitle: "Stale build",
        staleFixLead: "The running service predates this checkout. Missing:",
        missingStatus: "/api/status route (HTTP 404)",
        missingIngress: "ingress field on /health",
        restartHint:
          "Restart it from the checkout so it serves the current routes:",
        startHint: "Start it from the checkout:",
        downHint: "The Harness host could not reach the desk service at {url}.",
        probeFailedHint:
          "The service answered /health, but the /api/status probe did not answer with a usable status, so the running build cannot be confirmed.",
        rawHealth: "Raw /health",
        rawStatus: "Raw /api/status",
        dotTitle: "SportsDesk desk: {status}",
        liveCounterStrip: "Live counters",
        overviewSourceStrip: "Overview sources",
        operatorDesk: "Desk host",
        liveReads: "F402 live reads",
        liveReadsOk: "ticker and pending reachable",
        liveReadsPartial: "live reads degraded",
        legacyPortalLead: "Actions in legacy portal:",
        legacyPortalLink: "Fantasy402 Manager",
        marketFeed: "Market feed",
        book: "Book",
        executionCard: "Paper execution",
        stateLive: "live",
        stateStale: "stale",
        stateError: "error",
        stateMissing: "missing",
        stateChecking: "checking",
        measuredAt: "measured {time} · {age}",
        attemptedAt: "last attempt {time} · {age}",
        lastGood: "Showing the last good measurement from {time}",
        feedMissing: "feed section missing",
        feedStatus: "Feed status",
        dataMode: "Data mode",
        wssIngestion: "WSS ingestion",
        pollSequence: "Poll sequence",
        updated: "Updated",
        age: "Age",
        counts: "Counts",
        activeWallets: "Active wallets",
        openLegs: "Open legs",
        openExposure: "Open exposure",
        pendingBets: "Pending bets",
        ipClusters: "IP clusters",
        repo: "Repo",
        branch: "Branch",
        head: "HEAD",
        routesServed: "Routes served",
        citations: "Citations",
        citationSummary: "{checked} citations · {age}",
        tests: "Tests",
        testsSummary: "{tests} tests · {age}",
        agentsBlock: "Agents",
        total: "Total",
        agentsField: "Agents",
        masters: "Masters",
        pendingBlock: "Pending (F402)",
        wagers: "Wagers",
        tickets: "Tickets",
        wagered: "Wagered",
        toWin: "To win",
        tickerBlock: "Ticker (F402 · 3a)",
        r2PipelinesBlock: "R2 pipelines",
        r2F402Ticker: "Ticker (F402 · 3a)",
        r2F402Weblog: "Weblog (F402)",
        r2GsliveTally: "GSLive tally (3c)",
        r2WagersAggregate: "Wagers aggregate",
        r2SinkFresh: "fresh",
        r2SinkStale: "stale",
        r2SinkStaleData: "stale data",
        r2SinkState: "{state} · publish {age}",
        r2SinkDataAge: "data {age}",
        attentionR2Stale: "R2 sink {sink} is stale ({reason})",
        liveField: "Live",
        risk: "Risk",
        volume: "Volume",
        customerBook: "Customer book",
        customers: "Customers",
        customerNet: "Customer net",
        provenance: "provenance",
        notLive: "not live",
        partial: "partial",
        mode: "Mode",
        killSwitch: "Kill switch",
        liveExecution: "Live execution",
        dailyPlanned: "Daily planned",
        openIntents: "Open intents",
        marketExposure: "Market exposure",
        none: "none",
        venues: "Venues",
        liveReady: "live-ready",
        notLiveReady: "not live-ready",
        decisions: "Decisions",
        blocked: "Blocked",
        notBlocked: "Not blocked",
        decisionsUnknown: "Unknown — the payload has no decisions array.",
        blockedReasons: "Blocked reasons",
        planStale: "The plan was computed from stale market data",
        rawJson: "Raw JSON",
        attentionTitle: "Attention",
        attentionItem: "{source}: {detail}",
        attentionJoin: "; ",
        attentionFeedStale: "stale ({age})",
        attentionWss: "WSS not ingested ({value})",
        attentionFixtureProvenance:
          "Agent tree: fixture-sourced ({value}); not live portal data",
        attentionFeedStatus: "status is {status}",
        attentionKill: "kill switch is on",
        attentionMode: "mode is {mode}",
        attentionLive: "live execution is enabled",
        liveTitle: "Live stream",
        liveStateIdle: "idle",
        liveStateConnecting: "connecting…",
        liveStateStreaming: "streaming",
        liveStateReconnecting: "reconnecting",
        liveStatePaused: "paused",
        liveStateUnavailable: "no stream route",
        liveStatePolling: "polling fallback",
        liveStateError: "stream error",
        liveLastPoll: "Last poll",
        liveChangesPoll: "Changes between probes",
        livePolling:
          "The live stream route is not in this running build, so these counters come from the 15 s graph probe and the changes below are poll-to-poll. Streaming starts after the Harness reloads the plugin.",
        liveEndpoint: "Stream",
        liveFrames: "Frames",
        liveFramesValue: "{frames} frames · {bytes}",
        liveLastFrame: "Last change frame",
        liveHeartbeats: "Heartbeats",
        liveHeartbeatsValue: "{count} · last {age}",
        liveConnected: "Connected",
        liveConnectedValue: "{time} · {age}",
        liveNoFrames:
          "Connected. No change frame yet — the desk sends one only when its stat fingerprint changes (at most every 5 s) and a heartbeat comment every 5 s.",
        liveCounters: "Live counters",
        liveNoValues: "No summary frame has been read yet.",
        liveChanges: "Changes while connected",
        liveChangeLine: "{field} {from} → {to}",
        liveNoChanges: "No counter has changed since this stream connected.",
        liveUnavailable:
          "The live stream route is not in this running build — the Harness Host half or the desk service predates it. The 15 s overview probes below still measure the desk; streaming starts after the Harness reloads the plugin.",
        liveDown:
          "The live stream is not connected: {reason}. The 15 s overview probes below still measure the desk.",
        livePausedNote:
          "Reading pauses while the browser tab is hidden and resumes when it becomes visible again.",
        liveRetry: "Next attempt in {seconds}s.",
        liveRaw: "Raw stream",
        liveNote:
          "Live frames come from the desk's own Server-Sent Events route through the same-origin proxy. The three overview cards below stay on the shared probe loop: five read-only routes every {seconds}s while the tab is visible. Refresh measures both now.",
      },
      zh: {
        panel: "SportsDesk",
        title: "SportsDesk 工作台",
        description:
          "本地 SportsDesk webview 服务（由 bun run serve 启动）的只读视图：通过同源代理读取实时 Server-Sent Events 帧，以及服务状态、市场行情、账目指标与模拟执行计划，均来自其自身的只读路由。",
        refresh: "刷新",
        open: "打开工作台",
        retry: "重试",
        lastMeasured: "最近测量",
        latency: "健康检查延迟",
        latencySummary: "{count} 次探测 · p50 {p50} ms · 最大 {max} ms",
        latencyEmpty: "尚无成功探测",
        copyDiagnostics: "复制诊断",
        copied: "已复制",
        copyFailed: "复制失败",
        checking: "检测中…",
        current: "已是最新",
        degraded: "降级",
        degradedHint: "服务在线，但认证或管线检查未通过：{reasons}",
        degradedActionCopy: "点击复制修复命令",
        stale: "旧构建（已运行 {uptime}）",
        staleUnknown: "旧构建",
        down: "服务未运行",
        unknown: "状态探测失败",
        endpoint: "地址",
        http: "HTTP",
        uptime: "运行时长",
        checked: "检查时间",
        never: "—",
        justNow: "刚刚",
        agoSeconds: "{seconds} 秒前",
        agoMinutes: "{minutes} 分钟前",
        agoHours: "{hours} 小时前",
        source: "数据来源",
        sourceProxy: "Harness 代理",
        sourceDirect: "直接回环",
        service: "服务",
        runtime: "运行时",
        memory: "内存",
        pid: "进程号",
        environment: "环境",
        telegram: "Telegram",
        checks: "检查项",
        probes: "探测耗时",
        reports: "定时报告",
        enabledCount: "已启用 {enabled}/{total}",
        off: "停用",
        on: "启用",
        what: "检测内容",
        explain:
          "先检查 /health；/api/status 是当前代码定义的路由。该路由返回 404，或 /health 响应缺少 ingress 字段，说明运行中的服务早于此代码版本，因此显示“旧构建”而不是“正常”。概览中的每张卡片各自测量自己的数据源，单个源失败不会清空其他卡片。",
        staleFixTitle: "旧构建",
        staleFixLead: "运行中的服务早于当前代码版本，缺少：",
        missingStatus: "/api/status 路由（HTTP 404）",
        missingIngress: "/health 响应中的 ingress 字段",
        restartHint: "请在当前代码目录中重启服务，使其提供最新路由：",
        startHint: "请在当前代码目录中启动服务：",
        downHint: "Harness 主机无法连接位于 {url} 的 desk 服务。",
        probeFailedHint:
          "服务已响应 /health，但 /api/status 探测没有得到可用的状态，因此无法确认运行中的构建版本。",
        rawHealth: "原始 /health",
        rawStatus: "原始 /api/status",
        dotTitle: "SportsDesk 工作台：{status}",
        liveCounterStrip: "实时计数",
        overviewSourceStrip: "概览数据源",
        operatorDesk: "工作台主机",
        liveReads: "F402 实盘读取",
        liveReadsOk: "ticker 与 pending 可达",
        liveReadsPartial: "实盘读取降级",
        legacyPortalLead: "旧版门户操作：",
        legacyPortalLink: "Fantasy402 Manager",
        marketFeed: "市场行情",
        book: "账目",
        executionCard: "模拟执行",
        stateLive: "实时",
        stateStale: "过期",
        stateError: "错误",
        stateMissing: "缺失",
        stateChecking: "检测中",
        measuredAt: "测量于 {time} · {age}",
        attemptedAt: "最近尝试 {time} · {age}",
        lastGood: "显示 {time} 收到的上一次有效测量",
        feedMissing: "缺少 feed 段",
        feedStatus: "行情状态",
        dataMode: "数据模式",
        wssIngestion: "WSS 接入",
        pollSequence: "轮询序号",
        updated: "更新时间",
        age: "数据年龄",
        counts: "计数",
        activeWallets: "活跃钱包",
        openLegs: "未平仓腿",
        openExposure: "未平敞口",
        pendingBets: "待处理投注",
        ipClusters: "IP 簇",
        repo: "代码仓库",
        branch: "分支",
        head: "HEAD",
        routesServed: "已提供路由",
        citations: "引用",
        citationSummary: "{checked} 条引用 · {age}",
        tests: "测试",
        testsSummary: "{tests} 项测试 · {age}",
        agentsBlock: "代理",
        total: "总计",
        agentsField: "代理",
        masters: "主代理",
        pendingBlock: "待处理 (F402)",
        wagers: "注单",
        tickets: "票数",
        wagered: "投注额",
        toWin: "可赢",
        tickerBlock: "行情 (F402 · 3a)",
        r2PipelinesBlock: "R2 管线",
        r2F402Ticker: "行情 (F402 · 3a)",
        r2F402Weblog: "Weblog (F402)",
        r2GsliveTally: "GSLive 汇总 (3c)",
        r2WagersAggregate: "分状态汇总",
        r2SinkFresh: "新鲜",
        r2SinkStale: "过期",
        r2SinkStaleData: "数据过期",
        r2SinkState: "{state} · 发布 {age}",
        r2SinkDataAge: "数据 {age}",
        attentionR2Stale: "R2 接收端 {sink} 已过期（{reason}）",
        liveField: "进行中",
        risk: "风险",
        volume: "成交量",
        customerBook: "客户账本",
        customers: "客户数",
        customerNet: "客户净额",
        provenance: "来源",
        notLive: "非实盘",
        partial: "部分",
        mode: "模式",
        killSwitch: "紧急开关",
        liveExecution: "实盘执行",
        dailyPlanned: "每日计划",
        openIntents: "未结意图",
        marketExposure: "市场敞口",
        none: "无",
        venues: "场所",
        liveReady: "可实盘",
        notLiveReady: "不可实盘",
        decisions: "决策",
        blocked: "已阻断",
        notBlocked: "未阻断",
        decisionsUnknown: "未知 — 响应中没有 decisions 数组。",
        blockedReasons: "阻断原因",
        planStale: "该计划基于过期的市场数据计算",
        rawJson: "原始 JSON",
        attentionTitle: "注意",
        attentionItem: "{source}：{detail}",
        attentionJoin: "；",
        attentionFeedStale: "过期（{age}）",
        attentionWss: "WSS 未接入（{value}）",
        attentionFixtureProvenance:
          "代理树：夹具来源（{value}）；非门户实盘数据",
        attentionFeedStatus: "状态为 {status}",
        attentionKill: "紧急开关已开启",
        attentionMode: "模式为 {mode}",
        attentionLive: "已启用实盘执行",
        liveTitle: "实时流",
        liveStateIdle: "空闲",
        liveStateConnecting: "连接中…",
        liveStateStreaming: "实时接收中",
        liveStateReconnecting: "重连中",
        liveStatePaused: "已暂停",
        liveStateUnavailable: "无实时路由",
        liveStatePolling: "轮询回退",
        liveStateError: "实时流错误",
        liveLastPoll: "最近轮询",
        liveChangesPoll: "两次探测之间的变化",
        livePolling:
          "运行中的构建没有实时流路由，因此这些计数来自每 15 秒的行情探测，下方变化为两次探测之间的差异。Harness 重新加载插件后即开始实时接收。",
        liveEndpoint: "实时地址",
        liveFrames: "帧数",
        liveFramesValue: "{frames} 帧 · {bytes}",
        liveLastFrame: "最近变更帧",
        liveHeartbeats: "心跳",
        liveHeartbeatsValue: "{count} 次 · 最近 {age}",
        liveConnected: "连接时间",
        liveConnectedValue: "{time} · {age}",
        liveNoFrames:
          "已连接。尚未收到变更帧——只有服务端统计指纹变化时才会发送（最多每 5 秒一次），并每 5 秒发送一次心跳注释。",
        liveCounters: "实时计数",
        liveNoValues: "尚未读取到 summary 帧。",
        liveChanges: "连接期间的变更",
        liveChangeLine: "{field} {from} → {to}",
        liveNoChanges: "本次连接以来没有计数发生变化。",
        liveUnavailable:
          "运行中的构建没有实时流路由——Harness 主机部分或 desk 服务早于此版本。下方每 15 秒的概览探测仍会测量工作台；Harness 重新加载插件后即开始实时接收。",
        liveDown:
          "实时流未连接：{reason}。下方每 15 秒的概览探测仍会测量工作台。",
        livePausedNote: "浏览器标签页隐藏时暂停读取，重新可见时自动恢复。",
        liveRetry: "{seconds} 秒后重试。",
        liveRaw: "原始实时流",
        liveNote:
          "实时帧来自服务自身的 Server-Sent Events 路由，经同源代理转发。下方三张概览卡片仍使用共享探测循环：标签页可见时每 {seconds} 秒探测五个只读路由。点击“刷新”会同时重新测量两者。",
      },
    };

    /**
     * Initial state is "checking", never "healthy": nothing has been measured
     * yet. Every measured field is null until a probe fills it, so the page can
     * render only what the service actually answered. `sources` stays null per
     * source until that source has been probed at least once.
     */
    const INITIAL = Object.freeze({
      phase: "checking",
      uptimeSeconds: null,
      httpStatus: null,
      checkedAt: null,
      error: null,
      source: null,
      healthLatencyMs: null,
      statusLatencyMs: null,
      healthUrl: null,
      statusUrl: null,
      runtime: null,
      pid: null,
      memoryRss: null,
      nodeEnv: null,
      telegramMode: null,
      telegramReason: null,
      checks: null,
      schedules: null,
      deskHostname: null,
      liveReadsLine: null,
      missing: [],
      degradedReasons: [],
      dataStatus: null,
      sources: Object.freeze({
        health: null,
        status: null,
        graph: null,
        kpis: null,
        execution: null,
      }),
    });

    /**
     * The live-stream snapshot. It is separate from the polled snapshot on
     * purpose: a stream frame is a different measurement (the desk pushes it
     * when its stat fingerprint changes) and must not be rendered as if a
     * 15 s probe had confirmed the service phase.
     */
    const LIVE_INITIAL = Object.freeze({
      state: "idle",
      url: null,
      transport: null,
      httpStatus: null,
      error: null,
      attempts: 0,
      frames: 0,
      heartbeats: 0,
      parseErrors: 0,
      bytes: 0,
      connectedAt: null,
      lastFrameAt: null,
      lastHeartbeatAt: null,
      polledAt: null,
      values: null,
      changes: Object.freeze([]),
    });

    /** Empty sources map for a probe that threw before any source settled. */
    function emptySources() {
      return {
        health: null,
        status: null,
        graph: null,
        kpis: null,
        execution: null,
      };
    }

    /* --- small boundary readers: never invent data ----------------------- */

    /** @param {unknown} value @returns {value is Record<string, unknown>} */
    function isRecord(value) {
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    }

    /**
     * @param {unknown} value
     * @returns {number | null}
     */
    function readNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    /**
     * @param {unknown} value
     * @returns {boolean | null} the boolean, or null when the field is absent/other
     */
    function readBoolean(value) {
      return typeof value === "boolean" ? value : null;
    }

    /**
     * @param {unknown} value
     * @returns {string | null}
     */
    function readText(value) {
      return typeof value === "string" && value.length > 0 ? value : null;
    }

    /**
     * Read `/api/status.checks` into display rows; anything that is not a plain
     * string/number/boolean value is ignored rather than rendered as "[object]".
     * @param {unknown} value
     * @returns {{ name: string, value: string }[] | null}
     */
    function readChecks(value) {
      if (!isRecord(value)) return null;
      const rows = [];
      for (const [name, raw] of Object.entries(value)) {
        if (
          typeof raw === "string" ||
          typeof raw === "number" ||
          typeof raw === "boolean"
        ) {
          rows.push({ name, value: String(raw) });
        }
      }
      return rows.length > 0 ? rows : null;
    }

    /**
     * Read `/api/status.telegram.schedules` into display rows plus the enabled
     * count. Rows without a usable name/time are skipped; the rendered list is
     * bounded, while `enabled`/`total` still describe the full array.
     * @param {unknown} value
     * @returns {{ rows: { id: string, name: string, when: string, enabled: boolean }[], enabled: number, total: number } | null}
     */
    function readSchedules(value) {
      if (!Array.isArray(value)) return null;
      const rows = [];
      let enabled = 0;
      for (const item of value) {
        if (!isRecord(item)) continue;
        const name = readText(item.name);
        const when = readText(item.scheduleTime);
        if (name === null || when === null) continue;
        const isEnabled = item.enabled === true;
        if (isEnabled) enabled += 1;
        rows.push({
          id: readText(item.id) ?? `schedule-${rows.length}`,
          name,
          when,
          enabled: isEnabled,
        });
      }
      if (rows.length === 0) return null;
      return {
        rows: rows.slice(0, MAX_SCHEDULES),
        enabled,
        total: rows.length,
      };
    }

    /**
     * Belt-and-suspenders: trust basis when present, fall back to source prefix
     * so the chip works against older API versions during rollout.
     * @param {{ basis?: string | null, source?: string | null } | null | undefined} prov
     */
    function isFixtureSource(source) {
      const value = source.trim();
      if (value.startsWith("live:")) return false;
      if (value.startsWith("capture:")) return false;
      return (
        value.startsWith("scratch/") ||
        value.startsWith("tests/fixtures/") ||
        value.startsWith("./")
      );
    }

    function isFixtureProvenance(prov) {
      if (prov === null || prov === undefined) return false;
      const basis = (prov.basis ?? "").trim().toLowerCase();
      if (basis === "fixture") return true;
      if (basis === "live") return false;
      const srcRaw = (prov.source ?? "").trim();
      if (basis === "capture" && srcRaw.startsWith("data/")) return false;
      if (srcRaw === "") return false;
      if (isFixtureSource(srcRaw)) return true;
      const src = srcRaw.toLowerCase();
      return src.startsWith("tests/") || src.includes("fixture");
    }

    /**
     * Read a `provenance` block (the kpis and execution payload carry one per
     * measurement). Returns null when the block carries nothing usable, so the
     * page omits the row instead of printing "unknown age".
     * @param {unknown} value
     * @returns {{ ageSeconds: number | null, stale: boolean | null, partial: boolean | null, asOf: string | null, source: string | null, basis: string | null } | null}
     */
    function readProvenance(value) {
      if (!isRecord(value)) return null;
      const ageSeconds = readNumber(value.ageSeconds);
      const stale = readBoolean(value.stale);
      const partial = readBoolean(value.partial);
      const asOf = readText(value.asOf);
      const source = readText(value.source);
      const basis = readText(value.basis);
      if (
        ageSeconds === null &&
        stale === null &&
        partial === null &&
        asOf === null &&
        source === null &&
        basis === null
      ) {
        return null;
      }
      return { ageSeconds, stale, partial, asOf, source, basis };
    }

    /**
     * Read one `kpis.<block>`: the numeric fields the card renders plus the
     * provenance. Null when the block is absent or measures nothing, so a card
     * never invents an empty block.
     * @param {unknown} value
     * @param {readonly string[]} fields
     */
    function readKpiBlock(value, fields) {
      if (!isRecord(value)) return null;
      /** @type {Record<string, number | null>} */
      const values = {};
      let measured = false;
      for (const field of fields) {
        const number = readNumber(value[field]);
        values[field] = number;
        if (number !== null) measured = true;
      }
      const provenance = readProvenance(value.provenance);
      if (!measured && provenance === null) return null;
      return { values, provenance };
    }

    /**
     * Read `/api/graph/summary` into the card's measured view. Every field is
     * independently optional: a payload with only a feed (or only a repo) is a
     * partial measurement, not a malformed one.
     * @param {unknown} body
     */
    function readGraphPayload(body) {
      if (!isRecord(body)) return null;
      const feedRaw = isRecord(body.feed) ? body.feed : null;
      const feed =
        feedRaw === null
          ? null
          : {
              status: readText(feedRaw.status),
              dataMode: readText(feedRaw.dataMode),
              wssIngestion: readText(feedRaw.wssIngestion),
              pollSequence: readNumber(feedRaw.pollSequence),
              lastUpdatedIso:
                readText(feedRaw.lastUpdatedIso) ?? readText(feedRaw.asOf),
              ageSeconds: readNumber(feedRaw.ageSeconds),
              stale: readBoolean(feedRaw.stale),
              counts: readFeedCounts(feedRaw.counts),
            };
      const repoRaw = isRecord(body.repo) ? body.repo : null;
      const repo = repoRaw === null ? null : readRepo(repoRaw);
      if (feed === null && repo === null) return null;
      return { feed, repo };
    }

    /**
     * Read one live SSE `summary` frame into the counters the live card diffs.
     * The desk's stream carries the same body as `/api/graph/summary`, so this
     * reuses the graph readers; an unrecognised payload returns null and the
     * frame is never rendered as if it were a measurement.
     * @param {unknown} body
     */
    function readLiveValues(body) {
      const payload = readGraphPayload(body);
      if (payload === null) return null;
      const feed = payload.feed;
      return {
        feedStatus: feed === null ? null : feed.status,
        dataMode: feed === null ? null : feed.dataMode,
        feedAgeSeconds: feed === null ? null : feed.ageSeconds,
        feedStale: feed === null ? null : feed.stale,
        pollSequence: feed === null ? null : feed.pollSequence,
        lastUpdatedIso: feed === null ? null : feed.lastUpdatedIso,
        counts: feed === null ? null : feed.counts,
      };
    }

    /**
     * The counters that actually moved between two frames. Only two measured
     * numbers are compared, so a first frame (previous null) and a frame that
     * omits a counter produce no invented delta.
     * @param {{ counts: Record<string, unknown> | null } | null} previous
     * @param {{ counts: Record<string, unknown> | null }} next
     * @param {number} at
     */
    function diffLiveValues(previous, next, at) {
      if (previous === null || previous === undefined) return [];
      if (previous.counts === null || next.counts === null) return [];
      const changes = [];
      for (const key of LIVE_COUNTER_KEYS) {
        const from = previous.counts[key];
        const to = next.counts[key];
        if (typeof from === "number" && typeof to === "number" && from !== to) {
          changes.push({ key, from, to, at });
        }
      }
      return changes;
    }

    /**
     * @param {unknown} value
     */
    function readFeedCounts(value) {
      if (!isRecord(value)) return null;
      const counts = {
        activeWallets: readNumber(value.activeWallets),
        openLegs: readNumber(value.openLegs),
        openExposureUsd: readNumber(value.openExposureUsd),
        pendingBets: readNumber(value.pendingBets),
        ipClusters: readNumber(value.ipClusters),
      };
      for (const number of Object.values(counts)) {
        if (number !== null) return counts;
      }
      return null;
    }

    /**
     * @param {Record<string, unknown>} raw
     */
    function readRepo(raw) {
      const routes = isRecord(raw.routes) ? raw.routes : null;
      const citationsRaw = isRecord(raw.citations) ? raw.citations : null;
      const citations =
        citationsRaw === null
          ? null
          : {
              checked: readNumber(citationsRaw.checked),
              ageSeconds: readNumber(citationsRaw.ageSeconds),
              stale: readBoolean(citationsRaw.stale),
              asOf: readText(citationsRaw.asOf),
            };
      const checks = isRecord(raw.checks) ? raw.checks : null;
      const testsRaw = checks && isRecord(checks.tests) ? checks.tests : null;
      const tests =
        testsRaw === null
          ? null
          : {
              tests: readNumber(testsRaw.tests),
              failures: readNumber(testsRaw.failures),
              ageSeconds: readNumber(testsRaw.ageSeconds),
            };
      const repo = {
        branch: readText(raw.branch),
        head: readText(raw.head),
        routesServed: routes === null ? null : readNumber(routes.served),
        citations,
        tests,
      };
      if (
        repo.branch === null &&
        repo.head === null &&
        repo.routesServed === null &&
        repo.citations === null &&
        repo.tests === null
      ) {
        return null;
      }
      return repo;
    }

    /**
     * Read `/api/kpis` into the four measured blocks. Each block is rendered from
     * its own fields and provenance; a missing block is omitted, never zeroed.
     * @param {unknown} body
     */
    const R2_SINK_SPECS = [
      { id: "f402-bet-ticker", labelKey: "r2F402Ticker" },
      { id: "f402-weblog", labelKey: "r2F402Weblog" },
      { id: "gslive-tally", labelKey: "r2GsliveTally" },
      { id: "wagers-by-state", labelKey: "r2WagersAggregate" },
    ];

    /**
     * `/api/kpis.pipeline.r2` — public R2 pointer freshness (distinct from block provenance).
     * @param {unknown} body
     */
    function readR2PipelineSinks(body) {
      if (!isRecord(body) || !isRecord(body.pipeline)) return null;
      const r2 = body.pipeline.r2;
      if (!isRecord(r2)) return null;
      const sinks = [];
      for (const spec of R2_SINK_SPECS) {
        const raw = r2[spec.id];
        if (!isRecord(raw)) continue;
        sinks.push({
          id: spec.id,
          labelKey: spec.labelKey,
          stale: readBoolean(raw.stale) === true,
          dataStale: readBoolean(raw.dataStale) === true,
          state: readText(raw.state),
          ageSeconds: readNumber(raw.ageSeconds),
          dataAgeSeconds: readNumber(raw.dataAgeSeconds),
          reason: readText(raw.reason),
        });
      }
      return sinks.length === 0 ? null : sinks;
    }

    function readKpisPayload(body) {
      if (!isRecord(body)) return null;
      const raw = isRecord(body.kpis) ? body.kpis : null;
      const r2Sinks = readR2PipelineSinks(body);
      if (raw === null && r2Sinks === null) return null;
      const payload = {
        agents:
          raw === null
            ? null
            : readKpiBlock(raw.agents, ["total", "agents", "masters"]),
        pending:
          raw === null
            ? null
            : readKpiBlock(raw.pending, [
                "wagers",
                "tickets",
                "wageredCents",
                "toWinCents",
              ]),
        ticker:
          raw === null
            ? null
            : readKpiBlock(raw.ticker, [
                "wagers",
                "live",
                "riskCents",
                "volumeCents",
              ]),
        customerBook:
          raw === null
            ? null
            : readKpiBlock(raw.customerBook, [
                "customers",
                "tickets",
                "customerNetCents",
              ]),
        r2Sinks,
      };
      if (
        payload.agents === null &&
        payload.pending === null &&
        payload.ticker === null &&
        payload.customerBook === null &&
        payload.r2Sinks === null
      ) {
        return null;
      }
      return payload;
    }

    /**
     * Read `risk.marketExposureUsd`. A present empty object is a measured
     * "no entries" (an empty array here); null means the field was absent.
     * @param {unknown} value
     * @returns {{ market: string, amount: number }[] | null}
     */
    function readExposure(value) {
      if (!isRecord(value)) return null;
      const entries = [];
      for (const [market, raw] of Object.entries(value)) {
        const amount = readNumber(raw);
        if (amount !== null) entries.push({ market, amount });
      }
      return entries;
    }

    /**
     * @param {unknown} value
     * @returns {{ id: string, liveReady: boolean | null, reason: string | null }[] | null}
     */
    function readVenues(value) {
      if (!isRecord(value)) return null;
      const venues = [];
      for (const [id, raw] of Object.entries(value)) {
        if (!isRecord(raw)) continue;
        venues.push({
          id,
          liveReady: readBoolean(raw.liveReady),
          reason: readText(raw.reason),
        });
      }
      return venues;
    }

    /**
     * Count `decisions[].blocked`. Null when the payload has no decisions array
     * — the card renders that as "unknown", never as "0 blocked".
     * @param {unknown} value
     * @returns {{ total: number, blocked: number, notBlocked: number, known: number } | null}
     */
    function readDecisions(value) {
      if (!Array.isArray(value)) return null;
      let blocked = 0;
      let notBlocked = 0;
      for (const item of value) {
        if (!isRecord(item)) continue;
        if (item.blocked === true) blocked += 1;
        else if (item.blocked === false) notBlocked += 1;
      }
      return {
        total: value.length,
        blocked,
        notBlocked,
        known: blocked + notBlocked,
      };
    }

    /**
     * @param {unknown} value
     * @returns {{ reason: string, count: number }[] | null}
     */
    function readBlockedReasons(value) {
      if (!isRecord(value)) return null;
      const rows = [];
      for (const [reason, raw] of Object.entries(value)) {
        const count = readNumber(raw);
        if (count !== null && count > 0) rows.push({ reason, count });
      }
      return rows.length > 0 ? rows : null;
    }

    /**
     * Read `/api/execution/plan`. Every field is optional: a plan with only a
     * mode, or only venues, still renders the measured part.
     * @param {unknown} body
     */
    function readExecutionPayload(body) {
      if (!isRecord(body)) return null;
      const policyRaw = isRecord(body.policy) ? body.policy : null;
      const riskRaw = isRecord(body.risk) ? body.risk : null;
      const payload = {
        mode: readText(body.mode),
        killSwitch: readBoolean(body.killSwitch),
        liveEnabled:
          policyRaw === null ? null : readBoolean(policyRaw.liveEnabled),
        maxOpenIntents:
          policyRaw === null ? null : readNumber(policyRaw.maxOpenIntents),
        risk:
          riskRaw === null
            ? null
            : {
                dailyPlannedUsd: readNumber(riskRaw.dailyPlannedUsd),
                dailyCapUsd: readNumber(riskRaw.dailyCapUsd),
                openIntents: readNumber(riskRaw.openIntents),
                marketExposureUsd: readExposure(riskRaw.marketExposureUsd),
              },
        venues: readVenues(body.venues),
        decisions: readDecisions(body.decisions),
        blockedReasons: readBlockedReasons(body.blockedReasons),
        provenance: readProvenance(body.provenance),
      };
      if (
        payload.mode === null &&
        payload.killSwitch === null &&
        payload.liveEnabled === null &&
        payload.risk === null &&
        payload.venues === null &&
        payload.decisions === null &&
        payload.provenance === null
      ) {
        return null;
      }
      return payload;
    }

    /**
     * English fallback used only if the slot hands the component no `t` seat.
     * @param key - dictionary key.
     * @param params - interpolation values.
     * @returns the English template with its placeholders filled.
     */
    function fallbackT(key, params) {
      const template = DICTS.en[key] ?? key;
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        name in params ? String(params[name]) : match,
      );
    }

    /* --- transport: measure, never assume -------------------------------- */

    /**
     * GET one URL with a per-request bound and keep its HTTP status; a non-JSON
     * body is null, not an invented healthy payload. The request aborts when
     * either its own bound expires or the outer probe signal aborts (disposal or
     * a superseded manual Refresh).
     * @param {string} url
     * @param {AbortSignal | null | undefined} signal
     */
    async function getJson(url, signal) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (signal !== undefined && signal !== null) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", forwardAbort, { once: true });
      }
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        const latencyMs = Math.max(0, Math.round(Date.now() - startedAt));
        const proxied =
          typeof response.headers?.get === "function" &&
          response.headers.get("x-sportsdesk-desk-proxy") !== null;
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        return {
          status: response.status,
          body,
          url,
          latencyMs,
          proxied,
        };
      } finally {
        clearTimeout(timer);
        if (
          signal !== undefined &&
          signal !== null &&
          typeof signal.removeEventListener === "function"
        ) {
          signal.removeEventListener("abort", forwardAbort);
        }
      }
    }

    /**
     * One per-source measured state. `body` is only set for a 2xx JSON object;
     * every failure carries its reason so the card never renders a bare state.
     * @param {"error" | "missing"} status
     * @param {number | null} httpStatus
     * @param {string} error
     * @param {string} url
     * @param {"proxy" | "direct" | null} transport
     * @param {number | null} latencyMs
     */
    function failedSource(
      status,
      httpStatus,
      error,
      url,
      transport,
      latencyMs,
    ) {
      return {
        status,
        httpStatus,
        body: null,
        latencyMs,
        url,
        transport,
        error,
        receivedAt: null,
        checkedAt: Date.now(),
      };
    }

    /**
     * `HTTP 500 · upstream detail` style reason, so a card names the status the
     * proxy forwarded (and the proxy's own error token when it sent one).
     * @param {{ status: number, body: unknown }} result
     */
    function errorReason(result) {
      const detail = isRecord(result.body) ? readText(result.body.error) : null;
      const base = `HTTP ${result.status}`;
      return detail === null ? base : `${base} · ${detail}`;
    }

    /**
     * GET the first working URL in order. The proxy URL is tried first; an
     * UNMARKED proxy 404 means "this Harness did not register the route", so the
     * loopback URL is tried next. A 404 carrying the Host half's proxy marker is
     * authoritative: the desk service itself answered, so the source is
     * `missing` ("not in this build"), not down. The same holds for a 404 from a
     * proxy known to be present (the health probe already answered through it;
     * the Host half registers all five routes together).
     * @param {readonly string[]} urls
     * @param {AbortSignal | null | undefined} signal
     * @param {boolean} proxyKnownPresent
     */
    async function probeSource(urls, signal, proxyKnownPresent) {
      let lastError = null;
      let lastHttpStatus = null;
      let lastUrl = urls[urls.length - 1];
      let lastTransport = null;
      let lastLatencyMs = null;
      for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        const transport = index === 0 ? "proxy" : "direct";
        let result;
        try {
          result = await getJson(url, signal);
        } catch (error) {
          lastError = error;
          lastUrl = url;
          lastTransport = transport;
          continue;
        }
        lastUrl = url;
        lastTransport = transport;
        lastLatencyMs = result.latencyMs;
        lastHttpStatus = result.status;
        if (result.status >= 200 && result.status < 300) {
          if (!isRecord(result.body)) {
            return failedSource(
              "error",
              result.status,
              "non-JSON body",
              url,
              transport,
              result.latencyMs,
            );
          }
          return {
            status: "ok",
            httpStatus: result.status,
            body: result.body,
            latencyMs: result.latencyMs,
            url,
            transport,
            error: null,
            receivedAt: Date.now(),
            checkedAt: Date.now(),
          };
        }
        const proxy404 = transport === "proxy" && result.status === 404;
        const authoritative =
          !proxy404 ||
          result.proxied === true ||
          proxyKnownPresent ||
          index === urls.length - 1;
        if (!authoritative) {
          // The generic Harness 404: this Host half may predate the route. The
          // loopback fallback can only work on a browser on the desk host.
          lastError = new Error(`HTTP ${result.status}`);
          continue;
        }
        if (result.status === 404) {
          return failedSource(
            "missing",
            result.status,
            "HTTP 404",
            url,
            transport,
            result.latencyMs,
          );
        }
        return failedSource(
          "error",
          result.status,
          errorReason(result),
          url,
          transport,
          result.latencyMs,
        );
      }
      const message = String(
        (lastError && lastError.message) || lastError || "probe failed",
      );
      return failedSource(
        "error",
        lastHttpStatus,
        message,
        lastUrl,
        lastTransport,
        lastLatencyMs,
      );
    }

    /**
     * Keep the last good payload of a source that failed later: the card shows
     * it labelled stale with the time it was received. Only a payload that was
     * actually measured is carried forward.
     * @param {object | null | undefined} previous
     * @param {object} measured
     */
    function withLastGood(previous, measured) {
      if (measured.status === "ok") return measured;
      if (previous === null || previous === undefined) return measured;
      if (!isRecord(previous.body)) return measured;
      return {
        ...measured,
        body: previous.body,
        receivedAt:
          typeof previous.receivedAt === "number" ? previous.receivedAt : null,
      };
    }

    /**
     * Measure all five sources once. Every probe catches its own failure, so one
     * slow or failed source cannot blank the others; the returned snapshot
     * carries the per-source states plus the service-phase fields v1 classified.
     * @param {AbortSignal} signal
     * @param {typeof INITIAL} previous - the last published snapshot, used to
     *   keep last-good payloads when a source fails.
     * @returns {Promise<typeof INITIAL>}
     */
    async function measure(signal, previous) {
      const previousSources = previous?.sources ?? null;
      const healthState = await probeSource(HEALTH_URLS, signal, false);
      const proxyKnownPresent =
        healthState.status === "ok" && healthState.transport === "proxy";
      const statusState = await probeSource(
        STATUS_URLS,
        signal,
        proxyKnownPresent,
      );
      const graphState = await probeSource(
        GRAPH_URLS,
        signal,
        proxyKnownPresent,
      );
      const kpisState = await probeSource(KPIS_URLS, signal, proxyKnownPresent);
      const executionState = await probeSource(
        EXECUTION_URLS,
        signal,
        proxyKnownPresent,
      );
      /** @type {Record<string, object | null>} */
      const sources = {
        health: healthState,
        status: statusState,
        graph: withLastGood(previousSources?.graph, graphState),
        kpis: withLastGood(previousSources?.kpis, kpisState),
        execution: withLastGood(previousSources?.execution, executionState),
      };
      const checkedAt = Date.now();
      const healthBody =
        healthState.status === "ok" && isRecord(healthState.body)
          ? healthState.body
          : null;

      // /health is the gate: nothing about the running build can be confirmed
      // when it did not answer with a JSON object.
      if (healthState.status !== "ok" || healthBody === null) {
        return {
          ...INITIAL,
          phase: "down",
          checkedAt,
          httpStatus: healthState.httpStatus,
          error:
            healthState.error ??
            (healthState.httpStatus === null
              ? "health probe failed"
              : `HTTP ${healthState.httpStatus}`),
          healthUrl: healthState.url,
          healthLatencyMs: healthState.latencyMs,
          source: healthState.transport,
          sources,
        };
      }

      const uptimeSeconds = readNumber(healthBody.uptimeSeconds);
      const runtime = readText(healthBody.runtime);
      const nodeEnv = readText(healthBody.nodeEnv);
      const hasIngress = Object.hasOwn(healthBody, "ingress");
      const statusBody =
        statusState.status === "ok" && isRecord(statusState.body)
          ? statusState.body
          : null;

      /** @type {string[]} */
      const missing = [];
      let phase;
      let statusError = null;
      if (statusState.status === "error") {
        // The service answered /health but /api/status could not be read, so
        // the running build cannot be confirmed — unknown, never "current".
        phase = "unknown";
        statusError = statusState.error;
      } else if (statusState.status === "missing") {
        phase = "stale";
        missing.push("status");
      } else {
        phase = "current";
      }
      if (!hasIngress) missing.push("ingress");
      if (missing.length > 0) phase = "stale";

      const degradedReasons = readDegradedReasons(healthBody.degradedReasons);
      const operationalStatus = readText(healthBody.operationalStatus);
      const dataStatus = readText(healthBody.dataStatus);
      const healthStatus = readText(healthBody.status);
      if (
        phase === "current" &&
        (operationalStatus === "degraded" ||
          healthStatus === "degraded" ||
          healthStatus === "down")
      ) {
        phase = "degraded";
      }

      const healthData =
        statusBody !== null && isRecord(statusBody.health)
          ? statusBody.health
          : null;
      const memory =
        healthData !== null && isRecord(healthData.memory)
          ? healthData.memory
          : null;
      const telegram =
        statusBody !== null && isRecord(statusBody.telegram)
          ? statusBody.telegram
          : null;
      const telegramStatus =
        telegram !== null && isRecord(telegram.status) ? telegram.status : null;
      const statusHttp =
        statusState.httpStatus === null ? null : statusState.httpStatus;
      const liveReadsLine = readLiveReadsSummary(statusBody);

      return {
        ...INITIAL,
        phase,
        uptimeSeconds,
        httpStatus: statusHttp,
        checkedAt,
        error: statusError,
        source: healthState.transport,
        healthLatencyMs: healthState.latencyMs,
        statusLatencyMs: statusState.latencyMs,
        healthUrl: healthState.url,
        statusUrl: statusState.url,
        runtime: runtime ?? readText(healthData && healthData.runtime),
        pid: readNumber(healthData && healthData.pid),
        memoryRss: readNumber(memory && memory.rss),
        nodeEnv,
        telegramMode: readText(telegramStatus && telegramStatus.mode),
        telegramReason: readText(telegramStatus && telegramStatus.modeReason),
        checks: readChecks(statusBody && statusBody.checks),
        schedules: readSchedules(telegram && telegram.schedules),
        deskHostname: readText(healthBody.hostname),
        liveReadsLine,
        missing,
        degradedReasons,
        dataStatus,
        sources,
      };
    }

    /**
     * @param {unknown} value
     * @returns {{ message: string, kind: string, action: string | null, severity: "warn" | "error" }[]}
     */
    function readDegradedReasons(value) {
      if (!Array.isArray(value)) return [];
      const out = [];
      for (const entry of value) {
        if (typeof entry === "string") {
          out.push({
            message: entry,
            kind: "data",
            action: null,
            severity: "warn",
          });
          continue;
        }
        if (!isRecord(entry)) continue;
        const message = readText(entry.message);
        if (message === null) continue;
        const kind = readText(entry.kind) ?? "data";
        out.push({
          message,
          kind,
          action: readText(entry.action),
          severity: readText(entry.severity) === "error" ? "error" : "warn",
        });
      }
      return out;
    }

    /**
     * One secret-free line from `/api/status.live` (ticker/pending reachability).
     * @param {unknown} statusBody
     * @returns {string | null}
     */
    function readLiveReadsSummary(statusBody) {
      if (!isRecord(statusBody) || !isRecord(statusBody.live)) return null;
      const live = statusBody.live;
      const ticker = isRecord(live.ticker) ? live.ticker : null;
      const pending = isRecord(live.pending) ? live.pending : null;
      const parts = [];
      if (ticker !== null && typeof ticker.status === "string") {
        parts.push(`ticker ${ticker.status}`);
      }
      if (pending !== null && typeof pending.status === "string") {
        parts.push(`pending ${pending.status}`);
      }
      if (parts.length === 0) return null;
      return parts.join(" · ");
    }

    /* --- shared live store ----------------------------------------------- */

    /** Last measured snapshot; replaced only when a probe publishes. */
    let snapshot = INITIAL;
    const listeners = new Set();
    let disposed = false;
    let polling = false;
    let pollTimer = null;
    let inFlight = null;
    let visibilityListening = false;

    /** @param {typeof INITIAL} next */
    function publish(next) {
      // A down probe measured the failure, not the service; keep the strip to
      // successful /health answers (stale/current/unknown all read /health).
      if (next.phase !== "down" && typeof next.healthLatencyMs === "number") {
        healthLatencyHistory = [
          ...healthLatencyHistory,
          next.healthLatencyMs,
        ].slice(-LATENCY_HISTORY_MAX);
      }
      snapshot = next;
      // A polling-fallback live card follows the 15 s probe until a stream is
      // available; stream frames never pass through this path.
      syncLiveFromPoll(next);
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return snapshot;
    }

    /** Subscribe a component to the one measured snapshot. */
    function useStatus() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    function isHidden() {
      return (
        typeof document !== "undefined" && document.visibilityState === "hidden"
      );
    }

    /**
     * Probe once. A superseded probe is aborted and never publishes; a probe
     * that finishes after disposal never publishes either. `showChecking`
     * resets the visible state only for a manual Refresh (poll ticks keep the
     * last measurement on screen instead of flashing "checking…"); the last good
     * per-source payloads survive the reset so a failed Refresh cannot blank a
     * card that previously measured.
     * @param {boolean} showChecking
     */
    async function runProbe(showChecking) {
      if (disposed) return;
      const previous = inFlight;
      if (previous !== null) previous.abort();
      const controller = new AbortController();
      inFlight = controller;
      const previousSnapshot = snapshot;
      if (showChecking) publish({ ...INITIAL });
      let next;
      try {
        next = await measure(controller.signal, previousSnapshot);
      } catch (error) {
        next = {
          ...INITIAL,
          phase: "down",
          checkedAt: Date.now(),
          error: String((error && error.message) || error),
          sources: emptySources(),
        };
      }
      if (disposed || inFlight !== controller) return;
      inFlight = null;
      publish(next);
    }

    /**
     * Start the single poll loop. Called from a component effect; idempotent
     * while running. Disposal is owned by `apply`'s effect.
     */
    function startPolling() {
      if (polling || disposed) return;
      polling = true;
      if (
        !visibilityListening &&
        typeof document !== "undefined" &&
        typeof document.addEventListener === "function"
      ) {
        document.addEventListener("visibilitychange", onVisibilityChange);
        visibilityListening = true;
      }
      void runProbe(false).finally(scheduleNext);
    }

    function scheduleNext() {
      if (!polling || disposed) return;
      // A visibility catch-up can start a second probe while the superseded one
      // is still settling; both `.finally` paths land here, so keep exactly one
      // pending tick instead of allowing a duplicate poll timer.
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => {
        pollTimer = null;
        if (!polling || disposed) return;
        if (isHidden()) {
          scheduleNext();
          return;
        }
        void runProbe(false).finally(scheduleNext);
      }, POLL_MS);
    }

    /** A hidden tab stops probing and streaming; becoming visible resumes both. */
    function onVisibilityChange() {
      if (disposed) return;
      if (isHidden()) {
        stopLive("paused");
        if (!polling) return;
        if (pollTimer !== null) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
        return;
      }
      startLive();
      if (!polling) return;
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      void runProbe(false).finally(scheduleNext);
    }

    /* --- live stream store: the desk's own SSE frames -------------------- */

    /** Last published live snapshot; separate from the polled snapshot. */
    let liveState = LIVE_INITIAL;
    const liveListeners = new Set();
    /** The AbortController of the open (or opening) stream, else null. */
    let liveController = null;
    let liveRetryTimer = null;
    /** Bumped whenever the current connection must stop publishing. */
    let liveGeneration = 0;

    /** @param {typeof LIVE_INITIAL} next */
    function publishLive(next) {
      liveState = next;
      for (const listener of liveListeners) listener();
    }

    function subscribeLive(listener) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    }

    function getLive() {
      return liveState;
    }

    /** Subscribe a component to the live-stream snapshot. */
    function useLive() {
      return React.useSyncExternalStore(subscribeLive, getLive, getLive);
    }

    /**
     * The live card's fallback when the stream route is absent: the 15 s graph
     * probe becomes the card's source, labelled as a poll rather than a frame.
     * Runs only when the poll store publishes a new measured snapshot.
     * @param {typeof INITIAL} next
     */
    function syncLiveFromPoll(next) {
      // The stream's 404 can settle before the first graph probe; a later poll
      // upgrades `unavailable` to `polling` once it has data to show.
      if (liveState.state !== "polling" && liveState.state !== "unavailable") {
        return;
      }
      const source =
        next.sources && next.sources.graph ? next.sources.graph : null;
      const values = readLiveValues(source ? source.body : null);
      if (values === null) return;
      // Label the poll when the payload was received, not when it was folded
      // in: a carried-forward last-good payload must keep its own age.
      const at =
        typeof source.receivedAt === "number" ? source.receivedAt : Date.now();
      const changes = diffLiveValues(liveState.values, values, at);
      publishLive({
        ...liveState,
        state: "polling",
        values,
        polledAt: at,
        changes:
          changes.length === 0
            ? liveState.changes
            : [...changes, ...liveState.changes].slice(0, LIVE_CHANGES_MAX),
      });
    }

    /**
     * Record that this build has no stream route. When a polled graph
     * measurement exists — or an earlier one is still on screen — the card
     * keeps measuring those counters as `polling`; otherwise it is
     * `unavailable`, because there is nothing honest to render.
     * @param {{ url: string, transport: string, httpStatus: number | null, error: string }} absent
     */
    function publishStreamAbsent(absent) {
      const graphSource =
        snapshot.sources && snapshot.sources.graph
          ? snapshot.sources.graph
          : null;
      const polled = readLiveValues(graphSource ? graphSource.body : null);
      const values = polled ?? liveState.values;
      const polledAt =
        values === null
          ? liveState.polledAt
          : typeof graphSource?.receivedAt === "number"
            ? graphSource.receivedAt
            : Date.now();
      publishLive({
        ...liveState,
        state: values === null ? "unavailable" : "polling",
        url: absent.url,
        transport: absent.transport,
        httpStatus: absent.httpStatus,
        error: absent.error,
        attempts: 0,
        values,
        polledAt,
      });
    }

    /**
     * Parse one SSE block. `event: summary` carries the same body as
     * `/api/graph/summary`; `: heartbeat <epochMs>` comments prove the
     * connection is alive between frames. Anything else is ignored — the card
     * never renders a payload it did not recognise.
     * @param {string} block
     * @param {number} bytes - total bytes received on this connection.
     */
    function liveHandleFrame(block, bytes) {
      let event = "message";
      const data = [];
      let heartbeat = false;
      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line === "") continue;
        if (line.startsWith(":")) {
          heartbeat = true;
          continue;
        }
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const field = line.slice(0, colon);
        let value = line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (heartbeat) {
        publishLive({
          ...liveState,
          heartbeats: liveState.heartbeats + 1,
          lastHeartbeatAt: Date.now(),
          bytes,
        });
      }
      if (event !== "summary" || data.length === 0) return;
      let body;
      try {
        body = JSON.parse(data.join("\n"));
      } catch {
        // A frame the desk sent but this build cannot parse is counted, not
        // rendered and not guessed at.
        publishLive({
          ...liveState,
          parseErrors: liveState.parseErrors + 1,
        });
        return;
      }
      const values = readLiveValues(body);
      if (values === null) return;
      const at = Date.now();
      const changes = diffLiveValues(liveState.values, values, at);
      publishLive({
        ...liveState,
        frames: liveState.frames + 1,
        bytes,
        lastFrameAt: at,
        values,
        changes:
          changes.length === 0
            ? liveState.changes
            : [...changes, ...liveState.changes].slice(0, LIVE_CHANGES_MAX),
      });
    }

    /**
     * Read the SSE body until it ends or is aborted, splitting on blank lines.
     * Returns true when the desk ended the stream cleanly (retry), false when
     * this side aborted it (pause, Refresh, disposal — never retry).
     * @param {ReadableStream<Uint8Array>} body
     * @param {AbortController} controller
     * @param {number} generation
     * @returns {Promise<boolean>}
     */
    async function readLiveStream(body, controller, generation) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let bytes = 0;
      let ended = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            ended = true;
            break;
          }
          if (generation !== liveGeneration || disposed) break;
          if (value === undefined) continue;
          bytes += value.byteLength ?? 0;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n/g, "\n");
          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            liveHandleFrame(block, bytes);
            boundary = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted reads are the normal stop path; an unexpected read error is
        // reported by the retry state below instead of being swallowed.
        ended = controller.signal.aborted !== true;
      } finally {
        try {
          await reader.cancel();
        } catch {
          // Already closed by the desk.
        }
      }
      return ended;
    }

    /** The proxy's JSON error token, when it answered with one. */
    async function streamErrorDetail(response) {
      try {
        const body = await response.json();
        if (isRecord(body) && typeof body.error === "string") return body.error;
      } catch {
        // Non-JSON bodies are described by their status instead.
      }
      return null;
    }

    /**
     * Open the stream once. Proxy first, then loopback (an unmarked 404 means
     * this Harness has not registered the streaming route). A marked 404 means
     * the desk's running build has no `/api/graph/stream`, which the card
     * renders as `unavailable` instead of retrying a route that cannot appear.
     */
    async function openLiveStream() {
      if (disposed || liveController !== null) return;
      const generation = ++liveGeneration;
      publishLive({ ...liveState, state: "connecting", error: null });
      let failure = null;
      /** True when the Harness proxy answered for a route it does not have. */
      let routeAbsent = false;
      for (let index = 0; index < STREAM_URLS.length; index += 1) {
        const url = STREAM_URLS[index];
        const transport = index === 0 ? "proxy" : "direct";
        const controller = new AbortController();
        liveController = controller;
        try {
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { accept: "text/event-stream" },
          });
          if (generation !== liveGeneration || disposed) {
            controller.abort();
            return;
          }
          const proxied =
            typeof response.headers?.get === "function" &&
            response.headers.get("x-sportsdesk-desk-proxy") !== null;
          const contentType =
            typeof response.headers?.get === "function"
              ? response.headers.get("content-type")
              : null;
          const eventStream =
            typeof contentType === "string" &&
            contentType.toLowerCase().startsWith("text/event-stream");
          if (response.status === 200 && !eventStream) {
            controller.abort();
            liveController = null;
            if (transport === "proxy" && !proxied) {
              // The Harness answered for an unknown path (its generic 404, or
              // the SPA fallback / a plain 200). Either way this build has no
              // stream route: fall back to loopback before deciding.
              routeAbsent = true;
              continue;
            }
            if (generation !== liveGeneration || disposed) return;
            publishStreamAbsent({
              url,
              transport,
              httpStatus: response.status,
              error: `not an event stream (${contentType ?? "no content-type"})`,
            });
            return;
          }
          if (response.status === 404 && transport === "proxy" && !proxied) {
            // The generic Harness 404: this Host half predates the stream
            // route. The loopback fallback can only work on the desk host.
            controller.abort();
            liveController = null;
            routeAbsent = true;
            continue;
          }
          if (response.status !== 200) {
            const detail = await streamErrorDetail(response);
            liveController = null;
            if (generation !== liveGeneration || disposed) return;
            if (response.status === 404) {
              publishStreamAbsent({
                url,
                transport,
                httpStatus: response.status,
                error: detail ?? "HTTP 404",
              });
              return;
            }
            failure = {
              url,
              transport,
              error: detail === null ? `HTTP ${response.status}` : detail,
            };
            break;
          }
          if (
            response.body === null ||
            typeof response.body.getReader !== "function"
          ) {
            liveController = null;
            publishLive({
              ...liveState,
              state: "error",
              url,
              transport,
              httpStatus: response.status,
              error: "stream body missing",
              attempts: 0,
            });
            return;
          }
          publishLive({
            ...liveState,
            state: "streaming",
            url,
            transport,
            httpStatus: 200,
            error: null,
            attempts: 0,
            connectedAt: Date.now(),
          });
          const ended = await readLiveStream(
            response.body,
            controller,
            generation,
          );
          liveController = null;
          if (generation !== liveGeneration || disposed) return;
          if (ended) scheduleLiveRetry(null);
          return;
        } catch (error) {
          liveController = null;
          if (generation !== liveGeneration || disposed) return;
          if (controller.signal.aborted) return;
          failure = {
            url,
            transport,
            error: String((error && error.message) || error),
            // No HTTP answer at all: a CORS refusal and a refused socket are
            // both a transport failure, which decides "unavailable" below.
            transportError: true,
          };
          continue;
        }
      }
      liveController = null;
      if (generation !== liveGeneration || disposed) return;
      if (routeAbsent && failure !== null && failure.transportError === true) {
        // The proxy has no stream route and the loopback did not answer, so
        // retrying cannot succeed without the Host half being reloaded. Name
        // that state — with the polled counters when there are any — instead
        // of reconnecting forever.
        publishStreamAbsent({
          url: failure.url,
          transport: failure.transport,
          httpStatus: null,
          error: failure.error,
        });
        return;
      }
      scheduleLiveRetry(failure);
    }

    /**
     * Schedule the next connection attempt with a bounded backoff. The state
     * keeps the last measured failure reason, so the card says why it is
     * reconnecting instead of showing a bare spinner.
     * @param {{ url: string, transport: string, error: string } | null} failure
     */
    function scheduleLiveRetry(failure) {
      if (disposed || liveRetryTimer !== null) return;
      const attempts = liveState.attempts + 1;
      const delay =
        LIVE_RETRY_MS[Math.min(attempts - 1, LIVE_RETRY_MS.length - 1)];
      publishLive({
        ...liveState,
        state: "reconnecting",
        attempts,
        error: failure === null ? liveState.error : failure.error,
        url: failure === null ? liveState.url : failure.url,
        transport: failure === null ? liveState.transport : failure.transport,
        httpStatus: failure === null ? liveState.httpStatus : null,
      });
      liveRetryTimer = setTimeout(() => {
        liveRetryTimer = null;
        if (disposed) return;
        if (isHidden()) {
          publishLive({ ...liveState, state: "paused" });
          return;
        }
        void openLiveStream();
      }, delay);
    }

    /**
     * Start the live stream. Idempotent while a connection is open or opening,
     * and a no-op while the tab is hidden (the visibility listener resumes it).
     */
    function startLive() {
      if (disposed || liveController !== null) return;
      if (liveRetryTimer !== null) {
        clearTimeout(liveRetryTimer);
        liveRetryTimer = null;
      }
      if (isHidden()) {
        if (liveState.state !== "paused") {
          publishLive({ ...liveState, state: "paused" });
        }
        return;
      }
      void openLiveStream();
    }

    /**
     * Stop the stream and forbid any later publish from it. `nextState` is
     * rendered for a deliberate pause; unmount and disposal pass none.
     * @param {"paused" | undefined} nextState
     */
    function stopLive(nextState) {
      liveGeneration += 1;
      if (liveRetryTimer !== null) {
        clearTimeout(liveRetryTimer);
        liveRetryTimer = null;
      }
      const controller = liveController;
      liveController = null;
      if (controller !== null) controller.abort();
      if (nextState !== undefined && liveState.state !== nextState) {
        publishLive({ ...liveState, state: nextState });
      }
    }

    /** Manual Refresh: measure the polled snapshot and reopen the stream. */
    function reconnectLive() {
      stopLive();
      startLive();
    }

    /* --- formatting ------------------------------------------------------ */

    /**
     * Compact uptime for the status line: 5d, 7h, 42m.
     * @param {number | null} seconds
     * @returns {string | null}
     */
    function formatUptime(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
      const days = Math.floor(seconds / 86_400);
      if (days >= 1) return `${days}d`;
      const hours = Math.floor(seconds / 3_600);
      if (hours >= 1) return `${hours}h`;
      return `${Math.max(1, Math.floor(seconds / 60))}m`;
    }

    /**
     * Detailed uptime for the metadata row: 5d 4h, 7h 12m, 8s.
     * @param {number | null} seconds
     * @returns {string | null}
     */
    function formatDuration(seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
      const days = Math.floor(seconds / 86_400);
      const hours = Math.floor((seconds % 86_400) / 3_600);
      const minutes = Math.floor((seconds % 3_600) / 60);
      if (days >= 1) return hours >= 1 ? `${days}d ${hours}h` : `${days}d`;
      if (hours >= 1)
        return minutes >= 1 ? `${hours}h ${minutes}m` : `${hours}h`;
      if (minutes >= 1) return `${minutes}m`;
      return `${Math.max(0, Math.floor(seconds))}s`;
    }

    /**
     * Byte count for the memory row. RSS values are the ones a desk operator
     * reads, so keep them in MiB unless the process grows into GiB.
     * @param {number | null} bytes
     * @returns {string | null}
     */
    function formatBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
        return null;
      }
      const mib = bytes / (1024 * 1024);
      if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
      return `${mib >= 100 ? Math.round(mib) : mib.toFixed(1)} MiB`;
    }

    /**
     * Byte count for the live-stream row. Stream bodies are small (a summary
     * frame is ~13 KB), so keep them in B/KiB until MiB.
     * @param {number | null} bytes
     * @returns {string | null}
     */
    function formatLiveBytes(bytes) {
      if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
        return null;
      }
      if (bytes < 1024) return `${Math.round(bytes)} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    }

    /**
     * A count with thousands separators ("2,276"), or null when unmeasured.
     * @param {number | null} value
     * @returns {string | null}
     */
    function formatCount(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return Math.round(value).toLocaleString("en-US");
    }

    /**
     * Cents to a dollar string ("$224,065.00", "-$1,181,208.94"). The payload
     * stores money in cents; rendering the raw number would be a 100x error.
     * @param {number | null} cents
     * @returns {string | null}
     */
    /** Last-N /health latency polyline; null until two samples exist. */
    function latencySparkline(history) {
      if (history.length < 2) return null;
      const width = 160;
      const height = 24;
      const max = Math.max(...history, 1);
      const points = history
        .map((value, index) => {
          const x = (index / (history.length - 1)) * width;
          const y = height - 1 - (value / max) * (height - 2);
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
      return h(
        "svg",
        {
          key: "latency-spark",
          className: "spsd-spark",
          viewBox: `0 0 ${width} ${height}`,
          preserveAspectRatio: "none",
          "aria-hidden": true,
        },
        h("polyline", {
          points,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          vectorEffect: "non-scaling-stroke",
        }),
      );
    }

    /** p50/max over the same samples; null when nothing succeeded yet. */
    function latencySummary(history, t) {
      if (history.length === 0) return null;
      const sorted = [...history].sort((left, right) => left - right);
      const p50 = sorted[Math.floor((sorted.length - 1) / 2)];
      return t("latencySummary", {
        count: history.length,
        p50,
        max: sorted[sorted.length - 1],
      });
    }

    function formatUsdFromCents(cents) {
      if (typeof cents !== "number" || !Number.isFinite(cents)) return null;
      const negative = cents < 0;
      const dollars = Math.abs(cents) / 100;
      const text = dollars.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return `${negative ? "-" : ""}$${text}`;
    }

    /**
     * A USD amount already expressed in dollars ("$5,000", "$64,139").
     * @param {number | null} value
     * @returns {string | null}
     */
    function formatUsd(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      const negative = value < 0;
      const text = Math.abs(value).toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
      return `${negative ? "-" : ""}$${text}`;
    }

    /**
     * An ISO timestamp as a short UTC wall clock: "2026-11-04 11:44:39 UTC".
     * The feed's own "asOf" values are UTC instants; printing them in the
     * viewer's local zone would silently shift the evidence.
     * @param {string | null} iso
     * @returns {string | null}
     */
    function formatIsoUtc(iso) {
      if (typeof iso !== "string" || iso.length === 0) return null;
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms)) return iso;
      const text = new Date(ms).toISOString();
      return `${text.slice(0, 10)} ${text.slice(11, 19)} UTC`;
    }

    /**
     * An age in seconds as a relative label ("just now", "12s ago", "6h ago").
     * @param {(key: string, params?: object) => string} t
     * @param {number | null} seconds
     * @returns {string | null}
     */
    function formatAgeSeconds(t, seconds) {
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        return null;
      }
      const value = Math.max(0, Math.round(seconds));
      if (value <= 2) return t("justNow");
      if (value < 60) return t("agoSeconds", { seconds: value });
      const minutes = Math.floor(value / 60);
      if (minutes < 60) return t("agoMinutes", { minutes });
      return t("agoHours", { hours: Math.floor(minutes / 60) });
    }

    /**
     * Relative age for the live "Checked" cell.
     * @param {(key: string, params?: object) => string} t
     * @param {number | null} checkedAt
     * @param {number} now
     * @returns {string}
     */
    function formatAgo(t, checkedAt, now) {
      if (checkedAt === null) return t("never");
      return (
        formatAgeSeconds(t, Math.max(0, (now - checkedAt) / 1_000)) ??
        t("never")
      );
    }

    /**
     * A wall-clock time from a millisecond timestamp.
     * @param {number | null} ms
     * @returns {string | null}
     */
    function formatClock(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
      return new Date(ms).toLocaleTimeString();
    }

    /**
     * A short git revision: the feed reports an already-short head, but a full
     * SHA must stay readable in a card.
     * @param {string | null} head
     * @returns {string | null}
     */
    function shortHead(head) {
      if (typeof head !== "string" || head.length === 0) return null;
      return head.length > 10 ? head.slice(0, 7) : head;
    }

    /**
     * The feed's effective age: its own `ageSeconds` when measured, otherwise
     * derived from `lastUpdatedIso`. Null when neither is available.
     * @param {{ ageSeconds: number | null, lastUpdatedIso: string | null }} feed
     * @param {number} now
     * @returns {number | null}
     */
    function feedAgeSeconds(feed, now) {
      if (feed.ageSeconds !== null) return feed.ageSeconds;
      if (feed.lastUpdatedIso === null) return null;
      const ms = Date.parse(feed.lastUpdatedIso);
      if (!Number.isFinite(ms)) return null;
      return Math.max(0, (now - ms) / 1_000);
    }

    /**
     * A provenance block's age, preferring its measured `ageSeconds` and falling
     * back to its `asOf` timestamp.
     * @param {(key: string, params?: object) => string} t
     * @param {{ ageSeconds: number | null, asOf: string | null }} provenance
     * @param {number} now
     * @returns {string | null}
     */
    function provenanceAge(t, provenance, now) {
      if (provenance.ageSeconds !== null) {
        return formatAgeSeconds(t, provenance.ageSeconds);
      }
      if (provenance.asOf === null) return null;
      const ms = Date.parse(provenance.asOf);
      if (!Number.isFinite(ms)) return null;
      return formatAgeSeconds(t, Math.max(0, (now - ms) / 1_000));
    }

    /**
     * Readable status text for one measured state.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof INITIAL} state
     * @returns {string}
     */
    function statusText(t, state) {
      switch (state.phase) {
        case "current":
          return t("current");
        case "stale": {
          const uptime = formatUptime(state.uptimeSeconds);
          return uptime === null ? t("staleUnknown") : t("stale", { uptime });
        }
        case "down":
          return t("down");
        case "degraded": {
          const operationalReasons = state.degradedReasons.filter(
            (reason) => reason.kind !== "data",
          );
          return operationalReasons.length === 0
            ? t("degraded")
            : t("degradedHint", {
                reasons: operationalReasons
                  .slice(0, 3)
                  .map((reason) => reason.message)
                  .join("; "),
              });
        }
        case "unknown":
          return t("unknown");
        default:
          return t("checking");
      }
    }

    /**
     * @param {(key: string, params?: object) => string} t
     * @param {"proxy" | "direct" | null} source
     * @returns {string}
     */
    function sourceText(t, source) {
      if (source === "proxy") return t("sourceProxy");
      if (source === "direct") return t("sourceDirect");
      return t("never");
    }

    /** A seconds clock used only by relative age cells. */
    function useNow(intervalMs) {
      const [now, setNow] = React.useState(() => Date.now());
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
      }, [intervalMs]);
      return now;
    }

    /* --- shared rendering ------------------------------------------------ */

    /** One metadata cell in the status/detail card. */
    function metaRow(label, value, key) {
      return h(
        "div",
        { className: "spsd-meta-item", key: key ?? label },
        h("dt", null, label),
        h("dd", null, value),
      );
    }

    /** One label/value cell in an overview card. */
    function kvRow(label, value, key, tone) {
      return h(
        "div",
        { className: "spsd-kv-item", key: key ?? label },
        h("dt", { className: "spsd-kv-label" }, label),
        h(
          "dd",
          {
            className: "spsd-kv-value",
            "data-tone": tone === undefined ? undefined : tone,
          },
          value,
        ),
      );
    }

    /**
     * @param {(object | null)[]} rows
     * @param {string} key
     */
    function kvList(rows, key) {
      if (rows.length === 0) return null;
      return h("dl", { className: "spsd-kv", key }, rows);
    }

    /**
     * A card sub-section (Counts, Repo, Agents, …).
     * @param {string | null} title
     * @param {(object | null)[]} children
     * @param {string} key
     */
    function subSection(title, children, key) {
      return h(
        "div",
        { className: "spsd-block", key },
        title === null ? null : h("h3", { className: "spsd-h3" }, title),
        children,
      );
    }

    /** A small tone-tagged chip ("stale", "not live-ready", …). */
    function chip(text, tone, key) {
      return h(
        "span",
        {
          className: "spsd-chip",
          key: key ?? text,
          "data-tone": tone === undefined ? undefined : tone,
        },
        text,
      );
    }

    /** A one-line note inside a card; the tone only changes the text color. */
    function noteLine(text, tone, key) {
      return h(
        "p",
        {
          className: "spsd-note-line",
          key: key ?? text,
          "data-tone": tone === undefined ? undefined : tone,
        },
        text,
      );
    }

    /**
     * Links to the exact URLs that answered, so the raw documents are one click
     * away when a classification needs evidence.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof INITIAL} state
     */
    function rawLinks(t, state) {
      const links = [];
      if (state.healthUrl !== null) {
        links.push(
          h(
            "a",
            {
              key: "health",
              className: "spsd-link",
              href: state.healthUrl,
              target: "_blank",
              rel: "noreferrer",
            },
            t("rawHealth"),
          ),
        );
      }
      if (state.statusUrl !== null) {
        links.push(
          h(
            "a",
            {
              key: "status",
              className: "spsd-link",
              href: state.statusUrl,
              target: "_blank",
              rel: "noreferrer",
            },
            t("rawStatus"),
          ),
        );
      }
      if (links.length === 0) return null;
      return h("div", { className: "spsd-links" }, links);
    }

    /**
     * The recovery callout: what the running service is missing and the exact
     * command that fixes it. Rendered only for stale/down/unknown states, so a
     * healthy page stays quiet.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof INITIAL} state
     */
    function recoveryCallout(t, state) {
      if (
        state.phase !== "stale" &&
        state.phase !== "down" &&
        state.phase !== "unknown" &&
        state.phase !== "degraded"
      ) {
        return null;
      }
      const content = [];
      if (state.phase === "degraded") {
        content.push(
          h("h2", { key: "heading" }, t("degraded")),
          h("p", { key: "lead" }, statusText(t, state)),
          state.degradedReasons.filter((r) => r.kind !== "data").length === 0
            ? null
            : h(
                "ul",
                { key: "reasons" },
                state.degradedReasons
                  .filter((reason) => reason.kind !== "data")
                  .map((reason) =>
                  h(
                    "li",
                    {
                      key: reason.message,
                      "data-severity": reason.severity,
                    },
                    reason.message,
                    reason.action === null
                      ? null
                      : h(
                          "button",
                          {
                            key: "action",
                            type: "button",
                            className: "spsd-command spsd-reason-action",
                            title: t("degradedActionCopy"),
                            onClick: () => {
                              void (async () => {
                                try {
                                  if (navigator.clipboard?.writeText) {
                                    await navigator.clipboard.writeText(
                                      reason.action,
                                    );
                                  }
                                } catch {
                                  /* clipboard blocked */
                                }
                              })();
                            },
                          },
                          reason.action,
                        ),
                  ),
                ),
              ),
        );
      } else if (state.phase === "stale") {
        content.push(
          h("h2", { key: "heading" }, t("staleFixTitle")),
          h("p", { key: "lead" }, t("staleFixLead")),
          h(
            "ul",
            { key: "missing" },
            state.missing.map((kind) =>
              h(
                "li",
                { key: kind },
                kind === "status" ? t("missingStatus") : t("missingIngress"),
              ),
            ),
          ),
          h(
            "p",
            { key: "fix", className: "spsd-callout-fix" },
            t("restartHint"),
          ),
          h(
            "code",
            { key: "command", className: "spsd-command" },
            RESTART_COMMAND,
          ),
        );
      } else if (state.phase === "down") {
        content.push(
          h("h2", { key: "heading" }, t("down")),
          h("p", { key: "lead" }, t("downHint", { url: SERVICE_URL })),
          state.error === null
            ? null
            : h("p", { key: "error", className: "spsd-error" }, state.error),
          h("p", { key: "fix", className: "spsd-callout-fix" }, t("startHint")),
          h(
            "code",
            { key: "command", className: "spsd-command" },
            RESTART_COMMAND,
          ),
        );
      } else {
        content.push(
          h("h2", { key: "heading" }, t("unknown")),
          h("p", { key: "lead" }, t("probeFailedHint")),
          state.error === null
            ? null
            : h("p", { key: "error", className: "spsd-error" }, state.error),
        );
      }
      const links = rawLinks(t, state);
      if (links !== null) content.push(links);
      return h(
        "section",
        {
          className: "spsd-callout",
          "data-phase": state.phase,
          key: "recovery",
        },
        content,
      );
    }

    /** Chip state for the live card header (the host owns the colors). */
    function liveChipState(state) {
      if (state === "streaming") return "ok";
      if (state === "unavailable" || state === "error") return "error";
      if (
        state === "reconnecting" ||
        state === "paused" ||
        state === "polling"
      ) {
        return "stale";
      }
      return "checking";
    }

    /**
     * @param {(key: string, params?: object) => string} t
     * @param {string} state
     */
    function liveStateText(t, state) {
      if (state === "connecting") return t("liveStateConnecting");
      if (state === "streaming") return t("liveStateStreaming");
      if (state === "reconnecting") return t("liveStateReconnecting");
      if (state === "paused") return t("liveStatePaused");
      if (state === "polling") return t("liveStatePolling");
      if (state === "unavailable") return t("liveStateUnavailable");
      if (state === "error") return t("liveStateError");
      return t("liveStateIdle");
    }

    /** The delay the next retry will use, in whole seconds. */
    function liveRetrySeconds(attempts) {
      const index = Math.min(Math.max(attempts, 1), LIVE_RETRY_MS.length) - 1;
      return Math.round(LIVE_RETRY_MS[index] / 1_000);
    }

    /** One live counter in the unit its name implies (USD for exposure). */
    function liveCounterText(key, value) {
      return key === "openExposureUsd" ? formatUsd(value) : formatCount(value);
    }

    /**
     * Compact top strip of SSE/poll counters (legacy balance-strip position).
     * Non-interactive: read-only values, not navigation tiles.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof LIVE_INITIAL} live
     * @param {number} now
     */
    function liveCounterStrip(t, live, now) {
      if (live.values === null || live.values.counts === null) return null;
      const counts = live.values.counts;
      const items = [];
      for (const key of LIVE_COUNTER_KEYS) {
        const value = counts[key];
        if (typeof value !== "number") continue;
        items.push(
          h(
            "span",
            {
              className: "spsd-strip-item",
              key,
              title: t(LIVE_COUNTER_LABELS[key] ?? key),
            },
            h("span", { className: "spsd-strip-label" }, t(LIVE_COUNTER_LABELS[key] ?? key)),
            h(
              "span",
              { className: "spsd-strip-value" },
              liveCounterText(key, value),
            ),
          ),
        );
      }
      if (items.length === 0) return null;
      return h(
        "section",
        {
          className: "spsd-strip spsd-live-strip",
          key: "live-strip",
          "aria-label": t("liveCounterStrip"),
        },
        h("span", { className: "spsd-strip-title" }, t("liveCounterStrip")),
        h("div", { className: "spsd-strip-items" }, ...items),
      );
    }

    /**
     * Overview source states in one scannable row (not a tile grid).
     * @param {(key: string, params?: object) => string} t
     * @param {ReadonlyArray<{ readonly id: string, readonly label: string, readonly state: string }>} rows
     */
    function overviewSourceStrip(t, rows) {
      const visible = rows.filter((row) => row.state !== "checking");
      if (visible.length === 0) return null;
      return h(
        "section",
        {
          className: "spsd-strip spsd-source-strip",
          key: "source-strip",
          "aria-label": t("overviewSourceStrip"),
        },
        h("span", { className: "spsd-strip-title" }, t("overviewSourceStrip")),
        h(
          "div",
          { className: "spsd-strip-items" },
          ...visible.map((row) =>
            h(
              "span",
              {
                key: row.id,
                className: "spsd-chip-state",
                "data-state": row.state,
                title: row.label,
              },
              row.label,
            ),
          ),
        ),
      );
    }

    const LEGACY_PORTAL_URL = "https://fantasy402.com/manager.html";

    /**
     * One-line link for operators who still use the Fantasy402 Manager UI.
     * @param {(key: string, params?: object) => string} t
     */
    function legacyPortalRow(t) {
      return h(
        "p",
        { className: "spsd-legacy-portal", key: "legacy-portal" },
        t("legacyPortalLead"),
        " ",
        h(
          "a",
          {
            className: "spsd-link",
            href: LEGACY_PORTAL_URL,
            target: "_blank",
            rel: "noreferrer",
          },
          t("legacyPortalLink"),
        ),
      );
    }

    /**
     * The Live stream card: the desk's own Server-Sent Events connection,
     * rendered from what actually arrived — connection state, HTTP status,
     * frames/heartbeats/bytes, the latest frame's counters, and the counter
     * deltas between frames. A missing route, a refused connection and a quiet
     * (but open) stream are three different, named states; none of them falls
     * back to a placeholder value.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof LIVE_INITIAL} live
     * @param {number} now
     */
    function liveCard(t, live, now) {
      const state = live.state;
      const rows = [
        h(
          "div",
          { className: "spsd-live-head", key: "head" },
          h("span", { className: "spsd-live-dot", "aria-hidden": true }),
          h("h2", { className: "spsd-ovtitle" }, t("liveTitle")),
          h(
            "span",
            {
              className: "spsd-chip-state",
              "data-state": liveChipState(state),
            },
            liveStateText(t, state),
          ),
        ),
      ];

      const meta = [
        metaRow(
          t("liveEndpoint"),
          h("code", { className: "spsd-code" }, live.url ?? STREAM_URLS[0]),
        ),
        metaRow(
          t("http"),
          live.httpStatus === null ? t("never") : String(live.httpStatus),
        ),
        metaRow(
          t("liveFrames"),
          live.frames === 0
            ? "0"
            : t("liveFramesValue", {
                frames: formatCount(live.frames),
                bytes: formatLiveBytes(live.bytes) ?? t("never"),
              }),
        ),
        state === "polling"
          ? metaRow(
              t("liveLastPoll"),
              live.polledAt === null
                ? t("never")
                : `${formatClock(live.polledAt) ?? t("never")} · ${formatAgeSeconds(t, (now - live.polledAt) / 1_000) ?? t("never")}`,
            )
          : metaRow(
              t("liveLastFrame"),
              live.lastFrameAt === null
                ? t("never")
                : `${formatClock(live.lastFrameAt) ?? t("never")} · ${formatAgeSeconds(t, (now - live.lastFrameAt) / 1_000) ?? t("never")}`,
            ),
        metaRow(
          t("liveHeartbeats"),
          live.heartbeats === 0
            ? "0"
            : t("liveHeartbeatsValue", {
                count: formatCount(live.heartbeats),
                age:
                  live.lastHeartbeatAt === null
                    ? t("never")
                    : (formatAgeSeconds(
                        t,
                        (now - live.lastHeartbeatAt) / 1_000,
                      ) ?? t("never")),
              }),
        ),
      ];
      if (live.connectedAt !== null) {
        meta.push(
          metaRow(
            t("liveConnected"),
            t("liveConnectedValue", {
              time: formatClock(live.connectedAt) ?? t("never"),
              age:
                formatAgeSeconds(t, (now - live.connectedAt) / 1_000) ??
                t("never"),
            }),
          ),
        );
      }
      rows.push(h("dl", { className: "spsd-meta", key: "meta" }, meta));

      if (live.values === null) {
        rows.push(noteLine(t("liveNoValues"), undefined, "live-no-values"));
      } else {
        const values = [];
        if (live.values.feedStatus !== null) {
          values.push(
            kvRow(
              t("feedStatus"),
              live.values.feedStatus,
              "live-feed-status",
              live.values.feedStale === true ? "warn" : undefined,
            ),
          );
        }
        if (live.values.feedAgeSeconds !== null) {
          // The frame reports the age at frame time; the desk's feed keeps
          // aging between frames, so add the time elapsed since that frame.
          const reference =
            state === "polling" ? live.polledAt : live.lastFrameAt;
          const elapsed = reference === null ? 0 : (now - reference) / 1_000;
          values.push(
            kvRow(
              t("age"),
              formatAgeSeconds(t, live.values.feedAgeSeconds + elapsed) ??
                t("never"),
              "live-feed-age",
              live.values.feedStale === true ? "warn" : undefined,
            ),
          );
        }
        if (live.values.pollSequence !== null) {
          values.push(
            kvRow(
              t("pollSequence"),
              formatCount(live.values.pollSequence),
              "live-poll-seq",
            ),
          );
        }
        if (values.length > 0) {
          rows.push(
            subSection(
              t("liveCounters"),
              kvList(values, "live-values"),
              "live-values",
            ),
          );
        } else {
          rows.push(noteLine(t("liveNoValues"), undefined, "live-no-values"));
        }
      }

      if (live.frames > 0 || live.changes.length > 0) {
        const changeItems = live.changes.map((change, index) =>
          h(
            "li",
            { key: `live-change-${change.at}-${change.key}-${index}` },
            h(
              "span",
              { className: "spsd-when" },
              formatClock(change.at) ?? t("never"),
            ),
            h(
              "span",
              null,
              t("liveChangeLine", {
                field: t(LIVE_COUNTER_LABELS[change.key] ?? change.key),
                from: liveCounterText(change.key, change.from),
                to: liveCounterText(change.key, change.to),
              }),
            ),
          ),
        );
        rows.push(
          subSection(
            state === "polling" ? t("liveChangesPoll") : t("liveChanges"),
            changeItems.length === 0
              ? noteLine(t("liveNoChanges"), undefined, "live-no-changes")
              : h("ul", { className: "spsd-live-changes" }, changeItems),
            "live-changes",
          ),
        );
      }

      // One state line: what the card is doing about the connection it measured.
      if (state === "polling") {
        rows.push(noteLine(t("livePolling"), "warn", "live-polling"));
      } else if (state === "unavailable") {
        rows.push(noteLine(t("liveUnavailable"), "warn", "live-unavailable"));
      } else if (state === "error") {
        rows.push(
          noteLine(
            t("liveDown", { reason: live.error ?? t("never") }),
            "warn",
            "live-down",
          ),
        );
      } else if (state === "reconnecting") {
        rows.push(
          noteLine(
            `${t("liveDown", { reason: live.error ?? t("never") })} ${t("liveRetry", { seconds: liveRetrySeconds(live.attempts) })}`,
            "warn",
            "live-reconnect",
          ),
        );
      } else if (state === "paused") {
        rows.push(noteLine(t("livePausedNote"), undefined, "live-paused"));
      } else if (state === "streaming" && live.frames === 0) {
        rows.push(noteLine(t("liveNoFrames"), undefined, "live-no-frames"));
      } else if (state === "connecting" || state === "idle") {
        rows.push(noteLine(t("liveNoValues"), undefined, "live-connecting"));
      }

      rows.push(
        h(
          "div",
          { className: "spsd-ovfoot", key: "foot" },
          h(
            "a",
            {
              className: "spsd-link",
              href: live.url ?? STREAM_URLS[0],
              target: "_blank",
              rel: "noreferrer",
            },
            t("liveRaw"),
          ),
          live.transport === null
            ? null
            : h(
                "span",
                { className: "spsd-ovtransport" },
                sourceText(t, live.transport),
              ),
        ),
      );

      return h(
        "section",
        {
          className: "spsd-card spsd-live",
          key: "live",
          "data-live-state": state,
        },
        rows,
      );
    }

    /**
     * The Service card: the /api/status fields, rendered only when the service
     * actually answered them.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof INITIAL} state
     */
    function serviceCard(t, state) {
      const rows = [];
      if (state.deskHostname !== null) {
        rows.push(metaRow(t("operatorDesk"), state.deskHostname));
      }
      if (state.liveReadsLine !== null) {
        rows.push(metaRow(t("liveReads"), state.liveReadsLine));
      }
      if (state.runtime !== null)
        rows.push(metaRow(t("runtime"), state.runtime));
      if (state.pid !== null) rows.push(metaRow(t("pid"), String(state.pid)));
      if (state.memoryRss !== null) {
        rows.push(
          metaRow(t("memory"), formatBytes(state.memoryRss) ?? t("never")),
        );
      }
      if (state.nodeEnv !== null) {
        rows.push(metaRow(t("environment"), state.nodeEnv));
      }
      if (state.telegramMode !== null) {
        rows.push(
          metaRow(
            t("telegram"),
            h(
              "span",
              { title: state.telegramReason ?? undefined },
              state.telegramMode,
            ),
          ),
        );
      }
      if (state.checks !== null) {
        rows.push(
          metaRow(
            t("checks"),
            state.checks
              .map((check) => `${check.name} ${check.value}`)
              .join(" · "),
          ),
        );
      }
      const probeBits = [];
      if (state.healthLatencyMs !== null) {
        probeBits.push(`/health ${state.healthLatencyMs} ms`);
      }
      if (state.statusLatencyMs !== null) {
        probeBits.push(`/api/status ${state.statusLatencyMs} ms`);
      }
      if (probeBits.length === 1) {
        rows.push(metaRow(t("probes"), probeBits[0]));
      } else if (probeBits.length > 1) {
        // Two latency lines read better than one wrapped cell at narrow widths.
        rows.push(
          metaRow(
            t("probes"),
            h(
              "span",
              null,
              probeBits.map((bit) =>
                h("span", { key: bit, style: { display: "block" } }, bit),
              ),
            ),
          ),
        );
      }
      if (rows.length === 0) return null;

      const blocks = [
        h("h2", { key: "heading", className: "spsd-h2" }, t("service")),
        h("dl", { key: "meta", className: "spsd-meta spsd-meta-flat" }, rows),
      ];
      if (state.schedules !== null) {
        blocks.push(
          h(
            "div",
            { key: "schedules", className: "spsd-list" },
            h(
              "h3",
              null,
              t("reports"),
              " ",
              h(
                "span",
                { className: "spsd-list-count" },
                t("enabledCount", {
                  enabled: state.schedules.enabled,
                  total: state.schedules.total,
                }),
              ),
            ),
            h(
              "ul",
              null,
              state.schedules.rows.map((row) =>
                h(
                  "li",
                  { key: row.id },
                  h("span", { className: "spsd-list-name" }, row.name),
                  h(
                    "span",
                    { className: "spsd-when" },
                    row.enabled ? row.when : `${row.when} · ${t("off")}`,
                  ),
                ),
              ),
            ),
          ),
        );
      }
      return h(
        "section",
        { className: "spsd-card spsd-section", key: "service" },
        blocks,
      );
    }

    /* --- overview: per-source state and cards ---------------------------- */

    /** @param {object | null} source */
    function isSourceOk(source) {
      return source !== null && source.status === "ok";
    }

    /**
     * A card state derived from the measured source only: the transport state
     * first, then the payload's own staleness flags.
     * @param {object | null} source
     * @param {boolean} stale
     * @returns {"checking" | "ok" | "stale" | "error" | "missing"}
     */
    function cardState(source, stale) {
      if (source === null) return "checking";
      if (source.status === "error") return "error";
      if (source.status === "missing") return "missing";
      return stale ? "stale" : "ok";
    }

    /**
     * @param {(key: string, params?: object) => string} t
     * @param {"checking" | "ok" | "stale" | "error" | "missing"} state
     */
    function cardStateText(t, state) {
      switch (state) {
        case "ok":
          return t("stateLive");
        case "stale":
          return t("stateStale");
        case "error":
          return t("stateError");
        case "missing":
          return t("stateMissing");
        default:
          return t("stateChecking");
      }
    }

    /**
     * The market feed's own freshness: its stale flag, a not-"measured" status,
     * or WSS not ingested. Only measured flags count — absent fields are not
     * invented into staleness.
     * @param {ReturnType<typeof readGraphPayload>} payload
     */
    function isGraphStale(payload) {
      if (payload === null || payload.feed === null) return false;
      const feed = payload.feed;
      if (feed.stale === true) return true;
      if (feed.status !== null && feed.status !== "measured") return true;
      if (feed.wssIngestion !== null && feed.wssIngestion !== "ingested") {
        return true;
      }
      return false;
    }

    /**
     * Any KPI block's provenance stale flag makes the book card stale.
     * @param {ReturnType<typeof readKpisPayload>} payload
     */
    function isKpisStale(payload) {
      if (payload === null) return false;
      const blocks = [
        payload.agents,
        payload.pending,
        payload.ticker,
        payload.customerBook,
      ];
      if (
        blocks.some(
          (block) =>
            block !== null &&
            block.provenance !== null &&
            block.provenance.stale === true,
        )
      ) {
        return true;
      }
      if (payload.r2Sinks === null) return false;
      return payload.r2Sinks.some((sink) => sink.stale === true);
    }

    /**
     * @param {(key: string, params?: object) => string} t
     * @param {NonNullable<ReturnType<typeof readR2PipelineSinks>>[number]} sink
     * @param {number} now
     */
    function formatR2SinkValue(t, sink, now) {
      const age =
        sink.ageSeconds !== null
          ? formatAgeSeconds(t, sink.ageSeconds)
          : t("never");
      const state =
        sink.state ??
        (sink.stale ? t("r2SinkStale") : t("r2SinkFresh"));
      const parts = [t("r2SinkState", { state, age })];
      if (sink.dataAgeSeconds !== null) {
        parts.push(
          t("r2SinkDataAge", {
            age: formatAgeSeconds(t, sink.dataAgeSeconds),
          }),
        );
      }
      const children = [h("span", { key: "r2-text" }, parts.join(" · "))];
      if (sink.dataStale === true) {
        children.push(
          chip(t("r2SinkStaleData"), "warn", `r2-data-stale-${sink.id}`),
        );
      }
      return h("span", { className: "spsd-kv-inline" }, children);
    }

    /**
     * @param {ReturnType<typeof readExecutionPayload>} payload
     */
    function isExecutionStale(payload) {
      return (
        payload !== null &&
        payload.provenance !== null &&
        payload.provenance.stale === true
      );
    }

    /**
     * The measured-at line for one card: the received payload's wall clock and
     * age when the card shows data, the last probe attempt when it does not.
     * @param {(key: string, params?: object) => string} t
     * @param {object | null} source
     * @param {number} now
     * @param {"checking" | "ok" | "stale" | "error" | "missing"} state
     * @returns {string | null}
     */
    function cardMetaText(t, source, now, state) {
      if (source === null) return null;
      const received =
        (state === "ok" || state === "stale") && source.receivedAt !== null
          ? source.receivedAt
          : null;
      if (received !== null) {
        const time = formatClock(received) ?? t("never");
        const age = formatAgeSeconds(t, (now - received) / 1_000) ?? t("never");
        return t("measuredAt", { time, age });
      }
      const attempted =
        typeof source.checkedAt === "number" ? source.checkedAt : null;
      if (attempted === null) return null;
      const time = formatClock(attempted) ?? t("never");
      const age = formatAgeSeconds(t, (now - attempted) / 1_000) ?? t("never");
      return t("attemptedAt", { time, age });
    }

    /**
     * One overview card shell: title, state chip, measured-at line, the card
     * body, and — on error/missing — the reason plus a whole-snapshot Retry.
     * When a previous payload exists it stays visible under the failure, marked
     * with the time it was received.
     * @param {object} spec
     */
    function overviewCard(spec) {
      const { t, source, title, state, bodyBlocks, now, hasData, retry, key } =
        spec;
      const rows = [
        h(
          "div",
          { className: "spsd-ovhead", key: "head" },
          h("h2", { className: "spsd-ovtitle" }, title),
          h(
            "span",
            {
              className: "spsd-chip-state",
              "data-state": state,
            },
            cardStateText(t, state),
          ),
        ),
      ];
      const meta = cardMetaText(t, source, now, state);
      if (meta !== null) {
        rows.push(h("p", { className: "spsd-ovmeta", key: "meta" }, meta));
      }
      if (state === "error" || state === "missing") {
        rows.push(
          h(
            "p",
            { className: "spsd-source-error", key: "reason" },
            source.error ??
              (source.httpStatus === null
                ? t("never")
                : `HTTP ${source.httpStatus}`),
          ),
        );
        if (hasData) {
          const received = formatClock(source.receivedAt) ?? t("never");
          rows.push(
            h(
              "p",
              { className: "spsd-lastgood", key: "last-good" },
              t("lastGood", { time: received }),
            ),
          );
        }
        rows.push(...bodyBlocks);
        rows.push(
          h(
            "button",
            {
              key: "retry",
              type: "button",
              className: "spsd-btn spsd-retry",
              onClick: retry,
            },
            t("retry"),
          ),
        );
      } else {
        rows.push(...bodyBlocks);
      }
      if (source !== null && source.url !== null) {
        rows.push(
          h(
            "div",
            { className: "spsd-ovfoot", key: "foot" },
            h(
              "a",
              {
                className: "spsd-link",
                href: source.url,
                target: "_blank",
                rel: "noreferrer",
              },
              t("rawJson"),
            ),
            source.transport === null
              ? null
              : h(
                  "span",
                  { className: "spsd-ovtransport" },
                  sourceText(t, source.transport),
                ),
          ),
        );
      }
      return h(
        "section",
        {
          className: "spsd-card spsd-overview",
          key,
          "data-source": spec.sourceId,
          "data-state": state,
        },
        rows,
      );
    }

    /**
     * The Market feed card body: feed freshness, counts, and the repo/evidence
     * block. A payload without `feed` says so instead of rendering zeros.
     * @param {(key: string, params?: object) => string} t
     * @param {ReturnType<typeof readGraphPayload>} payload
     * @param {number} now
     */
    function graphCardBody(t, payload, now) {
      const blocks = [];
      if (payload === null) return blocks;
      const feed = payload.feed;
      if (feed === null) {
        blocks.push(noteLine(t("feedMissing"), "warn", "feed-missing"));
      } else {
        const rows = [];
        if (feed.status !== null) {
          rows.push(
            kvRow(
              t("feedStatus"),
              feed.status,
              "feed-status",
              feed.status === "measured" ? undefined : "warn",
            ),
          );
        }
        if (feed.dataMode !== null) {
          rows.push(
            kvRow(
              t("dataMode"),
              feed.dataMode,
              "data-mode",
              feed.dataMode === "FULL" ? undefined : "warn",
            ),
          );
        }
        if (feed.wssIngestion !== null) {
          rows.push(
            kvRow(
              t("wssIngestion"),
              feed.wssIngestion,
              "wss",
              feed.wssIngestion === "ingested" ? undefined : "warn",
            ),
          );
        }
        if (feed.pollSequence !== null) {
          rows.push(
            kvRow(
              t("pollSequence"),
              formatCount(feed.pollSequence) ?? t("never"),
              "poll-sequence",
            ),
          );
        }
        const updated =
          feed.lastUpdatedIso === null
            ? null
            : formatIsoUtc(feed.lastUpdatedIso);
        if (updated !== null) {
          rows.push(kvRow(t("updated"), updated, "updated"));
        }
        const age = feedAgeSeconds(feed, now);
        if (age !== null) {
          rows.push(
            kvRow(
              t("age"),
              h(
                "span",
                null,
                formatAgeSeconds(t, age) ?? t("never"),
                feed.stale === true
                  ? h(
                      "span",
                      {
                        className: "spsd-chip",
                        "data-tone": "warn",
                        style: { marginLeft: 6 },
                      },
                      t("stateStale"),
                    )
                  : null,
              ),
              "age",
            ),
          );
        }
        if (rows.length > 0) blocks.push(kvList(rows, "feed"));
        if (feed.counts !== null) {
          const counts = feed.counts;
          const countRows = [];
          if (counts.activeWallets !== null) {
            countRows.push(
              kvRow(
                t("activeWallets"),
                formatCount(counts.activeWallets) ?? t("never"),
                "active-wallets",
              ),
            );
          }
          if (counts.openLegs !== null) {
            countRows.push(
              kvRow(
                t("openLegs"),
                formatCount(counts.openLegs) ?? t("never"),
                "open-legs",
              ),
            );
          }
          if (counts.openExposureUsd !== null) {
            countRows.push(
              kvRow(
                t("openExposure"),
                formatUsd(counts.openExposureUsd) ?? t("never"),
                "open-exposure",
              ),
            );
          }
          if (counts.pendingBets !== null) {
            countRows.push(
              kvRow(
                t("pendingBets"),
                formatCount(counts.pendingBets) ?? t("never"),
                "pending-bets",
              ),
            );
          }
          if (counts.ipClusters !== null) {
            countRows.push(
              kvRow(
                t("ipClusters"),
                formatCount(counts.ipClusters) ?? t("never"),
                "ip-clusters",
              ),
            );
          }
          if (countRows.length > 0) {
            blocks.push(
              subSection(t("counts"), [kvList(countRows, "counts")], "counts"),
            );
          }
        }
      }
      if (payload.repo !== null) {
        const repo = payload.repo;
        const rows = [];
        if (repo.branch !== null) {
          rows.push(kvRow(t("branch"), repo.branch, "branch"));
        }
        const head = shortHead(repo.head);
        if (head !== null) rows.push(kvRow(t("head"), head, "head"));
        if (repo.routesServed !== null) {
          rows.push(
            kvRow(
              t("routesServed"),
              formatCount(repo.routesServed) ?? t("never"),
              "routes",
            ),
          );
        }
        if (repo.citations !== null) {
          const citations = repo.citations;
          const age = formatAgeSeconds(t, citations.ageSeconds);
          const checked =
            citations.checked === null ? null : formatCount(citations.checked);
          const text =
            checked !== null && age !== null
              ? t("citationSummary", { checked, age })
              : (age ?? checked ?? t("never"));
          rows.push(
            kvRow(
              t("citations"),
              h(
                "span",
                null,
                text,
                citations.stale === true
                  ? h(
                      "span",
                      {
                        className: "spsd-chip",
                        "data-tone": "warn",
                        style: { marginLeft: 6 },
                      },
                      t("stateStale"),
                    )
                  : null,
              ),
              "citations",
            ),
          );
        }
        if (repo.tests !== null) {
          const tests = repo.tests;
          const age = formatAgeSeconds(t, tests.ageSeconds);
          const count = tests.tests === null ? null : formatCount(tests.tests);
          const text =
            count !== null && age !== null
              ? t("testsSummary", { tests: count, age })
              : (age ?? count ?? t("never"));
          rows.push(kvRow(t("tests"), text, "tests"));
        }
        if (rows.length > 0) {
          blocks.push(subSection(t("repo"), [kvList(rows, "repo")], "repo"));
        }
      }
      return blocks;
    }

    /**
     * The Book card body: the four KPI blocks, each with its own provenance.
     * @param {(key: string, params?: object) => string} t
     * @param {ReturnType<typeof readKpisPayload>} payload
     * @param {number} now
     */
    function kpisCardBody(t, payload, now) {
      const blocks = [];
      if (payload === null) return blocks;
      if (payload.agents !== null) {
        const block = payload.agents;
        const rows = [];
        if (block.values.total !== null) {
          rows.push(
            kvRow(
              t("total"),
              formatCount(block.values.total) ?? t("never"),
              "total",
            ),
          );
        }
        if (block.values.agents !== null) {
          rows.push(
            kvRow(
              t("agentsField"),
              formatCount(block.values.agents) ?? t("never"),
              "agents",
            ),
          );
        }
        if (block.values.masters !== null) {
          rows.push(
            kvRow(
              t("masters"),
              formatCount(block.values.masters) ?? t("never"),
              "masters",
            ),
          );
        }
        blocks.push(
          subSection(
            t("agentsBlock"),
            [
              kvList(rows, "agents-kv"),
              provenanceLine(t, block.provenance, now, "agents-prov"),
            ],
            "agents-block",
          ),
        );
      }
      if (payload.pending !== null) {
        const block = payload.pending;
        const rows = [];
        if (block.values.wagers !== null) {
          rows.push(
            kvRow(
              t("wagers"),
              formatCount(block.values.wagers) ?? t("never"),
              "wagers",
            ),
          );
        }
        if (block.values.tickets !== null) {
          rows.push(
            kvRow(
              t("tickets"),
              formatCount(block.values.tickets) ?? t("never"),
              "tickets",
            ),
          );
        }
        if (block.values.wageredCents !== null) {
          rows.push(
            kvRow(
              t("wagered"),
              formatUsdFromCents(block.values.wageredCents) ?? t("never"),
              "wagered",
            ),
          );
        }
        if (block.values.toWinCents !== null) {
          rows.push(
            kvRow(
              t("toWin"),
              formatUsdFromCents(block.values.toWinCents) ?? t("never"),
              "to-win",
            ),
          );
        }
        blocks.push(
          subSection(
            t("pendingBlock"),
            [
              kvList(rows, "pending-kv"),
              provenanceLine(t, block.provenance, now, "pending-prov"),
            ],
            "pending-block",
          ),
        );
      }
      if (payload.ticker !== null) {
        const block = payload.ticker;
        const rows = [];
        if (block.values.wagers !== null) {
          rows.push(
            kvRow(
              t("wagers"),
              formatCount(block.values.wagers) ?? t("never"),
              "ticker-wagers",
            ),
          );
        }
        if (block.values.live !== null) {
          rows.push(
            kvRow(
              t("liveField"),
              formatCount(block.values.live) ?? t("never"),
              "ticker-live",
            ),
          );
        }
        if (block.values.riskCents !== null) {
          rows.push(
            kvRow(
              t("risk"),
              formatUsdFromCents(block.values.riskCents) ?? t("never"),
              "ticker-risk",
            ),
          );
        }
        if (block.values.volumeCents !== null) {
          rows.push(
            kvRow(
              t("volume"),
              formatUsdFromCents(block.values.volumeCents) ?? t("never"),
              "ticker-volume",
            ),
          );
        }
        blocks.push(
          subSection(
            t("tickerBlock"),
            [
              kvList(rows, "ticker-kv"),
              provenanceLine(t, block.provenance, now, "ticker-prov"),
            ],
            "ticker-block",
          ),
        );
      }
      if (payload.customerBook !== null) {
        const block = payload.customerBook;
        const rows = [];
        if (block.values.customers !== null) {
          rows.push(
            kvRow(
              t("customers"),
              formatCount(block.values.customers) ?? t("never"),
              "customers",
            ),
          );
        }
        if (block.values.tickets !== null) {
          rows.push(
            kvRow(
              t("tickets"),
              formatCount(block.values.tickets) ?? t("never"),
              "book-tickets",
            ),
          );
        }
        if (block.values.customerNetCents !== null) {
          rows.push(
            kvRow(
              t("customerNet"),
              formatUsdFromCents(block.values.customerNetCents) ?? t("never"),
              "customer-net",
            ),
          );
        }
        blocks.push(
          subSection(
            t("customerBook"),
            [
              kvList(rows, "book-kv"),
              provenanceLine(t, block.provenance, now, "book-prov"),
            ],
            "customer-book-block",
          ),
        );
      }
      if (payload.r2Sinks !== null) {
        const rows = payload.r2Sinks.map((sink) =>
          kvRow(
            t(sink.labelKey),
            formatR2SinkValue(t, sink, now),
            `r2-${sink.id}`,
            sink.stale || sink.dataStale ? "warn" : undefined,
          ),
        );
        blocks.push(
          subSection(
            t("r2PipelinesBlock"),
            [kvList(rows, "r2-pipelines-kv")],
            "r2-pipelines-block",
          ),
        );
      }
      return blocks;
    }

    /**
     * One KPI block's provenance age + stale/partial chips. A block without a
     * provenance renders no line at all (never "unknown age").
     * @param {(key: string, params?: object) => string} t
     * @param {ReturnType<typeof readProvenance>} provenance
     * @param {number} now
     * @param {string} key
     */
    function provenanceLine(t, provenance, now, key) {
      if (provenance === null) return null;
      const age = provenanceAge(t, provenance, now);
      const chips = [];
      if (isFixtureProvenance(provenance)) {
        chips.push(chip(t("notLive"), "warn", "prov-fixture"));
      }
      if (provenance.stale === true) {
        chips.push(chip(t("stateStale"), "warn", "prov-stale"));
      }
      if (provenance.partial === true) {
        chips.push(chip(t("partial"), "warn", "prov-partial"));
      }
      return h(
        "p",
        {
          className: "spsd-provenance",
          key,
          title: provenance.source ?? undefined,
        },
        t("provenance"),
        " ",
        age ?? t("never"),
        chips.length > 0 ? " " : null,
        ...chips,
      );
    }

    /**
     * A risk meter (planned vs cap) drawn only with theme tokens.
     * @param {number} planned
     * @param {number} cap
     */
    function riskMeter(planned, cap) {
      if (cap <= 0) return null;
      const ratio = Math.min(1, Math.max(0, planned / cap));
      return h(
        "span",
        { className: "spsd-meter", "aria-hidden": true },
        h("span", { style: { width: `${Math.round(ratio * 100)}%` } }),
      );
    }

    /**
     * The Paper execution card body: mode/kill switch/live policy, risk vs caps,
     * venues, decisions and the plan's own provenance.
     * @param {(key: string, params?: object) => string} t
     * @param {ReturnType<typeof readExecutionPayload>} payload
     * @param {number} now
     */
    function executionCardBody(t, payload, now) {
      const blocks = [];
      if (payload === null) return blocks;
      const summary = [];
      if (payload.mode !== null) {
        summary.push(
          kvRow(
            t("mode"),
            payload.mode,
            "mode",
            payload.mode === "paper" ? undefined : "error",
          ),
        );
      }
      if (payload.killSwitch !== null) {
        summary.push(
          kvRow(
            t("killSwitch"),
            payload.killSwitch ? t("on") : t("off"),
            "kill-switch",
            payload.killSwitch ? "error" : undefined,
          ),
        );
      }
      if (payload.liveEnabled !== null) {
        summary.push(
          kvRow(
            t("liveExecution"),
            payload.liveEnabled ? t("on") : t("off"),
            "live-enabled",
            payload.liveEnabled ? "error" : undefined,
          ),
        );
      }
      if (summary.length > 0) blocks.push(kvList(summary, "execution-summary"));
      if (payload.risk !== null) {
        const risk = payload.risk;
        const rows = [];
        if (risk.dailyPlannedUsd !== null || risk.dailyCapUsd !== null) {
          const planned =
            risk.dailyPlannedUsd === null
              ? t("never")
              : (formatUsd(risk.dailyPlannedUsd) ?? t("never"));
          const cap =
            risk.dailyCapUsd === null
              ? t("never")
              : (formatUsd(risk.dailyCapUsd) ?? t("never"));
          const meter =
            risk.dailyPlannedUsd !== null && risk.dailyCapUsd !== null
              ? riskMeter(risk.dailyPlannedUsd, risk.dailyCapUsd)
              : null;
          rows.push(
            kvRow(
              t("dailyPlanned"),
              h("span", null, `${planned} / ${cap}`, meter),
              "daily-planned",
            ),
          );
        }
        if (risk.openIntents !== null) {
          const cap =
            payload.maxOpenIntents === null
              ? null
              : formatCount(payload.maxOpenIntents);
          rows.push(
            kvRow(
              t("openIntents"),
              cap === null
                ? (formatCount(risk.openIntents) ?? t("never"))
                : `${formatCount(risk.openIntents) ?? t("never")} / ${cap}`,
              "open-intents",
            ),
          );
        }
        if (risk.marketExposureUsd !== null) {
          const entries = risk.marketExposureUsd;
          const text =
            entries.length === 0
              ? t("none")
              : entries
                  .map(
                    (entry) =>
                      `${entry.market} ${formatUsd(entry.amount) ?? t("never")}`,
                  )
                  .join(", ");
          rows.push(kvRow(t("marketExposure"), text, "market-exposure"));
        }
        if (rows.length > 0) {
          blocks.push(subSection(t("risk"), [kvList(rows, "risk-kv")], "risk"));
        }
      }
      if (payload.venues !== null && payload.venues.length > 0) {
        blocks.push(
          subSection(
            t("venues"),
            [
              h(
                "ul",
                { className: "spsd-venue-list", key: "venues" },
                payload.venues.map((venue) =>
                  h(
                    "li",
                    { key: venue.id, className: "spsd-venue" },
                    h("span", { className: "spsd-venue-name" }, venue.id),
                    chip(
                      venue.liveReady === true
                        ? t("liveReady")
                        : venue.liveReady === false
                          ? t("notLiveReady")
                          : t("never"),
                      venue.liveReady === false ? "warn" : undefined,
                      "live-ready",
                    ),
                    venue.reason === null
                      ? null
                      : h(
                          "span",
                          { className: "spsd-venue-reason" },
                          venue.reason,
                        ),
                  ),
                ),
              ),
            ],
            "venues",
          ),
        );
      }
      if (payload.decisions === null) {
        blocks.push(
          noteLine(t("decisionsUnknown"), "warn", "decisions-unknown"),
        );
      } else {
        const rows = [
          kvRow(
            t("blocked"),
            formatCount(payload.decisions.blocked) ?? "0",
            "blocked",
            payload.decisions.blocked > 0 ? "warn" : undefined,
          ),
          kvRow(
            t("notBlocked"),
            formatCount(payload.decisions.notBlocked) ?? "0",
            "not-blocked",
          ),
        ];
        if (payload.blockedReasons !== null) {
          rows.push(
            kvRow(
              t("blockedReasons"),
              payload.blockedReasons
                .map(
                  (row) =>
                    `${row.reason} ${formatCount(row.count) ?? t("never")}`,
                )
                .join(", "),
              "blocked-reasons",
            ),
          );
        }
        blocks.push(
          subSection(
            t("decisions"),
            [kvList(rows, "decisions-kv")],
            "decisions",
          ),
        );
      }
      if (payload.provenance !== null && payload.provenance.stale === true) {
        const age = provenanceAge(t, payload.provenance, now);
        blocks.push(
          noteLine(
            age === null ? t("planStale") : `${t("planStale")} · ${age}`,
            "warn",
            "plan-stale",
          ),
        );
      }
      return blocks;
    }

    /**
     * The attention banner, derived only from measured states. Each item names
     * its source; absent data is rendered as unknown by the card, never as an
     * alert. The feed produces one combined item (stale / not measured / WSS),
     * and each failed overview source produces one item.
     * @param {(key: string, params?: object) => string} t
     * @param {typeof INITIAL} state
     * @param {ReturnType<typeof readGraphPayload>} graphPayload
     * @param {ReturnType<typeof readExecutionPayload>} executionPayload
     * @param {ReturnType<typeof readKpisPayload>} kpisPayload
     */
    function attentionBanner(t, state, graphPayload, executionPayload, kpisPayload) {
      const items = [];
      if (
        state.phase === "down" ||
        state.phase === "stale" ||
        state.phase === "unknown" ||
        state.phase === "degraded"
      ) {
        items.push({
          key: "service",
          source: t("service"),
          detail: statusText(t, state),
        });
      }
      const graphSource = state.sources.graph;
      if (isSourceOk(graphSource) && graphPayload !== null) {
        const feed = graphPayload.feed;
        if (feed !== null) {
          const reasons = [];
          if (feed.stale === true) {
            const age =
              feed.ageSeconds === null
                ? null
                : formatAgeSeconds(t, feed.ageSeconds);
            reasons.push(
              age === null ? t("stateStale") : t("attentionFeedStale", { age }),
            );
          }
          if (feed.status !== null && feed.status !== "measured") {
            reasons.push(t("attentionFeedStatus", { status: feed.status }));
          }
          if (feed.wssIngestion !== null && feed.wssIngestion !== "ingested") {
            reasons.push(t("attentionWss", { value: feed.wssIngestion }));
          }
          if (reasons.length > 0) {
            items.push({
              key: "feed",
              source: t("marketFeed"),
              detail: reasons.join(t("attentionJoin")),
            });
          }
        }
      }
      const kpisSource = state.sources.kpis;
      if (isSourceOk(kpisSource) && kpisPayload !== null) {
        const agentsBlock = kpisPayload.agents;
        const agentsProv =
          agentsBlock === null ? null : agentsBlock.provenance;
        if (isFixtureProvenance(agentsProv)) {
          items.push({
            key: "agents-fixture",
            source: t("book"),
            detail: t("attentionFixtureProvenance", {
              value: agentsProv.source ?? "",
            }),
          });
        }
        if (state.dataStatus === "stale") {
          for (const reason of state.degradedReasons) {
            if (reason.kind !== "data") continue;
            items.push({
              key: `data-${reason.message}`,
              source: t("r2PipelinesBlock"),
              detail: reason.message,
            });
          }
        }
        if (kpisPayload.r2Sinks !== null) {
          for (const sink of kpisPayload.r2Sinks) {
            if (sink.stale !== true) continue;
            items.push({
              key: `r2-${sink.id}`,
              source: t("r2PipelinesBlock"),
              detail: t("attentionR2Stale", {
                sink: t(sink.labelKey),
                reason: sink.reason ?? t("r2SinkStale"),
              }),
            });
          }
        }
      }
      const executionSource = state.sources.execution;
      if (isSourceOk(executionSource) && executionPayload !== null) {
        if (executionPayload.killSwitch === true) {
          items.push({
            key: "kill-switch",
            source: t("executionCard"),
            detail: t("attentionKill"),
          });
        }
        if (
          executionPayload.mode !== null &&
          executionPayload.mode !== "paper"
        ) {
          items.push({
            key: "mode",
            source: t("executionCard"),
            detail: t("attentionMode", { mode: executionPayload.mode }),
          });
        }
        if (executionPayload.liveEnabled === true) {
          items.push({
            key: "live-enabled",
            source: t("executionCard"),
            detail: t("attentionLive"),
          });
        }
      }
      for (const entry of [
        ["graph", "marketFeed"],
        ["kpis", "book"],
        ["execution", "executionCard"],
      ]) {
        const source = state.sources[entry[0]];
        if (source === null || source.status === "ok") continue;
        const reason =
          source.error ??
          (source.httpStatus === null
            ? t("stateError")
            : `HTTP ${source.httpStatus}`);
        items.push({
          key: `source-${entry[0]}`,
          source: t(entry[1]),
          detail: reason,
        });
      }
      if (items.length === 0) return null;
      return h(
        "section",
        {
          className: "spsd-attention",
          key: "attention",
          "data-count": String(items.length),
          role: "status",
        },
        h("h2", { className: "spsd-attention-title" }, t("attentionTitle")),
        h(
          "ul",
          { className: "spsd-attention-list" },
          items.map((item) =>
            h(
              "li",
              { key: item.key, className: "spsd-attention-item" },
              t("attentionItem", {
                source: item.source,
                detail: item.detail,
              }),
            ),
          ),
        ),
      );
    }

    /** Page chrome. Colors come only from host `--dsw-alias-*` tokens. */
    const CSS = `
.spsd-page { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.6; }
.spsd-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.spsd-content { max-width: 1100px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.spsd-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 28px; margin-bottom: 8px; }
.spsd-heading { flex: 1 1 320px; min-width: 0; }
.spsd-head h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.spsd-sub { margin: 6px 0 0; max-width: 70ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.spsd-actions { display: flex; flex: none; gap: 8px; }
.spsd-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; text-decoration: none; cursor: pointer; }
.spsd-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.spsd-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.spsd-btn:disabled { cursor: progress; opacity: 0.6; }
.spsd-btn-strong { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 500; }
.spsd-lastmeasured { margin: 0 0 16px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.spsd-latency { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.spsd-latency-label { color: var(--dsw-alias-label-tertiary); }
.spsd-latency-text { font-variant-numeric: tabular-nums; }
.spsd-spark { width: 160px; height: 24px; margin-left: auto; color: var(--dsw-alias-state-success-primary); }
.spsd-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 20px; }
.spsd-section { margin-top: 16px; }
.spsd-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.spsd-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.spsd-card[data-phase='current'] .spsd-dot { background: var(--dsw-alias-state-success-primary); }
.spsd-card[data-phase='degraded'] .spsd-dot, .spsd-card[data-phase='stale'] .spsd-dot, .spsd-card[data-phase='unknown'] .spsd-dot { background: var(--dsw-alias-state-warn-primary); }
.spsd-card[data-phase='down'] .spsd-dot { background: var(--dsw-alias-state-error-primary); }
.spsd-status-text { font-size: 14px; font-weight: 500; }
.spsd-status .spsd-chip { margin-left: auto; }
.spsd-live { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.spsd-live-head { display: flex; align-items: center; gap: 8px; }
.spsd-live-head .spsd-chip-state { margin-left: auto; }
.spsd-live-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.spsd-live[data-live-state='streaming'] .spsd-live-dot { background: var(--dsw-alias-state-success-primary); }
.spsd-live[data-live-state='connecting'] .spsd-live-dot, .spsd-live[data-live-state='reconnecting'] .spsd-live-dot, .spsd-live[data-live-state='paused'] .spsd-live-dot { background: var(--dsw-alias-state-warn-primary); }
.spsd-live[data-live-state='unavailable'] .spsd-live-dot, .spsd-live[data-live-state='error'] .spsd-live-dot { background: var(--dsw-alias-state-error-primary); }
.spsd-live-changes { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.spsd-live-changes li { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.spsd-live-changes .spsd-when { flex: none; }
.spsd-chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; }
.spsd-chip[data-tone='warn'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.spsd-chip[data-tone='error'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.spsd-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.spsd-meta-flat { margin-top: 0; padding-top: 0; border-top: 0; }
.spsd-meta dt { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.spsd-meta dd { margin: 2px 0 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.spsd-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.spsd-h2 { margin: 0 0 12px; font-size: 14px; line-height: 20px; font-weight: 500; }
.spsd-callout { margin-top: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 16px 20px; }
.spsd-callout h2 { margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 500; }
.spsd-callout p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.spsd-callout ul { margin: 8px 0 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.spsd-callout-fix { margin-top: 12px; }
.spsd-error { margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.spsd-command { display: inline-block; margin-top: 8px; padding: 4px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; }
.spsd-reason-action { display: block; margin-top: 6px; cursor: pointer; text-align: left; color: inherit; }
.spsd-callout li[data-severity='error'] { color: var(--dsw-alias-state-error-primary); }
.spsd-links { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 12px; }
.spsd-link { color: var(--dsw-alias-brand-primary); font-size: 12px; text-decoration: none; }
.spsd-link:hover { text-decoration: underline; }
.spsd-link:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.spsd-list { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.spsd-list h3 { margin: 0 0 10px; font-size: 13px; line-height: 18px; font-weight: 500; }
.spsd-list-count { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.spsd-list ul { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.spsd-list li { display: flex; flex-wrap: wrap; gap: 4px 12px; justify-content: space-between; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.spsd-list-name { color: var(--dsw-alias-label-primary); }
.spsd-when { flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.spsd-attention { margin-top: 16px; padding: 12px 16px; border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.spsd-attention-title { margin: 0 0 8px; font-size: 13px; line-height: 18px; font-weight: 500; }
.spsd-attention-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.spsd-attention-item { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.spsd-overview-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; margin-top: 16px; align-items: start; }
@media (min-width: 900px) { .spsd-overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.spsd-overview { display: flex; flex-direction: column; gap: 10px; }
.spsd-ovhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.spsd-ovtitle { margin: 0; font-size: 14px; line-height: 20px; font-weight: 500; }
.spsd-ovmeta { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.spsd-chip-state { display: inline-flex; flex: none; align-items: center; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 18px; }
.spsd-chip-state[data-state='ok'] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
.spsd-chip-state[data-state='stale'] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); }
.spsd-chip-state[data-state='error'], .spsd-chip-state[data-state='missing'] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.spsd-chip-state[data-state='checking'] { border-color: var(--dsw-alias-state-idle-primary); color: var(--dsw-alias-state-idle-primary); }
.spsd-block { padding-top: 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.spsd-h3 { margin: 0 0 8px; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
.spsd-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px 14px; margin: 0; }
.spsd-kv-item { min-width: 0; }
.spsd-kv-label { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.spsd-kv-value { margin: 1px 0 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
.spsd-kv-value[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.spsd-kv-value[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.spsd-provenance { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; overflow-wrap: anywhere; }
.spsd-note-line { margin: 8px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.spsd-note-line[data-tone='warn'] { color: var(--dsw-alias-state-warn-primary); }
.spsd-source-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.spsd-lastgood { margin: 0; padding: 6px 8px; border: 1px solid var(--dsw-alias-state-warn-primary); border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.spsd-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 12px; padding: 10px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1); }
.spsd-strip-title { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
.spsd-strip-items { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.spsd-strip-item { display: inline-flex; align-items: baseline; gap: 6px; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; font-variant-numeric: tabular-nums; }
.spsd-strip-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.spsd-strip-value { font-weight: 500; }
.spsd-source-strip .spsd-chip-state { cursor: default; }
.spsd-legacy-portal { margin: 10px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.spsd-ovfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: auto; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1); }
.spsd-ovtransport { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.spsd-retry { align-self: flex-start; }
.spsd-meter { display: block; width: 100%; height: 5px; margin-top: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.spsd-meter > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary); }
.spsd-venue-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.spsd-venue { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 12px; line-height: 18px; }
.spsd-venue-name { font-weight: 500; }
.spsd-venue-reason { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.spsd-note { margin-top: 32px; max-width: 72ch; }
.spsd-note h2 { margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 500; }
.spsd-note p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.spsd-note .spsd-note-sub { margin-top: 8px; }
`;

    /** Decorative sidebar glyph; the host owns the entry's color and label. */
    function DeskIconSvg({ size }) {
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
          x: 2.75,
          y: 4.25,
          width: 18.5,
          height: 12.5,
          rx: 2.5,
          stroke: "currentColor",
          strokeWidth: 1.6,
        }),
        h("path", {
          d: "M7.5 13.4l3.1-3.3 2.6 2.3 3.9-4.2",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }),
        h("path", {
          d: "M12 16.75v3.5M8.5 20.25h7",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
        }),
      );
    }

    /** Dot color per measured phase; theme tokens, owned by the host. */
    const DOT_COLOR = {
      current: "var(--dsw-alias-state-success-primary)",
      stale: "var(--dsw-alias-state-warn-primary)",
      unknown: "var(--dsw-alias-state-warn-primary)",
      down: "var(--dsw-alias-state-error-primary)",
      checking: "var(--dsw-alias-state-idle-primary)",
    };

    /**
     * The sidebar entry. It starts the one poll loop (the glyph is mounted even
     * when the page is closed) and renders the measured phase as a corner dot,
     * so desk health is visible from the sidebar. The dot stays on the service
     * phase — a stale market feed does not turn it amber.
     */
    const DeskIcon = React.memo(function DeskIcon(props) {
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const state = useStatus();
      React.useEffect(() => {
        startPolling();
      }, []);
      const size =
        typeof props.size === "number" && props.size > 0 ? props.size : 20;
      return h(
        "span",
        {
          style: {
            position: "relative",
            display: "inline-flex",
            lineHeight: 0,
            color: "inherit",
          },
        },
        h(DeskIconSvg, { size }),
        h("span", {
          "aria-hidden": true,
          title: t("dotTitle", { status: statusText(t, state) }),
          style: {
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: DOT_COLOR[state.phase] ?? DOT_COLOR.checking,
            boxShadow: "0 0 0 1.5px var(--dsw-alias-bg-base)",
          },
        }),
      );
    });

    /**
     * The main-column desk page. Its only data source is the measured snapshot,
     * so an unmeasured page never shows a green "healthy" line and a failed
     * source card never turns into a zero.
     */
    const DeskPanel = React.memo(function DeskPanel(props) {
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const state = useStatus();
      const live = useLive();
      const [copyState, setCopyState] = React.useState("idle");
      const copyTimer = React.useRef(null);
      React.useEffect(
        () => () => {
          if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        },
        [],
      );
      React.useEffect(() => {
        startPolling();
        // The stream belongs to the page: the sidebar glyph needs only the
        // probe loop, so a closed desk page must not hold an SSE connection.
        startLive();
        return () => stopLive();
      }, []);
      const now = useNow(1_000);
      const sources = state.sources;
      const graphPayload = readGraphPayload(
        sources.graph && sources.graph.body ? sources.graph.body : null,
      );
      const kpisPayload = readKpisPayload(
        sources.kpis && sources.kpis.body ? sources.kpis.body : null,
      );
      const executionPayload = readExecutionPayload(
        sources.execution && sources.execution.body
          ? sources.execution.body
          : null,
      );
      const retry = () => {
        void runProbe(true);
        reconnectLive();
      };
      const copyDiagnostics = async () => {
        const measured = {
          generatedAt: new Date().toISOString(),
          phase: state.phase,
          httpStatus: state.httpStatus,
          uptimeSeconds: state.uptimeSeconds,
          checkedAt: state.checkedAt,
          source: state.source,
          healthLatencyMs: state.healthLatencyMs,
          statusLatencyMs: state.statusLatencyMs,
          error: state.error,
          degradedReasons: state.degradedReasons,
          live: {
            state: live.state,
            url: live.url,
            httpStatus: live.httpStatus,
            frames: live.frames,
            heartbeats: live.heartbeats,
            parseErrors: live.parseErrors,
            bytes: live.bytes,
            connectedAt: live.connectedAt,
            lastFrameAt: live.lastFrameAt,
            lastHeartbeatAt: live.lastHeartbeatAt,
            error: live.error ?? null,
          },
          sources: Object.fromEntries(
            Object.entries(state.sources).map(([id, entry]) => [
              id,
              {
                status: entry.status,
                httpStatus: entry.httpStatus,
                latencyMs: entry.latencyMs,
                error: entry.error ?? null,
              },
            ]),
          ),
        };
        let next = "failed";
        try {
          if (
            typeof navigator === "undefined" ||
            !navigator.clipboard ||
            typeof navigator.clipboard.writeText !== "function"
          ) {
            throw new Error("clipboard unavailable");
          }
          await navigator.clipboard.writeText(
            JSON.stringify(measured, null, 2),
          );
          next = "copied";
        } catch {
          next = "failed";
        }
        setCopyState(next);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopyState("idle"), 2_000);
      };
      const checked =
        state.checkedAt === null
          ? t("never")
          : `${new Date(state.checkedAt).toLocaleTimeString()} · ${formatAgo(t, state.checkedAt, now)}`;
      const uptime = formatDuration(state.uptimeSeconds) ?? t("never");
      const source =
        state.source === null
          ? t("never")
          : state.healthLatencyMs === null
            ? sourceText(t, state.source)
            : `${sourceText(t, state.source)} · ${state.healthLatencyMs} ms`;
      const recovery = recoveryCallout(t, state);
      const attention = attentionBanner(
        t,
        state,
        graphPayload,
        executionPayload,
        kpisPayload,
      );
      const service = serviceCard(t, state);
      const lastMeasured =
        state.checkedAt === null
          ? t("checking")
          : `${t("lastMeasured")} ${formatClock(state.checkedAt) ?? t("never")} · ${formatAgo(t, state.checkedAt, now)}`;
      const counterStrip = liveCounterStrip(t, live, now);

      const graphSource = sources.graph;
      const graphState = cardState(graphSource, isGraphStale(graphPayload));
      const kpisSource = sources.kpis;
      const kpisState = cardState(kpisSource, isKpisStale(kpisPayload));
      const executionSource = sources.execution;
      const executionState = cardState(
        executionSource,
        isExecutionStale(executionPayload),
      );
      const sourceStrip = overviewSourceStrip(t, [
        { id: "graph", label: t("marketFeed"), state: graphState },
        { id: "kpis", label: t("book"), state: kpisState },
        { id: "execution", label: t("executionCard"), state: executionState },
      ]);

      const overview = h(
        "div",
        { className: "spsd-overview-grid", key: "overview" },
        overviewCard({
          t,
          source: graphSource,
          sourceId: "graph",
          title: t("marketFeed"),
          state: graphState,
          bodyBlocks: graphCardBody(t, graphPayload, now),
          now,
          hasData: graphPayload !== null,
          retry,
          key: "graph-card",
        }),
        overviewCard({
          t,
          source: kpisSource,
          sourceId: "kpis",
          title: t("book"),
          state: kpisState,
          bodyBlocks: kpisCardBody(t, kpisPayload, now),
          now,
          hasData: kpisPayload !== null,
          retry,
          key: "kpis-card",
        }),
        overviewCard({
          t,
          source: executionSource,
          sourceId: "execution",
          title: t("executionCard"),
          state: executionState,
          bodyBlocks: executionCardBody(t, executionPayload, now),
          now,
          hasData: executionPayload !== null,
          retry,
          key: "execution-card",
        }),
      );

      return h(
        "div",
        { className: "spsd-page" },
        h("style", null, CSS),
        h(
          "div",
          { className: "spsd-scroll" },
          h(
            "div",
            { className: "spsd-content" },
            h(
              "header",
              { className: "spsd-head" },
              h(
                "div",
                { className: "spsd-heading" },
                h("h1", null, t("title")),
                h("p", { className: "spsd-sub" }, t("description")),
              ),
              h(
                "div",
                { className: "spsd-actions" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "spsd-btn",
                    disabled: state.phase === "checking",
                    onClick: retry,
                  },
                  t("refresh"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "spsd-btn",
                    disabled: state.checkedAt === null,
                    onClick: copyDiagnostics,
                  },
                  copyState === "copied"
                    ? t("copied")
                    : copyState === "failed"
                      ? t("copyFailed")
                      : t("copyDiagnostics"),
                ),
                h(
                  "a",
                  {
                    className: "spsd-btn spsd-btn-strong",
                    href: SERVICE_URL,
                    target: "_blank",
                    rel: "noreferrer",
                  },
                  t("open"),
                ),
              ),
            ),
            h(
              "p",
              { className: "spsd-lastmeasured", key: "last-measured" },
              lastMeasured,
            ),
            counterStrip,
            sourceStrip,
            legacyPortalRow(t),
            h(
              "section",
              {
                className: "spsd-card",
                key: "status",
                "data-phase": state.phase,
                role: "status",
                "aria-live": "polite",
                title: state.error ?? undefined,
              },
              h(
                "div",
                { className: "spsd-status" },
                h("span", { className: "spsd-dot", "aria-hidden": true }),
                h(
                  "span",
                  { className: "spsd-status-text" },
                  statusText(t, state),
                ),
                h(
                  "span",
                  { className: "spsd-chip" },
                  SERVICE_URL.replace(/^https?:\/\//, ""),
                ),
              ),
              h(
                "dl",
                { className: "spsd-meta" },
                metaRow(
                  t("endpoint"),
                  h("code", { className: "spsd-code" }, SERVICE_URL),
                ),
                metaRow(
                  t("http"),
                  state.httpStatus === null
                    ? t("never")
                    : String(state.httpStatus),
                ),
                metaRow(t("uptime"), uptime),
                metaRow(t("checked"), checked),
                metaRow(t("source"), source),
              ),
              rawLinks(t, state),
              h(
                "div",
                { className: "spsd-latency", key: "latency" },
                h("span", { className: "spsd-latency-label" }, t("latency")),
                h(
                  "span",
                  { className: "spsd-latency-text" },
                  latencySummary(healthLatencyHistory, t) ?? t("latencyEmpty"),
                ),
                latencySparkline(healthLatencyHistory),
              ),
            ),
            liveCard(t, live, now),
            recovery,
            attention,
            overview,
            service,
            h(
              "section",
              { className: "spsd-note", key: "note" },
              h("h2", null, t("what")),
              h("p", null, t("explain")),
              h(
                "p",
                { className: "spsd-note-sub" },
                t("liveNote", { seconds: Math.round(POLL_MS / 1_000) }),
              ),
            ),
          ),
        ),
      );
    });

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        // Owns the live loop's lifetime: disposal clears the timer, removes the
        // visibility listener, aborts the in-flight probe and forbids publishes.
        ctx.effect(() => {
          disposed = false;
          return () => {
            disposed = true;
            polling = false;
            if (pollTimer !== null) {
              clearTimeout(pollTimer);
              pollTimer = null;
            }
            if (
              visibilityListening &&
              typeof document !== "undefined" &&
              typeof document.removeEventListener === "function"
            ) {
              document.removeEventListener(
                "visibilitychange",
                onVisibilityChange,
              );
            }
            visibilityListening = false;
            const pending = inFlight;
            inFlight = null;
            if (pending !== null) pending.abort();
            // Closes the SSE connection and forbids any later publish from it.
            stopLive();
          };
        }, "sportsdesk desk panel: live status polling and stream");

        ctx.effect(
          () => ctx.locale.register(NS, DICTS),
          "sportsdesk desk panel: locale dictionaries",
        );
        const t = ctx.locale.bind(NS);

        // The page and the sidebar entry share one id: the sidebar selects the
        // panel by this key, so both registrations must use PANEL_ID.
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              locale: NS,
            },
            DeskPanel,
          ),
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 100,
              locale: NS,
              label: () => t("panel"),
            },
            DeskIcon,
          ),
        );
      },
    };
  },
});
