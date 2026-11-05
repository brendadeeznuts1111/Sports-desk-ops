import { describe, expect, test } from "bun:test";

import { stepMatchesEvent } from "../lib/ci_event_filter.ts";

describe("stepMatchesEvent", () => {
  test("runs unguarded, always() and non-event steps", () => {
    expect(stepMatchesEvent(undefined, "push")).toBe(true);
    expect(stepMatchesEvent("", "push")).toBe(true);
    expect(stepMatchesEvent("always()", "push")).toBe(true);
    expect(stepMatchesEvent("runner.os == 'Linux'", "push")).toBe(true);
  });

  test("matches the scheduled/manual guard used by the CDN pin", () => {
    const condition =
      "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
    expect(stepMatchesEvent(condition, "push")).toBe(false);
    expect(stepMatchesEvent(condition, "pull_request")).toBe(false);
    expect(stepMatchesEvent(condition, "schedule")).toBe(true);
    expect(stepMatchesEvent(condition, "workflow_dispatch")).toBe(true);
  });

  test("handles negation and the ${{ }} wrapper", () => {
    expect(
      stepMatchesEvent("github.event_name != 'pull_request'", "push"),
    ).toBe(true);
    expect(
      stepMatchesEvent("github.event_name != 'pull_request'", "pull_request"),
    ).toBe(false);
    expect(stepMatchesEvent("${{ github.event_name == 'push' }}", "push")).toBe(
      true,
    );
    expect(
      stepMatchesEvent("${{ github.event_name == 'push' }}", "schedule"),
    ).toBe(false);
  });

  test("treats an unknown expression as run", () => {
    expect(stepMatchesEvent("github.ref == 'refs/heads/main'", "push")).toBe(
      true,
    );
  });
});
