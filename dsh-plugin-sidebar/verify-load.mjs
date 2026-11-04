#!/usr/bin/env node
/**
 * Structural load test for the SportsDesk desk-panel Client bundle.
 *
 * WHAT THIS PROVES (without a browser): `client.js` parses, registers its lazy
 * factory under the package name, builds a side-effect-free module, and `apply`
 * installs exactly one locale dictionary plus the two registrations that make
 * the left-sidebar entry work — `sidebar.panellist` (the icon list) and `main`
 * (the page that entry selects) under the SAME id. It also renders the panel
 * once against an inert React shim to catch reference errors, checks that the
 * visible copy exists in every supplied locale, and that the page chrome uses
 * only `--dsw-alias-*` tokens rather than literal colors.
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
function check(label, body) {
  try {
    body();
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

/* --- client module ------------------------------------------------------ */

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (fn) => fn,
  useState: (initial) => [
    typeof initial === "function" ? initial() : initial,
    () => {},
  ],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: () => {},
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
};
vm.runInNewContext(read("client.js"), sandbox, { filename: "client.js" });

check("factory is registered under the package name", () => {
  assert(loaded !== undefined, "window.__ModuleLoader__.load was not called");
  assert(
    loaded.id === pkg.name,
    `factory id ${loaded.id} != package ${pkg.name}`,
  );
  assert(typeof loaded.factory === "function", "factory is not a function");
});

const plugin = loaded.factory((name) => {
  if (name === "react") return React;
  throw new Error(`unexpected module import: ${name}`);
});

check("module injects the services it uses", () => {
  assert(Array.isArray(plugin.inject), "inject is not an array");
  assert(plugin.inject.includes("slots"), "inject missing slots");
  assert(plugin.inject.includes("locale"), "inject missing locale");
});

const registrations = [];
const dictionaries = new Map();
const cleanups = [];
let activeLocale = "en";

const translate = (ns, key, params) => {
  const dict = dictionaries.get(ns)?.[activeLocale] ?? dictionaries.get(ns)?.en;
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
      registrations.push({ options, component });
      return () => {};
    },
  },
};

check("apply installs the locale dictionary and both registrations", () => {
  plugin.apply(ctx);
  assert(
    dictionaries.size === 1,
    `expected one locale namespace, got ${dictionaries.size}`,
  );
  const main = registrations.find((entry) => entry.options.name === "main");
  const sidebar = registrations.find(
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
});

check("locales are complete and interpolate", () => {
  const dicts = dictionaries.values().next().value;
  const enKeys = Object.keys(dicts.en).sort();
  const zhKeys = Object.keys(dicts.zh).sort();
  assert(enKeys.length > 0, "en dictionary is empty");
  assert(
    Bun.deepEquals(enKeys, zhKeys),
    "en and zh dictionaries have different keys",
  );
  assert(
    translate("sportsdesk-desk-panel", "stale", { uptime: "5d" }).includes(
      "5d",
    ),
    "stale interpolation",
  );
});

/** Find the first element whose className contains `cls`. */
function findByClass(node, cls) {
  if (node === null || typeof node !== "object") return undefined;
  if (
    typeof node.props?.className === "string" &&
    node.props.className.split(" ").includes(cls)
  ) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findByClass(child, cls);
    if (found !== undefined) return found;
  }
  return undefined;
}

check("panel renders without throwing and starts unmeasured", () => {
  const main = registrations.find((entry) => entry.options.name === "main");
  const tree = main.component({
    t: (key) => translate("sportsdesk-desk-panel", key),
  });
  assert(tree.type === "div", "panel root is not a div");
  const text = JSON.stringify(tree);
  assert(text.includes("SportsDesk desk"), "panel does not render its title");
  const card = findByClass(tree, "spsd-card");
  assert(card !== undefined, "panel renders no status card");
  assert(
    card.props["data-phase"] === "checking",
    `unmeasured card phase is ${card.props["data-phase"]}`,
  );
  const status = findByClass(tree, "spsd-status-text");
  assert(
    status !== undefined && status.children[0] === "checking…",
    "status line is not the checking state",
  );
});

check("page chrome uses theme tokens, not literal colors", () => {
  const main = registrations.find((entry) => entry.options.name === "main");
  const tree = main.component({
    t: (key) => translate("sportsdesk-desk-panel", key),
  });
  const style = tree.children.find((child) => child?.type === "style");
  assert(style !== undefined, "panel renders no style element");
  const css = style.children.join("\n");
  assert(css.includes("var(--dsw-alias-"), "CSS references no theme tokens");
  assert(!/#[0-9a-f]{3,8}\b/i.test(css), "CSS contains a literal hex color");
  assert(!/\brgba?\(/.test(css), "CSS contains a literal rgb()/rgba() color");
  assert(
    !/@deepseek-ai\/dsh-client-ui-primitives/.test(read("client.js")),
    "imports Harness primitives",
  );
  assert(
    !/document\.(body|documentElement)/.test(read("client.js")),
    "touches the document outside its slot",
  );
});

check("disposal removes what apply installed", () => {
  for (const dispose of cleanups.reverse()) {
    assert(typeof dispose === "function", "an effect returned no cleanup");
    dispose();
  }
  assert(dictionaries.size === 0, "locale dictionary survived disposal");
});

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${failed} failing check(s).`);
process.exit(failed === 0 ? 0 : 1);
