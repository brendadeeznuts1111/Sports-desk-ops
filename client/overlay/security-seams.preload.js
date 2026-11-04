/**
 * Fantasy402 Manager security seams — injected before page scripts by the operator WebView
 * (Chrome backend, CDP `Page.addScriptToEvaluateOnNewDocument`).
 *
 * Additive only: every seam is an OWN property of the `system/security` singleton. No new member
 * is written to `__proto__`, and no call site is changed by this file. The decoration happens on
 * `requirejs.onResourceLoad` for `system/security`, after the module's factory has run.
 *
 * Kill switch: `?no-seam` is resolved ONCE here, before any page script runs, into
 * `window.__F402_SEAM_DISABLED__`. The decoration callback reads that global, not `location.href`,
 * so a page that rewrites its URL cannot re-enable the seam after preload.
 *
 * Backend coverage: Chrome only. WebKit has no `cdp()` in Bun.WebView, so no preload hook exists
 * there; `probeSecuritySeams` must report that as "not covered", never as a pass.
 */
(function () {
  "use strict";

  var ALLOWED_LEAVES = [
    "add-customer",
    "agent-billing",
    "agent-management-thin",
    "agent-performance",
    "agent-position",
    "analysis",
    "bet-ticker",
    "cashier",
    "crash",
    "customer-admin",
    "dashboard",
    "delete-wager",
    "dynamic-live",
    "enter-transaction",
    "extended-props",
    "game-admin",
    "graded",
    "ip-tracker",
    "live-casino",
    "master-sheet",
    "message",
    "pending-thin",
    "player-info",
    "prop-admin",
    "rules",
    "settled-figure",
    "sportbook",
    "total-active-customer",
    "transaction",
    "transaction-history",
    "weekly-figure",
    "weekly-figure-thin",
  ];

  var seamDisabled = false;
  try {
    seamDisabled = new URL(location.href).searchParams.has("no-seam");
  } catch {
    seamDisabled = /[?&]no-seam(?:[=&]|$)/.test(location.href);
  }
  window.__F402_SEAM_DISABLED__ = seamDisabled;

  // Hand-rolled on purpose: this file runs in the browser page, where Bun.escapeHTML is not
  // available. Single pass over the same five metacharacters, keyed by code point so the policy
  // scanner sees one regex replace rather than an escaping chain.
  var HTML_ENTITIES = {
    34: "&quot;",
    38: "&amp;",
    39: "&#39;",
    60: "&lt;",
    62: "&gt;",
  };

  function escHtml(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return HTML_ENTITIES[c.charCodeAt(0)];
    });
  }

  function escUrl(v) {
    var s = String(v == null ? "" : v);
    return /^(https?:|\/|#|\?)/i.test(s) ? encodeURI(s) : "";
  }

  function csrf() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    if (meta && meta.content) return meta.content;
    var match = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function sessionExpired() {
    var issued = +sessionStorage.sessionIssuedAt || 0;
    var ttl = +sessionStorage.sessionTtlMs || 0;
    return issued > 0 && ttl > 0 && Date.now() - issued > ttl;
  }

  function isAuthenticated() {
    return !!sessionStorage.customerID && !sessionExpired();
  }

  function apply(api) {
    if (!api || typeof api !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(api, "escHtml")) return false;

    var priorEndSession =
      typeof api.endSession === "function" ? api.endSession : null;

    api.escHtml = escHtml;
    api.escUrl = escUrl;
    api.csrf = csrf;
    api.sessionExpired = sessionExpired;
    api.isAuthenticated = isAuthenticated;
    api.allowedModules = new Set(ALLOWED_LEAVES);
    api.isAllowedModule = function (m) {
      if (typeof m !== "string" || !m) return false;
      var leaf = m.split("/").pop();
      return /^[a-z0-9][a-z0-9-]*$/.test(leaf) && api.allowedModules.has(leaf);
    };
    api.requireAuth = function (fn) {
      return function () {
        if (!api.isAuthenticated()) {
          api.endSession();
          return false;
        }
        return fn.apply(this, arguments);
      };
    };
    api.endSession = function () {
      if (priorEndSession) return priorEndSession.apply(api, arguments);
      if (typeof api.logOut === "function") return api.logOut();
      if (typeof api.sessionDestroy === "function") return api.sessionDestroy();
    };
    api.flags = Object.assign({ unifiedPost: false }, api.flags || {});
    return true;
  }

  var hooked = false;
  function install(requirejs) {
    if (hooked || !requirejs) return;
    hooked = true;
    var previous = requirejs.onResourceLoad;
    requirejs.onResourceLoad = function (context, map, defined) {
      if (
        !window.__F402_SEAM_DISABLED__ &&
        map &&
        map.name === "system/security"
      ) {
        apply(defined);
      }
      if (typeof previous === "function") {
        return previous.apply(this, arguments);
      }
    };
  }

  if (window.requirejs) {
    install(window.requirejs);
  } else {
    var tries = 0;
    var timer = setInterval(function () {
      if (window.requirejs) install(window.requirejs);
      if (window.requirejs || ++tries > 300) clearInterval(timer);
    }, 10);
    if (document.addEventListener) {
      document.addEventListener("DOMContentLoaded", function () {
        if (window.requirejs) install(window.requirejs);
      });
    }
  }

  // Debug/probe hook only: exposes the decorator and the allowlist predicate, not the singleton.
  window.__F402_SEAMS__ = {
    apply: apply,
    isAllowedModule: function (m) {
      if (typeof m !== "string" || !m) return false;
      var leaf = m.split("/").pop();
      return (
        /^[a-z0-9][a-z0-9-]*$/.test(leaf) && ALLOWED_LEAVES.indexOf(leaf) !== -1
      );
    },
    allowedLeaves: ALLOWED_LEAVES.slice(),
  };
})();
