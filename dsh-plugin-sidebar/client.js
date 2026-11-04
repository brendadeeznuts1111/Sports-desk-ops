/**
 * Client half of the SportsDesk desk-panel bundle.
 *
 * WHAT THIS IS
 *
 * A left-sidebar entry (`sidebar.panellist`, the global panel-icon list that
 * already holds Plugins and Schedules) plus the main-column page that entry
 * selects (`main`, keyed by the same id — the sidebar owns the button, its
 * hover tooltip, and the selected state; the plugin owns the glyph and the
 * page).
 *
 * The page reports the local SportsDesk webview service on
 * http://127.0.0.1:4020 from its own routes, never from an assumed state:
 *
 *   /health     the service's health document (status, uptimeSeconds, runtime)
 *   /api/status a route the CURRENT checkout defines (services/sportsdesk_webview_server.ts)
 *
 * The classification is the same one the `sportsdesk_status` Host tool and the
 * composer desk-status row use:
 *
 *   fetch rejected / non-2xx /health        -> "service down"
 *   /health ok AND (/api/status 404 OR the
 *   /health body has no `ingress` field)    -> "stale build"
 *   /health ok AND /api/status answers      -> "current"
 *   /health ok AND /api/status probe failed -> "status probe failed" (unknown)
 *
 * The /api/status probe and the `ingress` field check exist because the running
 * service can answer /health while predating the checkout: measured on
 * 2026-11-02, /health answered with uptimeSeconds 457596 and no `ingress`, and
 * /api/status returned 404 — a naive health check says "healthy"; this page
 * says "stale build".
 *
 * CORS: the service grants cross-origin reads only for origins listed in
 * `SPORTSDESK_ALLOWED_ORIGINS` (`services/sportsdesk_webview_server.ts:691-722`;
 * the blanket `*` grant was removed on 2026-11-01). Measured 2026-11-03 with
 * that variable set to the GUI origin: /health and /api/status answer
 * `Access-Control-Allow-Origin: https://dsh.bookdeskops.com` and carry
 * `Vary: Origin`, while an unlisted origin gets no grant. So the page can read
 * the service only when the operator's env lists the origin the Harness Web UI
 * is served from. A browser cannot distinguish a CORS refusal from a network
 * failure; if the fetch rejects, the page says "service down" rather than
 * inventing a healthy state.
 *
 * RULES FOLLOWED
 *
 * - The factory is side-effect free: it only builds components and constants.
 *   The locale dictionary and the slot registrations are owned effects created
 *   in `apply`.
 * - Probing is mount-scoped: the page measures when it opens and on Refresh,
 *   cancels the in-flight request and its timeout on unmount, and never
 *   publishes a result after disposal. It does not poll in the background.
 * - Visible copy goes through the Client locale service (`ctx.locale.register`
 *   plus the `locale:` registration option, which supplies `t`), with a
 *   dictionary fallback so a missing seat renders English instead of a key.
 * - Chrome uses only host `--dsw-alias-*` color tokens; the sidebar glyph uses
 *   `currentColor`, so the host owns its color in every theme.
 * - React comes from the browser module table. No Harness Client package is
 *   imported, the app root is not touched, and no DOM outside the slot entry is
 *   written.
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
    const HEALTH_URL = `${SERVICE_URL}/health`;
    const STATUS_URL = `${SERVICE_URL}/api/status`;
    /** Per-request bound; the service answers /health in a few milliseconds when up. */
    const PROBE_TIMEOUT_MS = 4_000;

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
          "The local SportsDesk webview service the desk runs with bun run serve.",
        refresh: "Refresh",
        open: "Open desk",
        checking: "checking…",
        current: "current",
        stale: "stale build (uptime {uptime})",
        staleUnknown: "stale build",
        down: "service down",
        unknown: "status probe failed",
        endpoint: "Endpoint",
        http: "HTTP",
        uptime: "Uptime",
        checked: "Checked",
        never: "—",
        what: "What this checks",
        explain:
          "/health answers first. /api/status is a route the current checkout defines, so a 404 there — or a /health body without an ingress field — means the running service predates this checkout, and the page shows “stale build” rather than “healthy”.",
      },
      zh: {
        panel: "SportsDesk",
        title: "SportsDesk 工作台",
        description:
          "本地 SportsDesk webview 服务（工作台以 bun run serve 启动）。",
        refresh: "刷新",
        open: "打开工作台",
        checking: "检测中…",
        current: "已是最新",
        stale: "旧构建（已运行 {uptime}）",
        staleUnknown: "旧构建",
        down: "服务未运行",
        unknown: "状态探测失败",
        endpoint: "地址",
        http: "HTTP",
        uptime: "运行时长",
        checked: "检查时间",
        never: "—",
        what: "检测内容",
        explain:
          "先检查 /health；/api/status 是当前代码定义的路由。该路由返回 404，或 /health 响应缺少 ingress 字段，说明运行中的服务早于此代码版本，因此显示“旧构建”而不是“正常”。",
      },
    };

    /** Initial state is "checking", never "healthy": nothing has been measured yet. */
    const INITIAL = Object.freeze({
      phase: "checking",
      uptimeSeconds: null,
      httpStatus: null,
      checkedAt: null,
      error: null,
    });

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

    /**
     * GET one URL and keep its HTTP status; a non-JSON body is null, not an
     * invented healthy payload.
     * @param {string} url
     * @param {AbortSignal} signal
     */
    async function getJson(url, signal) {
      const response = await fetch(url, {
        signal,
        headers: { accept: "application/json" },
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, ok: response.ok, body };
    }

    /**
     * Measure the service once and classify it. Every rejection is caught here,
     * so nothing throws to the caller's render path.
     * @param {AbortSignal} signal
     * @returns {Promise<typeof INITIAL>} the measured state.
     */
    async function measure(signal) {
      const checkedAt = Date.now();
      let health;
      try {
        health = await getJson(HEALTH_URL, signal);
      } catch (error) {
        return {
          phase: "down",
          uptimeSeconds: null,
          httpStatus: null,
          checkedAt,
          error: String((error && error.message) || error),
        };
      }
      if (!health.ok) {
        return {
          phase: "down",
          uptimeSeconds: null,
          httpStatus: health.status,
          checkedAt,
          error: `HTTP ${health.status}`,
        };
      }

      const body = health.body;
      const uptimeSeconds =
        body && typeof body.uptimeSeconds === "number"
          ? body.uptimeSeconds
          : null;
      const hasIngress =
        body !== null && typeof body === "object"
          ? Object.hasOwn(body, "ingress")
          : false;

      let status = null;
      try {
        status = await getJson(STATUS_URL, signal);
      } catch {
        status = null;
      }
      if (status === null) {
        return {
          phase: "unknown",
          uptimeSeconds,
          httpStatus: null,
          checkedAt,
          error: "status probe failed",
        };
      }
      const stale = status.status === 404 || hasIngress === false;
      return {
        phase: stale ? "stale" : "current",
        uptimeSeconds,
        httpStatus: status.status,
        checkedAt,
        error: null,
      };
    }

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
        case "unknown":
          return t("unknown");
        default:
          return t("checking");
      }
    }

    /**
     * Mount-scoped probe state. Opening the page measures once; Refresh
     * measures again. The in-flight request and its timeout are cancelled on
     * unmount, and a superseded request never publishes.
     * @returns {[typeof INITIAL, () => Promise<void>]}
     */
    function useDeskStatus() {
      const [state, setState] = React.useState(INITIAL);
      const alive = React.useRef(true);
      const inFlight = React.useRef(null);

      const refresh = React.useCallback(async () => {
        const previous = inFlight.current;
        if (previous !== null) previous.abort();
        const controller = new AbortController();
        inFlight.current = controller;
        if (alive.current) setState(INITIAL);

        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        let next;
        try {
          next = await measure(controller.signal);
        } catch (error) {
          next = {
            phase: "down",
            uptimeSeconds: null,
            httpStatus: null,
            checkedAt: Date.now(),
            error: String((error && error.message) || error),
          };
        } finally {
          clearTimeout(timer);
        }
        if (!alive.current || inFlight.current !== controller) return;
        inFlight.current = null;
        setState(next);
      }, []);

      React.useEffect(() => {
        alive.current = true;
        void refresh();
        return () => {
          alive.current = false;
          const pending = inFlight.current;
          inFlight.current = null;
          if (pending !== null) pending.abort();
        };
      }, [refresh]);

      return [state, refresh];
    }

    /** One metadata cell in the status card. */
    function metaRow(label, value) {
      return h(
        "div",
        { className: "spsd-meta-item", key: label },
        h("dt", null, label),
        h("dd", null, value),
      );
    }

    /** Page chrome. Colors come only from host `--dsw-alias-*` tokens. */
    const CSS = `
.spsd-page { display: flex; flex-direction: column; height: 100%; min-width: 0; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 1.6; }
.spsd-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.spsd-content { max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 48px; }
.spsd-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 16px; padding-top: 28px; margin-bottom: 24px; }
.spsd-heading { flex: 1 1 320px; min-width: 0; }
.spsd-head h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; }
.spsd-sub { margin: 6px 0 0; max-width: 64ch; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
.spsd-actions { display: flex; flex: none; gap: 8px; }
.spsd-btn { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 28px; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; white-space: nowrap; text-decoration: none; cursor: pointer; }
.spsd-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.spsd-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.spsd-btn:disabled { cursor: progress; opacity: 0.6; }
.spsd-btn-strong { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); font-weight: 500; }
.spsd-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); padding: 20px; }
.spsd-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.spsd-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.spsd-card[data-phase='current'] .spsd-dot { background: var(--dsw-alias-state-success-primary); }
.spsd-card[data-phase='stale'] .spsd-dot, .spsd-card[data-phase='unknown'] .spsd-dot { background: var(--dsw-alias-state-warn-primary); }
.spsd-card[data-phase='down'] .spsd-dot { background: var(--dsw-alias-state-error-primary); }
.spsd-status-text { font-size: 14px; font-weight: 500; }
.spsd-chip { margin-left: auto; padding: 1px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 18px; }
.spsd-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin: 20px 0 0; padding: 16px 0 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.spsd-meta dt { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; }
.spsd-meta dd { margin: 2px 0 0; font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
.spsd-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.spsd-note { margin-top: 32px; max-width: 72ch; }
.spsd-note h2 { margin: 0 0 6px; font-size: 14px; line-height: 20px; font-weight: 500; }
.spsd-note p { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 20px; }
`;

    /** Decorative sidebar glyph; the host owns the entry's color and label. */
    function DeskIcon({ size }) {
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

    /**
     * The main-column desk page. Its only data source is the measured service
     * state, so an unmeasured page never shows a green "healthy" line.
     */
    const DeskPanel = React.memo(function DeskPanel(props) {
      const t = typeof props.t === "function" ? props.t : fallbackT;
      const [state, refresh] = useDeskStatus();
      const checked =
        state.checkedAt === null
          ? t("never")
          : new Date(state.checkedAt).toLocaleTimeString();
      const uptime = formatDuration(state.uptimeSeconds) ?? t("never");

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
                    onClick: () => {
                      void refresh();
                    },
                  },
                  t("refresh"),
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
              "section",
              {
                className: "spsd-card",
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
              ),
            ),
            h(
              "section",
              { className: "spsd-note" },
              h("h2", null, t("what")),
              h("p", null, t("explain")),
            ),
          ),
        ),
      );
    });

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
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
