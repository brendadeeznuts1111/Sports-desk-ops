/**
 * Client half of the SportsDesk desk-status decoration.
 *
 * WHAT THIS IS
 *
 * One compact, single-line, ambient row under the composer card
 * (`conversation.composer.dock`, a list slot with allocated space and
 * `replaceRisk: none`). It reports the local SportsDesk webview service on
 * http://127.0.0.1:4020, which is REAL data read from the service's own routes:
 *
 *   /health     the service's health document (status, uptimeSeconds, runtime)
 *   /api/status a route the CURRENT checkout defines (services/sportsdesk_webview_server.ts)
 *
 * The classification is the same one the `sportsdesk_status` Host tool uses:
 *
 *   fetch rejected / non-2xx /health        -> "service down"
 *   /health ok AND (/api/status 404 OR the
 *   /health body has no `ingress` field)    -> "stale build (uptime Nd)"
 *   /health ok AND /api/status answers      -> "current"
 *   /health ok AND /api/status probe failed -> "status probe failed" (unknown)
 *
 * The live service on 2026-11-02 measured uptimeSeconds 457596 (~5.3 days), a
 * 404 for /api/status, and a /health body without `ingress` — so a naive
 * `/health` check would say "healthy" while the row honestly says "stale build".
 *
 * CORS: measured with `curl -si` on 2026-11-02 — both /health and /api/status
 * answer `Access-Control-Allow-Origin: *`, so the page may read them. A browser
 * cannot distinguish a network failure from a CORS rejection; if the fetch
 * rejects, the row says "service down" rather than inventing a healthy state.
 *
 * RULES FOLLOWED
 *
 * - The factory is side-effect free: it only builds the component and a state
 *   cell. The fetch loop and the locale dictionary are registered in `apply`
 *   with `ctx.effect`, and their cleanups stop the timer and publish nothing
 *   after disposal.
 * - The row text goes through the Client locale service (`ctx.locale.register`
 *   plus the `locale:` registration option, which hands the component its typed
 *   `t` seat).
 * - Styling uses only host `--dsw-alias-*` tokens; no literal colors in chrome.
 * - React comes from the browser module table; no Harness Client package is
 *   imported.
 */

window.__ModuleLoader__.load({
  id: "dsh-plugin-sportsdesk-desk-status",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /** Locale namespace owned by this bundle (also the `locale:` registration option). */
    const NS = "sportsdesk-desk-status";
    /** The local webview service the desk runs with `bun run serve`. */
    const HEALTH_URL = "http://127.0.0.1:4020/health";
    const STATUS_URL = "http://127.0.0.1:4020/api/status";
    /** Per-request bound; the service answers /health in ~3 ms when up. */
    const PROBE_TIMEOUT_MS = 3_000;
    /** Poll cadence, inside the requested <= 60 s bound. */
    const POLL_MS = 30_000;

    /**
     * Visible copy. Both built-in locales are supplied because the locale
     * service's object form expects a dictionary per locale; a language switch
     * re-renders the row without re-registering it.
     */
    const DICT = {
      en: {
        brand: "SportsDesk",
        checking: "checking…",
        current: "current",
        stale: "stale build (uptime {uptime})",
        staleUnknown: "stale build",
        down: "service down",
        unknown: "status probe failed",
        detail: "Local webview service at {url} · checked {checked}",
      },
      zh: {
        brand: "SportsDesk",
        checking: "检测中…",
        current: "已是最新",
        stale: "旧构建（已运行 {uptime}）",
        staleUnknown: "旧构建",
        down: "服务未运行",
        unknown: "状态探测失败",
        detail: "本地 webview 服务 {url} · 检查于 {checked}",
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
     * Side-effect-free state cell. The polling loop in `apply` is the only
     * writer; the component only subscribes.
     */
    let snapshot = INITIAL;
    const listeners = new Set();

    function publish(next) {
      // Re-render only when something measurable changed: a same-classification
      // poll must not churn the dock every 30 s.
      if (
        next.phase === snapshot.phase &&
        next.uptimeSeconds === snapshot.uptimeSeconds &&
        next.httpStatus === snapshot.httpStatus &&
        next.error === snapshot.error
      ) {
        return;
      }
      snapshot = next;
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

    /** Subscribe the row to the cell without owning any effect of its own. */
    function useStatus() {
      return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    }

    /**
     * GET one URL and keep its HTTP status; a non-JSON body is null, not an
     * invented healthy payload.
     * @param {string} url
     */
    async function getJson(url) {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
     * Measure the service once and classify it. Rejections are caught inside
     * the poll loop, so nothing here throws to the timer.
     */
    async function probe() {
      const checkedAt = Date.now();
      let health;
      try {
        health = await getJson(HEALTH_URL);
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

      // Second probe: /api/status is a route the CURRENT source defines, so a
      // 404 (or a missing ingress field) is a stale-build signal, not a
      // missing-endpoint one.
      let status = null;
      try {
        status = await getJson(STATUS_URL);
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
     * Compact uptime: 5d, 7h, 42m.
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

    /** Dot color per class, from the host's semantic state tokens only. */
    const DOT_COLOR = {
      checking: "var(--dsw-alias-state-idle-primary)",
      current: "var(--dsw-alias-state-success-primary)",
      stale: "var(--dsw-alias-state-warn-primary)",
      down: "var(--dsw-alias-state-error-primary)",
      unknown: "var(--dsw-alias-state-warn-primary)",
    };

    /** One compact single line; inherits the host theme for all chrome. */
    const DeskStatusRow = React.memo(function DeskStatusRow(props) {
      // The slot's `locale:` option supplies `t`; fall back to the English
      // dictionary rather than rendering a raw key if the seat is absent.
      const t =
        typeof props.t === "function"
          ? props.t
          : (key, params) => {
              const template = DICT.en[key] ?? key;
              return params
                ? template.replace(/\{(\w+)\}/g, (match, name) =>
                    name in params ? String(params[name]) : match,
                  )
                : template;
            };
      const state = useStatus();
      const uptime = formatUptime(state.uptimeSeconds);
      const text =
        state.phase === "current"
          ? t("current")
          : state.phase === "stale"
            ? uptime === null
              ? t("staleUnknown")
              : t("stale", { uptime })
            : state.phase === "down"
              ? t("down")
              : state.phase === "unknown"
                ? t("unknown")
                : t("checking");
      const checked =
        state.checkedAt === null
          ? "—"
          : new Date(state.checkedAt).toLocaleTimeString();
      const title = [
        t("detail", { url: HEALTH_URL, checked }),
        state.httpStatus === null ? null : `HTTP ${state.httpStatus}`,
        state.error,
      ]
        .filter(Boolean)
        .join(" · ");

      return h(
        "div",
        {
          "data-sportsdesk-desk-status": state.phase,
          role: "status",
          "aria-live": "polite",
          title,
          style: {
            display: "flex",
            alignItems: "center",
            gap: 6,
            minHeight: 16,
            padding: "0 2px",
            fontFamily: "inherit",
            fontSize: 12,
            lineHeight: "16px",
            fontWeight: 400,
            color: "var(--dsw-alias-label-secondary)",
            userSelect: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          },
        },
        h("span", {
          "aria-hidden": true,
          style: {
            flex: "0 0 auto",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: DOT_COLOR[state.phase] ?? DOT_COLOR.unknown,
          },
        }),
        h(
          "span",
          {
            style: {
              color: "var(--dsw-alias-label-primary)",
              fontWeight: 500,
            },
          },
          t("brand"),
        ),
        h(
          "span",
          {
            "aria-hidden": true,
            style: { color: "var(--dsw-alias-label-tertiary)" },
          },
          "·",
        ),
        h("span", null, text),
      );
    });

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        // Dictionaries are owned effects: they unregister with the plugin.
        ctx.effect(
          () => ctx.locale.register(NS, DICT),
          "sportsdesk desk-status: locale dictionary",
        );

        // The poll loop is an owned effect too. Its cleanup stops the timer and
        // guarantees no publish after disposal.
        ctx.effect(() => {
          let disposed = false;
          let timer = null;
          const tick = async () => {
            try {
              const next = await probe();
              if (!disposed) publish(next);
            } catch {
              if (!disposed) {
                publish({
                  phase: "unknown",
                  uptimeSeconds: null,
                  httpStatus: null,
                  checkedAt: Date.now(),
                  error: "probe failed",
                });
              }
            }
          };
          void tick();
          timer = setInterval(() => {
            void tick();
          }, POLL_MS);
          return () => {
            disposed = true;
            if (timer !== null) clearInterval(timer);
          };
        }, "sportsdesk desk-status: health poll");

        // The row lives only while its owner (the composer bar entry) exists.
        ctx.slots.inject("conversation.composer.dock", () =>
          ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "sportsdesk-desk-status",
              order: 40,
              locale: NS,
            },
            DeskStatusRow,
          ),
        );
      },
    };
  },
});
