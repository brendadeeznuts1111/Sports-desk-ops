import { describe, expect, test } from "bun:test";
import { findRouteKeyCollisions } from "../scripts/dev_dashboard.ts";

describe("dev dashboard route collisions", () => {
  test("reports a key owned by more than one table", () => {
    const collisions = findRouteKeyCollisions({
      ui: { "/": () => new Response(), "/dashboard": () => new Response() },
      api: {
        "/api/status": () => new Response(),
        "/dashboard": () => new Response(),
      },
      companion: { "/health": () => new Response() },
    });
    expect(collisions).toEqual([{ key: "/dashboard", tables: ["ui", "api"] }]);
  });

  test("is empty when every table owns distinct keys", () => {
    expect(
      findRouteKeyCollisions({
        ui: { "/": () => new Response() },
        api: { "/api": () => new Response() },
      }),
    ).toEqual([]);
  });

  test("keeps table order and reports each duplicate once", () => {
    const collisions = findRouteKeyCollisions({
      ui: { "/shared": 1, "/unique": 2 },
      api: { "/shared": 3 },
      companion: { "/shared": 4 },
    });
    expect(collisions).toEqual([
      { key: "/shared", tables: ["ui", "api", "companion"] },
    ]);
  });

  test("treats route patterns literally, so a wildcard is not a literal match", () => {
    expect(
      findRouteKeyCollisions({
        ui: { "/api/*": 1 },
        api: { "/api/*": 2 },
        companion: { "/api/status": 3 },
      }),
    ).toEqual([{ key: "/api/*", tables: ["ui", "api"] }]);
  });
});
