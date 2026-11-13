import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  SportsDeskTelegramService,
  type TelegramSendMessageOptions,
  type TelegramUpdate,
} from "../services/sportsdesk_telegram_bot.ts";
import { ReportingSchedulerService } from "../services/reporting_scheduler_service.ts";

interface ApiCallBody extends TelegramSendMessageOptions {
  readonly chat_id?: string;
  readonly callback_query_id?: string;
  readonly text: string;
}

interface ApiCall {
  readonly method: string;
  readonly body: ApiCallBody;
}

const calls: ApiCall[] = [];
let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const method = new URL(req.url).pathname.split("/").pop()!;
      calls.push({ method, body: (await req.json()) as ApiCallBody });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
});

afterAll(() => stub.stop(true));
beforeEach(() => {
  calls.length = 0;
});

const AUTHORIZED = "100";
const env = Bun.env as Record<string, string | undefined>;

function makeBot() {
  const bot = new SportsDeskTelegramService({
    botToken: "test-token",
    chatId: AUTHORIZED,
    apiBaseUrl: `http://127.0.0.1:${stub.port}`,
    miniappUrl: "https://desk.example/miniapp",
  });
  new ReportingSchedulerService(bot);
  return bot;
}

function message(chatId: number, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId, type: chatId < 0 ? "group" : "private" },
      text,
    },
  };
}

describe("Telegram bot commands", () => {
  test("test_assert_chatid_answers_any_chat", async () => {
    await makeBot().handleUpdate(message(999, "/chatid"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.chat_id).toBe("999");
    expect(calls[0]!.body.text).toContain("<code>999</code>");
  });

  test("test_assert_unauthorized_chat_gets_no_account_data", async () => {
    await makeBot().handleUpdate(message(999, "/watchlist"));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toContain("not authorized");
    expect(calls[0]!.body.text).not.toContain("RF2003");
  });

  test("test_assert_authorized_chat_gets_watchlist_and_report", async () => {
    const bot = makeBot();
    await bot.handleUpdate(message(Number(AUTHORIZED), "/watchlist"));
    await bot.handleUpdate(
      message(Number(AUTHORIZED), "/report MORNING_BRIEFING"),
    );
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendMessage"]);
    expect(calls[0]!.body.text).toContain("RF2003");
    expect(calls[1]!.body.text).toContain("MORNING RISK BRIEFING");
  });

  test("test_assert_bot_suffix_and_unknown_report_handled", async () => {
    await makeBot().handleUpdate(
      message(Number(AUTHORIZED), "/report@demodevdeskbot NOPE"),
    );
    expect(calls[0]!.body.text).toContain("Unknown report");
  });

  test("test_assert_check_escapes_user_input", async () => {
    await makeBot().handleUpdate(
      message(Number(AUTHORIZED), "/check <b>x</b>"),
    );
    expect(calls[0]!.body.text).not.toContain("<b>X</b>");
    expect(calls[0]!.body.text).toContain("&lt;B&gt;");
  });
});

describe("Telegram mini app buttons", () => {
  test("test_assert_private_chat_gets_web_app_and_group_gets_url", async () => {
    const bot = new SportsDeskTelegramService({
      botToken: "test-token",
      chatId: "-100200",
      apiBaseUrl: `http://127.0.0.1:${stub.port}`,
      miniappUrl: "https://desk.example/miniapp",
    });
    await bot.dispatchTestAlert("RF2003", "-100200");
    await bot.dispatchTestAlert("RF2003", "555");
    const [group, priv] = calls.map(
      (c) => c.body.reply_markup?.inline_keyboard?.[0]?.[0],
    );
    expect(group?.web_app).toBeUndefined();
    expect(group?.url).toBe(
      "https://desk.example/miniapp?tab=forensics&agent=FAKEMONEY&customer=RF2003",
    );
    expect(priv?.web_app?.url).toBe(group?.url);
  });
});

describe("Telegram callback buttons", () => {
  test("test_assert_callback_from_unauthorized_chat_is_refused", async () => {
    await makeBot().handleUpdate({
      update_id: 2,
      callback_query: {
        id: "q1",
        data: "slash:RF2003:1000",
        from: { id: 7 },
        message: { chat: { id: 999, type: "private" } },
      },
    });
    expect(calls).toEqual([
      {
        method: "answerCallbackQuery",
        body: { callback_query_id: "q1", text: "Not authorized" },
      },
    ]);
  });

  test("test_assert_callback_is_recorded_not_applied", async () => {
    await makeBot().handleUpdate({
      update_id: 3,
      callback_query: {
        id: "q2",
        data: "delay:RF2003:6",
        from: { id: 7, username: "ops" },
        message: { chat: { id: Number(AUTHORIZED), type: "private" } },
      },
    });
    expect(calls[0]!.body.text).toContain("Apply 6s delay to RF2003: recorded");
  });
});

describe("Telegram activity log", () => {
  test("test_assert_sends_and_commands_are_logged_newest_first", async () => {
    const path = `${tmpdir()}/sd-activity-${crypto.randomUUID()}.jsonl`;
    const bot = new SportsDeskTelegramService({
      botToken: "test-token",
      chatId: AUTHORIZED,
      apiBaseUrl: `http://127.0.0.1:${stub.port}`,
      activityLogPath: path,
    });
    await bot.handleUpdate(message(999, "/watchlist"));
    await bot.handleUpdate(message(Number(AUTHORIZED), "/check RF2003"));
    const entries = await bot.getActivity();
    expect(entries.map((e) => [e.direction, e.chatId, e.outcome])).toEqual([
      ["out", AUTHORIZED, "sent"],
      ["in", AUTHORIZED, "received"],
      ["out", "999", "sent"],
      ["in", "999", "unauthorized"],
    ]);
    expect(entries[0]!.summary).toStartWith(
      "RF2003 (Whale Volatility Concentration)",
    );
    expect(entries[0]!.summary).not.toContain("<");
    expect(await bot.getActivity(1)).toHaveLength(1);
    await rm(path, { force: true });
  });

  test("test_assert_simulated_send_is_logged_with_reason", async () => {
    const path = `${tmpdir()}/sd-activity-${crypto.randomUUID()}.jsonl`;
    const bot = new SportsDeskTelegramService({
      botToken: "",
      activityLogPath: path,
    });
    await bot.sendMessage("", "<b>hello</b> &amp; bye");
    const [entry] = await bot.getActivity();
    expect(entry).toMatchObject({
      direction: "out",
      outcome: "simulated",
      summary: "hello & bye",
      detail: "TELEGRAM_BOT_TOKEN is not set",
    });
    await rm(path, { force: true });
  });
});

describe("Webview server Telegram endpoints", () => {
  let server: ReturnType<
    typeof import("../services/sportsdesk_webview_server.ts").startServer
  >;
  let base: string;
  const saved = {
    token: env.TELEGRAM_BOT_TOKEN,
    admin: env.SPORTSDESK_ADMIN_TOKEN,
    secret: env.TELEGRAM_WEBHOOK_SECRET,
  };

  beforeAll(async () => {
    delete env.TELEGRAM_BOT_TOKEN;
    env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
    const { startServer } =
      await import("../services/sportsdesk_webview_server.ts");
    server = startServer({ port: 0, hostname: "127.0.0.1" });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    for (const [key, value] of [
      ["TELEGRAM_BOT_TOKEN", saved.token],
      ["SPORTSDESK_ADMIN_TOKEN", saved.admin],
      ["TELEGRAM_WEBHOOK_SECRET", saved.secret],
    ] as const) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  test("test_assert_management_api_fails_closed_without_admin_token", async () => {
    delete env.SPORTSDESK_ADMIN_TOKEN;
    const res = await fetch(`${base}/api/telegram/status`);
    expect(res.status).toBe(503);
    expect((await fetch(`${base}/api/watchlist`)).status).toBe(503);
  });

  test("test_assert_management_api_requires_matching_bearer", async () => {
    env.SPORTSDESK_ADMIN_TOKEN = "admin-secret";
    const wrong = await fetch(`${base}/api/telegram/status`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/api/telegram/status`, {
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      status: { mode: string; tokenConfigured: boolean };
    };
    expect(body.status.tokenConfigured).toBe(false);
    expect(body.status.mode).toBe("simulation");
  });

  test("test_assert_report_rejects_unknown_type", async () => {
    env.SPORTSDESK_ADMIN_TOKEN = "admin-secret";
    const res = await fetch(`${base}/api/telegram/report?type=NOPE`, {
      method: "POST",
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(400);
  });

  test("test_assert_webhook_rejects_wrong_secret", async () => {
    const res = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "wrong",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    const ok = await fetch(`${base}/telegram/webhook`, {
      method: "POST",
      headers: {
        "X-Telegram-Bot-Api-Secret-Token": "hook-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(ok.status).toBe(200);
  });

  test("test_assert_activity_endpoint_is_admin_guarded", async () => {
    env.SPORTSDESK_ADMIN_TOKEN = "admin-secret";
    expect((await fetch(`${base}/api/telegram/activity`)).status).toBe(401);
    const res = await fetch(`${base}/api/telegram/activity?limit=5`, {
      headers: { Authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { entries: unknown[] }).entries).toBeArray();
  });

  test("test_assert_miniapp_trailing_slash_is_served", async () => {
    expect((await fetch(`${base}/miniapp/?tab=forensics`)).status).toBe(200);
  });
});

describe("Telegram FetchSession warm-up", () => {
  test("warmOnInit warms through fetchSession.fetch HEAD without global fetch.preconnect", async () => {
    const fetchCalls: Array<{
      url: string | URL | Request;
      init?: BunFetchRequestInit | undefined;
    }> = [];

    const bot = new SportsDeskTelegramService({
      botToken: "123:test-token",
      chatId: "456",
      apiBaseUrl: "http://127.0.0.1:49999/",
      activityLogPath: null,
      warmOnInit: true,
      fetchSession: {
        fetch: async (input, init) => {
          fetchCalls.push({ url: input, init });
          return new Response(null, { status: 200 });
        },
        close: () => {},
      },
    });

    // Allow the fire-and-forget microtask in constructor to settle
    await Bun.sleep(10);

    const botSource = await Bun.file(
      new URL("../services/sportsdesk_telegram_bot.ts", import.meta.url),
    ).text();
    const botCode = botSource
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(botCode).not.toContain("fetch.preconnect(");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("http://127.0.0.1:49999/");
    expect(fetchCalls[0]!.init?.method).toBe("HEAD");
    expect(fetchCalls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(await bot.warmSession()).toBe(true);
  });

  test("warmSession returns false cleanly on fetch rejection and in non-live mode", async () => {
    const failingBot = new SportsDeskTelegramService({
      botToken: "123:test-token",
      chatId: "456",
      apiBaseUrl: "http://127.0.0.1:49999",
      activityLogPath: null,
      warmOnInit: false,
      fetchSession: {
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        close: () => {},
      },
    });
    expect(await failingBot.warmSession(50)).toBe(false);

    const dryRunBot = new SportsDeskTelegramService({
      botToken: "",
      chatId: "",
      apiBaseUrl: "http://127.0.0.1:49999",
      activityLogPath: null,
      warmOnInit: false,
    });
    expect(await dryRunBot.warmSession(50)).toBe(false);
  });
});
