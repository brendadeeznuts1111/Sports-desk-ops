#!/usr/bin/env node
/**
 * Structural + behavioural load test for the SportsDesk desk-panel bundle.
 *
 * WHAT THIS PROVES (without a browser)
 *
 * Client half (`client.js`): parses, registers its lazy factory under the
 * package name, builds a side-effect-free module, and `apply` installs exactly
 * one locale dictionary plus the two registrations that make the left-sidebar
 * entry work — `sidebar.panellist` (the icon list) and `main` (the page that
 * entry selects) under the SAME id. With a stubbed fetch it drives the one
 * shared five-source store through the real probe path:
 *
 *   - the first render is "checking…", never a healthy claim;
 *   - all five sources (health, status, graph, kpis, execution) are probed
 *     independently through the same-origin proxy, and a captured 2026-11-04
 *     fixture for each one parses into the Market feed / Book / Paper execution
 *     cards with the measured values (cents→USD, counts, provenance ages);
 *   - a current service renders runtime/PID/memory/Telegram/schedules,
 *     "Harness proxy" provenance and the raw /health + /api/status links;
 *   - a failed source (graph 502) leaves the other cards rendered, names its
 *     reason and offers Retry; a missing source (execution 404) renders
 *     "missing", never a fake zero;
 *   - a source that fails AFTER a good payload keeps the last good values
 *     visible, labelled "Showing the last good measurement from …";
 *   - a 2xx non-JSON body is a source error;
 *   - partial payloads render only measured fields (missing decisions is
 *     "unknown", absent sections are omitted);
 *   - attention is derived from measured conditions only and is quiet for a
 *     fully healthy desk;
 *   - Retry re-probes the whole snapshot and recovers a failed source;
 *   - a stale service (no `ingress`, /api/status 404) renders "stale build" with
 *     the missing pieces and the `PORT=4020 bun run serve` command; a refused
 *     health probe renders "service down"; an /api/status 5xx is unknown;
 *   - the sidebar glyph renders the same measured service phase as a corner dot
 *     (and tracks only the phase, not the overview sources);
 *   - disposal removes the slot registrations and locale dictionary, aborts the
 *     in-flight probe, removes the visibility listener, and publishes nothing
 *     afterwards.
 *
 * Host half (`index.js`): registers the five allowlisted same-origin GET proxy
 * routes, answers 405 for other methods and 403 for a foreign Origin (both with
 * the proxy marker), forwards the upstream status/body/content-type with
 * `cache-control: no-store` and the marker, caps an oversized upstream document
 * at 502 `response_too_large`, turns an unreachable desk service into 502 JSON
 * (never a healthy response), and unregisters every route on disposal.
 *
 * It also checks that visible copy exists in every supplied locale, that every
 * dictionary key the client uses is present in BOTH locales, that the locale
 * JSON metadata files agree on their keys, and that the page chrome uses only
 * `--dsw-alias-*` tokens rather than literal colors.
 *
 * WHAT THIS DOES NOT PROVE: that the entry appears, is positioned, or looks
 * right in the running Web UI. That needs the connected page; without browser
 * control this script must not be reported as visual verification.
 *
 * Run: bun dsh-plugin-sidebar/verify-load.mjs
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const HERE = import.meta.dirname;

/**
 * The bundle's own files, read once through Bun.file. The script runs under Bun (like the sibling
 * plug-in verifiers), so no synchronous node:fs read is needed; `read` stays synchronous for the
 * checks below.
 */
const SOURCE_TEXT = await (async () => {
  const files = [];
  for (const entry of readdirSync(HERE, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      for (const child of readdirSync(join(HERE, entry.name), {
        withFileTypes: true,
      })) {
        if (child.isFile()) files.push(`${entry.name}/${child.name}`);
      }
    }
  }
  const pairs = await Promise.all(
    files.map(async (name) => [name, await Bun.file(join(HERE, name)).text()]),
  );
  return new Map(pairs);
})();
const read = (name) => SOURCE_TEXT.get(name) ?? "";

let failed = 0;
const passed = [];
function check(label, body) {
  try {
    body();
    passed.push(label);
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}
async function checkAsync(label, body) {
  try {
    await body();
    passed.push(label);
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* --- manifest ----------------------------------------------------------- */

const pkg = JSON.parse(read("package.json"));

check("manifest declares a bundle patch", () => {
  assert(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch");
  assert(pkg.dsh?.client?.platform === "web", "dsh.client.platform");
  assert(pkg.dsh?.client?.immediately === true, "dsh.client.immediately");
  const inject = pkg.dsh?.client?.inject ?? [];
  for (const name of [
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-sidebar",
    "@deepseek-ai/dsh-client-locale",
  ]) {
    assert(inject.includes(name), `dsh.client.inject missing ${name}`);
  }
});

check("manifest exports every runtime file and lists them in files", () => {
  assert(pkg.exports?.["./client"] === "./client.js", "exports ./client");
  assert(
    pkg.exports?.["./package.json"] === "./package.json",
    "exports ./package.json",
  );
  assert(pkg.exports?.["./icon"] === "./icon.svg", "exports ./icon");
  assert(
    pkg.exports?.["./locale/*.json"] === "./locale/*.json",
    "exports ./locale/*.json",
  );
  for (const required of [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "icon.svg",
    "README.md",
  ]) {
    assert(pkg.files?.includes(required), `files missing ${required}`);
  }
  assert(pkg.files?.includes("locale/*.json"), "files missing locale/*.json");
});

check("patch inserts one row named after the package", () => {
  const patch = read("cordis.patch.yml");
  assert(/insert:/.test(patch), "patch has no insert");
  assert(patch.includes(pkg.name), "patch does not name the package");
  const rowId = patch.match(/-\s+id:\s*(\S+)/)?.[1];
  assert(rowId === "sportsdesk-desk-panel", `unexpected row id ${rowId}`);
});

check("locale metadata is a real title and description in both locales", () => {
  for (const locale of ["en", "zh"]) {
    const meta = JSON.parse(read(`locale/${locale}.json`)).meta;
    assert(
      typeof meta?.title === "string" && meta.title.length > 2,
      `${locale} meta.title`,
    );
    assert(
      typeof meta?.description === "string" && meta.description.length > 20,
      `${locale} meta.description`,
    );
    assert(
      !/my-decoration|Composer decoration|blue circle/i.test(
        JSON.stringify(meta),
      ),
      `${locale} template copy`,
    );
  }
});

check("locale metadata files agree on their key sets", () => {
  const en = Object.keys(JSON.parse(read("locale/en.json")).meta).sort();
  const zh = Object.keys(JSON.parse(read("locale/zh.json")).meta).sort();
  assert(Bun.deepEquals(en, zh), "en/zh locale metadata keys differ");
});

check("icon is a bounded, self-contained SVG", () => {
  const svg = read("icon.svg");
  assert(svg.trimStart().startsWith("<svg"), "not an SVG");
  assert(Buffer.byteLength(svg) <= 256 * 1024, "icon over 256 KiB");
  assert(
    !/(href|src)=["'](https?:)?\/\//.test(svg),
    "icon references an external resource",
  );
});

check("every file the bundle ships exists", () => {
  const expected = new Set([
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "icon.svg",
    "README.md",
  ]);
  for (const localeFile of readdirSync(join(HERE, "locale")))
    expected.add(`locale/${localeFile}`);
  for (const file of expected) read(file);
});

/* --- captured fixtures (2026-11-04 18:13 UTC, Scratch/plugin-v2/desk-panel) */

/**
 * The five payloads the desk service answered while running the current
 * checkout, trimmed to the fields the overview renders. They are the measured
 * shape the cards must parse — not hand-written expectations.
 */
const FIXTURE_HEALTH = {
  status: "healthy",
  port: 4020,
  hostname: "localhost",
  url: "http://localhost:4020/",
  timestamp: "2026-11-04T18:13:39.531Z",
  uptimeSeconds: 1_038,
  runtime: "Bun v1.4.4 (arm64-darwin)",
  ingress: { proxied: false, trustProxy: false },
  nodeEnv: "development",
};

const FIXTURE_STATUS = {
  ok: true,
  status: "serving",
  checks: { telegram: "ok" },
  health: {
    uptimeSeconds: 1_038,
    runtime: "Bun v1.4.4 (arm64-darwin)",
    memory: { rss: 45_695_888, heapTotal: 5_274_624 },
    pid: 68_955,
  },
  telegram: {
    status: {
      mode: "simulation",
      modeReason: "TELEGRAM_BOT_TOKEN is not set",
    },
    schedules: [
      {
        id: "sched_10m_positions_pulse",
        name: "10-Minute Live Volume & Positions Pulse",
        scheduleTime: "*/10 * * * *",
        enabled: true,
      },
      {
        id: "sched_morning_briefing",
        name: "Morning Risk Briefing",
        scheduleTime: "08:00",
        enabled: true,
      },
      {
        id: "sched_midday_pulse",
        name: "Midday Steam & Volatility Pulse",
        scheduleTime: "13:00",
        enabled: true,
      },
      {
        id: "sched_evening_settlement",
        name: "Evening Settlement Recap",
        scheduleTime: "23:00",
        enabled: true,
      },
      {
        id: "sched_bridge_rollup_15m",
        name: "Bridge Rollup Cycle (3a/3b/3c)",
        scheduleTime: "*/15 * * * *",
        enabled: true,
      },
      {
        id: "sched_bridge_weblog_hourly",
        name: "Bridge WebLog Rollup (hourly)",
        scheduleTime: "7 * * * *",
        enabled: true,
      },
    ],
  },
  timestamp: "2026-11-04T18:13:39.548Z",
};

const FIXTURE_GRAPH = {
  success: true,
  schemaVersion: 1,
  generatedAt: "2026-11-04T18:13:39.574Z",
  feed: {
    status: "measured",
    schemaVersion: 3,
    lastUpdatedIso: "2026-11-04T11:44:39.790Z",
    pollSequence: 1,
    dataMode: "PARTIAL",
    wssIngestion: "not_ingested",
    ageSeconds: 23_339,
    stale: true,
    counts: {
      activeWallets: 23,
      configuredWallets: 39,
      openLegs: 94,
      openExposureUsd: 64_139,
      pendingBets: 14,
      walletProfiles: 39,
      ipClusters: 13,
      liveTicks: 0,
    },
  },
  repo: {
    head: "d3a10ed",
    branch: "main",
    routes: { status: "derived", served: 63, exact: 61, prefix: 2 },
    citations: {
      status: "measured",
      checked: 441,
      anchors: 112,
      external: 33,
      asOf: "2026-11-04T17:29:12.250Z",
      ageSeconds: 2_667,
      stale: false,
    },
    checks: {
      routeSurface: { status: "derived", value: 63, ageSeconds: 0 },
      tests: {
        status: "measured",
        tests: 2_640,
        failures: 0,
        skipped: 27,
        ageSeconds: 4_480,
        stale: false,
      },
      typecheck: {
        status: "not_measured",
        reason: "not measured at request time",
      },
    },
  },
};

const FIXTURE_KPIS = {
  success: true,
  generatedAt: "2026-11-04T18:13:39.599Z",
  kpis: {
    agents: {
      total: 2_276,
      agents: 1_679,
      masters: 596,
      provenance: { ageSeconds: 4_435, stale: false },
    },
    pending: {
      wagers: 2,
      tickets: 2,
      wageredCents: 22_406_500,
      toWinCents: 20_006_500,
      provenance: { ageSeconds: 316_263, stale: true },
    },
    ticker: {
      wagers: 16,
      live: 0,
      riskCents: 105_225,
      volumeCents: 103_863,
      provenance: { ageSeconds: 64_556, stale: true, partial: true },
    },
    customerBook: {
      customers: 220,
      tickets: 1_100,
      customerNetCents: -118_120_894,
      provenance: { ageSeconds: 136_162, stale: false },
    },
  },
};

const FIXTURE_EXECUTION = {
  success: true,
  schemaVersion: 1,
  generatedAt: "2026-11-04T18:13:39.616Z",
  mode: "paper",
  killSwitch: false,
  policy: { mode: "paper", liveEnabled: false, maxOpenIntents: 25 },
  venues: {
    kalshi: { liveReady: false, reason: "api_key_id_missing" },
    polymarket: {
      liveReady: false,
      reason: "Polymarket live has no EIP-712 signer in this checkout",
    },
  },
  risk: {
    dailyPlannedUsd: 0,
    openIntents: 0,
    marketExposureUsd: {},
    dailyCapUsd: 5_000,
  },
  decisions: Array.from({ length: 13 }, (_, index) => ({
    id: `exec:fixture-${index}`,
    blocked: true,
    reasons: index === 12 ? ["maker_edge_below_min"] : ["no_book"],
    blockReason: index === 12 ? "maker_edge_below_min" : "no_book",
  })),
  blockedReasons: { no_book: 12, maker_edge_below_min: 1 },
  provenance: {
    fixture: true,
    stale: true,
    dataMode: "PARTIAL",
    asOf: "2026-11-04T11:44:39.790Z",
    ageSeconds: 23_339,
    sources: ["docs/graph-live-feed.json"],
  },
};

/**
 * The same payloads a real Host proxy would return for each URL, so a stubbed
 * fetch can answer the proxy and loopback paths from one table.
 * @param {string} url
 */
function fixtureFor(url) {
  const text = String(url);
  if (text.endsWith("/health")) return FIXTURE_HEALTH;
  if (text.endsWith("/status") || text.endsWith("/api/status")) {
    return FIXTURE_STATUS;
  }
  if (text.endsWith("/graph") || text.endsWith("/api/graph/summary")) {
    return FIXTURE_GRAPH;
  }
  if (text.endsWith("/kpis") || text.endsWith("/api/kpis")) return FIXTURE_KPIS;
  if (text.endsWith("/execution") || text.endsWith("/api/execution/plan")) {
    return FIXTURE_EXECUTION;
  }
  return { error: "not found" };
}

/* --- client module ------------------------------------------------------ */

const NS = "sportsdesk-desk-panel";

/** A response-shaped object; the client only calls `.json()` and `.headers`. */
function jsonBody(body, status = 200, proxied = false) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) =>
        proxied && name.toLowerCase() === "x-sportsdesk-desk-proxy"
          ? "proxied"
          : null,
    },
    json: async () => body,
  };
}

/** Mark proxy-path responses like the Host half does on the wire. */
function proxiedResponse(url, body, status = 200) {
  return jsonBody(
    body,
    status,
    String(url).startsWith("/api/sportsdesk-desk/"),
  );
}

/** A response-shaped object for the Host half, which calls `.text()`. */
function upstreamBody(text, status = 200, contentType = "application/json") {
  return {
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    text: async () => text,
  };
}

/** A document the client can attach a visibility listener to. */
function fakeDocument() {
  const listeners = new Map();
  return {
    visibilityState: "visible",
    added: 0,
    removed: 0,
    listeners,
    addEventListener(type, handler) {
      listeners.set(type, handler);
      this.added += 1;
    },
    removeEventListener(type) {
      listeners.delete(type);
      this.removed += 1;
    },
  };
}

/**
 * Boot one isolated client-module instance with a stubbed fetch and document.
 * Each call gets a fresh store, so scenarios cannot leak state into each other.
 * Component effects run when a component renders (this is a shim, not React),
 * which is what starts the real poll loop.
 *
 * `slots.register` returns a real disposer so the disposal checks can prove the
 * registrations are removed, matching the slot service's contract.
 */
function bootClient(fetchImpl) {
  const effectCleanups = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    memo: (fn) => fn,
    useState: (initial) => [
      typeof initial === "function" ? initial() : initial,
      () => {},
    ],
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useEffect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  let loaded;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          loaded = definition;
        },
      },
    },
    fetch: fetchImpl,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: fakeDocument(),
    console,
  };
  vm.runInNewContext(read("client.js"), sandbox, { filename: "client.js" });

  const plugin = loaded.factory((name) => {
    if (name === "react") return React;
    throw new Error(`unexpected module import: ${name}`);
  });

  const registrations = [];
  const dictionaries = new Map();
  const cleanups = [];
  const activeLocale = "en";
  let registeredDicts = null;

  const translate = (ns, key, params) => {
    const dict =
      dictionaries.get(ns)?.[activeLocale] ?? dictionaries.get(ns)?.en;
    const template = dict?.[key];
    assert(
      typeof template === "string",
      `missing ${activeLocale} translation ${ns}:${key}`,
    );
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      name in params ? String(params[name]) : match,
    );
  };

  const ctx = {
    effect(fn) {
      const dispose = fn();
      cleanups.push(dispose);
      return dispose;
    },
    locale: {
      register(ns, dicts) {
        dictionaries.set(ns, dicts);
        registeredDicts = dicts;
        return () => dictionaries.delete(ns);
      },
      bind(ns) {
        return (key, params) => translate(ns, key, params);
      },
    },
    slots: {
      inject(key, callback) {
        const dispose = callback();
        cleanups.push(dispose);
        return dispose;
      },
      register(options, component) {
        const entry = { options, component };
        registrations.push(entry);
        return () => {
          const index = registrations.indexOf(entry);
          if (index >= 0) registrations.splice(index, 1);
        };
      },
    },
  };

  plugin.apply(ctx);

  return {
    factoryId: loaded.id,
    plugin,
    registrations,
    dictionaries,
    translate,
    document: sandbox.document,
    /** Render one registered slot entry with its locale `t` seat. */
    render(name) {
      const entry = registrations.find((row) => row.options.name === name);
      assert(entry !== undefined, `no ${name} registration`);
      return entry.component({
        t: (key, params) => translate(NS, key, params),
      });
    },
    /** The `main` registration captured before disposal. */
    mainEntry() {
      const entry = registrations.find((row) => row.options.name === "main");
      assert(entry !== undefined, "no main registration");
      return entry;
    },
    /** A `t` seat backed by the dictionary reference, usable after disposal. */
    capturedSeat(locale = activeLocale) {
      return (key, params) => {
        const template =
          registeredDicts?.[locale]?.[key] ?? registeredDicts?.en?.[key];
        assert(typeof template === "string", `captured seat missing ${key}`);
        if (!params) return template;
        return template.replace(/\{(\w+)\}/g, (match, name) =>
          name in params ? String(params[name]) : match,
        );
      };
    },
    dispose() {
      for (const dispose of cleanups.reverse()) {
        if (typeof dispose === "function") dispose();
      }
      for (const dispose of effectCleanups.splice(0)) {
        if (typeof dispose === "function") dispose();
      }
    },
  };
}

/** Wait for the stubbed fetch chain to finish and the store to publish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

/** Find every element whose className contains `cls` (arrays are traversed). */
function findAll(node, cls, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, cls, found);
    return found;
  }
  if (typeof node !== "object") return found;
  if (
    typeof node.props?.className === "string" &&
    node.props.className.split(" ").includes(cls)
  ) {
    found.push(node);
  }
  for (const child of node.children ?? []) findAll(child, cls, found);
  return found;
}

/** Find the first element whose className contains `cls`. */
function findOne(node, cls) {
  return findAll(node, cls, [])[0];
}

const textOf = (tree) => JSON.stringify(tree);

/**
 * The client source with its comments removed, for static "does the code do X"
 * assertions. A doc comment that says "no app-root or page-body writes" must
 * not be able to trip a scan for an actual write; only executable code counts.
 * @param {string} source
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** A healthy desk: every proxy route answers its captured fixture. */
async function healthyPage() {
  const calls = [];
  const harness = bootClient(async (url, init) => {
    calls.push({ url: String(url), signal: init?.signal });
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  return { harness, calls, tree: harness.render("main") };
}

check("factory is registered under the package name", () => {
  const harness = bootClient(async (url) =>
    proxiedResponse(url, fixtureFor(url)),
  );
  assert(
    harness.factoryId !== undefined,
    "window.__ModuleLoader__.load was not called",
  );
  assert(
    harness.factoryId === pkg.name,
    `factory id ${harness.factoryId} != package ${pkg.name}`,
  );
  assert(Array.isArray(harness.plugin.inject), "module has no inject list");
  harness.dispose();
});

check("module injects the services it uses", () => {
  const harness = bootClient(async (url) =>
    proxiedResponse(url, fixtureFor(url)),
  );
  const plugin = harness.plugin;
  assert(Array.isArray(plugin.inject), "inject is not an array");
  assert(plugin.inject.includes("slots"), "inject missing slots");
  assert(plugin.inject.includes("locale"), "inject missing locale");
  harness.dispose();
});

check("apply installs the locale dictionary and both registrations", () => {
  const harness = bootClient(async (url) =>
    proxiedResponse(url, fixtureFor(url)),
  );
  assert(
    harness.dictionaries.size === 1,
    `expected one locale namespace, got ${harness.dictionaries.size}`,
  );
  const main = harness.registrations.find(
    (entry) => entry.options.name === "main",
  );
  const sidebar = harness.registrations.find(
    (entry) => entry.options.name === "sidebar.panellist",
  );
  assert(main !== undefined, "no main registration");
  assert(sidebar !== undefined, "no sidebar.panellist registration");
  assert(
    sidebar.options.id === main.options.key,
    "sidebar id and main key differ",
  );
  assert(
    sidebar.options.id === "sportsdesk",
    `unexpected id ${sidebar.options.id}`,
  );
  assert(
    typeof sidebar.options.label === "function",
    "sidebar label is not a thunk",
  );
  assert(
    sidebar.options.label() === "SportsDesk",
    "sidebar label does not resolve",
  );
  assert(
    main.options.locale === sidebar.options.locale,
    "registrations use different locale namespaces",
  );
  assert(
    typeof main.component === "function" &&
      typeof sidebar.component === "function",
    "components are not functions",
  );
  harness.dispose();
});

check("locales are complete and interpolate", () => {
  const harness = bootClient(async () => jsonBody({}));
  const dicts = harness.dictionaries.values().next().value;
  const enKeys = Object.keys(dicts.en).sort();
  const zhKeys = Object.keys(dicts.zh).sort();
  assert(enKeys.length > 80, `en dictionary has only ${enKeys.length} keys`);
  assert(
    Bun.deepEquals(enKeys, zhKeys),
    "en and zh dictionaries have different keys",
  );
  assert(
    harness.translate(NS, "stale", { uptime: "5d" }).includes("5d"),
    "stale interpolation",
  );
  for (const [key, expected] of [
    ["title", "SportsDesk desk"],
    ["marketFeed", "Market feed"],
    ["refresh", "Refresh"],
    ["lastMeasured", "Last measured"],
  ]) {
    assert(
      harness.translate(NS, key) === expected,
      `${key} did not resolve to "${expected}"`,
    );
  }
  harness.dispose();
});

check("every dictionary key the client uses exists in both locales", () => {
  const harness = bootClient(async () => jsonBody({}));
  const dicts = harness.dictionaries.values().next().value;
  const used = new Set(
    [...read("client.js").matchAll(/\bt\("([A-Za-z][A-Za-z0-9]*)"/g)].map(
      (match) => match[1],
    ),
  );
  assert(used.size > 60, `client only uses ${used.size} dictionary keys`);
  for (const key of used) {
    assert(
      Object.hasOwn(dicts.en, key),
      `client uses "${key}" but en does not define it`,
    );
    assert(
      Object.hasOwn(dicts.zh, key),
      `client uses "${key}" but zh does not define it`,
    );
  }
  harness.dispose();
});

await checkAsync(
  "panel starts unmeasured, then renders the live current state",
  async () => {
    const calls = [];
    const harness = bootClient(async (url) => {
      calls.push(String(url));
      return proxiedResponse(url, fixtureFor(url));
    });

    // Nothing has been measured before the first render.
    const first = harness.render("main");
    const card = findOne(first, "spsd-card");
    assert(card !== undefined, "panel renders no status card");
    assert(
      card.props["data-phase"] === "checking",
      `unmeasured card phase is ${card.props["data-phase"]}`,
    );
    const status = findOne(first, "spsd-status-text");
    assert(
      status !== undefined && status.children[0] === "checking…",
      "status line is not the checking state",
    );

    await settle();

    const current = harness.render("main");
    const currentCard = findOne(current, "spsd-card");
    assert(
      currentCard.props["data-phase"] === "current",
      `measured card phase is ${currentCard.props["data-phase"]}`,
    );
    const text = textOf(current);
    for (const expected of [
      "current",
      "Bun v1.4.4 (arm64-darwin)",
      "68955",
      "43.6 MiB",
      "simulation",
      "6 of 6 enabled",
      "10-Minute Live Volume & Positions Pulse",
      "Harness proxy",
      "Raw /health",
      "Raw /api/status",
      "/api/sportsdesk-desk/health",
    ]) {
      assert(text.includes(expected), `current page is missing ${expected}`);
    }
    assert(
      calls[0] === "/api/sportsdesk-desk/health",
      `first probe was ${calls[0]}, not the same-origin proxy`,
    );

    // The sidebar glyph renders the same measured snapshot as a dot.
    const sidebar = harness.render("sidebar.panellist");
    const sidebarText = textOf(sidebar);
    assert(
      sidebarText.includes("state-success-primary"),
      "sidebar dot is not the success color",
    );
    assert(
      sidebarText.includes("SportsDesk desk: current"),
      "sidebar dot title does not reflect the measured phase",
    );

    harness.dispose();
  },
);

await checkAsync(
  "all five captured fixtures parse into the three overview cards",
  async () => {
    const { harness, calls, tree } = await healthyPage();
    const paths = calls.map((call) => call.url);
    assert(paths.length === 5, `probed ${paths.length} URLs, expected five`);
    assert(
      paths[0] === "/api/sportsdesk-desk/health",
      `first probe was ${paths[0]}`,
    );
    for (const source of ["health", "status", "graph", "kpis", "execution"]) {
      assert(
        paths.includes(`/api/sportsdesk-desk/${source}`),
        `${source} was not probed through the proxy`,
      );
    }
    assert(
      paths.every((path) => path.startsWith("/api/")),
      "a probe skipped the proxy before it was known to be absent",
    );

    const cards = findAll(tree, "spsd-overview");
    assert(cards.length === 3, `rendered ${cards.length} overview cards`);
    const states = new Map(
      cards.map((card) => [
        card.props["data-source"],
        card.props["data-state"],
      ]),
    );
    assert(
      states.get("graph") === "stale",
      `graph chip ${states.get("graph")}`,
    );
    assert(states.get("kpis") === "stale", `kpis chip ${states.get("kpis")}`);
    assert(
      states.get("execution") === "stale",
      `execution chip ${states.get("execution")}`,
    );

    const text = textOf(tree);
    for (const expected of [
      "Market feed",
      "Book",
      "Paper execution",
      "PARTIAL",
      "not_ingested",
      "2026-11-04 11:44:39 UTC",
      "6h ago",
      "64,139",
      "2,276",
      "1,679",
      "596",
      "$224,065.00",
      "$200,065.00",
      "$1,052.25",
      "$1,038.63",
      "-$1,181,208.94",
      "$5,000",
      "0 / 25",
      "kalshi",
      "not live-ready",
      "api_key_id_missing",
      "Blocked",
      "Not blocked",
      "The plan was computed from stale market data",
      "d3a10ed",
      "441 citations",
      "2,640 tests",
      "Last measured",
    ]) {
      assert(text.includes(expected), `overview page is missing ${expected}`);
    }
    // The feed's own age row is measured in hours, not invented.
    assert(!text.includes("undefined"), "page rendered an undefined value");
    // One attention item: the captured feed is stale and WSS is not ingested.
    const attention = findOne(tree, "spsd-attention");
    assert(attention !== undefined, "no attention banner for the stale feed");
    assert(
      attention.props["data-count"] === "1",
      `attention count ${attention.props["data-count"]}`,
    );
    harness.dispose();
  },
);

await checkAsync("a failed source blanks only itself", async () => {
  const harness = bootClient(async (url) => {
    const text = String(url);
    if (text.endsWith("/graph")) {
      return jsonBody({ error: "desk service unreachable" }, 502, true);
    }
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const tree = harness.render("main");
  const cards = findAll(tree, "spsd-overview");
  const states = new Map(
    cards.map((card) => [card.props["data-source"], card.props["data-state"]]),
  );
  assert(states.get("graph") === "error", `graph chip ${states.get("graph")}`);
  assert(states.get("kpis") === "stale", `kpis chip ${states.get("kpis")}`);
  assert(
    states.get("execution") === "stale",
    `execution chip ${states.get("execution")}`,
  );
  const text = textOf(tree);
  for (const expected of [
    "HTTP 502",
    "desk service unreachable",
    "$224,065.00",
    "2,276",
    "kalshi",
    "paper",
  ]) {
    assert(text.includes(expected), `isolated failure lost ${expected}`);
  }
  assert(
    findOne(tree, "spsd-card").props["data-phase"] === "current",
    "a failed overview source changed the service phase",
  );
  assert(
    findAll(tree, "spsd-retry").length === 1,
    "the failed card does not offer exactly one Retry",
  );
  // A first-measurement failure has no last good payload to fall back to.
  const graphCard = cards.find((card) => card.props["data-source"] === "graph");
  assert(
    !textOf(graphCard).includes("64,139"),
    "a failed source rendered unmeasured feed values",
  );
  harness.dispose();
});

await checkAsync("a missing source renders missing, not zero", async () => {
  const harness = bootClient(async (url) => {
    const text = String(url);
    if (text.endsWith("/execution")) {
      return jsonBody({ error: "not found" }, 404, true);
    }
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const tree = harness.render("main");
  const cards = findAll(tree, "spsd-overview");
  const execution = cards.find(
    (card) => card.props["data-source"] === "execution",
  );
  assert(
    execution !== undefined,
    "no paper-execution card registration is rendered",
  );
  assert(
    execution.props["data-state"] === "missing",
    `execution chip ${execution.props["data-state"]}`,
  );
  const executionText = textOf(execution);
  assert(executionText.includes("HTTP 404"), "missing reason is not shown");
  assert(executionText.includes("Retry"), "missing card has no Retry");
  for (const forbidden of ["$0", "0 / 25", "$5,000", "paper"]) {
    assert(
      !executionText.includes(forbidden),
      `a missing source invented ${forbidden}`,
    );
  }
  const book = cards.find((card) => card.props["data-source"] === "kpis");
  assert(
    textOf(book).includes("$224,065.00"),
    "a missing execution source blanked the book card",
  );
  harness.dispose();
});

await checkAsync(
  "a later failure keeps the last good payload, labelled stale",
  async () => {
    let failGraph = false;
    const harness = bootClient(async (url) => {
      const text = String(url);
      if (failGraph && text.endsWith("/graph")) {
        return jsonBody({ error: "boom" }, 500, true);
      }
      return proxiedResponse(url, fixtureFor(url));
    });
    harness.render("main");
    await settle();
    failGraph = true;
    const onVisibility = harness.document.listeners.get("visibilitychange");
    assert(typeof onVisibility === "function", "no visibility listener");
    onVisibility(); // a poll tick re-probes without resetting the store
    await settle();
    const tree = harness.render("main");
    const text = textOf(tree);
    const cards = findAll(tree, "spsd-overview");
    const graph = cards.find((card) => card.props["data-source"] === "graph");
    assert(
      graph.props["data-state"] === "error",
      `graph chip ${graph.props["data-state"]}`,
    );
    assert(text.includes("HTTP 500"), "failure reason is not shown");
    assert(
      text.includes("Showing the last good measurement from"),
      "the last good payload is not labelled",
    );
    for (const kept of ["PARTIAL", "64,139", "d3a10ed"]) {
      assert(text.includes(kept), `last good payload lost ${kept}`);
    }
    assert(
      findAll(tree, "spsd-retry").length === 1,
      "the failed card has no Retry",
    );
    harness.dispose();
  },
);

await checkAsync("a 2xx non-JSON body is a source error", async () => {
  const harness = bootClient(async (url) => {
    const text = String(url);
    if (text.endsWith("/graph")) return jsonBody("text", 200, true);
    if (text.endsWith("/kpis")) return jsonBody([1, 2], 200, true);
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const tree = harness.render("main");
  const states = new Map(
    findAll(tree, "spsd-overview").map((card) => [
      card.props["data-source"],
      card.props["data-state"],
    ]),
  );
  assert(states.get("graph") === "error", `graph chip ${states.get("graph")}`);
  assert(states.get("kpis") === "error", `kpis chip ${states.get("kpis")}`);
  const text = textOf(tree);
  assert(
    (text.match(/non-JSON body/g) ?? []).length >= 2,
    "non-JSON bodies are not named",
  );
  harness.dispose();
});

await checkAsync("partial payloads render measured fields only", async () => {
  const harness = bootClient(async (url) => {
    const text = String(url);
    if (text.endsWith("/graph")) {
      return jsonBody(
        { feed: { status: "measured", stale: false } },
        200,
        true,
      );
    }
    if (text.endsWith("/kpis")) {
      return jsonBody({ kpis: { agents: { total: 5 } } }, 200, true);
    }
    if (text.endsWith("/execution")) {
      return jsonBody({ mode: "paper" }, 200, true);
    }
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const text = textOf(harness.render("main"));
  for (const expected of ["measured", "paper", "5"]) {
    assert(text.includes(expected), `partial page missing ${expected}`);
  }
  for (const absent of ["Customer book", "Counts", "Venues"]) {
    assert(!text.includes(absent), `absent section ${absent} was rendered`);
  }
  assert(
    text.includes("Unknown — the payload has no decisions array."),
    "missing decisions is not rendered as unknown",
  );
  harness.dispose();
});

await checkAsync(
  "attention derives feed and execution conditions",
  async () => {
    const dangerous = {
      ...FIXTURE_EXECUTION,
      mode: "live",
      killSwitch: true,
      policy: { liveEnabled: true, maxOpenIntents: 25 },
      decisions: undefined,
      provenance: { stale: false },
    };
    const harness = bootClient(async (url) =>
      String(url).endsWith("/execution")
        ? proxiedResponse(url, dangerous)
        : proxiedResponse(url, fixtureFor(url)),
    );
    harness.render("main");
    await settle();
    const tree = harness.render("main");
    const text = textOf(tree);
    const attention = findOne(tree, "spsd-attention");
    assert(attention !== undefined, "no attention banner");
    assert(
      attention.props["data-count"] === "4",
      `attention count ${attention.props["data-count"]} (feed + kill + mode + live)`,
    );
    for (const expected of [
      "Market feed:",
      "WSS not ingested (not_ingested)",
      "stale (6h ago)",
      "kill switch is on",
      "mode is live",
      "live execution is enabled",
    ]) {
      assert(text.includes(expected), `attention missing ${expected}`);
    }
    harness.dispose();
  },
);

await checkAsync("attention is quiet for a fully healthy desk", async () => {
  const fresh = {
    ...FIXTURE_GRAPH,
    feed: {
      ...FIXTURE_GRAPH.feed,
      status: "measured",
      stale: false,
      wssIngestion: "ingested",
    },
  };
  const healthyExecution = {
    ...FIXTURE_EXECUTION,
    mode: "paper",
    killSwitch: false,
    policy: { liveEnabled: false, maxOpenIntents: 25 },
    provenance: { stale: false },
  };
  const harness = bootClient(async (url) => {
    const text = String(url);
    if (text.endsWith("/graph")) return proxiedResponse(url, fresh);
    if (text.endsWith("/execution")) {
      return proxiedResponse(url, healthyExecution);
    }
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const tree = harness.render("main");
  assert(
    findOne(tree, "spsd-attention") === undefined,
    "a healthy desk still shows an attention banner",
  );
  harness.dispose();
});

await checkAsync("retry recovers a failed source", async () => {
  let failGraph = true;
  const calls = [];
  const harness = bootClient(async (url) => {
    calls.push(String(url));
    if (failGraph && String(url).endsWith("/graph")) {
      return jsonBody({ error: "boom" }, 500, true);
    }
    return proxiedResponse(url, fixtureFor(url));
  });
  harness.render("main");
  await settle();
  const failed = harness.render("main");
  const graphCard = findAll(failed, "spsd-overview").find(
    (card) => card.props["data-source"] === "graph",
  );
  assert(graphCard.props["data-state"] === "error", "graph did not fail first");
  const before = calls.length;
  failGraph = false;
  const retry = findOne(failed, "spsd-retry");
  assert(retry !== undefined, "no Retry button");
  retry.props.onClick();
  await settle();
  const recovered = harness.render("main");
  const text = textOf(recovered);
  assert(calls.length > before, "Retry started no new probe");
  assert(
    findAll(recovered, "spsd-overview").find(
      (card) => card.props["data-source"] === "graph",
    ).props["data-state"] === "stale",
    "graph did not recover on Retry",
  );
  assert(
    !text.includes("Showing the last good measurement from"),
    "the stale last-good notice survived a successful Retry",
  );
  harness.dispose();
});

await checkAsync(
  "falls back to loopback when the Host half is absent",
  async () => {
    const calls = [];
    const harness = bootClient(async (url) => {
      const text = String(url);
      calls.push(text);
      if (text.startsWith("/api/sportsdesk-desk/")) {
        // The generic Harness 404: no proxy marker, so the client may fall back.
        return jsonBody({ error: "not found" }, 404);
      }
      return proxiedResponse(url, fixtureFor(url));
    });
    harness.render("main");
    await settle();
    const text = JSON.stringify(harness.render("main"));
    assert(
      text.includes("current"),
      "fallback did not reach the current state",
    );
    assert(text.includes("direct loopback"), "fallback source is not direct");
    assert(
      calls.includes("/api/sportsdesk-desk/health"),
      "the proxy was not tried first",
    );
    assert(
      calls.includes("http://127.0.0.1:4020/health"),
      "the loopback fallback was not tried",
    );
    harness.dispose();
  },
);

await checkAsync(
  "stale service renders the missing pieces and restart command",
  async () => {
    const calls = [];
    const harness = bootClient(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/health")) {
        const { ingress: _ingress, ...staleHealth } = FIXTURE_HEALTH;
        return proxiedResponse(url, staleHealth);
      }
      return proxiedResponse(url, { error: "not found" }, 404);
    });
    harness.render("main");
    await settle();
    const text = JSON.stringify(harness.render("main"));
    for (const expected of [
      "stale build",
      "/api/status route (HTTP 404)",
      "ingress field on /health",
      "PORT=4020 bun run serve",
      "Stale build",
    ]) {
      assert(text.includes(expected), `stale page is missing ${expected}`);
    }
    // A proxy-marked 404 is authoritative: the remote viewer must not fall back
    // to a loopback URL it cannot reach.
    assert(
      calls.every((url) => url.startsWith("/api/sportsdesk-desk/")),
      `stale classification fell back to ${calls.join(", ")}`,
    );
    harness.dispose();
  },
);

await checkAsync(
  "an older Host half still classifies a proxied 404 as stale",
  async () => {
    const calls = [];
    const harness = bootClient(async (url) => {
      calls.push(String(url));
      if (String(url).endsWith("/health")) {
        const { ingress: _ingress, ...staleHealth } = FIXTURE_HEALTH;
        // No proxy marker: this is what a Host half older than the marker sends.
        return jsonBody(staleHealth);
      }
      return jsonBody({ error: "not found" }, 404);
    });
    harness.render("main");
    await settle();
    const text = JSON.stringify(harness.render("main"));
    assert(
      text.includes("stale build"),
      "older Host half did not classify the proxied 404 as stale",
    );
    // The proxy answered /health, so it is present; a 404 for the other routes
    // is authoritative and must not fall back to an unreachable loopback.
    assert(
      calls.every((url) => url.startsWith("/api/sportsdesk-desk/")),
      `older Host half fell back to ${calls.join(", ")}`,
    );
    harness.dispose();
  },
);

await checkAsync(
  "refused health probe renders service down and the start command",
  async () => {
    const harness = bootClient(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:4020");
    });
    harness.render("main");
    await settle();
    const text = JSON.stringify(harness.render("main"));
    for (const expected of [
      "service down",
      "PORT=4020 bun run serve",
      "connect ECONNREFUSED",
    ]) {
      assert(text.includes(expected), `down page is missing ${expected}`);
    }
    harness.dispose();
  },
);

await checkAsync("an /api/status 5xx is unknown, never current", async () => {
  const harness = bootClient(async (url) =>
    String(url).endsWith("/health")
      ? proxiedResponse(url, FIXTURE_HEALTH)
      : jsonBody({ error: "boom" }, 500, true),
  );
  harness.render("main");
  await settle();
  const text = JSON.stringify(harness.render("main"));
  assert(text.includes("status probe failed"), "5xx probe is not unknown");
  assert(!text.includes(">current<"), "5xx probe was reported as current");
  harness.dispose();
});

check("the desk exposes latency history and a diagnostics copy", () => {
  const harness = bootClient(async (url) =>
    proxiedResponse(url, fixtureFor(url)),
  );
  const tree = harness.render("main");
  const text = JSON.stringify(tree);
  assert(text.includes("spsd-latency"), "no latency strip");
  assert(
    text.includes("No successful probes yet"),
    "the empty latency strip is not honest",
  );
  const source = read("client.js");
  assert(source.includes("navigator.clipboard"), "no clipboard copy path");
  assert(source.includes("polyline"), "no latency sparkline");
  assert(source.includes("copyDiagnostics"), "no diagnostics copy action");
  harness.dispose();
});

check("page chrome uses theme tokens, not literal colors", () => {
  const harness = bootClient(async (url) =>
    proxiedResponse(url, fixtureFor(url)),
  );
  const tree = harness.render("main");
  const style = tree.children.find((child) => child?.type === "style");
  assert(style !== undefined, "panel renders no style element");
  const css = style.children.join("\n");
  assert(css.includes("var(--dsw-alias-"), "CSS references no theme tokens");
  assert(!/#[0-9a-f]{3,8}\b/i.test(css), "CSS contains a literal hex color");
  assert(!/\brgba?\(/.test(css), "CSS contains a literal rgb()/rgba() color");
  assert(
    css.includes("@media (min-width: 900px)"),
    "CSS has no responsive two-column breakpoint",
  );
  const selectors = css.match(/^\.[a-zA-Z][\w-]*/gm) ?? [];
  assert(selectors.length > 40, "CSS defines too few class rules");
  for (const selector of selectors) {
    assert(
      selector.startsWith(".spsd-"),
      `CSS selector ${selector} is not prefixed spsd-`,
    );
  }
  // Scan executable code only: the file's doc comments intentionally describe
  // what it does NOT do ("no app-root or page-body writes"), which a raw
  // source scan would misread as a write.
  const source = codeOnly(read("client.js"));
  assert(
    !/@deepseek-ai\/dsh-client-ui-primitives/.test(source),
    "imports Harness primitives",
  );
  assert(
    !/document\.(body|documentElement)/.test(source),
    "touches the document outside its slot",
  );
  assert(
    /document\.visibilityState/.test(source),
    "the poll loop no longer reads document.visibilityState",
  );
  assert(
    /document\.addEventListener\(\s*"visibilitychange"/.test(source) &&
      /document\.removeEventListener\(\s*"visibilitychange"/.test(source),
    "the visibility listener is not added and removed symmetrically",
  );
  assert(!/dangerouslySetInnerHTML/.test(source), "uses innerHTML");
  assert(!/\.innerHTML\s*=/.test(source), "writes innerHTML");
  assert(
    !/window\.(confirm|alert|prompt)\s*\(/.test(source),
    "uses a blocking browser dialog",
  );
  assert(
    !/from\s+["']@deepseek-ai\//.test(source) &&
      !/require\(["']@deepseek-ai\//.test(source),
    "imports a Harness Client package",
  );
  harness.dispose();
});

await checkAsync(
  "disposal removes registrations and stops publishing",
  async () => {
    const pending = [];
    const signals = [];
    const harness = bootClient((url, init) => {
      signals.push(init?.signal);
      return new Promise((resolve) => {
        pending.push(() => resolve(proxiedResponse(url, fixtureFor(url))));
      });
    });
    const mainEntry = harness.mainEntry();
    const seat = harness.capturedSeat();
    const renderNow = () => mainEntry.component({ t: seat });
    const before = textOf(renderNow());
    await settle();
    assert(pending.length >= 1, "no probe started");
    assert(textOf(renderNow()) === before, "an unresolved probe published");
    harness.dispose();
    assert(
      harness.registrations.length === 0,
      `slot registrations survived disposal (${harness.registrations.length})`,
    );
    assert(
      harness.dictionaries.size === 0,
      "locale dictionary survived disposal",
    );
    assert(
      harness.document.removed >= 1,
      "disposal did not remove the visibility listener",
    );
    assert(
      signals.length > 0 && signals.every((signal) => signal?.aborted === true),
      "disposal did not abort the in-flight request",
    );
    for (let round = 0; round < 12 && pending.length > 0; round += 1) {
      const batch = pending.splice(0);
      for (const resolve of batch) resolve();
      await settle();
    }
    assert(textOf(renderNow()) === before, "a probe published after disposal");
  },
);

await checkAsync("the sidebar dot tracks the service phase only", async () => {
  const { harness, tree } = await healthyPage();
  const sidebarText = textOf(harness.render("sidebar.panellist"));
  assert(
    sidebarText.includes("state-success-primary"),
    "sidebar dot is not success for a current service",
  );
  assert(
    sidebarText.includes("SportsDesk desk: current"),
    "sidebar title does not track the service phase",
  );
  // A stale overview source must not change the glyph.
  assert(
    findAll(tree, "spsd-overview").some(
      (card) => card.props["data-state"] === "stale",
    ),
    "fixture did not produce a stale overview source",
  );
  harness.dispose();

  const downHarness = bootClient(async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:4020");
  });
  downHarness.render("main");
  await settle();
  const downSidebar = textOf(downHarness.render("sidebar.panellist"));
  assert(
    downSidebar.includes("state-error-primary"),
    "sidebar dot is not error when the service is down",
  );
  assert(
    downSidebar.includes("SportsDesk desk: service down"),
    "sidebar title does not report the down phase",
  );
  downHarness.dispose();
});

/* --- host half ---------------------------------------------------------- */

/**
 * Capture the routes the Host half registers and answer `getOrigin` like the
 * real `webServer` service does. `register` returns a disposer that removes the
 * route, matching the webServer contract the Host half relies on.
 */
function fakeWebServer(origin = "https://dsh.example") {
  const routes = [];
  let disposals = 0;
  const server = {
    routes,
    disposals: () => disposals,
    getOrigin: () => origin,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
        disposals += 1;
      };
    },
    /** Deliver the webServer service to the `ctx.inject` callback. */
    instantiate(callback) {
      callback({ webServer: server });
    },
  };
  return server;
}

function fakeRes() {
  const out = { status: null, headers: null, body: null };
  return {
    out,
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers;
    },
    end(body) {
      out.body = body;
    },
  };
}

/**
 * Apply the Host half against a fake webServer. `deferInjection` returns before
 * the webServer callback runs, so a test can dispose and only then deliver the
 * service (the callback-after-disposal path the Host half guards).
 */
async function bootHost({
  origin = "https://dsh.example",
  deferInjection = false,
} = {}) {
  const module = await import("./index.js");
  const webServer = fakeWebServer(origin);
  let pending = null;
  const dispose = module.apply({
    inject(_deps, callback) {
      if (deferInjection) {
        pending = callback;
        return;
      }
      webServer.instantiate(callback);
    },
  });
  return {
    routes: webServer.routes,
    disposals: webServer.disposals,
    dispose,
    deliver() {
      if (pending === null) throw new Error("no deferred injection");
      webServer.instantiate(pending);
    },
  };
}

/** The allowlist the Host half must register, proxy path -> upstream path. */
const ALLOWLIST = new Map([
  ["/api/sportsdesk-desk/health", "/health"],
  ["/api/sportsdesk-desk/status", "/api/status"],
  ["/api/sportsdesk-desk/graph", "/api/graph/summary"],
  ["/api/sportsdesk-desk/kpis", "/api/kpis"],
  ["/api/sportsdesk-desk/execution", "/api/execution/plan"],
]);

/** Run `body` against a temporary global fetch stub, then restore it. */
async function withFetchStub(fetchImpl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

await checkAsync(
  "host registers the allowlisted GET proxy routes",
  async () => {
    const host = await bootHost();
    assert(
      host.routes.length === ALLOWLIST.size,
      `registered ${host.routes.length} routes, expected ${ALLOWLIST.size}`,
    );
    for (const [path, target] of ALLOWLIST) {
      const route = host.routes.find((candidate) => candidate.path === path);
      assert(route !== undefined, `missing route ${path}`);
      assert(route.kind === "exact", `${path} is not an exact route`);
      assert(typeof route.handler === "function", `${path} has no handler`);
      assert(
        host.routes.filter((candidate) => candidate.path === path).length === 1,
        `${path} registered twice`,
      );
      assert(
        host.routes.some(
          (candidate) =>
            candidate.path === path && candidate.handler.length <= 2,
        ),
        `${target} handler shape`,
      );
    }
    assert(
      typeof host.dispose === "function",
      "apply does not return a disposal function",
    );
  },
);

await checkAsync("host refuses non-GET and foreign origins", async () => {
  const host = await bootHost();
  const health = host.routes.find(
    (candidate) => candidate.path === "/api/sportsdesk-desk/health",
  ).handler;

  const post = fakeRes();
  await health({ method: "POST", headers: {} }, post);
  assert(post.out.status === 405, `POST answered ${post.out.status}`);
  assert(
    post.out.headers["x-sportsdesk-desk-proxy"] === "/health",
    "405 does not carry the proxy marker",
  );

  const foreign = fakeRes();
  await health(
    { method: "GET", headers: { origin: "https://evil.example" } },
    foreign,
  );
  assert(
    foreign.out.status === 403,
    `foreign Origin answered ${foreign.out.status}`,
  );
  assert(
    foreign.out.headers["x-sportsdesk-desk-proxy"] === "/health",
    "403 does not carry the proxy marker",
  );

  // A same-origin GET may omit Origin entirely (same-origin fetch does).
  const sameOrigin = fakeRes();
  await withFetchStub(
    async () => upstreamBody('{"ok":true}'),
    () => health({ method: "GET", headers: {} }, sameOrigin),
  );
  assert(
    sameOrigin.out.status === 200,
    `same-origin answered ${sameOrigin.out.status}`,
  );
  assert(
    sameOrigin.out.headers["cache-control"] === "no-store",
    "success response is cacheable",
  );
});

await checkAsync(
  "host forwards upstream status/body and 502s an unreachable service",
  async () => {
    const host = await bootHost();
    const health = host.routes.find(
      (candidate) => candidate.path === "/api/sportsdesk-desk/health",
    ).handler;

    const ok = fakeRes();
    await withFetchStub(
      async (url, init) => {
        assert(
          init?.signal !== undefined,
          "upstream fetch carries no abort signal",
        );
        assert(
          String(url) === "http://127.0.0.1:4020/health",
          `unexpected upstream URL ${url}`,
        );
        return upstreamBody('{"status":"healthy"}', 200);
      },
      () => health({ method: "GET", headers: {} }, ok),
    );
    assert(ok.out.status === 200, `upstream 200 answered ${ok.out.status}`);
    assert(ok.out.body === '{"status":"healthy"}', "body not forwarded");
    assert(
      ok.out.headers["content-type"] === "application/json",
      "content-type not forwarded",
    );
    assert(
      ok.out.headers["x-sportsdesk-desk-proxy"] === "/health",
      "response does not carry the proxy marker",
    );

    const missing = fakeRes();
    await withFetchStub(
      async () => upstreamBody("{}", 404),
      () => health({ method: "GET", headers: {} }, missing),
    );
    assert(
      missing.out.status === 404,
      `upstream 404 answered ${missing.out.status}`,
    );
    assert(
      missing.out.headers["x-sportsdesk-desk-proxy"] === "/health",
      "forwarded 404 lost the proxy marker",
    );

    const down = fakeRes();
    await withFetchStub(
      async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4020");
      },
      () => health({ method: "GET", headers: {} }, down),
    );
    assert(
      down.out.status === 502,
      `unreachable service answered ${down.out.status}`,
    );
    const payload = JSON.parse(down.out.body);
    assert(payload.error === "desk service unreachable", "502 error token");
    assert(
      String(payload.detail).includes("ECONNREFUSED"),
      "502 does not carry the upstream detail",
    );
    assert(
      down.out.headers["x-sportsdesk-desk-proxy"] === "/health",
      "502 does not carry the proxy marker",
    );
  },
);

await checkAsync("host refuses an oversized upstream document", async () => {
  const host = await bootHost();
  const graph = host.routes.find(
    (candidate) => candidate.path === "/api/sportsdesk-desk/graph",
  ).handler;
  const oversized = "x".repeat(512 * 1024 + 1);
  const res = fakeRes();
  await withFetchStub(
    async () => upstreamBody(oversized, 200),
    () => graph({ method: "GET", headers: {} }, res),
  );
  assert(res.out.status === 502, `oversized body answered ${res.out.status}`);
  const payload = JSON.parse(res.out.body);
  assert(
    payload.error === "response_too_large",
    `oversized body error ${payload.error}`,
  );
  assert(
    !String(res.out.body).includes("x".repeat(1024)),
    "oversized body was forwarded",
  );
  assert(
    res.out.headers["x-sportsdesk-desk-proxy"] === "/api/graph/summary",
    "oversized refusal lost the proxy marker",
  );
});

await checkAsync("host unregisters its routes on disposal", async () => {
  const host = await bootHost();
  assert(host.routes.length === ALLOWLIST.size, "routes not registered");
  host.dispose();
  assert(
    host.routes.length === 0,
    `routes survived disposal (${host.routes.length})`,
  );
  assert(
    host.disposals() === ALLOWLIST.size,
    `disposed ${host.disposals()} of ${ALLOWLIST.size} routes`,
  );
});

await checkAsync(
  "a webServer callback after disposal registers nothing",
  async () => {
    const host = await bootHost({ deferInjection: true });
    host.dispose();
    host.deliver();
    assert(
      host.routes.length === 0,
      `late injection left ${host.routes.length} routes registered`,
    );
    assert(
      host.disposals() === ALLOWLIST.size,
      "late injection routes were not disposed",
    );
  },
);

console.log(
  `\n${failed === 0 ? "PASS" : "FAIL"}: ${passed.length} checks passed, ${failed} failed.`,
);
process.exit(failed === 0 ? 0 : 1);
