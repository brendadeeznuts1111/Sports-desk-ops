/**
 * @file tests/ci_notify_failure.test.ts
 * @description Unit tests for scripts/ci/notify_failure.ts (issue #248).
 *
 * No network: `postMessage` takes an injected fetch, and the retry sleeps take an injected sleep,
 * so the whole retry matrix runs instantly and deterministically.
 */

import { describe, expect, test } from "bun:test";

import {
  MAX_LISTED_JOBS,
  TELEGRAM_TEXT_LIMIT,
  contextFromEnv,
  decideCredentials,
  parseNeeds,
  postMessage,
  renderFailureMessage,
} from "../scripts/ci/notify_failure.ts";

import type { RunContext } from "../scripts/ci/notify_failure.ts";

const ctx: RunContext = {
  repo: "bw496915-cmyk/Sports-desk-ops",
  workflow: "sportsdesk-ops-ci",
  runUrl: "https://github.com/bw496915-cmyk/Sports-desk-ops/actions/runs/123",
  event: "pull_request",
  refName: "fix/ci-pr-always-trigger",
  prNumber: "251",
  actor: "bw496915-cmyk",
  failedJobs: ["verify-changed"],
};

/** Builds a fetch stub that returns the given responses in order, recording call count. */
function stubFetch(responses: readonly Response[]): {
  fetchFn: typeof fetch;
  calls: () => number;
} {
  let index = 0;
  const fetchFn = (async () => {
    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (response === undefined)
      throw new Error("stubFetch: no response queued");
    return response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => index };
}

const noSleep = async (): Promise<void> => {};

describe("parseNeeds", () => {
  test("selects only failures and sorts them", () => {
    const raw = JSON.stringify({
      verify: { result: "failure", outputs: {} },
      "market-index": { result: "success", outputs: {} },
      "verify-changed": { result: "failure", outputs: {} },
      "code-mode": { result: "skipped", outputs: {} },
    });
    expect(parseNeeds(raw)).toEqual(["verify", "verify-changed"]);
  });

  test("ignores cancelled and skipped", () => {
    const raw = JSON.stringify({
      verify: { result: "cancelled" },
      "code-mode": { result: "skipped" },
    });
    expect(parseNeeds(raw)).toEqual([]);
  });

  test("returns empty for malformed or empty payloads instead of throwing", () => {
    expect(parseNeeds("")).toEqual([]);
    expect(parseNeeds("not json")).toEqual([]);
    expect(parseNeeds("null")).toEqual([]);
    expect(parseNeeds("[1,2,3]")).toEqual([]);
  });

  test("tolerates entries with no result field", () => {
    expect(parseNeeds(JSON.stringify({ verify: {}, other: null }))).toEqual([]);
  });
});

describe("renderFailureMessage", () => {
  test("names the repo, workflow, failed job, ref and PR", () => {
    const text = renderFailureMessage(ctx);
    expect(text).toContain("bw496915-cmyk/Sports-desk-ops");
    expect(text).toContain("sportsdesk-ops-ci");
    expect(text).toContain("<code>verify-changed</code>");
    expect(text).toContain("fix/ci-pr-always-trigger · PR #251");
    expect(text).toContain("Open the failed run");
  });

  test("omits the PR suffix when there is no PR", () => {
    const text = renderFailureMessage({
      ...ctx,
      prNumber: null,
      event: "push",
    });
    expect(text).not.toContain("PR #");
    expect(text).toContain("(push)");
  });

  test("escapes HTML in every dynamic field", () => {
    const text = renderFailureMessage({
      ...ctx,
      refName: "<script>alert(1)</script>",
      actor: "a&b",
      workflow: "wf<x>",
    });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text).toContain("a&amp;b");
    expect(text).toContain("wf&lt;x&gt;");
  });

  test("caps the job list and reports the remainder", () => {
    const jobs = Array.from(
      { length: MAX_LISTED_JOBS + 3 },
      (_, i) => `job-${i}`,
    );
    const text = renderFailureMessage({ ...ctx, failedJobs: jobs });
    expect(text).toContain("and 3 more");
    expect(text).toContain("job-0");
    expect(text).not.toContain(`job-${MAX_LISTED_JOBS + 2}`);
  });

  test("says 'unknown' rather than printing an empty failure list", () => {
    expect(renderFailureMessage({ ...ctx, failedJobs: [] })).toContain(
      "<b>Failed:</b> unknown",
    );
  });

  test("stays within the Telegram limit", () => {
    const jobs = Array.from(
      { length: 500 },
      (_, i) => `job-${i}-${"x".repeat(40)}`,
    );
    const text = renderFailureMessage({ ...ctx, failedJobs: jobs });
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
  });
});

describe("decideCredentials", () => {
  const base = {
    hasToken: true,
    hasChatId: true,
    isFork: false,
    isDraft: false,
  };

  test("sends when both secrets are present", () => {
    expect(decideCredentials(base)).toEqual({ kind: "send" });
  });

  test("skips a draft PR even when everything else would send", () => {
    const decision = decideCredentials({ ...base, isDraft: true });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toContain("draft");
  });

  test("draft outranks fork and misconfiguration in the reason given", () => {
    // A draft fork PR with no secrets should report the draft reason: it is the one the author
    // can act on, and the others are consequences of being a draft fork PR anyway.
    const decision = decideCredentials({
      hasToken: false,
      hasChatId: false,
      isFork: true,
      isDraft: true,
    });
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.reason).toContain("draft");
  });

  test("skips on a fork PR, where secrets are never provided", () => {
    const decision = decideCredentials({
      ...base,
      hasToken: false,
      hasChatId: false,
      isFork: true,
    });
    expect(decision.kind).toBe("skip");
  });

  test("fails loudly when secrets are missing outside a fork PR", () => {
    const decision = decideCredentials({ ...base, hasToken: false });
    expect(decision.kind).toBe("misconfigured");
    if (decision.kind === "misconfigured") {
      expect(decision.reason).toContain("TELEGRAM_BOT_TOKEN");
      expect(decision.reason).not.toContain("TELEGRAM_CHAT_ID");
    }
  });

  test("a fork PR is skipped even when one secret appears present", () => {
    // Secrets are not exposed to fork PRs, so a partial value is noise, not a fixable config.
    expect(
      decideCredentials({ ...base, hasChatId: false, isFork: true }).kind,
    ).toBe("skip");
  });

  test("a half-configured repo outside a fork is a misconfiguration, not a skip", () => {
    expect(decideCredentials({ ...base, hasChatId: false }).kind).toBe(
      "misconfigured",
    );
  });
});

describe("postMessage", () => {
  const okBody = JSON.stringify({ ok: true, result: { message_id: 4242 } });

  test("returns the message id on success", async () => {
    const { fetchFn } = stubFetch([new Response(okBody, { status: 200 })]);
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn,
      sleepFn: noSleep,
    });
    expect(result).toEqual({ ok: true, messageId: 4242 });
  });

  test("retries a 5xx and succeeds", async () => {
    const stub = stubFetch([
      new Response("boom", { status: 503 }),
      new Response(okBody, { status: 200 }),
    ]);
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn: stub.fetchFn,
      sleepFn: noSleep,
    });
    expect(result.ok).toBe(true);
    expect(stub.calls()).toBe(2);
  });

  test("honours 429 retry_after and then succeeds", async () => {
    const slept: number[] = [];
    const stub = stubFetch([
      new Response(JSON.stringify({ parameters: { retry_after: 2 } }), {
        status: 429,
      }),
      new Response(okBody, { status: 200 }),
    ]);
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn: stub.fetchFn,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.ok).toBe(true);
    expect(slept).toEqual([2000]);
  });

  test("does not retry a bad token (4xx other than 429)", async () => {
    const stub = stubFetch([new Response("unauthorized", { status: 401 })]);
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn: stub.fetchFn,
      sleepFn: noSleep,
    });
    expect(result).toEqual({ ok: false, detail: "HTTP 401" });
    expect(stub.calls()).toBe(1);
  });

  test("gives up after the attempt cap and reports why", async () => {
    const stub = stubFetch([new Response("boom", { status: 500 })]);
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn: stub.fetchFn,
      sleepFn: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(stub.calls()).toBe(3);
    if (!result.ok) expect(result.detail).toContain("after 3 attempts");
  });

  test("survives a thrown network error", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await postMessage("hi", {
      botToken: "t",
      chatId: "c",
      fetchFn,
      sleepFn: noSleep,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("ECONNRESET");
  });
});

describe("contextFromEnv", () => {
  test("prefers the PR head ref and reads the PR number", () => {
    const built = contextFromEnv({
      GITHUB_REPOSITORY: "o/r",
      GITHUB_WORKFLOW: "wf",
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF_NAME: "251/merge",
      GITHUB_HEAD_REF: "feature-x",
      PR_NUMBER: "251",
      GITHUB_ACTOR: "someone",
      NEEDS_JSON: JSON.stringify({ verify: { result: "failure" } }),
    });
    expect(built.refName).toBe("feature-x");
    expect(built.prNumber).toBe("251");
    expect(built.runUrl).toBe("https://github.com/o/r/actions/runs/9");
    expect(built.failedJobs).toEqual(["verify"]);
  });

  test("treats an empty PR number as absent", () => {
    expect(contextFromEnv({ PR_NUMBER: "" }).prNumber).toBeNull();
    expect(contextFromEnv({}).prNumber).toBeNull();
  });
});
