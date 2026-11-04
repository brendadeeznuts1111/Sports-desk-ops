/**
 * SportsDesk security/fraud console — a read-only DSH Host plugin over the sportsdesk-ops
 * `cli/sportsdesk_fraud_cli.ts` security pipeline.
 *
 * WHY THIS EXISTS
 *
 * The desk already holds two real log corpora — GSLive `getBetReport` rows (including IP
 * addresses and the desk's own weak fraud flags) and F402 live ticket captures — plus repo
 * modules that parse GSLive bet-event timelines, weblog activity and surveillance predicates,
 * but nothing joins them into one security surface. Every step is a shell command, and
 * scraping stdout would flatten "the corpus is missing", "the session expired" and "the model
 * is not fitted" into one useless failure. This plugin exposes the same capabilities as
 * native tools with typed arguments and structured results, and adds a Web UI operator page.
 *
 * READ-ONLY, WITH ONE DERIVED WRITE
 *
 * Seven of the eight tools only read local artifacts. `fraud_model` with `action: "fit"`
 * writes a derived model artifact under `reports/security/` (gitignored) and requires both
 * `confirm: true` and `write: true`; without them it is a dry run that prints the candidate
 * artifact and its metrics. Nothing here places a bet, talks to a venue, or mutates a captured
 * log. There is no live order path.
 *
 * HONESTY RULES THE TOOLS PRESERVE
 *
 * A missing source is a measured state (`missing` / `session_expired`), never a zero. A
 * fixture-derived source is labelled `provenance: "fixture"` and is never fitted. The model
 * predicts a weak proxy label (the desk's own flags), not fraud, and its `limits` are part of
 * every report. Raw IP addresses are masked in every answer; the plugin never prints a
 * cookie or token.
 *
 * WHY IT SHELLS BUN
 *
 * There are two runtimes. The repo runs under Bun; the Host plugin shim runs in Electron's
 * Node main process, where the `Bun` global is undefined. The parsers, detectors and model are
 * TypeScript the Host cannot import, so every tool spawns the one existing CLI under Bun and
 * parses its JSON. Nothing is reimplemented here, so the plugin and the repo cannot drift.
 *
 * WHY RAW `ctx.tools.register`
 *
 * `defineTool` lives in a peer package (`@deepseek-ai/dsh-tools`). A directory-installed bundle
 * is a LINK, and Node resolves a linked module's imports from its realpath (this checkout), not
 * from the profile — which fails with ERR_MODULE_NOT_FOUND unless the bundle hand-symlinks the
 * peer. A raw ToolDefinition needs no dependencies. The trade-off: raw registration does NOT
 * validate arguments, so every tool validates its own and returns a structured refusal.
 *
 * THE CLI CONTRACT (frozen in Scratch/security/SECURITY-PLUGIN-CONTRACT.md)
 *
 * `bun run cli/sportsdesk_fraud_cli.ts <command> [flags]`, `--json` always, plus `--root`.
 * Success JSON carries `{ success: true, schemaVersion: 1, command, generatedAt, ...payload }`;
 * failure JSON carries `{ success: false, schemaVersion: 1, command, error: { code, message,
 * details? } }` and the exit code distinguishes usage (2) / refusal (3) / other (1). The
 * wrapper returns a success payload unchanged, and a failure as
 * `{ available: false, reason: <CLI code>, message, command, cli }` so the code and details
 * are preserved rather than flattened.
 *
 * @module dsh-plugin-sportsdesk-security
 */

// ast-grep-ignore: node-child-process -- Host plugin code runs in Electron's Node main process, where the Bun global does not exist; spawning bun is the shim's whole job.
import { execFile } from "node:child_process";
// ast-grep-ignore: node-fs-read-write-file -- same runtime: Bun.file() is not defined in Electron's Node, and the pre-spawn CLI existence check needs node:fs.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const name = "sportsdesk-security";

export const inject = ["tools"];

/** Repo-relative path of the core CLI every tool shells. Fixed by the frozen contract. */
const CLI_RELATIVE_PATH = "cli/sportsdesk_fraud_cli.ts";

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
  timeoutMs: 90_000,
};

/** Closed sets the CLI contract fixes. A value outside one is refused before the spawn. */
const SEVERITIES = Object.freeze(["info", "low", "medium", "high", "critical"]);
const MODEL_ACTIONS = Object.freeze(["report", "fit", "score"]);
const MODEL_PROXIES = Object.freeze([
  "desk_flag",
  "suspected_bot",
  "reversed_credit",
]);
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const PREFIX24_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const MAX_EXCERPT = 4000;

/**
 * Same-origin read API consumed by this bundle's Client page. Every route is a thin adapter
 * over the same CLI the tools shell; nothing is composed in the Host and nothing is mutated.
 *
 * Caching: the UI re-renders on every poll and every tab switch, and the corpus-scanning
 * commands parse a 55 MB document. A 4 s per-key cache absorbs re-renders without ever
 * serving a different query's payload (the key is the full path + query).
 */
const HTTP_PREFIX = "/api/security";
const HTTP_CACHE_MS = 4_000;
const HTTP_CACHE_MAX_ENTRIES = 16;
/**
 * Timeouts. The frozen contract says 4 s for the cheap routes (`status`, `weblog`, `model`,
 * `research`). The corpus-scanning routes (`bets`, `ip-graph`, `patterns`, `dossier`) parse
 * the GSLive export and are allowed a measured 15 s, because a 4 s cap would turn a healthy
 * slow answer into an error the operator cannot distinguish from a broken install.
 */
const HTTP_FAST_TIMEOUT_MS = 4_000;
const HTTP_SCAN_TIMEOUT_MS = 15_000;

/**
 * Normalize the row config. Malformed values fall back to their default; a non-object config
 * is treated as empty rather than crashing the bundle.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_CONFIG}
 */
function normalizeConfig(raw) {
  const given = typeof raw === "object" && raw !== null ? raw : {};
  const config = { ...DEFAULT_CONFIG };
  for (const key of ["repoPath", "bunPath"]) {
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
 * The refusal every fit that would write a model artifact returns without `confirm: true`.
 *
 * @param {string} action
 * @returns {{ available: false, reason: "confirmation_required", message: string }}
 */
function confirmationRequired(action) {
  return {
    available: false,
    reason: "confirmation_required",
    message:
      `fraud_model ${action}. Nothing was written and no model artifact changed. ` +
      "Run it without `write` first to review the candidate artifact and its validation " +
      "metrics, then re-run with confirm: true and write: true to persist it under " +
      "reports/security/. The model is a weak-label risk ranker, not a fraud determination.",
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
      message: `\`${key}\` must be an integer ${min}-${max}.`,
    };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-number reader, with explicit refusal on a non-finite value.
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
    return { ok: false, message: `\`${key}\` must be a number ${min}-${max}.` };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-boolean reader. The string "true" is refused on purpose: a model that
 * passes `"true"` should learn that booleans are JSON booleans, and `confirm` must be exactly
 * `true` before a write.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 */
function readBoolean(request, key) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (typeof value !== "boolean") {
    return { ok: false, message: `\`${key}\` must be a JSON boolean.` };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-string reader with a pattern check.
 *
 * @param {Record<string, unknown>} request
 * @param {string} key
 * @param {RegExp} pattern
 * @param {string} description
 */
function readToken(request, key, pattern, description) {
  const value = request[key];
  if (value === undefined) return { ok: true, present: false };
  if (typeof value !== "string" || !pattern.test(value)) {
    return { ok: false, message: `\`${key}\` must be ${description}.` };
  }
  return { ok: true, present: true, value };
}

/**
 * Shared optional-enum reader over a frozen set.
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
      message: `\`${key}\` must be one of ${allowed.join(", ")}.`,
    };
  }
  return { ok: true, present: true, value };
}

/** Parse the last JSON object/array out of captured stdout, tolerating a stray log line. */
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

/** Trim a captured stream for transport. */
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

/** Write one JSON HTTP response without throwing. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.end(payload);
}

/**
 * Read an optional single query parameter as a string.
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {{ ok: true, value: string | undefined } | { ok: false, message: string }}
 */
function queryString(params, key) {
  const value = params.get(key);
  if (value === null || value === "") return { ok: true, value: undefined };
  return { ok: true, value };
}

/**
 * Read an optional integer query parameter.
 *
 * @param {URLSearchParams} params
 * @param {string} key
 * @param {number} min
 * @param {number} max
 */
function queryInteger(params, key, min, max) {
  const raw = params.get(key);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^-?\d+$/.test(raw)) {
    return {
      ok: false,
      message: `\`${key}\` must be an integer ${min}-${max}.`,
    };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return {
      ok: false,
      message: `\`${key}\` must be an integer ${min}-${max}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Read an optional boolean query parameter (`true`/`false`, `1`/`0`).
 *
 * @param {URLSearchParams} params
 * @param {string} key
 */
function queryBoolean(params, key) {
  const raw = params.get(key);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (raw === "true" || raw === "1") return { ok: true, value: true };
  if (raw === "false" || raw === "0") return { ok: true, value: false };
  return { ok: false, message: `\`${key}\` must be true, false, 1 or 0.` };
}

/**
 * Build the argv suffix for the optional filters shared by `bets` and `patterns`.
 *
 * @param {Record<string, unknown>} values
 * @returns {string[]}
 */
function filterArgv(values) {
  const argv = [];
  if (values.agent !== undefined) argv.push("--agent", values.agent);
  if (values.account !== undefined) argv.push("--account", values.account);
  if (values.state !== undefined) argv.push("--state", String(values.state));
  if (values.since !== undefined) argv.push("--since", values.since);
  if (values.limit !== undefined) argv.push("--limit", String(values.limit));
  if (values.includeBots !== undefined) {
    argv.push("--include-bots", values.includeBots ? "true" : "false");
  }
  if (values.minSeverity !== undefined) {
    argv.push("--min-severity", values.minSeverity);
  }
  if (values.category !== undefined) argv.push("--category", values.category);
  if (values.extraLimit !== undefined)
    argv.push("--limit", String(values.extraLimit));
  return argv;
}

/**
 * Register the Host half.
 *
 * @param {any} ctx Cordis context (Host)
 * @param {unknown} config the bundle row's config
 * @returns {() => void} disposer
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const repoPath = settings.repoPath;
  const cliAbsolutePath = join(repoPath, CLI_RELATIVE_PATH);
  /** Disposers from ctx.tools.register and the web routes, returned as this plugin's cleanup. */
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };

  /**
   * Build the failure object for a CLI answer that was not a success.
   *
   * The CLI's own error code becomes `reason` unchanged (`source_missing`,
   * `insufficient_corpus`, `model_missing`, `unknown_subject`, …) so a caller can branch on
   * the contract code, and the whole CLI JSON is preserved under `cli` so nothing in
   * `error.details` is lost.
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
   * The CLI is spawned with an argv ARRAY (never a shell string): command parts are built only
   * from the closed command set plus validated argument values, so user text can never become
   * a shell word. `--root` is passed explicitly even though the cwd is already `repoPath`.
   *
   * @param {string[]} commandArgv validated command + flag argv (no `--json`, no globals)
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<Record<string, unknown>>}
   */
  async function runCli(commandArgv, options = {}) {
    const command = String(commandArgv[0] ?? "unknown");
    if (!existsSync(cliAbsolutePath)) {
      return {
        available: false,
        reason: "cli_missing",
        command,
        message:
          `The security/fraud CLI was not found at ${cliAbsolutePath}. ` +
          "The fraud-core workstream has not created it yet, or repoPath points at the " +
          "wrong checkout. Nothing was executed.",
        expectedPath: cliAbsolutePath,
        hint: `bun run ${CLI_RELATIVE_PATH} status --json --root ${repoPath}`,
      };
    }
    const timeoutMs = options.timeoutMs ?? settings.timeoutMs;
    const argv = [
      "run",
      CLI_RELATIVE_PATH,
      ...commandArgv,
      "--json",
      "--root",
      repoPath,
    ];
    const result = await runProcess(resolveBun(settings.bunPath), argv, {
      cwd: repoPath,
      timeoutMs,
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
        message:
          `The CLI did not finish within ${timeoutMs} ms and was stopped. No result is ` +
          "reported; re-read fraud_status before retrying.",
        timeoutMs,
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
  // Read tools — concurrency-safe, no artifact writes, one JSON object each.
  // ---------------------------------------------------------------------------

  register(
    defineTool({
      name: "fraud_status",
      description:
        "Security/fraud console state: every log source (GSLive bet-report corpus with sha256 and masked PII posture, F402 live captures, F402 weblog rollup, GSLive activity artifact, suspect audit, fixture books) measured as ok/stale/missing/session_expired with provenance, plus the corpus summary and whether a fitted model artifact exists. MISSING is never reported as zero. Start here before any other fraud_* tool.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute() {
        return runCli(["status"], { timeoutMs: HTTP_FAST_TIMEOUT_MS });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_bets",
      description:
        "Aggregated view of the GSLive getBetReport log corpus (24,778 rows today): row/account/agent counts, state mix, suspected-bot / reversed-credit / manual-log / odds-drift counts, delay histogram, plus a masked sample of normalized bet records. Filters: agent, account, state, since, limit (default 25, max 200), includeBots. Raw IP addresses are never returned — only masked values and stable tags.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Agent id filter." },
          account: { type: "string", description: "Account/user id filter." },
          state: { type: "integer", description: "Wager state code filter." },
          since: {
            type: "string",
            description: "ISO date/time lower bound on placement time.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Sample rows (default 25).",
          },
          includeBots: {
            type: "boolean",
            description: "Include suspected-bot rows (default true).",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const agent = readToken(
          request,
          "agent",
          AGENT_PATTERN,
          "an agent id token",
        );
        if (!agent.ok) return invalidArguments(agent.message);
        const account = readToken(
          request,
          "account",
          ID_PATTERN,
          "an account id token",
        );
        if (!account.ok) return invalidArguments(account.message);
        const state = readInteger(request, "state", 0, 8);
        if (!state.ok) return invalidArguments(state.message);
        const since = readToken(
          request,
          "since",
          ISO_PATTERN,
          "an ISO date/time",
        );
        if (!since.ok) return invalidArguments(since.message);
        const limit = readInteger(request, "limit", 1, 200);
        if (!limit.ok) return invalidArguments(limit.message);
        const includeBots = readBoolean(request, "includeBots");
        if (!includeBots.ok) return invalidArguments(includeBots.message);
        const argv = [
          "bets",
          ...filterArgv({
            agent: agent.value,
            account: account.value,
            state: state.value,
            since: since.value,
            limit: limit.value,
            includeBots: includeBots.value,
          }),
        ];
        return runCli(argv, { timeoutMs: HTTP_SCAN_TIMEOUT_MS });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_ip_graph",
      description:
        "Account↔IP network view over the GSLive bet-report corpus: clusters of accounts sharing an IP or a /24 (and IPv6 /64 where present), account IP fan-out, bot-ring range (/16) hits and datacenter IP classes. Identifiers are masked (IP → masked string + stable tag + prefix key); no raw IP is ever returned. Filters: minAccounts (default 2), limit (max 100), prefix24 (a.b.c).",
      parameters: {
        type: "object",
        properties: {
          minAccounts: {
            type: "integer",
            minimum: 2,
            maximum: 1000,
            description: "Minimum accounts in a cluster (default 2).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Cluster rows (default 25).",
          },
          prefix24: {
            type: "string",
            description: "Restrict to one /24, e.g. 140.248.7.",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const minAccounts = readInteger(request, "minAccounts", 2, 1000);
        if (!minAccounts.ok) return invalidArguments(minAccounts.message);
        const limit = readInteger(request, "limit", 1, 100);
        if (!limit.ok) return invalidArguments(limit.message);
        const prefix24 = readToken(
          request,
          "prefix24",
          PREFIX24_PATTERN,
          "a /24 prefix like 10.0.0",
        );
        if (!prefix24.ok) return invalidArguments(prefix24.message);
        const argv = ["ip-graph"];
        if (minAccounts.value !== undefined)
          argv.push("--min-accounts", String(minAccounts.value));
        if (limit.value !== undefined)
          argv.push("--limit", String(limit.value));
        if (prefix24.value !== undefined)
          argv.push("--prefix24", prefix24.value);
        return runCli(argv, { timeoutMs: HTTP_SCAN_TIMEOUT_MS });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_weblog",
      description:
        "F402 WebLog posture: the zero-PII rollup over the 523,632-row weblog corpus (sessions, logins, join coverage, execution-sniper / sniper-twin / line-shopper / bot-ring / cross-office-beard counts, IP classes, gates) and, when the GSLive activity artifact exists, per-account bet-log flags. When the corpus or the GSLive artifact is missing the reason is returned as a measured state, never as zero counts.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute() {
        return runCli(["weblog"], { timeoutMs: HTTP_FAST_TIMEOUT_MS });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_patterns",
      description:
        "Named sportsbook fraud/surveillance findings over all sources: suspected-bot bets, reversed credit, manual logs, odds drift, delay mismatch, state-mix anomaly, shared-IP clusters, account IP fan-out, bot-ring range, datacenter IPs, agent flag concentration, weblog sniper/twin/shopper/beard/bot-ring counts, GSLive steam/clinch/confirm-bypass/donor-shield/trojan predicates (when the activity artifact exists), F402 ticket anomalies (round-stake ladder, longshot concentration, writer mismatch, burst, VIP outlier) and data-quality findings (stale, ephemeral corpus, broken suspect audit, missing evidence rows). Each finding carries observed values, thresholds, evidence pointers, provenance and an insufficientData flag. Filters: minSeverity, category, agent, limit.",
      parameters: {
        type: "object",
        properties: {
          minSeverity: {
            type: "string",
            enum: [...SEVERITIES],
            description: "Minimum severity (default info).",
          },
          category: { type: "string", description: "Finding category filter." },
          agent: { type: "string", description: "Agent id filter." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Finding rows (default 50).",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const minSeverity = readEnum(request, "minSeverity", SEVERITIES);
        if (!minSeverity.ok) return invalidArguments(minSeverity.message);
        const category = readToken(
          request,
          "category",
          CATEGORY_PATTERN,
          "a category token",
        );
        if (!category.ok) return invalidArguments(category.message);
        const agent = readToken(
          request,
          "agent",
          AGENT_PATTERN,
          "an agent id token",
        );
        if (!agent.ok) return invalidArguments(agent.message);
        const limit = readInteger(request, "limit", 1, 200);
        if (!limit.ok) return invalidArguments(limit.message);
        const argv = [
          "patterns",
          ...filterArgv({
            minSeverity: minSeverity.value,
            category: category.value,
            agent: agent.value,
            extraLimit: limit.value,
          }),
        ];
        return runCli(argv, { timeoutMs: HTTP_SCAN_TIMEOUT_MS });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_model",
      description:
        "The transparent weak-label risk model. action=report returns the fitted artifact (features, weights, AUC/AP/precision@k/Brier/calibration, validation, explicit limits, corpus provenance) or a model_missing refusal with the fit command; action=fit runs a leakage-safe temporal fit and is a DRY RUN unless write:true; writing the artifact under reports/security/ additionally requires confirm:true; action=score returns one account's features, score 0-100, band and top contributions. The model predicts a proxy label built from the desk's own flags — it is NOT a fraud probability.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [...MODEL_ACTIONS],
            description: "report (default), fit or score.",
          },
          account: {
            type: "string",
            description: "Account id for action=score.",
          },
          proxy: {
            type: "string",
            enum: [...MODEL_PROXIES],
            description: "Weak-label proxy for fit (default desk_flag).",
          },
          split: {
            type: "number",
            minimum: 0.5,
            maximum: 0.9,
            description: "Temporal train share for fit (default 0.7).",
          },
          l2: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "L2 strength for fit (default 0.01).",
          },
          epochs: {
            type: "integer",
            minimum: 100,
            maximum: 5000,
            description:
              "Gradient-descent epochs for fit (default 4000; the 2026-11-04 corpus converges at 1250).",
          },
          write: {
            type: "boolean",
            description:
              "Persist the candidate artifact (requires confirm:true).",
          },
          confirm: {
            type: "boolean",
            description: "Must be exactly true to write the model artifact.",
          },
        },
        additionalProperties: false,
      },
      isConcurrencySafe: () => false,
      async execute(request) {
        const action = readEnum(request, "action", MODEL_ACTIONS);
        if (!action.ok) return invalidArguments(action.message);
        const chosen = action.value ?? "report";
        if (chosen === "report")
          return runCli(["model", "report"], {
            timeoutMs: HTTP_FAST_TIMEOUT_MS,
          });
        if (chosen === "score") {
          const account = readToken(
            request,
            "account",
            ID_PATTERN,
            "an account id token",
          );
          if (!account.ok) return invalidArguments(account.message);
          if (account.value === undefined) {
            return invalidArguments(
              '`account` is required for action "score".',
            );
          }
          return runCli(["model", "score", account.value], {
            timeoutMs: HTTP_SCAN_TIMEOUT_MS,
          });
        }
        // action === "fit"
        const proxy = readEnum(request, "proxy", MODEL_PROXIES);
        if (!proxy.ok) return invalidArguments(proxy.message);
        const split = readNumber(request, "split", 0.5, 0.9);
        if (!split.ok) return invalidArguments(split.message);
        const l2 = readNumber(request, "l2", 0, 1);
        if (!l2.ok) return invalidArguments(l2.message);
        const epochs = readInteger(request, "epochs", 100, 5000);
        if (!epochs.ok) return invalidArguments(epochs.message);
        const write = readBoolean(request, "write");
        if (!write.ok) return invalidArguments(write.message);
        const confirm = readBoolean(request, "confirm");
        if (!confirm.ok) return invalidArguments(confirm.message);
        if (write.value === true && confirm.value !== true) {
          return confirmationRequired("would write a derived model artifact");
        }
        const argv = ["model", "fit"];
        if (proxy.value !== undefined) argv.push("--proxy", proxy.value);
        if (split.value !== undefined)
          argv.push("--split", String(split.value));
        if (l2.value !== undefined) argv.push("--l2", String(l2.value));
        if (epochs.value !== undefined)
          argv.push("--epochs", String(epochs.value));
        if (write.value === true) argv.push("--write");
        return runCli(argv, { timeoutMs: settings.timeoutMs });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_dossier",
      description:
        "One account or agent dossier: hierarchy (agent index), bet aggregates, masked IP clusters, findings, model score/band and top contributions when a fitted artifact exists, and evidence pointers with source freshness. Refuses unknown_subject when the id has no rows. Read-only.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Account (userID/login) or agent id.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute(request) {
        const id = readToken(
          request,
          "id",
          ID_PATTERN,
          "an account or agent id",
        );
        if (!id.ok) return invalidArguments(id.message);
        if (id.value === undefined)
          return invalidArguments("`id` is required.");
        return runCli(["dossier", id.value], {
          timeoutMs: HTTP_SCAN_TIMEOUT_MS,
        });
      },
    }),
  );

  register(
    defineTool({
      name: "fraud_research",
      description:
        "The research catalog behind the detectors and the model: conventional sportsbook fraud/surveillance terminology, the prior-art register that each detector id maps to, where every threshold constant comes from (repo module + line or config), and the model's explicit limits. Use it to explain a finding or to justify a threshold; it is static curated content, measured against the repo's own constants.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      isConcurrencySafe: () => true,
      async execute() {
        return runCli(["research"], { timeoutMs: HTTP_FAST_TIMEOUT_MS });
      },
    }),
  );

  // ---------------------------------------------------------------------------
  // Read-only control-plane HTTP API for this bundle's Client page.
  // ---------------------------------------------------------------------------

  function readOriginAllowed(origin, req) {
    const requestOrigin =
      typeof req.headers.origin === "string" ? req.headers.origin : null;
    if (origin === null) return requestOrigin === null;
    return requestOrigin === null || requestOrigin === origin;
  }

  /**
   * Register one GET route whose argv is derived from a closed query contract.
   *
   * @param {any} webServer
   * @param {string} path
   * @param {number} timeoutMs
   * @param {(params: URLSearchParams) => { ok: true, argv: string[] } | { ok: false, message: string }} buildArgv
   */
  function registerReadRoute(webServer, path, timeoutMs, buildArgv) {
    const cache = new Map();
    return webServer.register({
      kind: "exact",
      path,
      handler: async (req, res) => {
        if (req.method !== "GET") {
          sendJson(res, 405, {
            ok: false,
            reason: "method_not_allowed",
            message: "GET only",
          });
          return;
        }
        if (!readOriginAllowed(originRef.value, req)) {
          sendJson(res, 403, {
            ok: false,
            reason: "origin_refused",
            message: "cross-origin request refused",
          });
          return;
        }
        const rawUrl = typeof req.url === "string" ? req.url : path;
        const params = new URL(rawUrl, "http://127.0.0.1").searchParams;
        const built = buildArgv(params);
        if (!built.ok) {
          sendJson(res, 400, {
            ok: false,
            reason: "invalid_arguments",
            message: built.message,
          });
          return;
        }
        const key = `${path}?${params.toString()}`;
        const cached = cache.get(key);
        // ast-grep-ignore: perf-now-timing -- cache freshness needs a wall-clock read; Date.now is the Host runtime's only clock.
        if (cached !== undefined && Date.now() - cached.at < HTTP_CACHE_MS) {
          sendJson(res, 200, cached.value);
          return;
        }
        try {
          const command = String(built.argv[0] ?? "unknown");
          const payload = await runCli(built.argv, { timeoutMs });
          if (payload.success !== true) {
            sendJson(res, 502, {
              ok: false,
              reason:
                typeof payload.reason === "string"
                  ? payload.reason
                  : "cli_failed",
              message:
                typeof payload.message === "string"
                  ? payload.message
                  : `${command} failed.`,
            });
            return;
          }
          const value = { ok: true, ...payload };
          if (cache.size >= HTTP_CACHE_MAX_ENTRIES) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
          // ast-grep-ignore: perf-now-timing -- cache freshness needs a wall-clock read; Date.now is the Host runtime's only clock.
          cache.set(key, { at: Date.now(), value });
          sendJson(res, 200, value);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            reason: "internal_error",
            message: String(error?.message ?? error),
          });
        }
      },
    });
  }

  const originRef = { value: null };
  // The browser carrier is optional: when this bundle is loaded in a headless profile the
  // tools still work and there is simply no operator UI to serve. The guard also keeps the
  // dependency-free loader harness (and any non-Cordis test double) working.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (serverCtx) => {
      const webServer = serverCtx.webServer;
      try {
        originRef.value = webServer.getOrigin();
      } catch {
        originRef.value = null;
      }
      disposers.push(
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/status`,
          HTTP_FAST_TIMEOUT_MS,
          () => ({
            ok: true,
            argv: ["status"],
          }),
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/bets`,
          HTTP_SCAN_TIMEOUT_MS,
          (params) => {
            const limit = queryInteger(params, "limit", 1, 200);
            if (!limit.ok) return limit;
            const includeBots = queryBoolean(params, "includeBots");
            if (!includeBots.ok) return includeBots;
            const agent = queryString(params, "agent");
            const account = queryString(params, "account");
            const state = queryInteger(params, "state", 0, 8);
            if (!state.ok) return state;
            const since = queryString(params, "since");
            return {
              ok: true,
              argv: [
                "bets",
                ...filterArgv({
                  agent: agent.value,
                  account: account.value,
                  state: state.value,
                  since: since.value,
                  limit: limit.value,
                  includeBots: includeBots.value,
                }),
              ],
            };
          },
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/ip-graph`,
          HTTP_SCAN_TIMEOUT_MS,
          (params) => {
            const minAccounts = queryInteger(params, "minAccounts", 2, 1000);
            if (!minAccounts.ok) return minAccounts;
            const limit = queryInteger(params, "limit", 1, 100);
            if (!limit.ok) return limit;
            const prefix24 = queryString(params, "prefix24");
            const argv = ["ip-graph"];
            if (minAccounts.value !== undefined)
              argv.push("--min-accounts", String(minAccounts.value));
            if (limit.value !== undefined)
              argv.push("--limit", String(limit.value));
            if (prefix24.value !== undefined)
              argv.push("--prefix24", prefix24.value);
            return { ok: true, argv };
          },
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/weblog`,
          HTTP_FAST_TIMEOUT_MS,
          () => ({
            ok: true,
            argv: ["weblog"],
          }),
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/patterns`,
          HTTP_SCAN_TIMEOUT_MS,
          (params) => {
            const minSeverity = queryString(params, "minSeverity");
            const category = queryString(params, "category");
            const agent = queryString(params, "agent");
            const limit = queryInteger(params, "limit", 1, 200);
            if (!limit.ok) return limit;
            return {
              ok: true,
              argv: [
                "patterns",
                ...filterArgv({
                  minSeverity: minSeverity.value,
                  category: category.value,
                  agent: agent.value,
                  extraLimit: limit.value,
                }),
              ],
            };
          },
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/model`,
          HTTP_FAST_TIMEOUT_MS,
          () => ({
            ok: true,
            argv: ["model", "report"],
          }),
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/dossier`,
          HTTP_SCAN_TIMEOUT_MS,
          (params) => {
            const id = queryString(params, "id");
            if (id.value === undefined) {
              return { ok: false, message: "`id` is required." };
            }
            if (!ID_PATTERN.test(id.value)) {
              return {
                ok: false,
                message: "`id` must be an account or agent id token.",
              };
            }
            return { ok: true, argv: ["dossier", id.value] };
          },
        ),
        registerReadRoute(
          webServer,
          `${HTTP_PREFIX}/research`,
          HTTP_FAST_TIMEOUT_MS,
          () => ({
            ok: true,
            argv: ["research"],
          }),
        ),
      );
    });
  }

  return () => {
    for (const dispose of disposers) dispose();
  };
}
