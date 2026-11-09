import { describe, expect, test } from "bun:test";
import {
  fixtureProvenanceSubtype,
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
    expect(fixtureProvenanceSubtype(prov)).toBe("scratch");
  });

  test("capture basis with data/ source does not chip", () => {
    const prov = {
      source: "data/agent-tree.json",
      basis: "capture",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(false);
    expect(fixtureProvenanceSubtype(prov)).toBe(null);
  });

  test("scratch source chips even if basis claims capture", () => {
    const prov = {
      source: "scratch/agent-graph.json",
      basis: "capture",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(true);
    expect(fixtureProvenanceSubtype(prov)).toBe("scratch");
  });

  test("sample fixture distinguishes from scratch", () => {
    expect(
      fixtureProvenanceSubtype({
        source: "./enriched_customers_full.json",
        basis: "fixture",
      }),
    ).toBe("sample");
    expect(
      fixtureProvenanceSubtype({
        source: "tests/fixtures/agent-tree.json",
        basis: "capture",
      }),
    ).toBe("sample");
  });

  test("live capture path does not chip", () => {
    const prov = {
      source: "/cloud/api/agent-tree@2026-11-09",
      basis: "live",
    };
    expect(shouldShowFixtureNotLiveChip(prov)).toBe(false);
    expect(fixtureProvenanceSubtype(prov)).toBe(null);
  });

  test("live: and capture: sources never chip on path alone", () => {
    expect(
      shouldShowFixtureNotLiveChip({
        source: "live:/cloud/api/Report/Pending@2026-11-09T03:00:00.000Z",
        basis: "capture",
      }),
    ).toBe(false);
    expect(
      shouldShowFixtureNotLiveChip({
        source: "capture:/cloud/api/Report/Pending@2026-11-09T03:00:00.000Z",
        basis: null,
      }),
    ).toBe(false);
  });
});
