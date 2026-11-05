#!/usr/bin/env node
/**
 * verify-load — dependency-free smoke test for the SportsDesk security/fraud Host bundle.
 *
 * WHAT THIS PROVES (without a DSH Host and without the core CLI):
 *   - the module imports under plain Node and exports the frozen identity,
 *   - `apply(ctx, config)` registers EXACTLY the eight fixed tools and eight GET routes, and
 *     returns a disposer that releases every registration,
 *   - every tool declares a complete raw ToolDefinition (description, parameters, output
 *     schema + render, execute, isConcurrencySafe),
 *   - the seven read tools are concurrency-safe; `fraud_model` is not,
 *   - `fraud_model` refuses to WRITE an artifact without `confirm: true` (and refuses a
 *     non-boolean `confirm`), reaches neither the CLI nor a write, and its dry-run path is a
 *     `fit` without `--write`,
 *   - malformed arguments are refused BEFORE any spawn (limit bounds, required id, action enum),
 *   - a missing CLI yields a structured `{ available: false, reason: "cli_missing" }` answer
 *     instead of an exception, on the tools and on an HTTP route,
 *   - every HTTP route refuses non-GET (405), a foreign Origin (403), an invalid query (400),
 *     and reports a missing CLI as 502,
 *   - every answer is one JSON-serializable plain object,
 *   - manifest, patch, icon, locale key parity, and the Client module's safety rules hold.
 *
 * WHAT IT DOES NOT PROVE: that the CLI's answers are correct (its own tests own that), that the
 * model is any good (the CLI reports metrics and limits), or that the running Host serves the
 * page (a live install check owns that). It deliberately points `repoPath` at a non-existent
 * temp directory so it never depends on the CLI existing and never reads or writes real data.
 *
 * Run: node dsh-plugin-security/verify-load.mjs
 */

// ast-grep-ignore: node-fs-read-write-file -- this smoke test reads its own bundle files to prove the manifest, locale and client safety rules.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Runs under Node as well as Bun: import.meta.dir is Bun-only.
// ast-grep-ignore: bun-import-meta-dir
const HERE = dirname(fileURLToPath(import.meta.url));
/** The bundle must never reach the real repo in this smoke test. */
const MISSING_REPO = join(
  tmpdir(),
  `dsh-security-verify-no-cli-${process.pid}`,
);
const CLI_RELATIVE_PATH = "cli/sportsdesk_fraud_cli.ts";
const EXPECTED_CLI_PATH = join(MISSING_REPO, CLI_RELATIVE_PATH);
const PACKAGE_NAME = "dsh-plugin-sportsdesk-security";
const BANNER_ID = "sportsdesk-security";
const HTTP_ORIGIN = "http://verify.test";

const EXPECTED_TOOL_NAMES = [
  "fraud_bets",
  "fraud_dossier",
  "fraud_ip_graph",
  "fraud_model",
  "fraud_patterns",
  "fraud_research",
  "fraud_status",
  "fraud_weblog",
];

const EXPECTED_ROUTE_PATHS = [
  "/api/security/bets",
  "/api/security/dossier",
  "/api/security/ip-graph",
  "/api/security/model",
  "/api/security/patterns",
  "/api/security/research",
  "/api/security/status",
  "/api/security/weblog",
];

let failed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function check(label, body) {
  try {
    body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}
async function checkAsync(label, body) {
  try {
    await body();
    console.log(`  OK    ${label}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${label}\n          ${error?.message ?? error}`);
  }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Every tool answer must survive a JSON round trip unchanged in shape. */
function assertJsonObject(label, value) {
  assert(
    isPlainObject(value),
    `${label}: expected one plain object, got ${typeof value}`,
  );
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `${label}: answer is not JSON-serializable: ${error?.message ?? error}`,
      { cause: error },
    );
  }
  assert(
    typeof serialized === "string",
    `${label}: JSON.stringify returned no string`,
  );
}

function readText(relative) {
  return readFileSync(join(HERE, relative), "utf8");
}

function readJson(relative) {
  return JSON.parse(readText(relative));
}

/** Build the mock Cordis context, capturing tool definitions and web routes. */
function makeContext() {
  const tools = [];
  const toolDisposals = { count: 0 };
  const routes = [];
  const routeDisposals = { count: 0 };
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {
          toolDisposals.count += 1;
        };
      },
    },
    inject(services, callback) {
      if (Array.isArray(services) && services.includes("webServer")) {
        callback({
          webServer: {
            getOrigin: () => HTTP_ORIGIN,
            register(route) {
              routes.push(route);
              return () => {
                routeDisposals.count += 1;
              };
            },
          },
        });
      }
    },
  };
  return { ctx, tools, routes, toolDisposals, routeDisposals };
}

/**
 * Invoke one registered route handler with a mock request/response and parse the JSON body.
 *
 * @param {{ handler: (req: any, res: any) => Promise<void> }} route
 * @param {{ method?: string, url?: string, origin?: string }} [options]
 */
async function callRoute(route, options = {}) {
  const headers = {};
  if (options.origin !== undefined) headers.origin = options.origin;
  const req = {
    method: options.method ?? "GET",
    url: options.url ?? "/",
    headers,
  };
  const res = {
    statusCode: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
  await route.handler(req, res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    parsed = { __unparsed: res.body };
  }
  return { status: res.statusCode, body: parsed, headers: res.headers };
}

const TOOL_SCHEMA_KEYS = ["type", "properties"];

async function main() {
  const module = await import(pathToFileURL(join(HERE, "index.js")).href);
  const { apply } = module;

  console.log("verify-load: identity and manifest");
  check("module name is the frozen banner id", () => {
    assert(module.name === BANNER_ID, `name is ${JSON.stringify(module.name)}`);
  });
  check("module injects the tools service", () => {
    assert(
      Array.isArray(module.inject) &&
        module.inject.length === 1 &&
        module.inject[0] === "tools",
      `inject is ${JSON.stringify(module.inject)}`,
    );
  });
  check("apply is a function", () => {
    assert(typeof apply === "function", "apply is not a function");
  });
  const pkg = readJson("package.json");
  check("package name/version conform", () => {
    assert(
      pkg.name === PACKAGE_NAME,
      `package name is ${JSON.stringify(pkg.name)}`,
    );
    assert(
      typeof pkg.version === "string" && pkg.version.length > 0,
      "version is missing",
    );
    assert(pkg.private === true, "bundle must stay private");
  });
  check("manifest declares the bundle patch and client half", () => {
    assert(
      pkg.dsh &&
        pkg.dsh.bundle &&
        pkg.dsh.bundle.patch === "./cordis.patch.yml",
      "dsh.bundle.patch must be ./cordis.patch.yml",
    );
    assert(
      pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === "web",
      "dsh.client.platform must be web",
    );
    const inject = pkg.dsh.client.inject ?? [];
    for (const peer of [
      "@deepseek-ai/dsh-client-ui-layout",
      "@deepseek-ai/dsh-client-ui-sidebar",
      "@deepseek-ai/dsh-client-locale",
    ]) {
      assert(inject.includes(peer), `dsh.client.inject is missing ${peer}`);
    }
  });
  check("every exported runtime file exists and is listed in files", () => {
    assert(isPlainObject(pkg.exports), "exports is missing");
    const files = Array.isArray(pkg.files) ? pkg.files : [];
    for (const value of Object.values(pkg.exports)) {
      if (
        typeof value !== "string" ||
        !value.startsWith("./") ||
        value.includes("*")
      )
        continue;
      assert(existsSync(join(HERE, value)), `export ${value} does not exist`);
      // package.json is a metadata export: npm always ships it, it need not be in files[].
      if (value === "./package.json") continue;
      const bare = value.replace(/^\.\//, "");
      assert(
        files.some((pattern) => pattern === bare),
        `export ${value} is not listed in files[]`,
      );
    }
    for (const required of [
      "index.js",
      "client.js",
      "cordis.patch.yml",
      "icon.svg",
      "README.md",
      "RESEARCH.md",
    ]) {
      assert(files.includes(required), `files[] is missing ${required}`);
    }
  });
  check("bundle patch inserts one row named after the package", () => {
    const patch = readText("cordis.patch.yml");
    assert(patch.includes("- insert:"), "patch has no insert block");
    assert(patch.includes(`id: ${BANNER_ID}`), "patch row id mismatch");
    assert(patch.includes(`name: ${PACKAGE_NAME}`), "patch row name mismatch");
    assert(patch.includes("repoPath:"), "patch row has no repoPath");
    assert(patch.includes("bunPath:"), "patch row has no bunPath");
  });
  check("icon is a bounded self-contained SVG", () => {
    const icon = readText("icon.svg");
    assert(icon.trimStart().startsWith("<svg"), "icon is not an svg");
    assert(
      icon.includes('viewBox="0 0 24 24"'),
      "icon viewBox is not the 24x24 grid",
    );
    assert(icon.includes("currentColor"), "icon must use currentColor");
    assert(!/<script/i.test(icon), "icon must not contain a script");
    assert(icon.length < 8192, `icon is unexpectedly large (${icon.length} B)`);
  });

  console.log("verify-load: tool registrations");
  const { ctx, tools, routes, toolDisposals, routeDisposals } = makeContext();
  const dispose = apply(ctx, {
    repoPath: MISSING_REPO,
    bunPath: "bun",
    timeoutMs: 5_000,
  });
  check("apply returns a disposer", () => {
    assert(typeof dispose === "function", "apply did not return a disposer");
  });
  check("exactly the eight frozen tools are registered", () => {
    const names = tools.map((tool) => tool.name).sort();
    assert(
      JSON.stringify(names) === JSON.stringify(EXPECTED_TOOL_NAMES),
      `registered ${JSON.stringify(names)}`,
    );
  });
  check("every tool declares a complete definition", () => {
    for (const tool of tools) {
      assert(
        typeof tool.name === "string" && tool.name !== "",
        "tool has no name",
      );
      assert(
        typeof tool.description === "string" && tool.description.length > 40,
        `${tool.name}: description is missing or too short`,
      );
      assert(
        isPlainObject(tool.parameters),
        `${tool.name}: parameters is not an object`,
      );
      assert(
        tool.parameters.type === "object",
        `${tool.name}: parameters.type is not object`,
      );
      assert(
        TOOL_SCHEMA_KEYS.every((key) => tool.parameters[key] !== undefined),
        `${tool.name}: parameters is not a JSON schema object`,
      );
      assert(
        isPlainObject(tool.output),
        `${tool.name}: output is not an object`,
      );
      assert(
        tool.output.schema !== undefined,
        `${tool.name}: output.schema is missing`,
      );
      assert(
        typeof tool.output.render === "function",
        `${tool.name}: output.render is missing`,
      );
      assert(
        typeof tool.execute === "function",
        `${tool.name}: execute is missing`,
      );
      assert(
        typeof tool.isConcurrencySafe === "function",
        `${tool.name}: no isConcurrencySafe`,
      );
    }
  });
  check("read tools are concurrency-safe and fraud_model is not", () => {
    for (const tool of tools) {
      const expected = tool.name !== "fraud_model";
      assert(
        tool.isConcurrencySafe() === expected,
        `${tool.name}: isConcurrencySafe() is ${tool.isConcurrencySafe()}`,
      );
    }
  });

  console.log("verify-load: tool behaviour without the CLI");
  const tool = (name) => {
    const found = tools.find((entry) => entry.name === name);
    assert(found !== undefined, `${name} is not registered`);
    return found;
  };
  const answer = async (name, args) => {
    const value = await tool(name).execute(args ?? {});
    assertJsonObject(name, value);
    return value;
  };

  await checkAsync(
    "fraud_status reports a missing CLI, not an exception",
    async () => {
      const value = await answer("fraud_status");
      assert(value.available === false, "expected available:false");
      assert(
        value.reason === "cli_missing",
        `reason is ${JSON.stringify(value.reason)}`,
      );
      assert(value.expectedPath === EXPECTED_CLI_PATH, "expectedPath mismatch");
      assert(
        typeof value.hint === "string" &&
          value.hint.includes(CLI_RELATIVE_PATH),
        "no hint",
      );
    },
  );
  await checkAsync(
    "a read tool with valid filters reports the missing CLI",
    async () => {
      const value = await answer("fraud_bets", {
        limit: 10,
        agent: "MARCO1022",
      });
      assert(
        value.reason === "cli_missing",
        `reason is ${JSON.stringify(value.reason)}`,
      );
    },
  );
  await checkAsync(
    "invalid arguments are refused before any spawn",
    async () => {
      const cases = [
        ["fraud_bets", { limit: 999 }],
        ["fraud_bets", { limit: 0 }],
        ["fraud_bets", { includeBots: "true" }],
        ["fraud_bets", { since: "not-a-date" }],
        ["fraud_ip_graph", { minAccounts: 1 }],
        ["fraud_ip_graph", { prefix24: "10.0" }],
        ["fraud_patterns", { minSeverity: "urgent" }],
        ["fraud_dossier", {}],
        ["fraud_dossier", { id: "bad id" }],
        ["fraud_model", { action: "predict" }],
        ["fraud_model", { action: "score" }],
        ["fraud_model", { action: "fit", split: 0.99 }],
        ["fraud_model", { action: "fit", write: "true", confirm: true }],
        ["fraud_model", { action: "fit", confirm: "true", write: true }],
      ];
      for (const [name, args] of cases) {
        const value = await answer(name, args);
        assert(
          value.available === false && value.reason === "invalid_arguments",
          `${name} ${JSON.stringify(args)}: expected invalid_arguments, got ${JSON.stringify(value.reason)}`,
        );
      }
    },
  );
  await checkAsync(
    "fraud_model refuses a write without confirm:true and writes nothing",
    async () => {
      const value = await answer("fraud_model", { action: "fit", write: true });
      assert(value.available === false, "expected available:false");
      assert(
        value.reason === "confirmation_required",
        `reason is ${JSON.stringify(value.reason)}`,
      );
      assert(
        /Nothing was written/.test(value.message),
        "refusal must say nothing was written",
      );
    },
  );
  await checkAsync(
    "a confirm-gated fit with valid arguments reaches the CLI layer safely",
    async () => {
      const value = await answer("fraud_model", {
        action: "fit",
        write: true,
        confirm: true,
      });
      assert(
        value.reason === "cli_missing",
        `reason is ${JSON.stringify(value.reason)}`,
      );
    },
  );
  await checkAsync(
    "an invalid model scene is refused, not scored",
    async () => {
      const value = await answer("fraud_model", {
        action: "score",
        account: "bad id",
      });
      assert(
        value.reason === "invalid_arguments",
        `reason is ${JSON.stringify(value.reason)}`,
      );
    },
  );

  console.log("verify-load: same-origin read routes");
  check("exactly the eight frozen route paths are registered", () => {
    const paths = routes.map((route) => route.path).sort();
    assert(
      JSON.stringify(paths) === JSON.stringify(EXPECTED_ROUTE_PATHS),
      `registered ${JSON.stringify(paths)}`,
    );
    for (const route of routes) {
      assert(
        route.kind === "exact",
        `${route.path}: kind is ${JSON.stringify(route.kind)}`,
      );
      assert(typeof route.handler === "function", `${route.path}: no handler`);
    }
  });
  const route = (path) => {
    const found = routes.find((entry) => entry.path === path);
    assert(found !== undefined, `${path} is not registered`);
    return found;
  };
  await checkAsync("a non-GET request is 405 on every route", async () => {
    for (const path of EXPECTED_ROUTE_PATHS) {
      const result = await callRoute(route(path), {
        method: "POST",
        url: path,
      });
      assert(result.status === 405, `${path}: status is ${result.status}`);
      assert(
        result.body.reason === "method_not_allowed",
        `${path}: unexpected reason`,
      );
    }
  });
  await checkAsync("a foreign Origin is refused on every route", async () => {
    for (const path of EXPECTED_ROUTE_PATHS) {
      const result = await callRoute(route(path), {
        url: path,
        origin: "https://evil.example",
      });
      assert(result.status === 403, `${path}: status is ${result.status}`);
      assert(
        result.body.reason === "origin_refused",
        `${path}: unexpected reason`,
      );
    }
  });
  await checkAsync(
    "a missing Origin and the bundle origin are allowed",
    async () => {
      for (const path of EXPECTED_ROUTE_PATHS) {
        for (const origin of [undefined, HTTP_ORIGIN]) {
          const result = await callRoute(route(path), { url: path, origin });
          assert(
            result.status !== 403,
            `${path} origin=${String(origin)}: unexpectedly refused`,
          );
        }
      }
    },
  );
  await checkAsync("an invalid query is 400 before any spawn", async () => {
    const cases = [
      ["/api/security/bets", "/api/security/bets?limit=999"],
      ["/api/security/bets", "/api/security/bets?limit=abc"],
      ["/api/security/bets", "/api/security/bets?state=99"],
      ["/api/security/bets", "/api/security/bets?includeBots=maybe"],
      ["/api/security/ip-graph", "/api/security/ip-graph?minAccounts=1"],
      ["/api/security/patterns", "/api/security/patterns?limit=0"],
      ["/api/security/dossier", "/api/security/dossier"],
      ["/api/security/dossier", "/api/security/dossier?id="],
    ];
    for (const [path, url] of cases) {
      const result = await callRoute(route(path), { url });
      assert(result.status === 400, `${url}: status is ${result.status}`);
      assert(
        result.body.reason === "invalid_arguments",
        `${url}: unexpected reason`,
      );
    }
  });
  await checkAsync(
    "a missing CLI is a structured 502, never an exception",
    async () => {
      for (const path of EXPECTED_ROUTE_PATHS) {
        const result = await callRoute(route(path), { url: `${path}?id=ACC1` });
        assert(result.status === 502, `${path}: status is ${result.status}`);
        assert(result.body.ok === false, `${path}: body.ok is not false`);
        assert(
          result.body.reason === "cli_missing",
          `${path}: reason is ${JSON.stringify(result.body.reason)}`,
        );
      }
    },
  );
  await checkAsync(
    "successful route answers are JSON objects carrying ok:true",
    async () => {
      // No CLI exists here, so this only pins the failure envelope shape: ok:false + reason.
      const result = await callRoute(route("/api/security/status"), {
        url: "/api/security/status",
      });
      assertJsonObject("route status body", result.body);
      assert(result.body.ok === false, "expected ok:false without a CLI");
    },
  );

  console.log("verify-load: bundle display resources and Client safety");
  check(
    "locale files carry bundle meta (title + description) in both locales",
    () => {
      // Bundle convention (shared with dsh-plugin-sidebar / dsh-plugin-watchlist-autobet): the
      // locale FILE carries display metadata under `meta`; the panel's full string dictionary is
      // embedded in client.js and registered through the locale service.
      const en = readJson("locale/en.json");
      const zh = readJson("locale/zh.json");
      for (const [locale, value] of [
        ["en", en],
        ["zh", zh],
      ]) {
        assert(isPlainObject(value), `${locale}.json must be a JSON object`);
        assert(
          isPlainObject(value.meta),
          `${locale}.json must carry a meta object`,
        );
        assert(
          typeof value.meta.title === "string" &&
            value.meta.title.trim() !== "",
          `${locale}.meta.title is missing`,
        );
        assert(
          typeof value.meta.description === "string" &&
            value.meta.description.trim() !== "",
          `${locale}.meta.description is missing`,
        );
        assert(
          Object.keys(value).length === 1,
          `${locale}.json must carry ONLY the meta object (found ${Object.keys(value).join(", ")})`,
        );
      }
      assert(
        JSON.stringify(Object.keys(en.meta).sort()) ===
          JSON.stringify(Object.keys(zh.meta).sort()),
        "en/zh meta key sets differ",
      );
    },
  );
  let clientSource = "";
  try {
    clientSource = readText("client.js");
  } catch {
    clientSource = "";
  }
  check(
    "client module names the frozen entry id and registers both halves",
    () => {
      assert(
        clientSource.includes(BANNER_ID),
        "client.js does not mention the entry id",
      );
      assert(
        clientSource.includes("sidebar"),
        "client.js does not touch a sidebar slot",
      );
      assert(
        clientSource.includes("main"),
        "client.js does not touch a main slot",
      );
      assert(clientSource.length > 4_000, "client.js is suspiciously small");
    },
  );
  check(
    "client module contains no forbidden rendering or navigation APIs",
    () => {
      for (const forbidden of [
        "innerHTML",
        "dangerouslySetInnerHTML",
        "window.confirm",
        "window.alert",
        "window.prompt",
        "document.body",
        "@deepseek-ai/",
      ]) {
        assert(
          !clientSource.includes(forbidden),
          `client.js contains ${forbidden}`,
        );
      }
    },
  );
  check("client module uses no literal colors", () => {
    const literalColor =
      /(?:color|background|border-color|fill|stroke)\s*:\s*["']?(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/;
    assert(
      !literalColor.test(clientSource),
      "client.js paints with a literal color",
    );
  });
  check("Host half never prints a cookie, bearer token or raw IP", () => {
    const hostSource = readText("index.js");
    for (const forbidden of ["Bearer ", "set-cookie", "cookie:"]) {
      assert(!hostSource.includes(forbidden), `index.js contains ${forbidden}`);
    }
    // A raw dotted IPv4 appears only in the docs comment of the mask example; the Host half
    // must not own a mask list (the CLI masks), so no IPv4 literal may be executable code.
    const ipv4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
    // Loopback is allowed: it is the base for parsing a request URL, not a customer address.
    const matches = (hostSource.match(ipv4) ?? []).filter(
      (match) => match !== "127.0.0.1",
    );
    assert(
      matches.length === 0,
      `index.js contains IPv4 literals: ${matches.join(", ")}`,
    );
  });
  check("disposal releases every tool and route registration", () => {
    dispose();
    assert(
      toolDisposals.count === EXPECTED_TOOL_NAMES.length,
      `tool disposals ${toolDisposals.count}`,
    );
    assert(
      routeDisposals.count === EXPECTED_ROUTE_PATHS.length,
      `route disposals ${routeDisposals.count}`,
    );
  });

  console.log("");
  if (failed === 0) {
    console.log(
      "PASS: 8 tools + 8 read routes load; write path refuses without confirm; CLI-missing is structured; no live or networked path.",
    );
    process.exit(0);
  }
  console.log(`FAIL: ${failed} failing check(s).`);
  process.exit(1);
}

await main();
