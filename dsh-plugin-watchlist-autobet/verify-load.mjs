#!/usr/bin/env node
/**
 * verify-load — dependency-free smoke test for the watchlist autobet Host bundle.
 *
 * WHAT THIS PROVES (without a DSH Host and without the core CLI):
 *   - the module imports under plain Node,
 *   - `apply(ctx, config)` registers EXACTLY the nine fixed tools and returns a disposer,
 *   - every tool declares a complete raw ToolDefinition (description, parameters, output
 *     schema/render, execute, isConcurrencySafe),
 *   - the read tools are marked concurrency-safe and the four ledger-writing tools are not,
 *   - every writing tool refuses WITHOUT `confirm: true` (including the string "true" and the
 *     number 1) with a `confirmation_required` refusal, and reaches neither argument
 *     validation nor the CLI — nothing executes,
 *   - with `confirm: true` the tools still validate their arguments first,
 *   - a missing CLI yields a structured `{ available: false, reason: "cli_missing" }` answer
 *     instead of an exception, on read tools and on a confirm-gated write tool with valid args,
 *   - every answer is a JSON-serializable object,
 *   - the disposer releases all nine registrations.
 *
 * WHAT IT DOES NOT PROVE: that a tool's CLI answer is correct, or that the Host (Electron's
 * Node main process) runs it. It uses a temp checkout with a valid root `package.json` but no
 * CLI so tools answer `cli_missing` without mutating a real ledger.
 *
 * Run: node dsh-plugin-watchlist-autobet/verify-load.mjs
 */

// ast-grep-ignore: node-fs-read-write-file -- this smoke test reads its own index.js to prove the bundle imports only node: builtins.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Runs under Node as well as Bun: import.meta.dir is Bun-only.
// ast-grep-ignore: bun-import-meta-dir
const HERE = dirname(fileURLToPath(import.meta.url));
function smokeCheckout(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-${process.pid}-`));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@tennis-hq/sportsdesk-workspace", private: true }),
  );
  return dir;
}
const SMOKE_REPO = smokeCheckout("dsh-autobet-verify");
const CLI_RELATIVE_PATH = "cli/watchlist_autobet_cli.ts";
const EXPECTED_CLI_PATH = join(SMOKE_REPO, CLI_RELATIVE_PATH);

/** Sorted, so the comparison is order-independent. */
const EXPECTED_TOOL_NAMES = [
  "autobet_decide",
  "autobet_enqueue",
  "autobet_execute",
  "autobet_journal",
  "autobet_plan",
  "autobet_queue",
  "autobet_settle",
  "autobet_signals",
  "autobet_status",
];

const READ_TOOLS = [
  "autobet_status",
  "autobet_signals",
  "autobet_plan",
  "autobet_queue",
  "autobet_journal",
];
const WRITE_TOOLS = [
  "autobet_enqueue",
  "autobet_decide",
  "autobet_execute",
  "autobet_settle",
];

/** A syntactically valid contract intent id; no such intent exists, and no CLI exists here. */
const VALID_INTENT_ID = "wa-00000000-0000-4000-8000-000000000000";

/**
 * Arguments each writing tool receives in the confirmation-gate check. They are otherwise
 * VALID, so a refusal can only come from the missing `confirm: true` — not from validation.
 */
const WRITE_ARGUMENTS = {
  autobet_enqueue: { actor: "verify-load" },
  autobet_decide: {
    intentId: VALID_INTENT_ID,
    decision: "approve",
    actor: "verify-load",
  },
  autobet_execute: { intentId: VALID_INTENT_ID },
  autobet_settle: { intentId: VALID_INTENT_ID, result: "won" },
};

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
 * @returns {value is Record<string, unknown>}
 */
// Dependency-free verifier runs in Electron's Node (no zod): local narrowing is intentional.
function isPlainObjectValue(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** One fake Host context that captures registrations and records disposals. */
function makeContext() {
  const registered = [];
  const disposed = [];
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {
          disposed.push(definition.name);
        };
      },
    },
  };
  return { ctx, registered, disposed };
}

let plugin;
try {
  plugin = await import(new URL("./index.js", import.meta.url).href);
} catch (error) {
  console.error(
    `\nFAIL  cannot import ./index.js: ${error?.message ?? error}\n\n` +
      "This bundle is dependency-free by design: it must import nothing outside node: builtins.\n",
  );
  process.exit(1);
}
const SOURCE = readFileSync(join(HERE, "index.js"), "utf8");

const harness = makeContext();
const dispose = plugin.apply(harness.ctx, {
  repoPath: SMOKE_REPO,
  bunPath: "bun-not-required-for-this-smoke-test",
  configPath: "config/watchlist-autobet.json",
  timeoutMs: 5000,
});
const byName = new Map(harness.registered.map((tool) => [tool.name, tool]));

/** Every result an execute produced; asserted to be one lossless JSON object at the end. */
const results = [];
async function call(name, args) {
  const tool = byName.get(name);
  assert(tool !== undefined, `unknown tool ${name}`);
  const value = await tool.execute(args);
  results.push({ name, value });
  return value;
}

console.log("verify-load: plugin shape");

check("module exports the cordis apply/name/inject contract", () => {
  assert(typeof plugin.apply === "function", "apply must be a function");
  assert(
    plugin.name === "watchlist-autobet",
    `name is ${JSON.stringify(plugin.name)}`,
  );
  assert(
    Array.isArray(plugin.inject) && plugin.inject.includes("tools"),
    `inject is ${JSON.stringify(plugin.inject)}`,
  );
  assert(
    typeof dispose === "function",
    "apply must return a disposer function",
  );
});

check(
  "index.js imports only node: builtins (a linked bundle resolves peers from its realpath)",
  () => {
    const specifiers = [];
    const patterns = [
      /\bfrom\s+["']([^"']+)["']/g,
      /\bimport\s*\(\s*["']([^"']+)["']/g,
      /\brequire\s*\(\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(SOURCE)) !== null) specifiers.push(match[1]);
    }
    assert(
      specifiers.length > 0,
      "found no imports at all; expected node: builtins",
    );
    for (const specifier of specifiers) {
      assert(
        specifier.startsWith("node:"),
        `index.js imports a non-builtin module: ${specifier}`,
      );
    }
    // The header may NAME a peer package to explain why it is not imported; what must not
    // appear is a peer in an import/require position (the specifier scan above covers that).
    assert(
      !/\b(?:from|require\s*\()\s*["']@deepseek-ai\//.test(SOURCE),
      "index.js imports a @deepseek-ai peer package; the bundle must stay dependency-free",
    );
  },
);

check("registers exactly the nine fixed tools", () => {
  assert(
    harness.registered.length === EXPECTED_TOOL_NAMES.length,
    `registered ${harness.registered.length} tools, expected ${EXPECTED_TOOL_NAMES.length}`,
  );
  const names = harness.registered.map((tool) => tool.name).sort();
  assert(
    // Node-runtime verifier: Bun.deepEquals is not available in Electron's Node.
    // ast-grep-ignore: bun-deep-equals
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOL_NAMES),
    `names are ${JSON.stringify(names)}`,
  );
  const unique = new Set(names);
  assert(unique.size === names.length, "a tool name is registered twice");
});

check(
  "no tool name promises a live order (live betting is not implemented)",
  () => {
    for (const tool of harness.registered) {
      assert(
        !/^autobet_(place_live|live|bet)$/.test(tool.name),
        `${tool.name} looks like a live-order tool`,
      );
    }
  },
);

for (const tool of harness.registered) {
  check(`${tool.name} declares a complete raw ToolDefinition`, () => {
    assert(
      /^autobet_[a-z_]+$/.test(tool.name),
      `unexpected tool name ${tool.name}`,
    );
    assert(
      typeof tool.description === "string" && tool.description.length > 80,
      "description must explain the capability",
    );
    assert(
      isPlainObjectValue(tool.parameters) && tool.parameters.type === "object",
      "parameters must be an object-root JSON schema",
    );
    assert(
      isPlainObjectValue(tool.output?.schema),
      "output.schema must be an object",
    );
    assert(
      typeof tool.output?.render === "function",
      "output.render must be a function",
    );
    assert(typeof tool.execute === "function", "execute must be a function");
    assert(
      typeof tool.isConcurrencySafe === "function",
      "isConcurrencySafe must be declared",
    );
  });
}

check("read tools are concurrency-safe; ledger-writing tools are not", () => {
  for (const name of READ_TOOLS) {
    assert(
      byName.get(name).isConcurrencySafe() === true,
      `${name} must be concurrency-safe`,
    );
  }
  for (const name of WRITE_TOOLS) {
    assert(
      byName.get(name).isConcurrencySafe() === false,
      `${name} must NOT be concurrency-safe`,
    );
  }
});

console.log(
  "\nverify-load: missing CLI and malformed arguments are structured answers",
);

await checkAsync(
  "read tools answer cli_missing instead of throwing (the CLI is absent here)",
  async () => {
    for (const name of ["autobet_status", "autobet_plan"]) {
      const value = await call(name, {});
      assert(isPlainObjectValue(value), `${name} did not return an object`);
      assert(value.available === false, `${name} reported available:true`);
      assert(
        value.reason === "cli_missing",
        `${name} reason is ${value.reason}`,
      );
      assert(
        typeof value.message === "string" &&
          value.message.includes(EXPECTED_CLI_PATH),
        `${name} cli_missing message does not name the expected path`,
      );
    }
    const signals = await call("autobet_signals", {
      limit: 5,
      includeRejected: true,
    });
    assert(
      signals.reason === "cli_missing",
      `signals reason is ${signals.reason}`,
    );
    const queue = await call("autobet_queue", { status: "queued", limit: 5 });
    assert(queue.reason === "cli_missing", `queue reason is ${queue.reason}`);
    const journal = await call("autobet_journal", { limit: 5 });
    assert(
      journal.reason === "cli_missing",
      `journal reason is ${journal.reason}`,
    );
  },
);

await checkAsync(
  "read tools refuse malformed arguments before spawning",
  async () => {
    const cases = [
      ["autobet_signals", { limit: 0 }, "limit"],
      ["autobet_signals", { limit: 201 }, "limit"],
      ["autobet_signals", { limit: 1.5 }, "limit"],
      ["autobet_signals", { limit: "5" }, "limit"],
      ["autobet_signals", { minConfidence: 101 }, "minConfidence"],
      ["autobet_signals", { minConfidence: -0.1 }, "minConfidence"],
      ["autobet_signals", { includeRejected: "yes" }, "includeRejected"],
      ["autobet_queue", { status: "bogus" }, "status"],
      ["autobet_queue", { limit: 501 }, "limit"],
      ["autobet_journal", { limit: 0 }, "limit"],
    ];
    for (const [name, args, field] of cases) {
      const value = await call(name, args);
      assert(
        value.available === false && value.reason === "invalid_arguments",
        `${name} accepted ${JSON.stringify(args)} (reason ${value.reason})`,
      );
      assert(
        typeof value.message === "string" && value.message.includes(field),
        `${name} refusal does not name the bad field ${field}`,
      );
    }
  },
);

console.log(
  "\nverify-load: writing tools refuse without confirm:true and execute nothing",
);

await checkAsync(
  "every writing tool refuses without confirm:true",
  async () => {
    for (const name of WRITE_TOOLS) {
      const value = await call(name, WRITE_ARGUMENTS[name]);
      assert(isPlainObjectValue(value), `${name} did not return an object`);
      assert(
        value.available === false && value.reason === "confirmation_required",
        `${name} reason is ${value.reason}; it must be confirmation_required without confirm:true`,
      );
      assert(
        typeof value.message === "string" &&
          value.message.includes("confirm: true"),
        `${name} refusal does not say how to confirm`,
      );
      assert(
        typeof value.message === "string" &&
          /human decision/i.test(value.message),
        `${name} refusal does not say approval is a human decision`,
      );
    }
  },
);

await checkAsync(
  'confirm must be exactly boolean true (the string "true" and 1 are refused)',
  async () => {
    for (const name of WRITE_TOOLS) {
      for (const confirm of ["true", 1, "yes", null]) {
        const value = await call(name, {
          ...WRITE_ARGUMENTS[name],
          confirm,
        });
        assert(
          value.reason === "confirmation_required",
          `${name} accepted confirm=${JSON.stringify(confirm)} (reason ${value.reason})`,
        );
      }
    }
  },
);

await checkAsync(
  "with confirm:true the writing tools still validate arguments first",
  async () => {
    const cases = [
      ["autobet_decide", { confirm: true }, "intentId"],
      [
        "autobet_decide",
        { confirm: true, intentId: VALID_INTENT_ID, decision: "maybe" },
        "decision",
      ],
      [
        "autobet_decide",
        { confirm: true, intentId: VALID_INTENT_ID, decision: "reject" },
        "reason",
      ],
      [
        "autobet_decide",
        {
          confirm: true,
          intentId: VALID_INTENT_ID,
          decision: "approve",
          reason: "not valid for an approval",
        },
        "reason",
      ],
      [
        "autobet_execute",
        { confirm: true, intentId: "not an id!" },
        "intentId",
      ],
      [
        "autobet_execute",
        { confirm: true, intentId: VALID_INTENT_ID, venue: "paper money" },
        "venue",
      ],
      [
        "autobet_settle",
        { confirm: true, intentId: VALID_INTENT_ID, result: "push" },
        "result",
      ],
      ["autobet_settle", { confirm: true }, "intentId"],
      ["autobet_enqueue", { confirm: true, actor: "" }, "actor"],
      [
        "autobet_decide",
        {
          confirm: true,
          intentId: VALID_INTENT_ID,
          decision: "approve",
          actor: "bad\u0000actor",
        },
        "actor",
      ],
      [
        "autobet_decide",
        {
          confirm: true,
          intentId: VALID_INTENT_ID,
          decision: "reject",
          reason: "",
        },
        "reason",
      ],
    ];
    for (const [name, args, field] of cases) {
      const value = await call(name, args);
      assert(
        value.available === false && value.reason === "invalid_arguments",
        `${name} accepted ${JSON.stringify(args)} (reason ${value.reason})`,
      );
      assert(
        typeof value.message === "string" && value.message.includes(field),
        `${name} refusal does not name the bad field ${field}`,
      );
    }
  },
);

await checkAsync(
  "a confirm-gated write with valid args reaches the CLI layer and reports cli_missing",
  async () => {
    // Valid intent id + valid venue: the only reason nothing runs is the absent CLI. This is
    // the "never throw out of execute" path for a real spawn attempt.
    const value = await call("autobet_execute", {
      confirm: true,
      intentId: VALID_INTENT_ID,
    });
    assert(
      value.available === false,
      "execute reported available:true without a CLI",
    );
    assert(value.reason === "cli_missing", `execute reason is ${value.reason}`);
  },
);

await checkAsync(
  "a confirm-gated enqueue with valid args also reports cli_missing",
  async () => {
    const value = await call("autobet_enqueue", {
      confirm: true,
      actor: "verify-load",
    });
    assert(
      value.available === false,
      "enqueue reported available:true without a CLI",
    );
    assert(value.reason === "cli_missing", `enqueue reason is ${value.reason}`);
  },
);

console.log("\nverify-load: JSON results and disposer");

await checkAsync(
  "every answer is one JSON-serializable plain object",
  async () => {
    for (const { name, value } of results) {
      assert(isPlainObjectValue(value), `${name} returned a non-object answer`);
      let roundTrip;
      try {
        roundTrip = JSON.parse(JSON.stringify(value));
      } catch (error) {
        throw new Error(
          `${name} answer is not JSON-serializable: ${error?.message ?? error}`,
          { cause: error },
        );
      }
      assert(
        // Node-runtime verifier: Bun.deepEquals is not available in Electron's Node.
        // ast-grep-ignore: bun-deep-equals
        JSON.stringify(roundTrip) === JSON.stringify(value),
        `${name} answer does not survive a JSON round-trip`,
      );
    }
  },
);

await checkAsync(
  "apply tolerates a missing/partial config by falling back to defaults",
  async () => {
    for (const config of [undefined, null, { repoPath: 42, timeoutMs: -1 }]) {
      const second = makeContext();
      const secondDispose = plugin.apply(second.ctx, config);
      assert(
        second.registered.length === EXPECTED_TOOL_NAMES.length,
        `apply(${JSON.stringify(config)}) registered ${second.registered.length} tools`,
      );
      assert(
        typeof secondDispose === "function",
        "apply did not return a disposer",
      );
      secondDispose();
      assert(
        second.disposed.length === EXPECTED_TOOL_NAMES.length,
        "disposer released only some registrations",
      );
    }
  },
);

check("dispose releases every registration", () => {
  dispose();
  assert(
    harness.disposed.length === EXPECTED_TOOL_NAMES.length,
    `disposer released ${harness.disposed.length} of ${EXPECTED_TOOL_NAMES.length}`,
  );
  const released = [...harness.disposed].sort();
  assert(
    // Node-runtime verifier: Bun.deepEquals is not available in Electron's Node.
    // ast-grep-ignore: bun-deep-equals
    JSON.stringify(released) === JSON.stringify(EXPECTED_TOOL_NAMES),
    `disposer released ${JSON.stringify(released)}`,
  );
});

console.log(
  failed === 0
    ? `\nverify-load: PASS — ${EXPECTED_TOOL_NAMES.length} tools load; writing tools refuse without confirm:true (stage 1/2, Node runtime).`
    : `\nverify-load: ${failed} FAILURE(S) (stage 1/2, Node runtime).`,
);
process.exit(failed === 0 ? 0 : 1);
