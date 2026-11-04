/**
 * Watchlist autobet (paper only) — a Host-only DSH plugin over the sportsdesk-ops
 * `cli/watchlist_autobet_cli.ts` paper-trading pipeline.
 *
 * WHY THIS EXISTS
 *
 * The desk's watchlist autobet pipeline derives signals from its own watchlist engine, gates
 * each one through a closed list of risk/provenance checks, queues paper bet intents for
 * operator approval, paper-fills approved intents and settles them. Every step is a shell
 * command. An agent could scrape stdout, but then "the CLI is missing", "the config is
 * missing" and "the ledger is corrupt" would all look like a failed command, and quoting an
 * intent id into a shell is how a typo inspects the wrong ticket. This plugin exposes the
 * same nine capabilities as native tools with typed arguments and structured results.
 *
 * PAPER ONLY — NO LIVE ORDER PATH
 *
 * Nothing in this bundle can place a real bet. `autobet_execute` calls the CLI's paper
 * adapter only; any venue other than `paper` is refused by the CLI with `live_disabled`.
 * There is no live adapter in v1, there is no live-order tool here, and the plugin has no
 * credentials and makes no network calls of its own. Live betting is NOT implemented.
 *
 * APPROVAL IS A HUMAN DECISION
 *
 * `autobet_enqueue` only APPENDS intents awaiting approval. `autobet_decide` records an
 * operator's approve/reject decision; it does not make that decision. All four state-changing
 * tools require `confirm: true`; without it they return a structured
 * `confirmation_required` refusal and execute nothing.
 *
 * WHY IT SHELLS BUN
 *
 * There are two runtimes. The repo runs under Bun; the Host plugin shim runs in Electron's
 * Node main process, where the `Bun` global is undefined. The engine, gates, ledger and
 * money math live in TypeScript that the Host cannot import, so every tool spawns the one
 * existing CLI under Bun and parses its JSON. Nothing is reimplemented here, so there is no
 * drift between the plugin and the repo's own tooling.
 *
 * WHY RAW `ctx.tools.register`
 *
 * `defineTool` lives in a peer package (`@deepseek-ai/dsh-tools`). A directory-installed
 * bundle is a LINK, and Node resolves a linked module's imports from its realpath (this
 * checkout), not from the profile — which fails with ERR_MODULE_NOT_FOUND unless the bundle
 * hand-symlinks the peer. A raw ToolDefinition needs no dependencies, which is what the
 * documented "a Host-only bundle needs no dependencies" contract means. The trade-off: raw
 * registration does NOT validate arguments, so every tool validates its own and returns a
 * structured refusal instead of throwing.
 *
 * THE CLI CONTRACT (frozen in Scratch/watchlist-autobet/CONTRACT.md)
 *
 * `bun run cli/watchlist_autobet_cli.ts <command> [flags]`, `--json` always, with
 * `--root <repoPath>` and `--config <configPath>`. Success JSON carries
 * `{ success: true, schemaVersion: 1, command, generatedAt, ...payload }`; failure JSON
 * carries `{ success: false, schemaVersion: 1, command, error: { code, message, details? } }`
 * and the exit code distinguishes usage (2) / refusal (3) / other (1). The wrapper returns a
 * success payload unchanged, and a failure as
 * `{ available: false, reason: <CLI code>, message, command, cli: <the CLI JSON> }` so the
 * error code and details are preserved rather than flattened.
 *
 * @module dsh-plugin-watchlist-autobet
 */

// ast-grep-ignore: node-child-process -- Host plugin code runs in Electron's Node main process, where the Bun global does not exist; spawning bun is the shim's whole job.
import { execFile } from "node:child_process";
// The control-plane CSRF token is generated per plugin activation; node:crypto is a builtin.
import { randomUUID } from "node:crypto";
// ast-grep-ignore: node-fs-read-write-file -- same runtime: Bun.file() is not defined in Electron's Node, and the pre-spawn CLI existence check needs node:fs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const name = "watchlist-autobet";

export const inject = ["tools"];

/** Repo-relative path of the core CLI every tool shells. Fixed by the frozen contract. */
const CLI_RELATIVE_PATH = "cli/watchlist_autobet_cli.ts";

/**
 * Defaults for the bundle row's `config`.
 *
 * WHY THIS PLUGIN DECLARES NO `Config` SCHEMA: a Schemastery schema would import
 * `@deepseek-ai/schemastery`, and a directory-installed bundle is a LINK whose imports
 * resolve from its realpath (this checkout), not from the profile. This bundle is
 * dependency-free instead; the loader then passes the row config through unvalidated, so
 * values are normalized here and a malformed value falls back to its default rather than
 * reaching a spawn.
 */
const DEFAULT_CONFIG = {
  repoPath: "/Users/nolarose/code/sportsdesk-ops",
  bunPath: "bun",
  // Repo-relative, as the CLI contract requires. Changing it to a non-paper config cannot
  // enable live execution: the CLI rejects any mode other than "paper" at config load time.
  configPath: "config/watchlist-autobet.json",
  timeoutMs: 60_000,
};

/** Closed sets the CLI contract fixes. A value outside one is refused before the spawn. */
const QUEUE_STATUSES = Object.freeze([
  "queued",
  "approved",
  "filled",
  "settled",
  "rejected",
  "expired",
]);
const SETTLE_RESULTS = Object.freeze(["won", "lost", "void"]);
const DECISIONS = Object.freeze(["approve", "reject"]);

/** `intentId` is `wa-` + UUID from the engine; this pattern is deliberately a bit wider. */
const INTENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
/**
 * A venue is a short token (`paper`, `live`, `draftkings`). Anything else is refused here as
 * malformed; a well-formed non-paper venue still reaches the CLI, which is the code that owns
 * the `live_disabled` refusal. This plugin never decides that a venue is safe.
 */
const VENUE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_ACTOR_LENGTH = 120;
const MAX_FREE_TEXT_LENGTH = 2000;
/** How much captured stdout/stderr a failure result keeps before eliding the rest. */
const MAX_EXCERPT = 4000;

/**
 * Same-origin control-plane API consumed by this bundle's Client page. It is a thin,
 * paper-only adapter over the same CLI the tools shell: reads compose the operator board
 * and the signals inspector, and the single mutation endpoint maps a closed action set onto
 * the CLI commands. The routes never construct a shell string, and every mutation requires
 * `confirm: true` plus a per-activation CSRF token, so a cross-site page cannot drive the
 * ledger.
 */
const HTTP_PREFIX = "/api/watchlist-autobet";
const MAX_HTTP_BODY_BYTES = 32 * 1024;
const HTTP_BOARD_CACHE_MS = 4_000;
/** Signals derivation is one CLI spawn per key; cache it briefly to absorb UI re-renders. */
const HTTP_SIGNALS_CACHE_MS = 4_000;
/** Bound the signals cache; each entry is one derived snapshot. */
const HTTP_SIGNALS_CACHE_MAX_KEYS = 8;
/** CLI contract bounds for `signals` (see the command's --help). */
const HTTP_SIGNALS_DEFAULT_LIMIT = 50;
const HTTP_SIGNALS_MAX_LIMIT = 200;
const HTTP_SIGNALS_MAX_MIN_CONFIDENCE = 100;
/** Journal event type → the operator decision it records (the UI's decision feed). */
const HTTP_DECISION_ACTIONS = Object.freeze({
  intent_approved: "approve",
  intent_rejected: "reject",
  intent_filled: "execute",
  intent_settled: "settle",
  intent_expired: "expire",
});

/**
 * Parse and validate the `/signals` query string before any spawn. The query is the only
 * caller-controlled input on that route; every value is bounded here so the CLI receives a
 * closed flag set. Unknown parameters are ignored (forward-compatible), not forwarded.
 *
 * @param {unknown} rawUrl the request URL (path + query)
 * @returns {{ ok: true, value: { includeRejected: boolean, limit: number, minConfidence: number | undefined } } | { ok: false, message: string }}
 */
function readSignalsQuery(rawUrl) {
  let params;
  try {
    params = new URL(String(rawUrl ?? "/"), "http://carrier.invalid")
      .searchParams;
  } catch {
    return { ok: false, message: "the request URL could not be parsed" };
  }
  const includeRaw = params.get("includeRejected");
  let includeRejected = false;
  if (includeRaw !== null) {
    if (includeRaw === "true" || includeRaw === "1") includeRejected = true;
    else if (includeRaw === "false" || includeRaw === "0")
      includeRejected = false;
    else {
      return {
        ok: false,
        message: "includeRejected must be true, false, 1 or 0",
      };
    }
  }
  const limitRaw = params.get("limit");
  let limit = HTTP_SIGNALS_DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^\d+$/.test(limitRaw)) {
      return {
        ok: false,
        message: `limit must be an integer 1-${HTTP_SIGNALS_MAX_LIMIT}`,
      };
    }
    limit = Number(limitRaw);
    if (limit < 1 || limit > HTTP_SIGNALS_MAX_LIMIT) {
      return {
        ok: false,
        message: `limit must be an integer 1-${HTTP_SIGNALS_MAX_LIMIT}`,
      };
    }
  }
  const confidenceRaw = params.get("minConfidence");
  let minConfidence;
  if (confidenceRaw !== null) {
    if (!/^\d+$/.test(confidenceRaw)) {
      return {
        ok: false,
        message: `minConfidence must be an integer 0-${HTTP_SIGNALS_MAX_MIN_CONFIDENCE}`,
      };
    }
    minConfidence = Number(confidenceRaw);
    if (minConfidence > HTTP_SIGNALS_MAX_MIN_CONFIDENCE) {
      return {
        ok: false,
        message: `minConfidence must be an integer 0-${HTTP_SIGNALS_MAX_MIN_CONFIDENCE}`,
      };
    }
  }
  return { ok: true, value: { includeRejected, limit, minConfidence } };
}

/**
 * Merge the row's config over the defaults, keeping only values of the right shape.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
function normalizeConfig(raw) {
  const given = typeof raw === "object" && raw !== null ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  for (const key of ["repoPath", "bunPath", "configPath"]) {
    const value = given[key];
    if (typeof value === "string" && value.trim() !== "") {
      config[key] = value.trim();
    }
  }
  const timeout = given.timeoutMs;
  if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) {
    config.timeoutMs = timeout;
  }
  return config;
}

/** Every tool returns one JSON object; the render callback owns the text projection. */
const TEXT_OUTPUT = {
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [
    { type: "text", text: JSON.stringify(value, null, 2) },
  ],
};

/**
 * @param {unknown} value
 * @returns {boolean}
 */
// Dependency-free plugin runs in Electron's Node (no zod): local narrowing is intentional.
function isPlainObjectValue(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Build a raw ToolDefinition without importing `@deepseek-ai/dsh-tools`.
 *
 * The wrapper is the "never throw out of execute" guarantee: an argument validator that
 * misses a case, an unexpected CLI adapter failure, or a non-object return is turned into a
 * structured object instead of an exception that would surface as a tool crash.
 *
 * @param {{ name: string, description: string, parameters: object, isConcurrencySafe: () => boolean, execute: (args: any) => Promise<unknown> }} spec
 * @returns {object}
 */
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { ...TEXT_OUTPUT, presentationMeta: (_args, value) => value },
    isConcurrencySafe: spec.isConcurrencySafe,
    async execute(args) {
      try {
        const value = await spec.execute(isPlainObjectValue(args) ? args : {});
        if (isPlainObjectValue(value)) return value;
        return {
          available: false,
          reason: "internal_error",
          message: `${spec.name} produced a non-object result; this is a plugin bug, not a CLI answer.`,
        };
      } catch (error) {
        return {
          available: false,
          reason: "internal_error",
          message: `${spec.name} failed before it could return a structured answer: ${
            error?.message ?? String(error)
          }`,
        };
      }
    },
  };
}

/**
 * Structured refusal for a malformed argument (raw registration does not validate input).
 *
 * @param {string} message
 * @returns {{ available: false, reason: "invalid_arguments", message: string }}
 */
function invalidArguments(message) {
  return { available: false, reason: "invalid_arguments", message };
}

/**
 * The refusal every writing tool returns when `confirm: true` was not supplied.
 *
 * WHY THE MESSAGE SAYS "re-run with confirm: true" AND "human decision": a model that can
 * retry must know the exact token that unlocks the action, and it must not read the token as
 * permission to decide the approval itself. Nothing executes on this path.
 *
 * @param {string} tool
 * @param {string} action
 * @returns {{ available: false, reason: "confirmation_required", message: string }}
 */
function confirmationRequired(tool, action) {
  return {
    available: false,
    reason: "confirmation_required",
    message:
      `${tool} ${action}. Nothing was executed and the paper ledger is unchanged. ` +
      "Review the action first (autobet_plan for a dry run, autobet_queue for the current " +
      "intents), then re-run with confirm: true. Approval of a queued intent is a human " +
      "decision; this plugin only records the decision it is given and never places a live bet.",
  };
}

/**
 * Shared optional-integer reader: `{ ok, present, value? }` or a refusal message.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 * @param {number} min
 * @param {number} max
 */
function readInteger(request, key, min, max) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return {
      ok: false,
      message: `${key} must be an integer from ${min} to ${max}.`,
    };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-number reader (finite, range-checked).
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 * @param {number} min
 * @param {number} max
 */
function readNumber(request, key, min, max) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    return {
      ok: false,
      message: `${key} must be a number from ${min} to ${max}.`,
    };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-boolean reader.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 */
function readBoolean(request, key) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (typeof value !== "boolean") {
    return { ok: false, message: `${key} must be a boolean.` };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-enum reader over a closed set.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 * @param {readonly string[]} allowed
 */
function readEnum(request, key, allowed) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (typeof value !== "string" || !allowed.includes(value)) {
    return {
      ok: false,
      message: `${key} must be one of: ${allowed.join(", ")} (got ${JSON.stringify(value)}).`,
    };
  }
  return { ok: true, present: true, value };
}

/**
 * Read and validate the required `intentId`. The value is passed as ONE argv element, never
 * interpolated into a shell.
 *
 * @param {Record<string, unknown>} request
 */
function readIntentId(request) {
  const value = request.intentId;
  if (typeof value !== "string") {
    return { ok: false, message: "intentId must be a string." };
  }
  const trimmed = value.trim();
  if (!INTENT_ID_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        "intentId must be a ledger id such as wa-<uuid> (letters, digits, dot, colon, " +
        "underscore, hyphen; at most 160 characters).",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * True when a string carries C0 controls (except tab/newline) or DEL.
 *
 * WHY A LOOP AND NOT A REGEX: a control-character regex trips the lint rule that exists
 * because such patterns are usually accidental. This check is intentional, so it is written
 * as code the rule does not have to guess about.
 *
 * @param {string} value
 * @returns {boolean}
 */
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Read the optional `actor` (who records the action); the plugin's default is `dsh-agent`.
 * The CLI contract defaults it too, but sending it explicitly makes the ledger entry
 * attributable to this tool.
 *
 * @param {Record<string, unknown>} request
 */
function readActor(request) {
  const value = request.actor;
  if (value === undefined) return { ok: true, value: "dsh-agent" };
  if (typeof value !== "string") {
    return { ok: false, message: "actor must be a string." };
  }
  const trimmed = value.trim();
  if (
    trimmed === "" ||
    trimmed.length > MAX_ACTOR_LENGTH ||
    hasControlCharacters(trimmed)
  ) {
    return {
      ok: false,
      message: `actor must be a non-empty string of at most ${MAX_ACTOR_LENGTH} characters with no control characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Read optional free text (`note` / `reason`). Empty-after-trim is treated as malformed
 * rather than silently dropped, so a decision cannot lose its stated reason.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 */
function readFreeText(request, key) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (typeof value !== "string") {
    return { ok: false, message: `${key} must be a string.` };
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return {
      ok: false,
      message: `${key} must be a non-empty string when provided.`,
    };
  }
  if (trimmed.length > MAX_FREE_TEXT_LENGTH) {
    return {
      ok: false,
      message: `${key} must be at most ${MAX_FREE_TEXT_LENGTH} characters.`,
    };
  }
  if (hasControlCharacters(trimmed)) {
    return {
      ok: false,
      message: `${key} must not contain control characters.`,
    };
  }
  return { ok: true, present: true, value: trimmed };
}

/**
 * Read the optional `venue`; default `paper`. A well-formed non-paper token is NOT refused
 * here — it is handed to the CLI, which owns the `live_disabled` refusal. Malformed tokens
 * never reach a spawn.
 *
 * @param {Record<string, unknown>} request
 */
function readVenue(request) {
  const value = request.venue;
  if (value === undefined) return { ok: true, value: "paper" };
  if (typeof value !== "string") {
    return { ok: false, message: "venue must be a string (default: paper)." };
  }
  const trimmed = value.trim();
  if (!VENUE_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        "venue must be a short lowercase token such as paper (letters, digits, underscore, " +
        "hyphen; at most 32 characters).",
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * Parse JSON without throwing. If the whole text does not parse, the last non-empty line is
 * tried, because a CLI that printed a progress line before its final JSON line would
 * otherwise look broken.
 *
 * @param {string | null} text
 * @returns {{ ok: boolean, value: unknown }}
 */
function parseJson(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // fall through to the single-line fallback
  }
  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") || line.startsWith("["));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return { ok: true, value: JSON.parse(lines[index]) };
    } catch {
      // try an earlier line
    }
  }
  return { ok: false, value: null };
}

/**
 * Trim a captured stream for transport.
 *
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const clean = String(text ?? "").trim();
  if (clean.length <= MAX_EXCERPT) return clean;
  const dropped = clean.length - MAX_EXCERPT;
  return `${clean.slice(0, MAX_EXCERPT)}\n... (${dropped} more characters)`;
}

/**
 * Find the bun executable that will run the CLI.
 *
 * Resolution order: an explicit absolute `bunPath`, then the running binary when we ARE Bun,
 * then the known install locations, then the bare configured value so a spawn failure is
 * reported as "could not start" rather than silently misreported.
 *
 * @param {string} preferred
 * @returns {string}
 */
function resolveBun(preferred) {
  if (preferred && preferred !== "bun" && existsSync(preferred)) {
    return preferred;
  }
  if (process.versions && process.versions.bun) return process.execPath;
  const home = homedir();
  for (const candidate of [
    `${home}/.bun/bin/bun`,
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return preferred || "bun";
}

/**
 * Spawn one process and report its outcome WITHOUT throwing.
 *
 * A non-zero exit is DATA, not an exception: the CLI contract exits 2 for a usage error, 3
 * for a refusal and 1 for everything else, and collapsing those into a thrown error would
 * hide which one happened. A timeout is reported as timed_out, never as a refusal.
 *
 * @param {string} bin
 * @param {string[]} argv
 * @param {{ cwd: string, timeoutMs: number }} options
 * @returns {Promise<{ ok: boolean, exitCode: number | null, timedOut: boolean, stdout: string, stderr: string, durationMs: number, spawnError: string | null }>}
 */
async function runProcess(bin, argv, options) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(bin, argv, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    });
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      // ast-grep-ignore: perf-now-timing -- the Host runtime is Electron Node, where Bun.nanoseconds is undefined; this duration is reported, not used for ordering.
      durationMs: Date.now() - startedAt,
      spawnError: null,
    };
  } catch (error) {
    const exitCode = typeof error?.code === "number" ? error.code : null;
    const timedOut = error?.killed === true && error?.signal === "SIGTERM";
    const spawnError =
      exitCode === null && !timedOut
        ? `could not start ${bin}: ${error?.message ?? String(error)}`
        : null;
    return {
      ok: false,
      exitCode,
      timedOut,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? String(error)),
      // ast-grep-ignore: perf-now-timing -- the Host runtime is Electron Node, where Bun.nanoseconds is undefined; this duration is reported, not used for ordering.
      durationMs: Date.now() - startedAt,
      spawnError,
    };
  }
}

/**
 * Write one JSON HTTP response without throwing.
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(payload);
}

/**
 * Read one bounded JSON object from a Node request body, without throwing.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, status: number, message: string }>}
 */
async function readHttpJsonBody(req) {
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    // The frozen control-plane contract collapses malformed requests to 400 invalid_body;
    // the action handler keeps the specific reason in the message.
    return {
      ok: false,
      status: 400,
      message: "content-type must be application/json",
    };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_HTTP_BODY_BYTES) {
      return {
        ok: false,
        status: 400,
        message: `request body exceeds ${MAX_HTTP_BODY_BYTES} bytes`,
      };
    }
    chunks.push(chunk);
  }
  const parsed = parseJson(Buffer.concat(chunks).toString("utf8"));
  if (!parsed.ok || !isPlainObjectValue(parsed.value)) {
    return {
      ok: false,
      status: 400,
      message: "request body must be one JSON object",
    };
  }
  return { ok: true, value: parsed.value };
}

/**
 * Human-readable market label for the operator UI, derived only from intent fields the
 * engine already recorded. It is a projection, never a new market interpretation.
 *
 * @param {Record<string, unknown>} intent
 * @returns {string}
 */
function buildIntentMarketLabel(intent) {
  if (!isPlainObjectValue(intent)) return "";
  const parts = [];
  if (typeof intent.league === "string" && intent.league !== "") {
    parts.push(intent.league);
  }
  if (Array.isArray(intent.teams) && intent.teams.length > 0) {
    parts.push(intent.teams.join(" vs "));
  }
  if (typeof intent.marketKind === "string" && intent.marketKind !== "") {
    parts.push(intent.marketKind.replaceAll("_", " "));
  }
  if (typeof intent.line === "number") parts.push(String(intent.line));
  const side = intent.overUnder ?? intent.sideTeam ?? null;
  if (typeof side === "string" && side !== "") parts.push(side);
  return parts.join(" · ");
}

/**
 * The one primary action an operator can take next, mirroring the CLI transition rules.
 *
 * @param {unknown} status
 * @returns {"approve" | "execute" | "settle" | null}
 */
function nextActionForStatus(status) {
  if (status === "queued") return "approve";
  if (status === "approved") return "execute";
  if (status === "filled") return "settle";
  return null;
}

/**
 * @param {{ tools: { register: (definition: object) => () => void } }} ctx
 *   Host context; only the `tools` service is injected, so no other service is touched.
 * @param {unknown} config the bundle row's config (normalized above)
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const repoPath = settings.repoPath;
  const cliAbsolutePath = join(repoPath, CLI_RELATIVE_PATH);
  /** Disposers from ctx.tools.register, returned as this plugin's cleanup. */
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  /**
   * Build the failure object for a CLI answer that was not a success.
   *
   * The CLI's own error code becomes `reason` unchanged (`config_missing`,
   * `ledger_corrupt`, `invalid_transition`, `intent_expired`, `live_disabled`, …) so a caller
   * can branch on the contract code, and the whole CLI JSON is preserved under `cli` so
   * nothing in `error.details` is lost.
   *
   * @param {{ reason: string, message: string, command: string, exitCode?: number | null, parsed?: unknown, result?: any }} failure
   * @returns {Record<string, unknown>}
   */
  function cliFailure(failure) {
    const answer = {
      available: false,
      reason: failure.reason,
      message: failure.message,
      command: failure.command,
    };
    if (failure.exitCode !== undefined && failure.exitCode !== null) {
      answer.exitCode = failure.exitCode;
    }
    if (failure.parsed !== undefined && failure.parsed !== null) {
      answer.cli = failure.parsed;
      const error = failure.parsed.error;
      if (isPlainObjectValue(error) && error.details !== undefined) {
        answer.details = error.details;
      }
    }
    if (failure.result) {
      answer.durationMs = failure.result.durationMs;
      const stderr = excerpt(failure.result.stderr);
      if (stderr !== "") answer.stderr = stderr;
    }
    return answer;
  }

  /**
   * Run one closed-set CLI command and return exactly one JSON object.
   *
   * The CLI is spawned with an argv ARRAY (never a shell string): command parts are built
   * only from the closed command set plus validated argument values, so user text can never
   * become a shell word. `--root` and `--config` are passed explicitly even though the cwd is
   * already `repoPath`, so the answer does not depend on an implicit default.
   *
   * @param {string[]} commandArgv validated command + flag argv (no `--json`, no globals)
   * @returns {Promise<Record<string, unknown>>}
   */
  async function runCli(commandArgv) {
    const command = String(commandArgv[0] ?? "unknown");
    if (!existsSync(cliAbsolutePath)) {
      return {
        available: false,
        reason: "cli_missing",
        command,
        message:
          `The watchlist autobet CLI was not found at ${cliAbsolutePath}. ` +
          "The core engine/CLI workstream has not created it yet, or repoPath points at " +
          "the wrong checkout. Nothing was executed.",
        expectedPath: cliAbsolutePath,
        hint: `bun run ${CLI_RELATIVE_PATH} status --json --root ${repoPath}`,
      };
    }
    const argv = [
      "run",
      CLI_RELATIVE_PATH,
      ...commandArgv,
      "--json",
      "--root",
      repoPath,
      "--config",
      settings.configPath,
    ];
    const result = await runProcess(resolveBun(settings.bunPath), argv, {
      cwd: repoPath,
      timeoutMs: settings.timeoutMs,
    });
    if (result.spawnError !== null) {
      return {
        available: false,
        reason: "cli_missing",
        command,
        message: `Could not start bun (${result.spawnError}). Nothing was executed.`,
        bin: settings.bunPath,
      };
    }
    if (result.timedOut) {
      return {
        available: false,
        reason: "cli_timeout",
        command,
        message: `The CLI did not finish within ${settings.timeoutMs} ms and was stopped. No result is reported; the ledger may or may not have changed — re-read autobet_journal before retrying.`,
        timeoutMs: settings.timeoutMs,
        durationMs: result.durationMs,
      };
    }
    const parsed = parseJson(result.stdout);
    if (parsed.ok && isPlainObjectValue(parsed.value)) {
      const payload = parsed.value;
      if (payload.success === true) {
        if (!result.ok) {
          return cliFailure({
            reason: "cli_failed",
            message: `The CLI reported success but exited with code ${result.exitCode}; the answer is not trusted.`,
            command:
              typeof payload.command === "string" ? payload.command : command,
            exitCode: result.exitCode,
            parsed: payload,
            result,
          });
        }
        // Success payload is returned unchanged: the contract fixes its shape, and adding
        // wrapper keys here would make the CLI contract and the tool answer diverge.
        return payload;
      }
      if (payload.success === false) {
        const error = isPlainObjectValue(payload.error) ? payload.error : {};
        return cliFailure({
          reason:
            typeof error.code === "string" && error.code !== ""
              ? error.code
              : "cli_failed",
          message:
            typeof error.message === "string" && error.message !== ""
              ? error.message
              : "The CLI reported failure without a message.",
          command:
            typeof payload.command === "string" ? payload.command : command,
          exitCode: result.exitCode,
          parsed: payload,
          result,
        });
      }
      return cliFailure({
        reason: "cli_failed",
        message:
          "The CLI answered a JSON object without a boolean `success` field; the contract " +
          "violation is reported instead of guessing success or failure.",
        command,
        exitCode: result.exitCode,
        parsed: payload,
        result,
      });
    }
    const stderr = String(result.stderr ?? "");
    if (/Module not found|Cannot find module|ENOENT/.test(stderr)) {
      return cliFailure({
        reason: "cli_missing",
        message: `bun could not find ${CLI_RELATIVE_PATH} under ${repoPath}. Nothing was executed.`,
        command,
        exitCode: result.exitCode,
        result,
      });
    }
    return cliFailure({
      reason: "cli_failed",
      message: `The CLI exited with code ${result.exitCode} and its stdout was not a JSON object.`,
      command,
      exitCode: result.exitCode,
      result,
    });
  }

  // ---------------------------------------------------------------------------
  // Control-plane HTTP API (the operator UI half of this bundle)
  //
  // Three same-origin routes are served by the Harness browser carrier when it exists; a
  // headless profile keeps the tools and simply has no UI routes. All three delegate to
  // the same CLI as the tools, so the engine, gates, ledger and money math have exactly
  // one implementation. Mutations are confirm-gated and CSRF-guarded; execute is hard-coded
  // to the paper venue and no route can place a live bet.
  // ---------------------------------------------------------------------------

  /**
   * Raw CLI JSON for HTTP. A transport failure is `{ ok:false, reason, message }`; a CLI
   * answer (success OR refusal) is `{ ok:true, body }` so the UI can render the CLI error
   * code instead of losing it.
   *
   * @param {string[]} commandArgv
   * @returns {Promise<{ ok: true, body: Record<string, unknown> } | { ok: false, reason: string, message: string, exitCode?: number | null, stderr?: string }>}
   */
  async function runCliJson(commandArgv) {
    const command = String(commandArgv[0] ?? "unknown");
    if (!existsSync(cliAbsolutePath)) {
      return {
        ok: false,
        reason: "cli_missing",
        message: `The watchlist autobet CLI was not found at ${cliAbsolutePath}. Nothing was executed.`,
      };
    }
    const argv = [
      "run",
      CLI_RELATIVE_PATH,
      ...commandArgv,
      "--json",
      "--root",
      repoPath,
      "--config",
      settings.configPath,
    ];
    const result = await runProcess(resolveBun(settings.bunPath), argv, {
      cwd: repoPath,
      timeoutMs: settings.timeoutMs,
    });
    if (result.spawnError !== null) {
      return {
        ok: false,
        reason: "cli_missing",
        message: `Could not start bun (${result.spawnError}). Nothing was executed.`,
      };
    }
    if (result.timedOut) {
      return {
        ok: false,
        reason: "cli_timeout",
        message: `The CLI did not finish within ${settings.timeoutMs} ms and was stopped.`,
      };
    }
    const parsed = parseJson(result.stdout);
    if (!parsed.ok || !isPlainObjectValue(parsed.value)) {
      return {
        ok: false,
        reason: "cli_unparseable",
        message: `${command}: the CLI stdout was not a JSON object (exit ${result.exitCode}).`,
        exitCode: result.exitCode,
        stderr: excerpt(result.stderr),
      };
    }
    return { ok: true, body: parsed.value };
  }

  /** Board cache: a board is four CLI reads; the UI polls every 20 s. */
  let boardCacheAt = 0;
  /** @type {Record<string, unknown> | null} */
  let boardCacheValue = null;
  /** Signals cache keyed by the full validated query; insertion order is the eviction order. */
  /** @type {Map<string, { at: number, value: Record<string, unknown> }>} */
  const signalsCache = new Map();

  /**
   * Compose the operator board: safety, config, source freshness, ledger counts, intents
   * with UI derivations, paper summary, the current plan (what would queue) and the recent
   * decision feed. Four read-only CLI calls; no mutation.
   */
  async function readBoard(force = false) {
    const nowMs = Date.now();
    if (
      !force &&
      boardCacheValue !== null &&
      nowMs - boardCacheAt < HTTP_BOARD_CACHE_MS
    ) {
      return { ok: true, value: boardCacheValue };
    }
    const [status, list, journal, plan] = await Promise.all([
      runCliJson(["status"]),
      runCliJson(["list", "--limit", "500"]),
      runCliJson(["journal", "--limit", "500"]),
      runCliJson(["plan"]),
    ]);
    const parts = { status, list, journal, plan };
    for (const [name, part] of Object.entries(parts)) {
      if (!part.ok) {
        return {
          ok: false,
          reason: part.reason,
          message: `${name}: ${part.message}`,
        };
      }
      if (part.body.success !== true) {
        const error = isPlainObjectValue(part.body.error)
          ? part.body.error
          : {};
        return {
          ok: false,
          reason:
            typeof error.code === "string" && error.code !== ""
              ? error.code
              : "cli_failed",
          message:
            typeof error.message === "string" && error.message !== ""
              ? `${name}: ${error.message}`
              : `${name}: the CLI reported failure.`,
        };
      }
    }
    const now = new Date();
    const rawIntents = Array.isArray(list.body.intents)
      ? list.body.intents
      : [];
    const intents = rawIntents.map((intent) => {
      const expiresAtMs =
        typeof intent.expiresAt === "string"
          ? Date.parse(intent.expiresAt)
          : Number.NaN;
      return {
        ...intent,
        marketLabel: buildIntentMarketLabel(intent),
        expiresInMinutes: Number.isFinite(expiresAtMs)
          ? Math.round((expiresAtMs - now.getTime()) / 60_000)
          : null,
        nextAction: nextActionForStatus(intent.status),
      };
    });
    const byId = new Map(intents.map((intent) => [intent.intentId, intent]));
    const rawEvents = Array.isArray(journal.body.events)
      ? journal.body.events
      : [];
    const decisions = rawEvents
      .filter(
        (event) =>
          typeof event.type === "string" &&
          HTTP_DECISION_ACTIONS[event.type] !== undefined,
      )
      .map((event) => {
        const intent = byId.get(event.intentId) ?? null;
        const data = isPlainObjectValue(event.data) ? event.data : {};
        return {
          intentId: event.intentId,
          signalId: intent === null ? null : intent.signalId,
          marketLabel: intent === null ? null : intent.marketLabel,
          type: event.type,
          action: HTTP_DECISION_ACTIONS[event.type],
          actor: event.actor,
          at: event.at,
          note: typeof data.note === "string" ? data.note : null,
          reason: typeof data.reason === "string" ? data.reason : null,
          stakeUsd: intent === null ? null : intent.stakeUsd,
          status: intent === null ? null : intent.status,
        };
      })
      .reverse();
    const value = {
      ok: true,
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      safety: status.body.safety,
      config: status.body.config,
      sources: status.body.sources,
      ledger: status.body.ledger,
      counts: list.body.counts,
      intents,
      summary: journal.body.summary,
      plan: plan.body,
      decisions,
    };
    boardCacheAt = Date.now();
    boardCacheValue = value;
    return { ok: true, value };
  }

  /**
   * Derive the watchlist signals for the operator inspector. One read-only CLI call per
   * (includeRejected, limit, minConfidence) key, cached for a moment because the browser may
   * activate the tab or refresh in quick succession. The cache is keyed, never global: a
   * different query can never receive another query's payload.
   *
   * @param {{ includeRejected: boolean, limit: number, minConfidence: number | undefined }} query
   * @param {boolean} [force]
   * @returns {Promise<{ ok: true, value: Record<string, unknown> } | { ok: false, reason: string, message: string }>}
   */
  async function readSignals(query, force = false) {
    const cacheKey = `${query.includeRejected ? "1" : "0"}|${query.limit}|${query.minConfidence ?? ""}`;
    const nowMs = Date.now();
    const cached = signalsCache.get(cacheKey);
    if (
      !force &&
      cached !== undefined &&
      nowMs - cached.at < HTTP_SIGNALS_CACHE_MS
    ) {
      return { ok: true, value: cached.value };
    }
    const argv = ["signals", "--limit", String(query.limit)];
    if (query.includeRejected) argv.push("--include-rejected");
    if (query.minConfidence !== undefined) {
      argv.push("--min-confidence", String(query.minConfidence));
    }
    const cli = await runCliJson(argv);
    if (!cli.ok) {
      return { ok: false, reason: cli.reason, message: cli.message };
    }
    if (cli.body.success !== true) {
      const error = isPlainObjectValue(cli.body.error) ? cli.body.error : {};
      return {
        ok: false,
        reason:
          typeof error.code === "string" && error.code !== ""
            ? error.code
            : "cli_failed",
        message:
          typeof error.message === "string" && error.message !== ""
            ? `signals: ${error.message}`
            : "signals: the CLI reported failure.",
      };
    }
    // Keep the CLI contract shape and add the envelope marker the other control-plane
    // answers use; the UI reads `ok` before trusting the payload.
    const value = { ...cli.body, ok: true };
    if (signalsCache.size >= HTTP_SIGNALS_CACHE_MAX_KEYS) {
      const oldestKey = signalsCache.keys().next().value;
      if (oldestKey !== undefined) signalsCache.delete(oldestKey);
    }
    signalsCache.set(cacheKey, { at: nowMs, value });
    return { ok: true, value };
  }

  /** Closed action set the operator UI may post. */
  const HTTP_ACTIONS = Object.freeze([
    "enqueue",
    "approve",
    "reject",
    "execute",
    "settle",
  ]);

  /**
   * Validate one action body and run the matching CLI command. Every branch maps to an
   * argv array of literal flags and validated values — never a shell string. Approve and
   * reject require an explicit operator name; execute is pinned to the paper venue.
   */
  async function performHttpAction(body) {
    if (!isPlainObjectValue(body)) {
      return {
        status: 400,
        body: {
          ok: false,
          reason: "invalid_body",
          message: "request body must be a JSON object",
        },
      };
    }
    const action = typeof body.action === "string" ? body.action : "";
    if (!HTTP_ACTIONS.includes(action)) {
      return {
        status: 400,
        body: {
          ok: false,
          reason: "invalid_action",
          message: `action must be one of: ${HTTP_ACTIONS.join(", ")}`,
        },
      };
    }
    if (body.confirm !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          reason: "confirmation_required",
          message:
            "re-run with confirm: true; the control plane never mutates on a poll or a bare request",
        },
      };
    }
    const actorResult = readActor({
      actor: typeof body.actor === "string" ? body.actor : undefined,
    });
    if (!actorResult.ok) {
      return {
        status: 400,
        body: {
          ok: false,
          reason: "invalid_arguments",
          message: actorResult.message,
        },
      };
    }
    const actorProvided =
      typeof body.actor === "string" && body.actor.trim() !== "";
    if ((action === "approve" || action === "reject") && !actorProvided) {
      return {
        status: 400,
        body: {
          ok: false,
          reason: "actor_required",
          message:
            "approve/reject are human decisions: send the operator name as `actor`",
        },
      };
    }
    const actor = actorProvided ? actorResult.value : "operator";

    /** @type {string[]} */
    let argv;
    if (action === "enqueue") {
      argv = ["enqueue", "--actor", actor];
    } else {
      const intentResult = readIntentId({ intentId: body.intentId });
      if (!intentResult.ok) {
        return {
          status: 400,
          body: {
            ok: false,
            reason: "invalid_arguments",
            message: intentResult.message,
          },
        };
      }
      const intentId = intentResult.value;
      if (action === "approve") {
        const noteResult = readFreeText({ note: body.note }, "note");
        if (!noteResult.ok) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "invalid_arguments",
              message: noteResult.message,
            },
          };
        }
        argv = ["approve", intentId, "--actor", actor];
        if (noteResult.present) argv.push("--note", noteResult.value);
      } else if (action === "reject") {
        const reasonResult = readFreeText({ reason: body.reason }, "reason");
        if (!reasonResult.ok) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "invalid_arguments",
              message: reasonResult.message,
            },
          };
        }
        if (!reasonResult.present) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "invalid_arguments",
              message: "reject requires a non-empty reason",
            },
          };
        }
        argv = [
          "reject",
          intentId,
          "--actor",
          actor,
          "--reason",
          reasonResult.value,
        ];
      } else if (action === "execute") {
        // The venue is not caller-controlled: paper is the only adapter in v1.
        argv = ["execute", intentId, "--venue", "paper"];
      } else {
        const resultResult = readEnum(
          { result: body.result },
          "result",
          SETTLE_RESULTS,
        );
        if (!resultResult.ok) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "invalid_arguments",
              message: resultResult.message,
            },
          };
        }
        if (!resultResult.present) {
          return {
            status: 400,
            body: {
              ok: false,
              reason: "invalid_arguments",
              message: "settle requires result: won, lost or void",
            },
          };
        }
        argv = ["settle", intentId, "--result", resultResult.value];
      }
    }

    const cli = await runCliJson(argv);
    if (!cli.ok) {
      return {
        status: 502,
        body: { ok: false, reason: cli.reason, message: cli.message },
      };
    }
    const refreshed = await readBoard(true);
    const answer = {
      ok: cli.body.success === true,
      action,
      actor,
      actedAt: new Date().toISOString(),
      cli: cli.body,
    };
    if (refreshed.ok) {
      answer.board = refreshed.value;
    } else {
      answer.boardError = {
        reason: refreshed.reason,
        message: refreshed.message,
      };
    }
    return { status: 200, body: answer };
  }

  // The browser carrier is optional: when this bundle is loaded in a headless profile the
  // tools still work and there is simply no operator UI to serve. The guard also keeps the
  // dependency-free loader harness (and any non-Cordis test double) working.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (serverCtx) => {
      const webServer = serverCtx.webServer;
      let origin = null;
      try {
        origin = webServer.getOrigin();
      } catch {
        origin = null;
      }
      const csrfToken = randomUUID();
      /** GETs may omit Origin (same-origin fetch/curl); a present Origin must match. */
      const readOriginAllowed = (req) => {
        const requestOrigin =
          typeof req.headers.origin === "string" ? req.headers.origin : null;
        if (origin === null) return requestOrigin === null;
        return requestOrigin === null || requestOrigin === origin;
      };
      const boardRoute = webServer.register({
        kind: "exact",
        path: `${HTTP_PREFIX}/board`,
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, {
              ok: false,
              reason: "method_not_allowed",
              message: "GET only",
            });
            return;
          }
          if (!readOriginAllowed(req)) {
            sendJson(res, 403, {
              ok: false,
              reason: "origin_refused",
              message: "cross-origin request refused",
            });
            return;
          }
          try {
            const board = await readBoard(false);
            if (!board.ok) {
              sendJson(res, 502, {
                ok: false,
                reason: board.reason,
                message: board.message,
              });
              return;
            }
            sendJson(res, 200, { ...board.value, csrfToken });
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              reason: "internal_error",
              message: String(error?.message ?? error),
            });
          }
        },
      });
      const actionRoute = webServer.register({
        kind: "exact",
        path: `${HTTP_PREFIX}/action`,
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, {
              ok: false,
              reason: "method_not_allowed",
              message: "POST only",
            });
            return;
          }
          // Mutations require the exact same origin the carrier advertises: a cross-site
          // page cannot drive the paper ledger, and a no-Origin local client cannot approve.
          if (origin === null || req.headers.origin !== origin) {
            sendJson(res, 403, {
              ok: false,
              reason: "origin_refused",
              message: "mutations require the same-origin control-plane UI",
            });
            return;
          }
          if (req.headers["x-autobet-csrf"] !== csrfToken) {
            sendJson(res, 403, {
              ok: false,
              reason: "csrf_refused",
              message: "missing or stale CSRF token; reload the control plane",
            });
            return;
          }
          try {
            const read = await readHttpJsonBody(req);
            if (!read.ok) {
              sendJson(res, read.status, {
                ok: false,
                reason: "invalid_body",
                message: read.message,
              });
              return;
            }
            const outcome = await performHttpAction(read.value);
            // The refreshed board is composed without the per-activation token (the GET
            // route adds it); re-attach it so an action answer is a drop-in board snapshot.
            const responseBody =
              isPlainObjectValue(outcome.body) &&
              isPlainObjectValue(outcome.body.board)
                ? {
                    ...outcome.body,
                    board: { ...outcome.body.board, csrfToken },
                  }
                : outcome.body;
            sendJson(res, outcome.status, responseBody);
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              reason: "internal_error",
              message: String(error?.message ?? error),
            });
          }
        },
      });
      const signalsRoute = webServer.register({
        kind: "exact",
        path: `${HTTP_PREFIX}/signals`,
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, {
              ok: false,
              reason: "method_not_allowed",
              message: "GET only",
            });
            return;
          }
          if (!readOriginAllowed(req)) {
            sendJson(res, 403, {
              ok: false,
              reason: "origin_refused",
              message: "cross-origin request refused",
            });
            return;
          }
          const query = readSignalsQuery(req.url);
          if (!query.ok) {
            sendJson(res, 400, {
              ok: false,
              reason: "invalid_arguments",
              message: query.message,
            });
            return;
          }
          try {
            const signals = await readSignals(query.value);
            if (!signals.ok) {
              sendJson(res, 502, {
                ok: false,
                reason: signals.reason,
                message: signals.message,
              });
              return;
            }
            sendJson(res, 200, signals.value);
          } catch (error) {
            sendJson(res, 500, {
              ok: false,
              reason: "internal_error",
              message: String(error?.message ?? error),
            });
          }
        },
      });
      disposers.push(boardRoute, actionRoute, signalsRoute);
    });
  }

  // ---------------------------------------------------------------------------
  // Read tools — concurrency-safe, no ledger writes, one JSON object each.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // autobet_status — is the paper pipeline configured, and is live execution off?
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_status",
      description:
        "Read-only status of the paper-only watchlist autobet pipeline: config path/" +
        "existence/effective settings, ledger path/event and intent counts by derived status, " +
        "signal-source freshness, and the hard safety state (live execution disabled, paper " +
        "mode only). Shells the repo CLI (status --json). It never writes to the ledger and " +
        "never places a bet.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute() {
        return runCli(["status"]);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_signals — derived signals with their closed-list gate results
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_signals",
      description:
        "Read-only derived watchlist signals, each paired with its gate result over a closed " +
        "list of risk/provenance checks (enabled, league allowlist, fixture provenance, " +
        "freshness, confidence, distinct accounts, one-sided share, reference price, stake and " +
        "desk-day caps, duplicate intent). Default hides ineligible signals; set " +
        "includeRejected=true to see them with their failed-check reasons. Signals are advice, " +
        "not orders: nothing is queued or executed.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Maximum signals to return (1-200).",
          },
          minConfidence: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Override the configured minimum confidence (0-100).",
          },
          includeRejected: {
            type: "boolean",
            description:
              "Include signals that failed a gate, with their failed-check reasons. Default false.",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const limit = readInteger(request, "limit", 1, 200);
        if (!limit.ok) return invalidArguments(limit.message);
        const confidence = readNumber(request, "minConfidence", 0, 100);
        if (!confidence.ok) return invalidArguments(confidence.message);
        const includeRejected = readBoolean(request, "includeRejected");
        if (!includeRejected.ok)
          return invalidArguments(includeRejected.message);
        const argv = ["signals"];
        if (limit.present) argv.push("--limit", String(limit.value));
        if (confidence.present) {
          argv.push("--min-confidence", String(confidence.value));
        }
        if (includeRejected.present && includeRejected.value) {
          argv.push("--include-rejected");
        }
        return runCli(argv);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_plan — dry run of enqueue; writes nothing
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_plan",
      description:
        "Read-only dry run of autobet_enqueue: shows the paper bet intents that WOULD be " +
        "queued (preview stake, reference price, gates), the signals skipped with reasons, and " +
        "the desk-day/per-league stake caps. It writes nothing to the append-only ledger, so it " +
        "is the safe check to run before deciding whether to enqueue.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute() {
        return runCli(["plan"]);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_queue — intents with derived status
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_queue",
      description:
        "Read-only view of paper bet intents from the append-only ledger, with the derived " +
        "status (expiry is computed at read time, so a past-due approval shows as expired). " +
        "Optionally filter by status (queued, approved, filled, settled, rejected, expired) " +
        "and cap the row count. Reads the ledger; never mutates it.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...QUEUE_STATUSES],
            description: "Only intents whose derived status equals this value.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum intents to return (1-500).",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const status = readEnum(request, "status", QUEUE_STATUSES);
        if (!status.ok) return invalidArguments(status.message);
        const limit = readInteger(request, "limit", 1, 500);
        if (!limit.ok) return invalidArguments(limit.message);
        const argv = ["list"];
        if (status.present) argv.push("--status", status.value);
        if (limit.present) argv.push("--limit", String(limit.value));
        return runCli(argv);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_journal — raw append-only event tail + paper P&L summary
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_journal",
      description:
        "Read-only tail of the append-only paper ledger: the raw intent_created / " +
        "intent_approved / intent_rejected / intent_filled / intent_settled / intent_expired " +
        "events with actor and timestamps, plus the folded paper P&L summary (staked, settled, " +
        "profit, ROI, pending). This is the audit trail; a missing ledger reports MISSING " +
        "(exists:false), never zero events.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum ledger events to return (1-500).",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const limit = readInteger(request, "limit", 1, 500);
        if (!limit.ok) return invalidArguments(limit.message);
        const argv = ["journal"];
        if (limit.present) argv.push("--limit", String(limit.value));
        return runCli(argv);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Write tools — ledger-changing. confirm:true first, then validated argv.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // autobet_enqueue — append intents awaiting HUMAN approval
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_enqueue",
      description:
        "PAPER ONLY; requires confirm:true. Scans the watchlist signals and APPENDS paper bet " +
        "intents for every eligible signal that passes all gates, bounded by the desk-day " +
        "stake caps; re-running is idempotent. It does NOT approve or execute anything — " +
        "approval is a human decision recorded by autobet_decide. No live order path exists, " +
        "and live betting is not implemented.",
      parameters: {
        type: "object",
        properties: {
          actor: {
            type: "string",
            description:
              "Who is recording the enqueue in the ledger. Defaults to dsh-agent.",
          },
          confirm: {
            type: "boolean",
            description:
              "Must be exactly true. Without it the tool returns confirmation_required and writes nothing.",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      async execute(request) {
        if (request.confirm !== true) {
          return confirmationRequired(
            "autobet_enqueue",
            "would append paper bet intents to the append-only ledger for operator approval",
          );
        }
        const actor = readActor(request);
        if (!actor.ok) return invalidArguments(actor.message);
        return runCli(["enqueue", "--actor", actor.value]);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_decide — record an operator's approve/reject decision
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_decide",
      description:
        "PAPER ONLY; requires confirm:true. Records an operator's approve or reject decision " +
        "on ONE queued paper intent (reject requires a reason). Approval is a human decision " +
        "and this tool only records the decision it is given; execution is a separate " +
        "confirm-gated step (autobet_execute). No live order path exists.",
      parameters: {
        type: "object",
        properties: {
          intentId: {
            type: "string",
            description: "Ledger intent id (wa-<uuid>).",
          },
          decision: {
            type: "string",
            enum: [...DECISIONS],
            description: "approve or reject.",
          },
          actor: {
            type: "string",
            description: "Who recorded the decision. Defaults to dsh-agent.",
          },
          note: {
            type: "string",
            description: "Optional note for an approval.",
          },
          reason: {
            type: "string",
            description:
              "Reason for a rejection (required when decision=reject).",
          },
          confirm: {
            type: "boolean",
            description:
              "Must be exactly true. Without it the tool returns confirmation_required and writes nothing.",
          },
        },
        required: ["intentId", "decision"],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      async execute(request) {
        if (request.confirm !== true) {
          return confirmationRequired(
            "autobet_decide",
            "would record an approve/reject decision on a queued paper intent",
          );
        }
        const intentId = readIntentId(request);
        if (!intentId.ok) return invalidArguments(intentId.message);
        const decision = readEnum(request, "decision", DECISIONS);
        if (!decision.ok) return invalidArguments(decision.message);
        const actor = readActor(request);
        if (!actor.ok) return invalidArguments(actor.message);
        const note = readFreeText(request, "note");
        if (!note.ok) return invalidArguments(note.message);
        const reason = readFreeText(request, "reason");
        if (!reason.ok) return invalidArguments(reason.message);
        if (decision.value === "approve") {
          if (reason.present) {
            return invalidArguments(
              'reason is only valid with decision="reject"; use note to annotate an approval.',
            );
          }
          const argv = ["approve", intentId.value, "--actor", actor.value];
          if (note.present) argv.push("--note", note.value);
          return runCli(argv);
        }
        // Rejection: reason is required; a note is accepted as the reason if no reason given.
        const reasonText = reason.present
          ? reason.value
          : note.present
            ? note.value
            : null;
        if (reasonText === null) {
          return invalidArguments(
            'decision="reject" requires a non-empty reason (or note) so the ledger records why.',
          );
        }
        return runCli([
          "reject",
          intentId.value,
          "--actor",
          actor.value,
          "--reason",
          reasonText,
        ]);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_execute — paper fill of an APPROVED intent
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_execute",
      description:
        "PAPER ONLY; requires confirm:true. Paper-fills ONE approved paper intent through the " +
        "CLI's paper adapter (simulated fill with the configured slippage and recorded paper " +
        "P&L). Venue defaults to paper; any other venue is refused by the CLI with " +
        "live_disabled. Live betting is not implemented and no live adapter exists in v1.",
      parameters: {
        type: "object",
        properties: {
          intentId: {
            type: "string",
            description: "Ledger intent id (wa-<uuid>) of an approved intent.",
          },
          venue: {
            type: "string",
            description:
              "Venue token; default paper. Anything other than paper is refused by the CLI (live_disabled).",
          },
          confirm: {
            type: "boolean",
            description:
              "Must be exactly true. Without it the tool returns confirmation_required and executes nothing.",
          },
        },
        required: ["intentId"],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      async execute(request) {
        if (request.confirm !== true) {
          return confirmationRequired(
            "autobet_execute",
            "would paper-fill an approved intent and append a fill event to the ledger",
          );
        }
        const intentId = readIntentId(request);
        if (!intentId.ok) return invalidArguments(intentId.message);
        const venue = readVenue(request);
        if (!venue.ok) return invalidArguments(venue.message);
        return runCli(["execute", intentId.value, "--venue", venue.value]);
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // autobet_settle — record won/lost/void for a paper fill
  // ---------------------------------------------------------------------------
  register(
    defineTool({
      name: "autobet_settle",
      description:
        "PAPER ONLY; requires confirm:true. Records the won/lost/void result of ONE " +
        "paper-filled intent and folds it into the paper P&L summary. Settlement moves no real " +
        "money; it only appends a settlement event to the local ledger.",
      parameters: {
        type: "object",
        properties: {
          intentId: {
            type: "string",
            description: "Ledger intent id (wa-<uuid>) of a filled intent.",
          },
          result: {
            type: "string",
            enum: [...SETTLE_RESULTS],
            description: "won, lost or void.",
          },
          confirm: {
            type: "boolean",
            description:
              "Must be exactly true. Without it the tool returns confirmation_required and writes nothing.",
          },
        },
        required: ["intentId", "result"],
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      async execute(request) {
        if (request.confirm !== true) {
          return confirmationRequired(
            "autobet_settle",
            "would record a settlement for a paper-filled intent",
          );
        }
        const intentId = readIntentId(request);
        if (!intentId.ok) return invalidArguments(intentId.message);
        const result = readEnum(request, "result", SETTLE_RESULTS);
        if (!result.ok) return invalidArguments(result.message);
        return runCli(["settle", intentId.value, "--result", result.value]);
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
