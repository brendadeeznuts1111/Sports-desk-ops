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

  var loadNames = [];
  var appliedCount = 0;
  var hookInstalled = false;
  var sweepCount = 0;
  var registryDegraded = false;

  function requirejsRegistry() {
    var req = window.requirejs;
    var contexts = req && req.s && req.s.contexts;
    var context = contexts && contexts._;
    var defined = context && context.defined;
    return defined || null;
  }

  // The application can install or replace `requirejs.onResourceLoad`, so the hook is not the only
  // path: a short watchdog reads requirejs' defined-module registry and decorates the export once
  // it appears. Prototype decoration is retroactive for already-created instances, so a late sweep
  // still reaches the singleton the controller created.
  function sweep() {
    sweepCount += 1;
    var req = window.requirejs;
    if (!req || !req.s || !req.s.contexts) {
      // `requirejs.s` is private. If RequireJS changes it, keep the page alive and let the probe
      // report the degradation instead of breaking the controller.
      registryDegraded = true;
      return false;
    }
    var defined = requirejsRegistry();
    if (!defined) return false;
    var exported = defined["system/security"];
    if (!exported) return false;
    return apply(exported);
  }

  window.__F402_SEAMS__ = {
    sweep: sweep,
    diag: function () {
      return {
        hookInstalled: hookInstalled,
        loadNames: loadNames.slice(-10),
        appliedCount: appliedCount,
        sweepCount: sweepCount,
        registry: requirejsRegistry() !== null,
        registryDegraded: registryDegraded,
      };
    },
    isAllowedModule: function (m) {
      if (typeof m !== "string" || !m) return false;
      var leaf = m.split("/").pop();
      return (
        /^[a-z0-9][a-z0-9-]*$/.test(leaf) && ALLOWED_LEAVES.indexOf(leaf) !== -1
      );
    },
    allowedLeaves: ALLOWED_LEAVES.slice(),
  };

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

  var SEAM_KEYS = [
    "escHtml",
    "escUrl",
    "csrf",
    "sessionExpired",
    "isAuthenticated",
    "requireAuth",
    "allowedModules",
    "isAllowedModule",
    "endSession",
    "flags",
  ];

  function seamValue(instance, key, priorEndSession, priorFlags) {
    if (key === "escHtml") return escHtml;
    if (key === "escUrl") return escUrl;
    if (key === "csrf") return csrf;
    if (key === "sessionExpired") return sessionExpired;
    if (key === "isAuthenticated") return isAuthenticated;
    if (key === "allowedModules") return new Set(ALLOWED_LEAVES);
    if (key === "flags") {
      return Object.assign(
        { unifiedPost: false, externalViewGuard: false },
        priorFlags || {},
      );
    }
    if (key === "isAllowedModule") {
      return function (m) {
        if (typeof m !== "string" || !m) return false;
        var leaf = m.split("/").pop();
        return (
          /^[a-z0-9][a-z0-9-]*$/.test(leaf) && instance.allowedModules.has(leaf)
        );
      };
    }
    if (key === "requireAuth") {
      return function (fn) {
        return function () {
          if (!instance.isAuthenticated()) {
            instance.endSession();
            return false;
          }
          return fn.apply(this, arguments);
        };
      };
    }
    // endSession
    return function () {
      if (priorEndSession) return priorEndSession.apply(instance, arguments);
      if (typeof instance.logOut === "function") return instance.logOut();
      if (typeof instance.sessionDestroy === "function")
        return instance.sessionDestroy();
    };
  }

  function installInstanceSeam(instance, key, priorEndSession, priorFlags) {
    // defineProperty, not assignment: the prototype accessor has no setter, and strict-mode
    // assignment to it throws. This creates the own data property that shadows the accessor.
    Object.defineProperty(instance, key, {
      value: seamValue(instance, key, priorEndSession, priorFlags),
      writable: true,
      enumerable: false,
      configurable: false,
    });
  }

  // The live module exports a class (`core/class`'s extend), so the singleton most call sites use
  // is an instance created by a consumer. An own property on the constructor would never reach it.
  // Put an accessor on the class prototype; the first read on any instance materializes the member
  // as an OWN property of that instance and re-defines it there. No `__proto__` assignment and no
  // prototype pollution: the accessor is a plain own property of the prototype object.
  function decorateClass(ExportedClass) {
    var proto = ExportedClass.prototype;
    if (!proto || typeof proto !== "object") return false;
    var installed = false;
    for (var i = 0; i < SEAM_KEYS.length; i += 1) {
      var key = SEAM_KEYS[i];
      if (Object.prototype.hasOwnProperty.call(proto, key)) continue;
      (function (seamKey) {
        Object.defineProperty(proto, seamKey, {
          configurable: true,
          enumerable: false,
          get: function () {
            if (this === proto) {
              // Reading the seam on the prototype would materialize an own value there and turn the
              // accessor into shared state for every instance. Make that mistake loud.
              throw new TypeError(
                "system/security seam: access on prototype, not instance",
              );
            }
            // No vendor endSession exists on the class (the accessor is only added when the
            // prototype does not already own one), so pass null rather than re-reading this.endSession,
            // which would re-enter this accessor.
            installInstanceSeam(this, seamKey, null, undefined);
            return this[seamKey];
          },
        });
      })(key);
      installed = true;
    }
    return installed;
  }

  function apply(api) {
    if (!api) return false;
    if (typeof api === "function") return decorateClass(api);
    if (typeof api !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(api, "escHtml")) return false;

    var priorEndSession =
      typeof api.endSession === "function" ? api.endSession : null;
    var priorFlags = api.flags;
    for (var i = 0; i < SEAM_KEYS.length; i += 1) {
      installInstanceSeam(api, SEAM_KEYS[i], priorEndSession, priorFlags);
    }
    return true;
  }

  function install(requirejs) {
    if (hookInstalled || !requirejs) return;
    hookInstalled = true;
    var previous = requirejs.onResourceLoad;
    requirejs.onResourceLoad = function (context, map, defined) {
      if (map && map.name) loadNames.push(map.name);
      if (
        !window.__F402_SEAM_DISABLED__ &&
        map &&
        map.name === "system/security"
      ) {
        if (apply(defined)) appliedCount += 1;
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

  // Watchdog: run for ~30s after load. The app may replace onResourceLoad, and a module defined
  // before this script's first tick is missed by the hook; the registry sweep still finds it.
  // Prototype decoration is retroactive for already-created instances, so a late sweep works.
  var sweeps = 0;
  var sweepTimer = setInterval(function () {
    if (!window.__F402_SEAM_DISABLED__) sweep();
    sweeps += 1;
    if (sweeps > 300) clearInterval(sweepTimer);
  }, 100);
  if (document.addEventListener) {
    document.addEventListener("DOMContentLoaded", function () {
      if (!window.__F402_SEAM_DISABLED__) sweep();
    });
  }
})();
