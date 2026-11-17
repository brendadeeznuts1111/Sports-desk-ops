import { describe, expect, test } from "bun:test";

import { resolveDbPoolOptions } from "../lib/db.ts";

describe("resolveDbPoolOptions", () => {
  test("defaults to 30s idle, no lifetime cap, 20 connections", () => {
    expect(resolveDbPoolOptions()).toEqual({
      idleTimeout: 30,
      maxLifetime: 0,
      max: 20,
    });
  });

  test("URL parameters override the defaults", () => {
    const params = new URLSearchParams("idle_timeout=5&max_lifetime=120&max=3");
    expect(resolveDbPoolOptions(params)).toEqual({
      idleTimeout: 5,
      maxLifetime: 120,
      max: 3,
    });
  });

  test("invalid or non-positive values fall back", () => {
    const params = new URLSearchParams(
      "idle_timeout=0&max_lifetime=-1&max=abc",
    );
    expect(resolveDbPoolOptions(params)).toEqual({
      idleTimeout: 30,
      maxLifetime: 0,
      max: 20,
    });
  });
});
