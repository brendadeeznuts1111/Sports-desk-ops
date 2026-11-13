import { describe, expect, test } from "bun:test";
import {
  GSLIVE_OPENAPI_EXTENSION,
  renderGSLiveDocsMarkdown,
} from "../lib/gslive_api_docs.ts";
import {
  GSLIVE_MANAGER_ORIGIN,
  GSLIVE_PARTNER_ID,
} from "../lib/gslive_manager_watchlist.ts";

const extension = GSLIVE_OPENAPI_EXTENSION["x-sportsdesk-gslive"];
const surfaces = extension.surfaces;
const report = surfaces.find((surface) => surface.id === "users-report")!;
const calc = surfaces.find((surface) => surface.id === "bet-history-calctime")!;
const bet = surfaces.find((surface) => surface.id === "bet-history-bettime")!;

describe("GSLIVE_OPENAPI_EXTENSION", () => {
  test("identifies the console and its provenance", () => {
    expect(extension.provider).toBe("GSLive Manager (Partner 118)");
    expect(extension.kind).toBe("operator-deep-links-not-wire-operations");
    expect(extension.origin).toBe(GSLIVE_MANAGER_ORIGIN);
    expect(extension.origin).toBe("https://plive.sportswidgets.pro");
    expect(extension.managerPath).toBe("/manager-tools/");
    expect(extension.partnerId).toBe(Number(GSLIVE_PARTNER_ID));
    expect(extension.partnerId).toBe(118);
    expect(extension.cli).toBe("./bin/dx gslive <LOGIN>");
    expect(extension.contractDoc).toBe("docs/gs-manager-contracts.md");
  });

  test("declares the three operator surfaces", () => {
    expect(surfaces.map((surface) => surface.id)).toEqual([
      "users-report",
      "bet-history-calctime",
      "bet-history-bettime",
    ]);
    expect(report.route).toBe("#/reports/users");
    expect(calc.route).toBe("#/events/bet-history");
    expect(bet.route).toBe("#/events/bet-history");
    expect(report.windows).toEqual(["today", "7d", "14d", "churn"]);
  });

  test("documents the mandatory account-report query", () => {
    expect(report.requiredQuery).toMatchObject({
      bot: "true",
      eventId: "",
      partnerId: "118",
      searchBy: "player",
      text: "player_<LOGIN>",
    });
    expect(report.requiredQuery.from).toBe("<desk-day start, ISO-8601 UTC>");
    expect(report.notes.join(" ")).toContain("bot=true is mandatory");
  });

  test("documents the epoch-second bet-history window and cache-buster", () => {
    for (const surface of [calc, bet]) {
      expect(surface.requiredQuery).toMatchObject({
        minVolume: "0",
        maxTimeUntilScore: "0",
        from: "<desk-day start, epoch seconds>",
        to: "<desk-day start, epoch seconds>",
        toTime: "<desk day length - 1: 86399, or 89999/82799 on DST days>",
      });
    }
    expect(calc.requiredQuery.dateFilterBy).toBe("calcTime");
    expect(bet.requiredQuery.dateFilterBy).toBe("betTime");
  });

  test("publishes example links built from the console origin", () => {
    for (const surface of surfaces) {
      expect(
        surface.example.startsWith(
          `${GSLIVE_MANAGER_ORIGIN}${extension.managerPath}#/`,
        ),
      ).toBe(true);
    }
    expect(report.example).toContain("#/reports/users?");
    expect(report.example).toContain("bot=true");
    expect(report.example).toContain("partnerId=118");
    expect(report.example).toContain("text=player_CHURN_003");
    expect(report.example).toContain("from=2026-10-18T05%3A00%3A00.000Z");
    expect(calc.example).toContain("dateFilterBy=calcTime");
    expect(calc.example).toContain("from=1793422800");
    expect(calc.example).toContain("toTime=86399");
    expect(calc.example).toContain("t=1793469958152");
    expect(bet.example).toContain("dateFilterBy=betTime");
  });
});

describe("renderGSLiveDocsMarkdown", () => {
  const markdown = renderGSLiveDocsMarkdown();

  test("starts with the operator heading and disclaims server status", () => {
    expect(
      markdown.startsWith(
        "## GSLive Manager (Partner 118): operator deep links\n",
      ),
    ).toBe(true);
    expect(markdown).toContain("**not** a server of this API");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  test("does not fabricate a wire route", () => {
    expect(markdown).not.toContain("ajax.php");
    expect(markdown).not.toContain("x-\u0000");
  });

  test("renders the surface table and the account-report rules", () => {
    expect(markdown).toContain(
      "| Account report (batch) | `#/reports/users` |",
    );
    expect(markdown).toContain(
      "| Live settling stream (`calcTime`) | `#/events/bet-history` |",
    );
    expect(markdown).toContain(
      "| Live placement stream (`betTime`) | `#/events/bet-history` |",
    );
    expect(markdown).toContain("`bot=true` is mandatory");
    expect(markdown).toContain(
      "`searchBy=player` and `text=player_<LOGIN>`; `partnerId=118`",
    );
  });

  test("renders the bet-history rules including DST offsets", () => {
    expect(markdown).toContain("**epoch seconds**");
    expect(markdown).toContain(
      "`86399`, or `89999`/`82799` on US DST transition days",
    );
    expect(markdown).toContain("`t` is an epoch-millisecond cache-buster");
    expect(markdown).toContain("**unverified** as a server-side filter");
  });

  test("embeds every example, including the per-player variant", () => {
    for (const surface of surfaces) expect(markdown).toContain(surface.example);
    expect(markdown).toContain("Per-player variant (adds `partnerUserId`)");
    expect(markdown).toContain("partnerUserId=CHURN_003");
  });

  test("links the contract and runbook documentation", () => {
    expect(markdown).toContain("docs/gs-manager-contracts.md");
    expect(markdown).toContain(
      "docs/OPERATOR_QUICKSTART_AND_10_MODE_RUNBOOK.md",
    );
  });
});
