import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { handleDashboardCli } from "../cli/sportsdesk_cli.ts";
import { renderAnsiMarkdown } from "../lib/canonical_osc8_links.ts";

describe("Dashboard Build and Markdown Pipeline", () => {
  describe("Bun.markdown", () => {
    it("renders dashboard.md to ANSI terminal presentation in single-digit milliseconds", async () => {
      const file = Bun.file(resolve(process.cwd(), "dashboard.md"));
      expect(await file.exists()).toBe(true);

      const start = performance.now();
      const markdown = await file.text();
      const rendered = renderAnsiMarkdown(markdown, {
        colors: false,
        columns: 0,
      });
      const elapsed = performance.now() - start;

      expect(rendered).toContain("Top Rated Sharp Bettors");
      expect(rendered).toContain("GP301");
      expect(rendered).toContain("BRT5229");
      expect(rendered).toContain("ELITE_SHARP");
      expect(rendered).toContain("CRITICAL ALERT");
      expect(elapsed).toBeLessThan(100);
    });

    it("compiles dashboard.md into semantic HTML tables via Bun.markdown.html()", async () => {
      const file = Bun.file(resolve(process.cwd(), "dashboard.md"));
      const markdown = await file.text();
      const html = Bun.markdown.html(markdown);

      expect(html).toContain("<table>");
      expect(html).toContain("GP301");
      expect(html).toContain("ELITE_SHARP");
      expect(html).toContain("CRITICAL");
    });
  });

  describe("Bun.build", () => {
    it("bundles React 18 browser dashboard into minified standalone JavaScript asset", async () => {
      const start = performance.now();
      const result = await Bun.build({
        entrypoints: ["src/dashboard/index.tsx"],
        target: "browser",
        minify: true,
      });
      const elapsed = performance.now() - start;

      expect(result.success).toBe(true);
      expect(result.outputs.length).toBeGreaterThan(0);
      const bundle = result.outputs[0];
      expect(bundle).toBeDefined();
      expect(bundle?.path.endsWith(".js")).toBe(true);
      expect(bundle?.size).toBeGreaterThan(50000);
      expect(elapsed).toBeLessThan(500);
    });
  });

  describe("SportsDesk Dashboard CLI", () => {
    it("executes CLI directive without throwing and dispatches shell commands", async () => {
      expect(async () => {
        await handleDashboardCli(["--exec"]);
      }).not.toThrow();
    });
  });
});
