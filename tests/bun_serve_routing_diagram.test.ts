/**
 * @file tests/bun_serve_routing_diagram.test.ts
 * @description Guards the Bun.serve routing diagram: valid standalone SVG, accessible
 * title/description, no scripts or external references, and referenced by the runbook.
 */
import { describe, expect, test } from "bun:test";

const ASSET = new URL(
  "../docs/assets/bun-serve-bunrequest-routing.svg",
  import.meta.url,
);
const RUNBOOK = new URL(
  "../docs/runbooks/bun_server_runtime_shapes_runbook.md",
  import.meta.url,
);

describe("Bun.serve routing diagram", () => {
  test("is a standalone, accessible SVG", async () => {
    const svg = await Bun.file(ASSET).text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 680 256"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="bun-route-title bun-route-desc"');
    expect(svg).toContain('<title id="bun-route-title">');
    expect(svg).toContain('<desc id="bun-route-desc">');
    expect(svg).toContain("BunRequest");
    expect(svg).toContain("fetch(req, srv)");
    expect(svg).not.toContain("<script");
    expect(svg).not.toMatch(/href="https?:/);
  });

  test("the Bun server runbook embeds it with alt text", async () => {
    const runbook = await Bun.file(RUNBOOK).text();
    expect(runbook).toContain(
      "![Bun.serve route table: BunRequest on a hit, plain Request on the fetch fallback](../assets/bun-serve-bunrequest-routing.svg)",
    );
  });
});
