import { describe, expect, test } from "bun:test";
import { newTicketIds } from "../packages/ui/src/live_stream.ts";

describe("newTicketIds", () => {
  test("the first snapshot is a baseline, not an arrival burst", () => {
    expect(newTicketIds(null, ["W-1", "W-2"])).toEqual([]);
  });

  test("reports only tickets absent from the previous snapshot", () => {
    const previous = new Set(["W-1", "W-2"]);
    expect(newTicketIds(previous, ["W-1", "W-2", "W-3"])).toEqual(["W-3"]);
    expect(newTicketIds(previous, ["W-1", "W-2"])).toEqual([]);
  });

  test("tickets that disappeared are not reported as new", () => {
    const previous = new Set(["W-1", "W-2", "W-3"]);
    expect(newTicketIds(previous, ["W-2", "W-3"])).toEqual([]);
  });

  test("preserves the incoming order of new tickets", () => {
    const previous = new Set(["W-1"]);
    expect(newTicketIds(previous, ["W-9", "W-1", "W-8"])).toEqual([
      "W-9",
      "W-8",
    ]);
  });
});
