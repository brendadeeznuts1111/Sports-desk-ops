import { describe, expect, test } from "bun:test";
import { pickApiTarget } from "../lib/dashboard_preview_routing.ts";

const api = "http://127.0.0.1:4020";
const feedsApi = "http://127.0.0.1:4021";

describe("pickApiTarget", () => {
  test("keeps everything on the daemon when no feed host is configured", () => {
    expect(pickApiTarget("/api/wagers", { api })).toBe(api);
    expect(pickApiTarget("/api/alerts", { api, feedsApi: "" })).toBe(api);
  });

  test("sends the React feed reads to the feed host", () => {
    for (const path of [
      "/api/config/tiers",
      "/api/customers",
      "/api/wagers",
      "/api/dashboard",
      "/api/bet-ticker",
      "/api/build-matrix",
      "/api/dns",
      "/api/r2/pipeline",
      "/api/shadow-pricing",
      "/api/shift/summary",
      "/api/terminal/exec",
    ]) {
      expect(pickApiTarget(path, { api, feedsApi })).toBe(feedsApi);
    }
  });

  test("sends the parameterised alert and agent families to the feed host", () => {
    for (const path of [
      "/api/alerts",
      "/api/alerts/sweep",
      "/api/alerts/7/ack",
      "/api/alerts/7/retry",
      "/api/agents/42",
      "/api/agent/42",
      "/api/customer/profile",
      "/api/dns/telemetry",
      "/api/dns/benchmark",
      "/api/dns/reverse",
      "/api/rankings/all",
      "/api/live-wagers",
    ]) {
      expect(pickApiTarget(path, { api, feedsApi })).toBe(feedsApi);
    }
  });

  test("leaves daemon-only routes and health alone", () => {
    for (const path of [
      "/api/kpis",
      "/api/live-bets",
      "/api/graph",
      "/health",
    ]) {
      expect(pickApiTarget(path, { api, feedsApi })).toBe(api);
    }
  });
});
