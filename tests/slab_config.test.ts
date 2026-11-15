import { describe, expect, test } from "bun:test";
import {
  assertRelativePath,
  assertSafeInt,
  createServerSlab,
  parseServerSlab,
  SlabConfigError,
  SLAB_SERVER,
} from "../lib/slab_config.ts";
import {
  NULL_BRIDGE_CHANNEL_WORD32,
  NULL_CLV_SENTINEL,
  NULL_CUSTOMER_HANDLE32,
} from "../lib/bridge_and_channel_router.ts";
import { F402_BET_TICKER_JSONL_WINDOW_BYTES } from "../lib/f402_bet_ticker_jsonl.ts";
import { wagersWireContractPath } from "../lib/wagers_wire_contract.ts";
import {
  createFrontendSlab,
  SLAB_FRONTEND,
} from "../packages/ui/src/config/slab.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVER_TOML = resolve(process.cwd(), "config/slab.toml");
const FRONTEND_TOML = resolve(
  process.cwd(),
  "packages/ui/src/config/slab.frontend.toml",
);

/** Minimal valid table; overrides merge one level deep per top-level key. */
function slab(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      schema: "sportsdesk-slab/v1",
      version: "1.0.0",
      generated_at: "2026-11-14T00:00:00Z",
    },
    unsafe: { allowed: true },
    paths: { wire_contract: "schema/wagers_field_contract.json" },
    capacity: { ticker_window_bytes: 2_000_000 },
    sentinels: {
      null_clv: -2147483648,
      null_customer_handle32: 4294967295,
      null_bridge_channel_word32: 4294967295,
    },
    ...overrides,
  };
}

describe("server slab config", () => {
  test("the committed TOML validates and matches the code constants", () => {
    const parsed = parseServerSlab(readFileSync(SERVER_TOML, "utf8"));
    expect(parsed.meta.schema).toBe("sportsdesk-slab/v1");
    expect(parsed.unsafe.allowed).toBe(true);
    // The reader's window comes from the same table.
    expect(F402_BET_TICKER_JSONL_WINDOW_BYTES).toBe(
      parsed.capacity.ticker_window_bytes,
    );
    // Sentinel drift fails here instead of moving a pack/unpack boundary.
    expect(parsed.sentinels.null_clv).toBe(NULL_CLV_SENTINEL);
    expect(parsed.sentinels.null_customer_handle32).toBe(
      NULL_CUSTOMER_HANDLE32,
    );
    expect(parsed.sentinels.null_bridge_channel_word32).toBe(
      NULL_BRIDGE_CHANNEL_WORD32,
    );
  });

  test("a fresh parse yields a new frozen slab, not a shared object (reload semantics)", () => {
    const text = readFileSync(SERVER_TOML, "utf8");
    const first = parseServerSlab(text);
    const second = parseServerSlab(text);
    expect(first).not.toBe(second);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);

    // Editing the TOML produces a slab with the new column values.
    const edited = text.replace(
      "ticker_window_bytes = 2000000",
      "ticker_window_bytes = 3000000",
    );
    expect(edited).not.toBe(text);
    const reloaded = parseServerSlab(edited);
    expect(reloaded).not.toBe(first);
    expect(reloaded.capacity.ticker_window_bytes).toBe(3_000_000);
    expect(first.capacity.ticker_window_bytes).toBe(2_000_000);
  });

  test("TOML integers outside the safe range are rejected", () => {
    // 2^53 is exactly representable but not safe: TOML cannot carry it as an
    // exact integer, so it must never become a sentinel.
    expect(() =>
      createServerSlab(
        slab({
          sentinels: {
            null_clv: 9007199254740992,
            null_customer_handle32: 4294967295,
            null_bridge_channel_word32: 4294967295,
          },
        }),
      ),
    ).toThrow(SlabConfigError);
    expect(() => assertSafeInt(2 ** 53, "x")).toThrow("safe integer");
    expect(() => assertSafeInt(1.5, "x")).toThrow("safe integer");
  });

  test("capacity and sentinel bounds are enforced", () => {
    expect(() =>
      createServerSlab(slab({ capacity: { ticker_window_bytes: 0 } })),
    ).toThrow("capacity.ticker_window_bytes");
    expect(() =>
      createServerSlab(
        slab({
          sentinels: {
            null_clv: 2147483648,
            null_customer_handle32: 0,
            null_bridge_channel_word32: 0,
          },
        }),
      ),
    ).toThrow("sentinels.null_clv");
  });

  test("absolute paths and traversal are rejected before any read", () => {
    for (const bad of [
      "/home/ci/checkout/schema/wagers.json",
      "../outside/schema.json",
      "schema/../../escape.json",
    ]) {
      expect(() =>
        createServerSlab(slab({ paths: { wire_contract: bad } })),
      ).toThrow(SlabConfigError);
    }
    expect(assertRelativePath("schema/wagers_field_contract.json", "p")).toBe(
      "schema/wagers_field_contract.json",
    );
  });

  test("WAGERS_WIRE_CONTRACT_PATH is validated by the adapter", () => {
    const previous = process.env.WAGERS_WIRE_CONTRACT_PATH;
    try {
      process.env.WAGERS_WIRE_CONTRACT_PATH = "/tmp/wagers.json";
      expect(() => wagersWireContractPath()).toThrow("must be relative");

      process.env.WAGERS_WIRE_CONTRACT_PATH =
        "schema/wagers_field_contract.json";
      expect(wagersWireContractPath()).toBe(
        resolve(process.cwd(), "schema/wagers_field_contract.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.WAGERS_WIRE_CONTRACT_PATH;
      else process.env.WAGERS_WIRE_CONTRACT_PATH = previous;
    }
  });

  test("an unknown schema is rejected", () => {
    expect(() =>
      createServerSlab(
        slab({
          meta: {
            schema: "sportsdesk-slab/v2",
            version: "1.0.0",
            generated_at: "2026-11-14T00:00:00Z",
          },
        }),
      ),
    ).toThrow("meta.schema");
  });

  test("SLAB_SERVER is the committed, validated snapshot", () => {
    expect(SLAB_SERVER.paths.wire_contract).toBe(
      "schema/wagers_field_contract.json",
    );
    expect(Object.isFrozen(SLAB_SERVER)).toBe(true);
  });
});

describe("frontend slab capability", () => {
  test("the committed frontend TOML validates with unsafe disabled", () => {
    const text = readFileSync(FRONTEND_TOML, "utf8");
    const parsed = createFrontendSlab(Bun.TOML.parse(text));
    expect(parsed.unsafe.allowed).toBe(false);
    expect(SLAB_FRONTEND.unsafe.allowed).toBe(false);
  });

  test("a frontend config that enables unsafe slabs is rejected at load", () => {
    expect(() =>
      createFrontendSlab({
        meta: {
          schema: "sportsdesk-slab-frontend/v1",
          version: "1.0.0",
          generated_at: "2026-11-14T00:00:00Z",
        },
        unsafe: { allowed: true },
      }),
    ).toThrow("must be false");
  });
});
