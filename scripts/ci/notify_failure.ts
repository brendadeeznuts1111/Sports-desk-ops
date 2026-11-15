/**
 * @file scripts/ci/notify_failure.ts
 * @description Pages the desk Telegram chat when a CI run fails (issue #248).
 *
 * The repo has one collaborator and zero watchers, so a red check reaches nobody until someone
 * opens the PR. This posts the failure to the same chat `r2-staleness-alert.yml` already uses.
 *
 * Deliberately dependency-free — no imports, `fetch` only. The moments this matters most are the
 * ones where `bun install --frozen-lockfile` fails (a broken lockfile, a bad pin, a removed
 * dependency), and a notifier that needs `node_modules` cannot report the failure that removed
 * them. `lib/telegram.ts` exists but is coupled to wager alert rendering; sharing it would pull in
 * the wager shapes and still need an install step.
 *
 * Credential policy: fork pull requests never receive repository secrets, so a missing secret
 * there is expected — it is skipped with a notice so fork PRs do not fail on something they
 * cannot fix. Anywhere else a missing secret is a misconfiguration and FAILS the job, because a
 * notifier that silently cannot notify is the bug this file exists to fix.
 *
 * Delivery is retried on 429 (honouring `retry_after`) and on 5xx; 4xx other than 429 is not
 * retried, because a bad token or chat id does not become correct on the second attempt.
 */

export const TELEGRAM_TEXT_LIMIT = 4096;
export const MAX_LISTED_JOBS = 6;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 750;

export interface RunContext {
  readonly repo: string;
  readonly workflow: string;
  readonly runUrl: string;
  readonly event: string;
  readonly refName: string;
  readonly prNumber: string | null;
  readonly actor: string;
  readonly failedJobs: readonly string[];
}

export type CredentialDecision =
  | { readonly kind: "send" }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "misconfigured"; readonly reason: string };

export type DeliveryResult =
  | { readonly ok: true; readonly messageId: number | null }
  | { readonly ok: false; readonly detail: string };

/* ------------------------------- parsing -------------------------------- */

/** Reads `result` off one `needs` entry without casting through `any`. */
function readJobResult(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("result" in value)) return null;
  const result: unknown = value.result;
  return typeof result === "string" ? result : null;
}

/**
 * Extracts the failed job names from `toJSON(needs)`.
 *
 * Anything unparseable yields an empty list rather than throwing: a malformed needs payload must
 * not turn a reportable failure into a crash the reporter cannot explain.
 */
export function parseNeeds(raw: string): readonly string[] {
  if (raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const failed: string[] = [];
  for (const [job, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (readJobResult(value) === "failure") failed.push(job);
  }
  return failed.sort();
}

/* ------------------------------ rendering -------------------------------- */

/** Builds the Telegram HTML body. Pure, so the wording is testable without a network. */
export function renderFailureMessage(ctx: RunContext): string {
  const esc = (value: string): string => Bun.escapeHTML(value);

  const listed = ctx.failedJobs.slice(0, MAX_LISTED_JOBS);
  const overflow = ctx.failedJobs.length - listed.length;
  const failed =
    listed.length === 0
      ? "unknown"
      : listed.map((job) => `<code>${esc(job)}</code>`).join(", ") +
        (overflow > 0 ? ` and ${overflow} more` : "");

  const ref =
    ctx.prNumber === null
      ? ctx.refName
      : `${ctx.refName} · PR #${ctx.prNumber}`;

  const lines = [
    `<b>CI failed</b> — ${esc(ctx.repo)}`,
    `<b>Workflow:</b> <code>${esc(ctx.workflow)}</code>`,
    `<b>Failed:</b> ${failed}`,
    `<b>Ref:</b> <code>${esc(ref)}</code> (${esc(ctx.event)})`,
    `<a href="${esc(ctx.runUrl)}">Open the failed run</a> · by ${esc(ctx.actor)}`,
  ];

  const text = lines.join("\n");
  // Backstop only: the job list is already capped, so this should not truncate mid-entity.
  return text.length <= TELEGRAM_TEXT_LIMIT
    ? text
    : `${text.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

/* ----------------------------- credentials ------------------------------- */

export function decideCredentials(input: {
  readonly hasToken: boolean;
  readonly hasChatId: boolean;
  readonly isFork: boolean;
}): CredentialDecision {
  if (input.hasToken && input.hasChatId) return { kind: "send" };

  if (input.isFork) {
    return {
      kind: "skip",
      reason:
        "fork pull request: repository secrets are not exposed to fork PRs",
    };
  }

  const missing: string[] = [];
  if (!input.hasToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!input.hasChatId) missing.push("TELEGRAM_CHAT_ID");
  return { kind: "misconfigured", reason: `missing ${missing.join(" and ")}` };
}

/* ------------------------------- delivery -------------------------------- */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Reads `retry_after` from a 429 body when Telegram sends one. */
async function retryAfterMs(res: Response): Promise<number | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("parameters" in body))
      return null;
    const params: unknown = body.parameters;
    if (
      typeof params !== "object" ||
      params === null ||
      !("retry_after" in params)
    )
      return null;
    const retryAfter: unknown = params.retry_after;
    if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter))
      return null;
    return Math.min(60_000, Math.max(0, retryAfter * 1000));
  } catch {
    return null;
  }
}

export interface PostOptions {
  readonly botToken: string;
  readonly chatId: string;
  readonly fetchFn?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

/** POSTs one message, retrying 429/5xx. Returns a value rather than throwing. */
export async function postMessage(
  text: string,
  opts: PostOptions,
): Promise<DeliveryResult> {
  const fetcher = opts.fetchFn ?? fetch;
  const pause = opts.sleepFn ?? sleep;
  const endpoint = `https://api.telegram.org/bot${opts.botToken}/sendMessage`;

  let detail = "no attempt made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetcher(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: opts.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });
    } catch (error) {
      detail = `network error: ${error instanceof Error ? error.message : String(error)}`;
      if (attempt < MAX_ATTEMPTS) await pause(RETRY_BASE_MS * attempt);
      continue;
    }

    if (res.ok) {
      try {
        const body: unknown = await res.json();
        if (typeof body === "object" && body !== null && "result" in body) {
          const result: unknown = body.result;
          if (
            typeof result === "object" &&
            result !== null &&
            "message_id" in result
          ) {
            const id: unknown = result.message_id;
            return { ok: true, messageId: typeof id === "number" ? id : null };
          }
        }
        return { ok: true, messageId: null };
      } catch {
        return { ok: true, messageId: null };
      }
    }

    detail = `HTTP ${res.status}`;
    if (res.status === 429) {
      const wait = (await retryAfterMs(res)) ?? RETRY_BASE_MS * attempt * 2;
      if (attempt < MAX_ATTEMPTS) await pause(wait);
      continue;
    }
    if (res.status >= 500) {
      if (attempt < MAX_ATTEMPTS) await pause(RETRY_BASE_MS * attempt);
      continue;
    }
    // 4xx other than 429 cannot be fixed by retrying.
    return { ok: false, detail };
  }

  return { ok: false, detail: `${detail} after ${MAX_ATTEMPTS} attempts` };
}

/* --------------------------------- main ---------------------------------- */

function runUrlFrom(env: Record<string, string | undefined>): string {
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = env.GITHUB_REPOSITORY ?? "unknown/unknown";
  const runId = env.GITHUB_RUN_ID ?? "";
  return `${server}/${repo}/actions/runs/${runId}`;
}

export function contextFromEnv(
  env: Record<string, string | undefined>,
): RunContext {
  const prNumber = env.PR_NUMBER;
  return {
    repo: env.GITHUB_REPOSITORY ?? "unknown/unknown",
    workflow: env.GITHUB_WORKFLOW ?? "unknown",
    runUrl: runUrlFrom(env),
    event: env.GITHUB_EVENT_NAME ?? "unknown",
    refName: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || "unknown",
    prNumber: prNumber !== undefined && prNumber !== "" ? prNumber : null,
    actor: env.GITHUB_ACTOR ?? "unknown",
    failedJobs: parseNeeds(env.NEEDS_JSON ?? ""),
  };
}

async function main(argv: readonly string[]): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const ctx = contextFromEnv(Bun.env);
  const token = Bun.env.TELEGRAM_BOT_TOKEN ?? "";
  const chatId = Bun.env.TELEGRAM_CHAT_ID ?? "";
  const isFork = (Bun.env.IS_FORK ?? "").toLowerCase() === "true";

  if (ctx.failedJobs.length === 0) {
    console.log(
      "notify_failure: no failed jobs in the needs payload; nothing to report",
    );
    return 0;
  }

  const decision = decideCredentials({
    hasToken: token !== "",
    hasChatId: chatId !== "",
    isFork,
  });

  // A dry run never sends, so it is not gated on credentials — the point is to inspect the
  // message. It still reports the credential state, so a broken config is visible when previewing.
  if (dryRun) {
    console.log(`notify_failure: dry run — credentials: ${decision.kind}`);
    if (decision.kind !== "send")
      console.log(`notify_failure: ${decision.reason}`);
    console.log(renderFailureMessage(ctx));
    return 0;
  }

  if (decision.kind === "skip") {
    console.log(`::notice::notify_failure skipped — ${decision.reason}`);
    return 0;
  }
  if (decision.kind === "misconfigured") {
    console.log(`::error::notify_failure cannot run — ${decision.reason}`);
    return 1;
  }

  const text = renderFailureMessage(ctx);

  const result = await postMessage(text, { botToken: token, chatId });
  if (!result.ok) {
    console.log(`::error::notify_failure delivery failed — ${result.detail}`);
    return 1;
  }
  console.log(
    `notify_failure: delivered (message_id=${result.messageId ?? "unknown"}) for ${ctx.failedJobs.join(", ")}`,
  );
  return 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
