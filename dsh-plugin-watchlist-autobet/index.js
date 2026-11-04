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
function isPlainObject(value) {
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
        const value = await spec.execute(isPlainObject(args) ? args : {});
        if (isPlainObject(value)) return value;
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
      if (isPlainObject(error) && error.details !== undefined) {
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
    if (parsed.ok && isPlainObject(parsed.value)) {
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
        const error = isPlainObject(payload.error) ? payload.error : {};
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
