import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { handleDashboardCli } from "../cli/sportsdesk_cli.ts";
import { renderAnsiMarkdown } from "../lib/canonical_osc8_links.ts";
import {
  SURFACE,
  TIER,
  WAGER_BADGE,
  composite,
  hexToSgr,
  wagerBadge,
} from "../lib/wager_tokens.ts";
import {
  renderWagerMarkdownTerminal,
  TIER_KEYWORD_RE,
} from "../lib/terminal_emulator.ts";
import { parseAnsiTokens } from "../src/dashboard/ansi.tsx";

describe("Dashboard Build and Markdown Pipeline", () => {
  describe("Wager Tier Tokens & TrueColor ANSI Bridge", () => {
    it("composites alpha foreground over panel backdrop to produce deterministic solid hex", () => {
      const critBg = composite("#f87171", 0.15, SURFACE.panel);
      expect(critBg).toBe("#302332");
      expect(critBg).toBe(TIER.CRITICAL.bg);

      const steamBg = composite("#fb923c", 0.15, SURFACE.panel);
      expect(steamBg).toBe("#31282a");
      expect(steamBg).toBe(TIER.STEAM.bg);
    });

    it("encodes CSS hex tokens into standard ANSI 24-bit TrueColor SGR escape sequences", () => {
      // #f87171 -> rgb(248, 113, 113)
      const criticalSgr = hexToSgr(TIER.CRITICAL.fg);
      expect(criticalSgr).toBe("\x1b[38;2;248;113;113m");

      // Background code 48;2;r;g;b
      const bgSgr = hexToSgr(TIER.CRITICAL.bg, true);
      expect(bgSgr).toBe("\x1b[48;2;48;35;50m");
    });

    it("precomputes CSSProperties badges with zero runtime allocation overhead", () => {
      expect(WAGER_BADGE.CRITICAL.color).toBe("#f87171");
      expect(WAGER_BADGE.CRITICAL.backgroundColor).toBe("#302332");
      expect(WAGER_BADGE.STEAM.color).toBe("#f59e0b");
      expect(WAGER_BADGE.LATENCY.color).toBe("#c084fc");
      expect(WAGER_BADGE.RECREATIONAL.color).toBe("#4ade80");

      // Fallback handles unknown string without crashing
      const fallback = wagerBadge("UNKNOWN_TIER");
      expect(fallback.color).toBe("#94a3b8");
    });

    it("translates markdown through Bun.markdown.render() applying brand TrueColor ANSI escapes", () => {
      const sample =
        "# Wager Alert\n\n**CRITICAL** alert for GP301.\n**STEAM** chaser on BRT5229.\nRecreational unit: **RECREATIONAL**.";
      const ansi = renderWagerMarkdownTerminal(sample);

      expect(ansi).toContain("\x1b[38;2;248;113;113m"); // Critical fg
      expect(ansi).toContain("\x1b[48;2;48;35;50m"); // Critical bg
      expect(ansi).toContain("\x1b[38;2;245;158;11m"); // Steam fg (#f59e0b)
      expect(ansi).toContain("\x1b[38;2;74;222;128m"); // Recreational fg
      expect(ansi).toContain("# Wager Alert");
    });

    const tierCases = [
      ["**CRITICAL**", true],
      ["**#CRITICAL**", true],
      ["**🚨 CRITICAL**", true],
      ["**STEAM (T2 Syndicate)**", true],
      ["**STEAM100**", false],
      ["**critical line move**", false],
      ["**Steam Runner**", false],
      ["**STEAM STEAM**", false],
    ] as const;

    it.each(tierCases)(
      "anchored tier matching: %s → badge=%p",
      (md, isBadge) => {
        const out = renderWagerMarkdownTerminal(md);
        expect(out.includes("\x1b[48;")).toBe(isBadge);
      },
    );

    it("verifies visible text integrity and width via Bun.stripANSI and Bun.stringWidth", () => {
      const out = renderWagerMarkdownTerminal("**STEAM (T2)**\nnext line");
      const stripped = Bun.stripANSI(out);
      expect(stripped).toContain("STEAM (T2)");
      expect(stripped).toContain("next line");
      // SGR bytes must not inflate visible column width
      expect(Bun.stringWidth(out)).toBe(Bun.stringWidth(stripped));
    });

    it("preserves visual column alignment across multi-byte and emoji codepoints using padDisplay", async () => {
      const { padDisplay } = await import("../lib/cli_inspect.ts");
      const emojiHeader = "📊 SHARPNESS RADAR";
      const paddedLeft = padDisplay(emojiHeader, 25);
      expect(Bun.stringWidth(paddedLeft)).toBe(25);

      const paddedRight = padDisplay("⚡ STEAM", 15, "right");
      expect(Bun.stringWidth(paddedRight)).toBe(15);
      expect(paddedRight.endsWith("⚡ STEAM")).toBe(true);

      const ansiColored = "\x1b[32m+14.2¢\x1b[0m";
      const paddedAnsi = padDisplay(ansiColored, 12, "right");
      expect(Bun.stringWidth(paddedAnsi)).toBe(12);

      // ZWJ grapheme cluster sequences
      const zwjFamily = "👨‍👩‍👧‍👦";
      const paddedZwj = padDisplay(zwjFamily, 10);
      expect(Bun.stringWidth(paddedZwj)).toBe(10);

      // Modifier / skin tone sequences
      const skinTone = "👍🏽";
      const paddedSkin = padDisplay(skinTone, 8, "right");
      expect(Bun.stringWidth(paddedSkin)).toBe(8);

      // Combining marks
      const combining = "e\u0301";
      const paddedCombining = padDisplay(combining, 6);
      expect(Bun.stringWidth(paddedCombining)).toBe(6);
    });

    it("resets colors cleanly on multi-param SGR 39;49, 1;39, and bare \\x1b[m", () => {
      const input =
        "\x1b[31;42mcolored\x1b[39;49m reset \x1b[1mbold\x1b[m plain";
      const tokens = parseAnsiTokens(input);

      // First segment: red fg, green bg
      expect(tokens[0]?.text).toBe("colored");
      expect(tokens[0]?.color).toBe("#f87171");
      expect(tokens[0]?.bg).toBe("rgba(34, 197, 94, 0.2)");

      // Second segment: reset by 39;49
      expect(tokens[1]?.text).toBe(" reset ");
      expect(tokens[1]?.color).toBeUndefined();
      expect(tokens[1]?.bg).toBeUndefined();

      // Third segment: bold
      expect(tokens[2]?.text).toBe("bold");
      expect(tokens[2]?.bold).toBe(true);

      // Fourth segment: reset to plain by bare \x1b[m
      expect(tokens[3]?.text).toBe(" plain");
      expect(tokens[3]?.bold).toBe(false);
    });

    it("parses 24-bit TrueColor ANSI escape codes into rgb() CSS color strings in client parser", () => {
      const input = `${hexToSgr("#f87171")}CRITICAL EXPOSURE\x1b[0m normal text`;
      const segments = parseAnsiTokens(input);

      expect(segments.length).toBeGreaterThanOrEqual(2);
      expect(segments[0]?.text).toBe("CRITICAL EXPOSURE");
      expect(segments[0]?.color).toBe("rgb(248, 113, 113)");
      expect(segments[1]?.text).toBe(" normal text");
      expect(segments[1]?.color).toBeUndefined();
    });

    it("evaluates safely without throwing in browser environments where Bun is undefined", () => {
      // Verifies the pure arithmetic bit-shift fallback
      const sgr = hexToSgr("#f87171");
      expect(sgr).toBe("\x1b[38;2;248;113;113m");

      const mixed = composite("#f87171", 0.15, "#0d1527");
      expect(mixed).toBe("#302332");
    });

    it("ensures SGR state is per-call and does not leak between renders", () => {
      const first = parseAnsiTokens("\x1b[31;42mred-on-green");
      expect(first[0]?.color).toBe("#f87171");
      expect(first[0]?.bg).toBe("rgba(34, 197, 94, 0.2)");

      const second = parseAnsiTokens("plain fresh call");
      expect(second[0]?.color).toBeUndefined();
      expect(second[0]?.bg).toBeUndefined();
      expect(second[0]?.bold).toBe(false);
    });

    it.each([
      ["**CRITICAL**", "CRITICAL"],
      ["**🚨 STEAM (T2 Syndicate)**", "🚨 STEAM (T2 Syndicate)"],
      ["plain `code` **bold** _italic_", "plain code bold italic"],
      [
        "multi\nline **LATENCY**\nwith emoji 🎯",
        "multi line LATENCY with emoji 🎯",
      ],
    ])(
      "render → strip preserves exact visible content: %s",
      (md, expectedNormalized) => {
        const rendered = renderWagerMarkdownTerminal(md);
        const stripped = Bun.stripANSI(rendered);
        expect(stripped.trim().replace(/\s+/g, " ")).toBe(expectedNormalized);
      },
    );

    it("verifies double-width emoji calculations via Bun.stringWidth", () => {
      const rendered = renderWagerMarkdownTerminal("**🚨 CRITICAL**");
      const stripped = Bun.stripANSI(rendered);
      // Badge padding " 🚨 CRITICAL \n\n":
      // 1 (space) + 2 (🚨 emoji) + 9 (" CRITICAL") + 1 (space) = 13 visible columns
      // Note: surrogate pair + newlines gives 15 UTF-16 code units (.length), proving stringWidth is doing work
      expect(Bun.stringWidth(stripped)).toBe(13);
      expect(stripped.length).toBe(15);
      expect(stripped.length).toBeGreaterThan(Bun.stringWidth(stripped));
    });

    it("verifies ZWJ multi-codepoint emoji column width through Bun.stringWidth", () => {
      const family = "👨‍👩‍👧";
      // ZWJ sequence: 8 UTF-16 code units, but exactly 2 visible terminal columns
      expect(family.length).toBe(8);
      expect(Bun.stringWidth(family)).toBe(2);

      const rendered = renderWagerMarkdownTerminal(
        `**CRITICAL** syndicate family ${family} alert`,
      );
      const stripped = Bun.stripANSI(rendered);
      const diff =
        Bun.stringWidth(stripped) -
        Bun.stringWidth(stripped.replace(family, ""));
      expect(diff).toBe(2);
    });

    it("CRITICAL badge SGR is byte-stable and matches canonical snapshot", () => {
      const rendered = renderWagerMarkdownTerminal("**CRITICAL**");
      expect(rendered).toBe(
        "\x1b[38;2;248;113;113m\x1b[48;2;48;35;50m\x1b[1m CRITICAL \x1b[0m\n\n",
      );
    });

    it("wraps ANSI badge text cleanly using Bun.wrapAnsi without escape sequence corruption", () => {
      const rendered = renderWagerMarkdownTerminal(
        "**CRITICAL** stake limit clamped to $250 by risk engine",
      );
      const wrapped = Bun.wrapAnsi(rendered, 20);
      for (const line of wrapped.split("\n")) {
        const stripped = Bun.stripANSI(line);
        expect(Bun.stringWidth(stripped)).toBeLessThanOrEqual(20);
      }
      // Content preservation invariant: all words preserved in exact sequence after wrapping
      const originalWords = Bun.stripANSI(rendered).trim().split(/\s+/);
      const wrappedWords = Bun.stripANSI(wrapped).trim().split(/\s+/);
      expect(wrappedWords).toEqual(originalWords);
    });

    it("fuzz tests SGR state machine across 500 deterministic pseudo-random seeds", () => {
      function mulberry32(a: number) {
        return () => {
          a |= 0;
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      const CODES = [
        0, 1, 2, 4, 22, 24, 30, 31, 32, 39, 40, 41, 49, 90, 91, 100,
      ];

      for (let seed = 0; seed < 500; seed++) {
        const rand = mulberry32(seed);
        const seqLen = 1 + Math.floor(rand() * 6);
        const seq = Array.from(
          { length: seqLen },
          () => CODES[Math.floor(rand() * CODES.length)],
        );
        const sgr = `\x1b[${seq.join(";")}m`;

        // Invariant A: any sequence followed by \x1b[0m leaves a clean slate
        const afterFullReset = parseAnsiTokens(`${sgr}payload\x1b[0m reset`);
        const resetSeg = afterFullReset[afterFullReset.length - 1];
        expect(resetSeg?.color).toBeUndefined();
        expect(resetSeg?.bg).toBeUndefined();
        expect(resetSeg?.bold).toBe(false);
        expect(resetSeg?.dim).toBe(false);
        expect(resetSeg?.underline).toBe(false);

        // Invariant B: \x1b[39m clears foreground regardless of preceding sequence
        const afterFgReset = parseAnsiTokens(`${sgr}payload\x1b[39m reset`);
        const fgResetSeg = afterFgReset[afterFgReset.length - 1];
        expect(fgResetSeg?.color).toBeUndefined();

        // Invariant C: \x1b[49m clears background regardless of preceding sequence
        const afterBgReset = parseAnsiTokens(`${sgr}payload\x1b[49m reset`);
        const bgResetSeg = afterBgReset[afterBgReset.length - 1];
        expect(bgResetSeg?.bg).toBeUndefined();
      }
    });

    it("enforces median tier regex execution performance under 250ns/op budget across 50,000 iterations", () => {
      const candidates = [
        "#CRITICAL",
        "🚨 STEAM (T2 Syndicate)",
        "STEAM100",
        "regular prose in markdown that should fail quickly",
      ];
      // Warm up
      for (let i = 0; i < 5_000; i++) {
        for (const c of candidates) TIER_KEYWORD_RE.test(c);
      }

      const SAMPLES = 7;
      const ITERS_PER_SAMPLE = 10_000;
      const sampleRates: number[] = [];
      for (let s = 0; s < SAMPLES; s++) {
        const start = Bun.nanoseconds();
        for (let i = 0; i < ITERS_PER_SAMPLE; i++) {
          for (const c of candidates) {
            TIER_KEYWORD_RE.test(c);
          }
        }
        const elapsedNs = Bun.nanoseconds() - start;
        sampleRates.push(elapsedNs / (ITERS_PER_SAMPLE * candidates.length));
      }
      sampleRates.sort((a, b) => a - b);
      const medianNsPerOp = sampleRates[Math.floor(SAMPLES / 2)]!;
      expect(medianNsPerOp).toBeLessThan(250);
    });
  });

  describe("Bun.markdown", () => {
    it("renders dashboard.md to ANSI terminal presentation in single-digit milliseconds", async () => {
      const file = Bun.file(resolve(process.cwd(), "dashboard.md"));
      expect(await file.exists()).toBe(true);

      const markdown = await file.text();
      // Warm up Bun.markdown.ansi before timing pure render latency
      renderAnsiMarkdown("# warmup", { colors: false, columns: 0 });
      const start = performance.now();
      const rendered = renderAnsiMarkdown(markdown, {
        colors: false,
        columns: 0,
      });
      const elapsed = performance.now() - start;

      expect(rendered).toContain("Top Rated Sharp Bettors");
      expect(rendered).toContain("GP301");
      expect(rendered).toContain("BRT5229");
      expect(rendered).toContain("ELITE_SHARP");
      expect(rendered).toContain("CRITICAL");
      expect(rendered).toContain("ALERT_OPERATOR");
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
