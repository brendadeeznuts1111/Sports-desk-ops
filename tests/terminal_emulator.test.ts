import { describe, expect, test } from "bun:test";
import {
  ansiToHtml,
  executeTerminalQuery,
  parseAnsiSegments,
} from "../lib/terminal_emulator.ts";
import { hasPty } from "./support/capabilities.ts";

describe("SportsDesk Terminal Emulator & Query Engine", () => {
  test("parseAnsiSegments tokenizes colors and styles accurately", () => {
    const raw = "\x1b[1;36mHeader\x1b[0m normal \x1b[32mGreen\x1b[0m";
    const segments = parseAnsiSegments(raw);

    expect(segments.length).toBe(3);
    expect(segments[0]?.text).toBe("Header");
    expect(segments[0]?.bold).toBe(true);
    expect(segments[0]?.color).toBe("#38bdf8"); // Cyan

    expect(segments[1]?.text).toBe(" normal ");
    expect(segments[1]?.bold).toBe(false);

    expect(segments[2]?.text).toBe("Green");
    expect(segments[2]?.color).toBe("#4ade80"); // Green
  });

  test("parseAnsiSegments parses OSC 8 terminal hyperlinks", () => {
    const raw =
      "Visit \x1b]8;;https://example.com\x1b\\Example Link\x1b]8;;\x1b\\ now.";
    const segments = parseAnsiSegments(raw);

    expect(segments.some((s) => s.linkUrl === "https://example.com")).toBe(
      true,
    );
    const linkSeg = segments.find((s) => s.linkUrl === "https://example.com");
    expect(linkSeg?.text).toBe("Example Link");
  });

  test("ansiToHtml transforms ANSI codes to safe styled HTML spans", () => {
    const raw = "\x1b[1;31mALERT\x1b[0m: <bad & dangerous>";
    const html = ansiToHtml(raw);

    expect(html).toContain('style="color: #f87171; font-weight: 700"');
    expect(html).toContain("ALERT");
    // Verifies HTML escaping
    expect(html).toContain("&lt;bad &amp; dangerous&gt;");
    expect(html).not.toContain("<bad & dangerous>");
  });

  test("executeTerminalQuery returns welcome banner on 'help'", async () => {
    const result = await executeTerminalQuery("help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "SPORTSDESK & FANTASY402 INTERACTIVE PTY TERMINAL",
    );
    expect(result.stdout).toContain("profile <id>");
  });

  test("executeTerminalQuery executes customer search with 'find'", async () => {
    const result = await executeTerminalQuery("find GP301");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GP301");
    expect(result.stdout).toContain("Key number buyer");
  });

  test("executeTerminalQuery inspects customer profile with 'profile GP301'", async () => {
    const result = await executeTerminalQuery("profile GP301");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SPORTSDESK BEHAVIORAL PROFILE: GP301");
    expect(result.stdout).toContain("ALERT_OPERATOR");
  });

  test("executeTerminalQuery benchmarks DNS latency with 'dns'", async () => {
    const result = await executeTerminalQuery("dns fantasy402.com");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "Bun.dns Latency Benchmark: fantasy402.com",
    );
    expect(result.stdout).toContain("c-ares resolver");
  });

  test("executeTerminalQuery classifies IP address with 'reverse'", async () => {
    const result = await executeTerminalQuery("reverse 1.1.1.1");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Reverse DNS Forensics: 1.1.1.1");
    expect(result.stdout).toContain("Cloudflare");
  });

  test("executeTerminalQuery handles 'clear' with VT100 control code", async () => {
    const result = await executeTerminalQuery("clear");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("\x1b[2J\x1b[H");
  });

  test("executeTerminalQuery parses cron schedule via Bun.cron", async () => {
    const result = await executeTerminalQuery("cron */10 * * * *");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bun.cron() Schedule Inspector");
    expect(result.stdout).toContain("America/New_York");
    expect(result.stdout).toContain("[1]");
  });

  test("executeTerminalQuery renders markdown via Bun.markdown.ansi", async () => {
    const result = await executeTerminalQuery("markdown # Operator Alert");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Operator Alert");
  });

  test("executeTerminalQuery displays Bun 1.4 capability matrix", async () => {
    const result = await executeTerminalQuery("capabilities");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("BUN 1.4 NATIVE RUNTIME");
    expect(result.stdout).toContain("HTTP/3");
    expect(result.stdout).toContain("Replaces glow");
    expect(result.stdout).toContain("Bun.markdown");
    expect(result.stdout).toContain("Bun.cron");
    expect(result.stdout).toContain("Bun.Terminal");
    expect(result.stdout).toContain("bun run --parallel");
  });

  test.skipIf(!hasPty)(
    "executeTerminalQuery spawns subprocess in PTY via Bun.spawn and Bun.Terminal",
    async () => {
      const result = await executeTerminalQuery("bun -v");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/1\.\d+\.\d+/);
    },
  );

  test("executeTerminalQuery supports shortcode 'p GP301' and single-token 'GP301'", async () => {
    const res1 = await executeTerminalQuery("p GP301");
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain("SPORTSDESK BEHAVIORAL PROFILE: GP301");

    const res2 = await executeTerminalQuery("GP301");
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout).toContain("SPORTSDESK BEHAVIORAL PROFILE: GP301");
  });

  test("executeTerminalQuery handles profile flags: --json, --radar, --wagers", async () => {
    const jsonRes = await executeTerminalQuery("p GP301 --json");
    expect(jsonRes.exitCode).toBe(0);
    const parsed = JSON.parse(jsonRes.stdout);
    expect(parsed.id).toBe("GP301");
    expect(parsed.score).toBe(9.6);

    const radarRes = await executeTerminalQuery("p GP301 --radar");
    expect(radarRes.exitCode).toBe(0);
    expect(radarRes.stdout).toContain("SHARPNESS RADAR DECOMPOSITION");
    expect(radarRes.stdout).toContain("CLV Alpha");
    expect(radarRes.stdout).toContain("Bayesian Skill");

    const wagersRes = await executeTerminalQuery("p GP301 --wagers");
    expect(wagersRes.exitCode).toBe(0);
    expect(wagersRes.stdout).toContain("Recent Ticket Sample for GP301");
    expect(wagersRes.stdout).toContain("KC -3.0");
  });

  test("executeTerminalQuery handles key-numbers query and shortcode 'k'", async () => {
    const result = await executeTerminalQuery("k");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("FOOTBALL KEY NUMBER BUYER COHORT");
    expect(result.stdout).toContain("GP301");
    expect(result.stdout).toContain("CCC88412");
    expect(result.stdout).toContain("+11.5¢");
  });

  test("executeTerminalQuery handles gini rankings query and shortcode 'g'", async () => {
    const result = await executeTerminalQuery("g");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("STAKE INEQUALITY GINI RANKINGS");
    expect(result.stdout).toContain("MARTINGALE_CHASER");
    expect(result.stdout).toContain("PROPORTIONAL_KELLY");
  });

  test("executeTerminalQuery handles desk directives query and shortcode 'dir'", async () => {
    const result = await executeTerminalQuery("dir");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ACTIONABLE DESK DIRECTIVES");
    expect(result.stdout).toContain("autoExecute: false");
    expect(result.stdout).toContain("ALERT_OPERATOR");
  });

  test("executeTerminalQuery handles risk forensics query and shortcode 'var'", async () => {
    const result = await executeTerminalQuery("var");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PORTFOLIO RISK FORENSICS");
    expect(result.stdout).toContain("7d VaR(95%)");
    expect(result.stdout).toContain("CVaR Shortfall");
  });

  test("executeTerminalQuery handles stats summary query and shortcode 'stat'", async () => {
    const result = await executeTerminalQuery("stat");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "SPORTSDESK PORTFOLIO PROFILING INTELLIGENCE",
    );
    expect(result.stdout).toContain("4,914 accounts");
    expect(result.stdout).toContain("counterfactual savings");
  });

  test("executeTerminalQuery handles operator session query 'who' and shortcode 'w'", async () => {
    const result = await executeTerminalQuery("w");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "SPORTSDESK OPERATOR IDENTITY & RUNTIME FORENSICS",
    );
    expect(result.stdout).toContain("Bun v1.4.4");
    expect(result.stdout).toContain("customer_wager_profiling_rating");
  });

  test("executeTerminalQuery handles keybindings cheat sheet query 'kb'", async () => {
    const result = await executeTerminalQuery("kb");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "SPORTSDESK KEYBOARD SHORTCUTS & NAVIGATION",
    );
    expect(result.stdout).toContain("Ctrl + ` / Cmd + K");
    expect(result.stdout).toContain("Tab");
  });

  test("executeTerminalQuery handles find with flags -t, -s, -a", async () => {
    const tierRes = await executeTerminalQuery("f -t elite");
    expect(tierRes.exitCode).toBe(0);
    expect(tierRes.stdout).toContain("GP301");
    expect(tierRes.stdout).toContain("TIER_1_ELITE_ORIGINATOR");

    const sportRes = await executeTerminalQuery("f -s cfb");
    expect(sportRes.exitCode).toBe(0);
    expect(sportRes.stdout).toContain("CFB");

    const actionRes = await executeTerminalQuery("f -a ALERT_OPERATOR");
    expect(actionRes.exitCode).toBe(0);
    expect(actionRes.stdout).toContain("ALERT_OPERATOR");
  });

  test("executeTerminalQuery handles rankings query and alias 'rank-all'", async () => {
    const result = await executeTerminalQuery("rank-all");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SPORTSDESK 30-DAY SHARP BETTOR RANKINGS");
    expect(result.stdout).toContain("Tier");
  });

  test("executeTerminalQuery handles conduits query", async () => {
    const result = await executeTerminalQuery("conduits");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("IDENTIFIED SUB-AGENT PROXY CONDUITS");
    expect(result.stdout).toContain("SINGLE BETTOR PROXY CONDUIT");
  });

  test("executeTerminalQuery handles subagents query and alias 'sa'", async () => {
    const result = await executeTerminalQuery("sa");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TOP SUB-AGENTS BY 30-DAY VOLUME");
    expect(result.stdout).toContain("Sub-Agent");
  });

  test("executeTerminalQuery handles bursts query and alias 'b'", async () => {
    const result = await executeTerminalQuery("b");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SYNCHRONIZED SYNDICATE STEAM BURSTS");
    expect(result.stdout).toContain("Cowboys");
  });

  test("executeTerminalQuery handles trunks query and alias 't'", async () => {
    const result = await executeTerminalQuery("t");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("TWO-TRUNK TOPOLOGY COMPARISON");
    expect(result.stdout).toContain("TRACKTHIS");
    expect(result.stdout).toContain("NOLAPPH");
  });

  test("executeTerminalQuery handles quarantine query and alias 'guard'", async () => {
    const result = await executeTerminalQuery("guard");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SYNDICATE BURST QUARANTINE ENGINE");
    expect(result.stdout).toContain("HOLD_FOR_MANUAL_REVIEW");
    expect(result.stdout).toContain("autoExecute: false");
  });

  test("executeTerminalQuery handles ws and subscriptions query", async () => {
    const result = await executeTerminalQuery("ws");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("WEBSOCKET TOPIC SUBSCRIPTIONS TELEMETRY");
    expect(result.stdout).toContain("ServerWebSocket.subscriptions");
    expect(result.stdout).toContain("live-bets");
    expect(result.stdout).toContain("syndicate-alerts");
  });
});
