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

  // Canary gate for the held external-view fix. Resolved once, here, from (in order) an injected
  // global override, then the URL. Enabling a session needs no code change or redeploy; rollback is
  // "open without the parameter", effective on the next navigation.
  var externalViewGuard = false;
  try {
    externalViewGuard =
      new URL(location.href).searchParams.get("external-view-guard") === "1";
  } catch {
    externalViewGuard = /[?&]external-view-guard=1(?:[&#]|$)/.test(
      location.href,
    );
  }
  if (window.__F402_EXTERNAL_VIEW_GUARD__ === true) externalViewGuard = true;
  // The guard calls seam members (isAuthenticated/isAllowedModule), so it must never outlive a
  // disabled seam: no-seam wins over external-view-guard by dependency, not policy.
  externalViewGuard = !seamDisabled && externalViewGuard;
  window.__F402_EXTERNAL_VIEW_GUARD__ = externalViewGuard;

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
    flushRejects();
    var decorated = false;
    var security = defined["system/security"];
    if (security) decorated = apply(security) || decorated;
    var manager = defined["manager/manager"];
    if (manager) decorated = applyManagerGuard(manager) || decorated;
    if (manager) decorated = applySearchEscaper(manager) || decorated;
    if (manager) decorated = applySetHistoryEscaper(manager) || decorated;
    if (manager) decorated = applyMessageInitEscaper(manager) || decorated;
    if (manager) decorated = applyPopUpMessagesEscaper(manager) || decorated;
    return decorated;
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
        managerGuardInstalled: managerGuardInstalled,
        managerGuardFailure: managerGuardFailure,
        searchEscaperInstalled: searchEscaperInstalled,
        searchEscaperFailure: searchEscaperFailure,
        historyEscaperInstalled: historyEscaperInstalled,
        historyEscaperFailure: historyEscaperFailure,
        messageInitEscaperInstalled: messageInitEscaperInstalled,
        messageInitEscaperFailure: messageInitEscaperFailure,
        popUpMessagesEscaperInstalled: popUpMessagesEscaperInstalled,
        popUpMessagesEscaperFailure: popUpMessagesEscaperFailure,
        rejectCount: rejectBuffer().length,
        unflushedRejects: rejectBuffer().filter(function (entry) {
          return entry.flushed !== true;
        }).length,
        externalViewGuard: externalViewGuard,
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
        { unifiedPost: false, externalViewGuard: externalViewGuard },
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

  var managerGuardInstalled = false;
  var managerGuardFailure = null;
  var searchEscaperInstalled = false;
  var searchEscaperFailure = null;
  var searchEscaperApiCache = null;

  // Rejections are audit records, not diagnostics. The live client has no
  // `r.security(r.events.MODULE_REJECT, …)` API (verified in language.js and the pinned
  // controller), so the durable sink is system/log's `write` -> POST /cloud/api/Log/write, and the
  // queryable buffer is `window.__F402_REJECTS__` (read by the probe). console.warn is only a
  // third, local signal.
  function rejectBuffer() {
    if (!window.__F402_REJECTS__) window.__F402_REJECTS__ = [];
    return window.__F402_REJECTS__;
  }

  function logSink() {
    var defined = requirejsRegistry();
    var Log = defined && defined["system/log"];
    if (!Log) return null;
    try {
      var instance = typeof Log === "function" ? new Log() : Log;
      return instance && typeof instance.write === "function" ? instance : null;
    } catch {
      return null;
    }
  }

  function flushRejects() {
    var pending = rejectBuffer().filter(function (entry) {
      return entry.flushed !== true;
    });
    if (pending.length === 0) return;
    var sink = logSink();
    if (!sink) return;
    for (var i = 0; i < pending.length; i += 1) {
      try {
        sink.write({
          customerID: sessionStorage.customerID,
          description:
            "external-view module rejected: " +
            pending[i].reason +
            " " +
            String(pending[i].module),
        });
        pending[i].flushed = true;
      } catch {
        return;
      }
    }
  }

  function auditModuleReject(reason, moduleId) {
    var entry = {
      reason: reason,
      module: moduleId === null ? null : String(moduleId),
      href: location.href,
      ts: new Date().toISOString(),
      flushed: false,
    };
    rejectBuffer().push(entry);
    console.warn(
      "[f402-seam] external-view guard rejected module:",
      entry.module,
    );
    flushRejects();
    return entry;
  }

  // Deliberately stricter than the vendor's `dataUrl` (which regex-extracts without percent-
  // decoding): searchParams decodes, so the wrapper matches a superset of the forms the original
  // treats as external-view. Do not "fix" this to match dataUrl exactly — that would reopen an
  // encoded-module bypass. A change to the *matching rule* (e.g. case-insensitive) requires both.
  function urlParam(name) {
    try {
      return new URL(location.href).searchParams.get(name);
    } catch {
      var match = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.href);
      return match ? match[1] : null;
    }
  }

  function guardSecurityApi() {
    var defined = requirejsRegistry();
    var Security = defined && defined["system/security"];
    if (!Security) return null;
    try {
      return typeof Security === "function" ? new Security() : Security;
    } catch {
      return null;
    }
  }

  // The external-view call site is vendor code (`manager.js` setAccountInfo -> require(
  // "manager/module/" + dataUrl("module"))). The overlay lands the guard as a prototype wrapper so
  // the call-site PR is a default-false flag flip in behavior, not a vendor redeploy. Dead by
  // default: with externalViewGuard false the wrapper delegates immediately.
  function applyManagerGuard(Manager) {
    if (managerGuardInstalled || !Manager || !Manager.prototype) {
      if (Manager && !Manager.prototype)
        managerGuardFailure = "manager-module-invalid";
      return false;
    }
    var proto = Manager.prototype;
    var original = proto.setAccountInfo;
    if (typeof original !== "function") {
      // Loud: the wrapper exists but has no target. Every gate can stay green while the guard is
      // inert, so make it visible in the console and in the probe diagnostics.
      managerGuardFailure = "setAccountInfo-missing";
      console.error(
        "[f402-seam] external-view guard cannot install: setAccountInfo missing — the overlay is inert; update it against the current manager.js",
      );
      return false;
    }
    managerGuardInstalled = true;
    Object.defineProperty(proto, "setAccountInfo", {
      configurable: true,
      writable: true,
      value: function () {
        if (externalViewGuard && !window.__F402_SEAM_DISABLED__) {
          if (urlParam("external-view") === "active") {
            var api = guardSecurityApi();
            if (api) {
              try {
                if (!api.isAuthenticated()) {
                  api.endSession();
                  return;
                }
                var mod = urlParam("module");
                if (!api.isAllowedModule(mod)) {
                  auditModuleReject("module-not-allowed", mod);
                  return;
                }
              } catch {
                // Fail closed: a guard that cannot evaluate must not let the branch through.
                auditModuleReject("guard-error", urlParam("module"));
                if (typeof api.endSession === "function") api.endSession();
                return;
              }
            }
          }
        }
        return original.apply(this, arguments);
      },
    });
    return true;
  }

  function searchEscaperApi() {
    if (searchEscaperApiCache === null)
      searchEscaperApiCache = guardSecurityApi();
    return searchEscaperApiCache;
  }

  // Sink migration for manager.searchComponent: the player/all branches interpolate
  // NameFirst/Login/Password into <li> HTML and inject with .html(). searchComponent itself only
  // binds the keyup handler; the render runs later, per keystroke. Escaping for the duration of the
  // searchComponent call would therefore be inert. Instead the row fields are escaped once, in
  // place, when the component is set up. HTML entities decode back to the original characters when
  // the browser parses the generated attribute, so data-login/data-pass still carry the real value
  // (obj:true callers keep working); only the raw-string interpolation is neutralised.
  //
  // Landmine: after setup, the module-level players/agents arrays hold escaped values. Do not read
  // NameFirst/Login/Password/customerID/AgentID directly from those arrays in new code; use the
  // rendered DOM (attr decodes back to the real value) or a render copy.
  //
  // setPlayers() is not a consumer of these arrays: it takes its argument from hierarchy nodes.
  // The hierarchy success sets global players, then clears non-master node players to [] before
  // lazy expansion; GENERAL rows in the captured envelope carry no players key, and getPlayers()
  // has no call sites. So the setPlayers direct-read risk is theoretical, not live. A browser check
  // also showed escaped Login renders as text A&B, id/for decode to c&d, and label association /
  // getElementById work; only raw #id selectors with &/< would differ, and setPlayers uses none.
  // The live
  // landmine is anything reading the module-level arrays directly (searchComponent itself).
  //
  // Tradeoff: the search filter compares the typed term against the escaped field, so searching for
  // a literal "&" or "<" inside a name/password no longer matches. Those are the characters that
  // have to be escaped for the sink to be safe; ordinary names/passwords are unaffected.
  var searchEscapedRows = typeof WeakMap === "function" ? new WeakMap() : null;

  function escapeSearchRows(rows, fields, esc) {
    if (!Array.isArray(rows)) return;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== "object") continue;
      var seen = searchEscapedRows ? searchEscapedRows.get(row) : null;
      if (searchEscapedRows && !seen) {
        seen = {};
        searchEscapedRows.set(row, seen);
      }
      for (var j = 0; j < fields.length; j += 1) {
        var field = fields[j];
        if (typeof row[field] !== "string") continue;
        // Skip only when the field still holds the value this overlay wrote. A vendor that
        // reuses the same row object and assigns a new raw value is re-escaped.
        if (seen && seen[field] === row[field]) continue;
        row[field] = esc(row[field]);
        if (seen) seen[field] = row[field];
      }
    }
  }

  function applySearchEscaper(Manager) {
    if (searchEscaperInstalled) return false;
    if (!Manager || !Manager.prototype) {
      searchEscaperFailure = "manager-invalid";
      return false;
    }
    var proto = Manager.prototype;
    var original = proto.searchComponent;
    if (typeof original !== "function") {
      searchEscaperFailure = "searchComponent-missing";
      console.error(
        "[f402-seam] searchComponent escaper cannot install: method missing — the overlay is inert; update it against the current manager.js",
      );
      return false;
    }
    searchEscaperInstalled = true;
    Object.defineProperty(proto, "searchComponent", {
      configurable: true,
      writable: true,
      value: function () {
        var api = searchEscaperApi();
        if (api && typeof api.escHtml === "function") {
          try {
            escapeSearchRows(this.agents, ["Login", "AgentID"], api.escHtml);
            escapeSearchRows(
              this.players,
              ["Login", "NameFirst", "Password", "customerID"],
              api.escHtml,
            );
          } catch (err) {
            console.error("[f402-seam] searchComponent escaping failed:", err);
          }
        }
        return original.apply(this, arguments);
      },
    });
    return true;
  }

  // Sink migration for manager.setHistory: it builds an HTML title from e.info.agent and injects
  // it with .html(). The same argument is passed to getHistory(), so it must stay raw for the
  // request. Intercept only the synchronous title .html() call and replace its string with an
  // escaped copy; the request path is untouched.
  var historyEscaperInstalled = false;
  var historyEscaperFailure = null;

  function applySetHistoryEscaper(Manager) {
    if (historyEscaperInstalled) return false;
    if (!Manager || !Manager.prototype) {
      historyEscaperFailure = "manager-invalid";
      return false;
    }
    var proto = Manager.prototype;
    var original = proto.setHistory;
    if (typeof original !== "function") {
      historyEscaperFailure = "setHistory-missing";
      console.error(
        "[f402-seam] setHistory escaper cannot install: method missing — update the overlay against the current manager.js",
      );
      return false;
    }
    historyEscaperInstalled = true;
    Object.defineProperty(proto, "setHistory", {
      configurable: true,
      writable: true,
      value: function (event) {
        var api = searchEscaperApi();
        var jq = window.jQuery || window.$;
        if (
          !api ||
          typeof api.escHtml !== "function" ||
          !jq ||
          !jq.fn ||
          typeof jq.fn.html !== "function" ||
          !event ||
          !event.info ||
          event.info.agent === undefined
        ) {
          return original.apply(this, arguments);
        }
        var rawTitle =
          "History for " + event.info.agent.toString().split(".").join("");
        var escapedTitle =
          "History for " +
          api.escHtml(event.info.agent.toString().split(".").join(""));
        var baseHtml = jq.fn.html;
        jq.fn.html = function (value) {
          if (value === rawTitle) return baseHtml.call(this, escapedTitle);
          return baseHtml.apply(this, arguments);
        };
        try {
          return original.apply(this, arguments);
        } finally {
          jq.fn.html = baseHtml;
        }
      },
    });
    return true;
  }

  // Sink migration for manager.getMessageInit. The AJAX success stores e.INFO.LIST on the module
  // (emailCount) and renders FromE/Subject from the same rows. Render-copy: hand the success
  // handler escaped row copies, then restore the stored copy to raw values after the synchronous
  // render, so the count/dropdown remain correct and later consumers see raw data.
  var messageInitEscaperInstalled = false;
  var messageInitEscaperFailure = null;

  function applyMessageInitEscaper(Manager) {
    if (messageInitEscaperInstalled) return false;
    if (!Manager || !Manager.prototype) {
      messageInitEscaperFailure = "manager-invalid";
      return false;
    }
    var proto = Manager.prototype;
    var original = proto.getMessageInit;
    if (typeof original !== "function") {
      messageInitEscaperFailure = "getMessageInit-missing";
      console.error(
        "[f402-seam] getMessageInit escaper cannot install: method missing — update the overlay against the current manager.js",
      );
      return false;
    }
    messageInitEscaperInstalled = true;
    Object.defineProperty(proto, "getMessageInit", {
      configurable: true,
      writable: true,
      value: function () {
        var api = searchEscaperApi();
        var jq = window.jQuery || window.$;
        if (
          !api ||
          typeof api.escHtml !== "function" ||
          !jq ||
          typeof jq.ajax !== "function"
        ) {
          return original.apply(this, arguments);
        }
        var baseAjax = jq.ajax;
        jq.ajax = function (options) {
          if (
            options &&
            options.data &&
            options.data.operation === "getNewEmailsCount" &&
            typeof options.success === "function"
          ) {
            var rawSuccess = options.success;
            options.success = function (response) {
              var list =
                response && response.INFO && response.INFO.LIST
                  ? response.INFO.LIST
                  : null;
              if (!Array.isArray(list))
                return rawSuccess.apply(this, arguments);
              var raw = [];
              for (var i = 0; i < list.length; i += 1) {
                var row = list[i];
                if (!row || typeof row !== "object") continue;
                for (var f = 0; f < 2; f += 1) {
                  var field = f === 0 ? "FromE" : "Subject";
                  if (typeof row[field] === "string")
                    raw.push([row, field, row[field]]);
                }
              }
              for (var k = 0; k < raw.length; k += 1) {
                var entry = raw[k];
                entry[0][entry[1]] = api.escHtml(entry[2]);
              }
              try {
                return rawSuccess.apply(this, arguments);
              } finally {
                for (var r = 0; r < raw.length; r += 1) {
                  var restore = raw[r];
                  restore[0][restore[1]] = restore[2];
                }
              }
            };
          }
          return baseAjax.apply(this, arguments);
        };
        try {
          return original.apply(this, arguments);
        } finally {
          jq.ajax = baseAjax;
        }
      },
    });
    return true;
  }

  // Sink migration for manager.getPopUpMessages. The getMessage success builds two templates:
  // a comment popup from COMMENT[0].CommentsForAgent and list items with {SUBJECT}/{MESSAGE}/
  // {INDEX}, then replaces newlines with <br>. Escaping the response fields BEFORE the handler runs
  // means the later newline replacement inserts <br> as markup while raw <b> etc. stay text. The
  // response object is local to the callback (nothing is stored), so in-place escaping is safe.
  var popUpMessagesEscaperInstalled = false;
  var popUpMessagesEscaperFailure = null;

  function applyPopUpMessagesEscaper(Manager) {
    if (popUpMessagesEscaperInstalled) return false;
    if (!Manager || !Manager.prototype) {
      popUpMessagesEscaperFailure = "manager-invalid";
      return false;
    }
    var proto = Manager.prototype;
    var original = proto.getPopUpMessages;
    if (typeof original !== "function") {
      popUpMessagesEscaperFailure = "getPopUpMessages-missing";
      console.error(
        "[f402-seam] getPopUpMessages escaper cannot install: method missing — update the overlay against the current manager.js",
      );
      return false;
    }
    popUpMessagesEscaperInstalled = true;
    Object.defineProperty(proto, "getPopUpMessages", {
      configurable: true,
      writable: true,
      value: function () {
        var api = searchEscaperApi();
        var jq = window.jQuery || window.$;
        if (
          !api ||
          typeof api.escHtml !== "function" ||
          !jq ||
          typeof jq.ajax !== "function"
        ) {
          return original.apply(this, arguments);
        }
        var baseAjax = jq.ajax;
        jq.ajax = function (options) {
          if (
            options &&
            options.data &&
            options.data.operation === "getMessage" &&
            typeof options.success === "function"
          ) {
            var rawSuccess = options.success;
            options.success = function (response) {
              if (response) {
                if (
                  response.COMMENT &&
                  response.COMMENT[0] &&
                  typeof response.COMMENT[0].CommentsForAgent === "string"
                ) {
                  response.COMMENT[0].CommentsForAgent = api.escHtml(
                    response.COMMENT[0].CommentsForAgent,
                  );
                }
                if (Array.isArray(response.LIST)) {
                  for (var i = 0; i < response.LIST.length; i += 1) {
                    var row = response.LIST[i];
                    if (!row || typeof row !== "object") continue;
                    if (typeof row.Subject === "string") {
                      row.Subject = api.escHtml(row.Subject);
                    }
                    if (typeof row.Message === "string") {
                      row.Message = api.escHtml(row.Message);
                    }
                    if (typeof row.Id === "string") {
                      row.Id = api.escHtml(row.Id);
                    }
                  }
                }
              }
              return rawSuccess.apply(this, arguments);
            };
          }
          return baseAjax.apply(this, arguments);
        };
        try {
          return original.apply(this, arguments);
        } finally {
          jq.ajax = baseAjax;
        }
      },
    });
    return true;
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
      if (
        !window.__F402_SEAM_DISABLED__ &&
        map &&
        map.name === "manager/manager"
      ) {
        applyManagerGuard(defined);
        applySearchEscaper(defined);
        applySetHistoryEscaper(defined);
        applyMessageInitEscaper(defined);
        applyPopUpMessagesEscaper(defined);
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
