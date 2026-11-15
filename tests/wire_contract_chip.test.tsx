import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WireContractChip } from "@sportsdesk-ops/ui";
import type { WagersWireContractSummary } from "@sportsdesk-ops/contracts";

const clean: WagersWireContractSummary = {
  ok: true,
  registry: "schema/wagers_field_contract.json",
  capture: "getBetTicker-2026-10-31",
  capture_sha256:
    "955c3d0a084825f4fe35309b499b9d38111c6b8001e958b393e139e6fb39e1c3",
  enum_source: "observed",
  fields_checked: ["WagerType", "ShortDesc", "VolumeAmount", "VIP"],
  rows: 237,
  skipped_rows: 63,
  violations: [],
};

const render = (
  summary: WagersWireContractSummary | null,
  error: string | null = null,
) =>
  renderToStaticMarkup(
    React.createElement(WireContractChip, { summary, error }),
  );

describe("WireContractChip", () => {
  test("renders nothing when the host neither checks nor errors", () => {
    expect(render(null)).toBe("");
  });

  test("clean summary is a details disclosure with the capture evidence", () => {
    const html = render(clean);
    expect(html).toContain("<details");
    expect(html).toContain("✓ wire: 237 rows");
    expect(html).toContain("getBetTicker-2026-10-31");
    expect(html).toContain("sha 955c3d0a0848");
    expect(html).toContain("237 row(s) checked · 63 sentinel");
    expect(html).toContain("No type or nullability violations.");
    // The enum caveat travels with the evidence, not with the reader's memory.
    expect(html).toContain("Enum differences are not violations");
  });

  test("violations render per field with examples and the failure label", () => {
    const html = render({
      ...clean,
      ok: false,
      violations: [
        { field: "VIP", kind: "nullable", count: 4, examples: ["null"] },
        { field: "VolumeAmount", kind: "type", count: 1, examples: ['"7500"'] },
      ],
    });
    expect(html).toContain("⚠ wire: 2 issue(s)");
    expect(html).toContain("VIP");
    expect(html).toContain("nullable ×4");
    expect(html).toContain("VolumeAmount");
    expect(html).toContain("type ×1");
    expect(html).toContain("&quot;7500&quot;");
    expect(html).not.toContain("No type or nullability violations.");
  });

  test("ok:false with no parseable violations never reads as clean", () => {
    const html = render({ ...clean, ok: false, violations: [] });
    expect(html).toContain("⚠ wire: invalid summary");
    expect(html).not.toContain("0 issue(s)");
  });

  test("an error wins over a stale clean summary and suppresses its detail", () => {
    const html = render(clean, "GET /api/wagers failed: boom");
    expect(html).toContain("⚠ wire: unavailable");
    expect(html).toContain("GET /api/wagers failed: boom");
    expect(html).not.toContain("✓ wire: 237 rows");
    expect(html).not.toContain("No type or nullability violations.");
    expect(html).not.toContain("237 row(s) checked");
  });

  test("registry errors surface as unavailable without a summary", () => {
    const html = render(null, "wire contract registry or capture unavailable");
    expect(html).toContain("⚠ wire: unavailable");
    expect(html).toContain("registry or capture unavailable");
  });
});
