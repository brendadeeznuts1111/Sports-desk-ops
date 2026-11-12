import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SPORTSDESK_DAEMON_PORT,
  resolveBunServePort,
  resolveSportsdeskDaemonPort,
} from "../lib/bun_serve_port.ts";

describe("DEFAULT_SPORTSDESK_DAEMON_PORT", () => {
  test("is the default when no port env is set", () => {
    expect(DEFAULT_SPORTSDESK_DAEMON_PORT).toBe(4020);
    expect(resolveSportsdeskDaemonPort({})).toBe(
      DEFAULT_SPORTSDESK_DAEMON_PORT,
    );
  });

  test("env values still outrank the default", () => {
    expect(resolveSportsdeskDaemonPort({ PORT: "4100" })).toBe(4100);
    expect(resolveBunServePort({})).toBe(3000);
  });
});
