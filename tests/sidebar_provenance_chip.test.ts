import { describe, expect, test } from "bun:test";
import {
  isFixtureProvenance,
  shouldShowFixtureNotLiveChip,
} from "../lib/sidebar_fixture_provenance.ts";

describe("sidebar fixture provenance chip", () => {
  test("fixture basis renders not-live chip", () => {
    const prov = {
      source: "scratch/agent-graph.json",
      basis: "fixture",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(true);
    expect(isFixtureProvenance(prov)).toBe(true);
  });

  test("capture basis with data/ source does not chip", () => {
    const prov = {
      source: "data/agent-tree.json",
      basis: "capture",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(false);
  });

  test("scratch source chips even if basis claims capture", () => {
    const prov = {
      source: "scratch/agent-graph.json",
      basis: "capture",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(true);
  });

  test("live capture path does not chip", () => {
    const prov = {
      source: "/cloud/api/agent-tree@2026-11-09",
      basis: "live",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(false);
  });
});
