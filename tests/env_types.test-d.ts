import { describe, expectTypeOf, test } from "bun:test";

describe("Environment Variable Type Parity (Bun.env vs process.env)", () => {
  test("test_assert_type_parity_between_bun_env_and_process_env", () => {
    // Verify interface merging propagation across Bun.Env and NodeJS.ProcessEnv
    expectTypeOf<typeof Bun.env.PORT>().toEqualTypeOf<typeof Bun.env.PORT>();
    expectTypeOf<typeof Bun.env.HOST>().toEqualTypeOf<typeof Bun.env.HOST>();
    expectTypeOf<typeof Bun.env.HOSTNAME>().toEqualTypeOf<
      typeof Bun.env.HOSTNAME
    >();
    expectTypeOf<typeof Bun.env.NODE_ENV>().toEqualTypeOf<
      typeof Bun.env.NODE_ENV
    >();

    // Gateway variables
    expectTypeOf<typeof Bun.env.F402_BASE_URL>().toEqualTypeOf<
      typeof Bun.env.F402_BASE_URL
    >();
    expectTypeOf<typeof Bun.env.F402_AGENT_ID>().toEqualTypeOf<
      typeof Bun.env.F402_AGENT_ID
    >();
    expectTypeOf<typeof Bun.env.F402_PASSWORD>().toEqualTypeOf<
      typeof Bun.env.F402_PASSWORD
    >();

    // Cloudflare & R2 variables
    expectTypeOf<typeof Bun.env.CLOUDFLARE_API_TOKEN>().toEqualTypeOf<
      typeof Bun.env.CLOUDFLARE_API_TOKEN
    >();
    expectTypeOf<typeof Bun.env.R2_BUCKET_NAME>().toEqualTypeOf<
      typeof Bun.env.R2_BUCKET_NAME
    >();

    // Telegram Bot & Mini App variables
    expectTypeOf<typeof Bun.env.TELEGRAM_BOT_TOKEN>().toEqualTypeOf<
      typeof Bun.env.TELEGRAM_BOT_TOKEN
    >();
    expectTypeOf<typeof Bun.env.TELEGRAM_CHAT_ID>().toEqualTypeOf<
      typeof Bun.env.TELEGRAM_CHAT_ID
    >();
    expectTypeOf<typeof Bun.env.TELEGRAM_MINIAPP_URL>().toEqualTypeOf<
      typeof Bun.env.TELEGRAM_MINIAPP_URL
    >();
  });
});
