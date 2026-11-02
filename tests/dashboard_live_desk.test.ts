import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_SETTINGS,
  LANGUAGES,
  TIMEZONES,
} from "../lib/settings_prefs.ts";

/**
 * Static checks for the executive dashboard's Live Desk panel. No DOM in `bun:test`, so these
 * assert the wiring: parseable module script, required ids, the endpoints the panel calls, and
 * that the panel does not depend on the Telegram admin token.
 */
describe("static/customer-churn-simulation-dashboard.html", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  /** The panel's own IIFE, located by its first lookup. */
  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("live-desk")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("inline module script parses", () => {
    expect(() => new Function(moduleScript)).not.toThrow();
  });

  test("never assigns innerHTML", () => {
    expect(html).not.toContain("innerHTML");
  });

  test("declares the Live Desk hooks the panel looks up", () => {
    for (const id of [
      "live-desk",
      "ld-badge",
      "ld-stats",
      "ld-sports",
      "ld-fixtures",
      "ld-scoreboard",
      "ld-source",
      "ld-refresh",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const id of [
      "ld-badge",
      "ld-stats",
      "ld-sports",
      "ld-fixtures",
      "ld-scoreboard",
      "ld-source",
      "ld-refresh",
    ]) {
      expect(panel).toContain(id);
    }
  });

  test("reads the endpoints the scoreboard exposes", () => {
    for (const path of [
      "/api/live-bets",
      "/api/game-admin",
      "/api/sports",
      "/api/scoreboard",
    ]) {
      expect(panel).toContain(path);
    }
  });

  test("does not gate the panel on the Telegram admin token", () => {
    // On loopback these endpoints are open; anywhere else the server answers 401/503 and the
    // panel reports that explicitly instead of borrowing the bot token form.
    expect(panel).not.toContain("tokenInput");
    expect(panel).not.toContain("Authorization");
    expect(panel).toContain("TOKEN REQUIRED");
  });

  test("labels the data source instead of implying a live feed", () => {
    expect(panel).toContain("CAPTURE");
    expect(panel).toContain("SAMPLE");
    expect(panel).toContain("transcribed");
  });

  test("polls only while visible and sends no cache directive", () => {
    expect(panel).toContain('document.visibilityState === "visible"');
    expect(panel).toContain('cache: "no-store"');
  });
});

describe("Analysis panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("an-form")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("renders the portal's four filter controls plus the agent search", () => {
    for (const id of [
      "analysis",
      "an-form",
      "an-report",
      "an-activity",
      "an-group",
      "an-week",
      "an-agent",
      "an-result",
      "an-badge",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("loads the vocabulary from the server instead of hard-coding it twice", () => {
    expect(panel).toContain("/api/analysis/filters");
    expect(panel).toContain("/api/analysis?");
    // No option labels are duplicated in the page; the endpoint is the single source.
    expect(html).not.toContain("Customer Volume</option>");
  });

  test("reports the uncaptured report instead of showing an empty grid", () => {
    expect(panel).toContain("501");
    expect(panel).toContain("NOT CAPTURED");
    expect(panel).toContain("requiredCapture");
  });

  test("surfaces validation errors as a rejection, not a pass", () => {
    expect(panel).toContain("INVALID");
    expect(panel).toContain("issues");
  });
});

describe("Sport catalog panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("sc-list")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("declares the catalog hooks and loads them from the endpoint", () => {
    for (const id of [
      "sport-catalog",
      "sc-badge",
      "sc-list",
      "sc-count",
      "sc-search",
      "sc-expand",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(panel).toContain("/api/sports/catalog");
  });

  test("renders sub-sport codes and per-sport period menus", () => {
    expect(panel).toContain("Sub-sports (code)");
    expect(panel).toContain("Periods (number → name)");
    expect(panel).toContain("sub.code");
    expect(panel).toContain("period.number");
  });

  test("warns about sub-sport codes shared by several sports", () => {
    expect(panel).toContain("collision");
    expect(panel).toContain("Code shared by");
  });

  test("does not hard-code a global period number mapping", () => {
    // A number→name table in the page would mislabel Hockey/Basketball/Baseball periods.
    expect(panel).not.toContain("1st Half");
    expect(panel).not.toContain("1st Quarter");
  });
});

describe("Settings panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  test("renders the modal's four controls", () => {
    for (const id of [
      "settings",
      "st-badge",
      "st-notify",
      "st-language",
      "st-timezone",
      "st-agent-menu",
      "st-save",
      "st-reset",
      "st-status",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-setting="notify"');
    expect(html).toContain('data-setting="agentMenu"');
  });

  test("keeps the portal's option values", () => {
    expect(html).toMatch(/<option value="Y">On<\/option>/);
    expect(html).toMatch(/<option value="N">Off<\/option>/);
    expect(html).toMatch(/<option value="Chinese \(Simp\)">/);
    expect(html).toMatch(/<option value="3">\(PST\)<\/option>/);
    expect(html).toMatch(/<option value="Tile Menu">/);
  });

  test("applies the time zone to rendered timestamps", () => {
    // A stored preference that changes nothing would make the panel lie.
    expect(moduleScript).toContain("function sdFormatTs");
    expect(moduleScript).toContain("captured ${sdFormatTs(");
    expect(moduleScript).toContain("transcribed ${sdFormatTs(");
    expect(moduleScript).toContain("SD_ZONES");
  });

  test("refreshes panels when settings are saved", () => {
    expect(
      moduleScript.match(/new Event\("sportsdesk-settings"\)/g)?.length,
    ).toBe(2);
    // Live Desk, the ticker and the KPI strip.
    expect(
      moduleScript.match(/addEventListener\("sportsdesk-settings", load\)/g)
        ?.length,
    ).toBe(3);
  });

  test("the KPI strip is derived from /api/kpis, not typed into the markup", () => {
    expect(moduleScript).toContain('authed("/api/kpis"');
    for (const name of ["agents", "pending", "ticker", "customerBook"]) {
      expect(html).toContain(`data-kpi="${name}"`);
    }
    const grid = html.slice(
      html.indexOf('id="kpi-grid"'),
      html.indexOf('<main id="panels"'),
    );
    expect(grid.length).toBeGreaterThan(0);
    // The retired literals traced to no capture.
    for (const literal of ["668 Agents", "9,435", "$2.79M", "$10.49M"]) {
      expect(grid).not.toContain(literal);
    }
  });

  test("says which preferences do not change the UI", () => {
    expect(moduleScript).toContain("No strings are translated yet");
    expect(moduleScript).toContain("does not follow US daylight saving");
  });

  test("hides alert dispatch when Wager Alerts is off", () => {
    expect(moduleScript).toContain('settings.notify === "N"');
    expect(moduleScript).toContain('data-action="alert"');
  });
});

describe("Analysis report table", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  test("offers stored reports and a sport filter", () => {
    expect(html).toContain('id="an-stored"');
    expect(html).toContain('id="an-sport"');
    expect(moduleScript).toContain("/api/analysis/reports");
  });

  test("sends the sport with the selection", () => {
    expect(moduleScript).toContain('params.set("sport", sport)');
  });

  test("renders rows, totals and the duplicate marker", () => {
    expect(moduleScript).toContain("an-table");
    expect(moduleScript).toContain("an-dup");
    expect(moduleScript).toContain("body.totals.holdPercent");
  });

  test("surfaces a totals discrepancy rather than hiding it", () => {
    expect(moduleScript).toContain("Totals disagree with the rows in");
    expect(moduleScript).toContain("match the published figures");
  });

  test("fills the form from a report's recorded context", () => {
    expect(moduleScript).toContain("applyStoredContext");
    expect(moduleScript).toContain("context.agent");
  });
});

describe("Live wager ticker panel", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const moduleScript = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((b) => (b[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const panel = (() => {
    const start = moduleScript.indexOf('document.getElementById("lw-rows")');
    expect(start).toBeGreaterThan(-1);
    const end = moduleScript.indexOf("})();", start);
    return moduleScript.slice(start, end === -1 ? undefined : end);
  })();

  test("declares the ticker hooks", () => {
    for (const id of [
      "live-wagers",
      "lw-badge",
      "lw-note",
      "lw-stats",
      "lw-writers",
      "lw-types",
      "lw-rows",
      "lw-count",
      "lw-risk",
      "lw-volume",
      "lw-mismatch",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("reads the ticker endpoint and handles its empty state", () => {
    expect(panel).toContain("/api/live-wagers");
    expect(panel).toContain("NOT CAPTURED");
    expect(panel).toContain("data/live-wagers.json");
    expect(panel).toContain("bun run capture:bet-ticker");
  });

  test("says whether the ticker is a capture or a paste, and keeps polling", () => {
    expect(html).toContain("Live Wagers — Bet Ticker");
    expect(panel).toContain('"CAPTURE"');
    expect(panel).toContain('"PASTE"');
    expect(panel).toMatch(/setInterval\([\s\S]*?loadLiveWagers\(\)/);
  });

  test("flags a volume mismatch instead of hiding it", () => {
    expect(panel).toContain("volumeDiffers");
    expect(panel).toContain("lw-vol");
  });

  test("renders one cell per declared column", () => {
    // Nine headers; the Legs cell carries the count and the first leg's label together.
    const headerCount = (html.match(/<th scope="col">/g) ?? []).length;
    expect(headerCount).toBeGreaterThanOrEqual(9);
    expect(panel).toContain("legCell");
    expect(panel).not.toContain('tr.append(make("td", "", ""))');
  });

  test("offers writer and type filters", () => {
    expect(panel).toContain("buildBars");
    expect(panel).toContain("byWriter");
    expect(panel).toContain("byType");
  });

  test("labels a partial list as partial, in the file's own words", () => {
    // A count of 17 must not read as "the ticker showed 17".
    expect(panel).toContain("PARTIAL");
    expect(panel).toContain("provenance.partial");
    expect(panel).toContain("provenance.captureNote");
    expect(panel).toContain("provenance.source");
    // The note comes from the server, not from a sentence invented in the browser.
    expect(panel).not.toContain("subset of the shown list");
  });

  test("an empty refresh replaces the previous rows", () => {
    // render() used to return early on an empty list, leaving old rows under stats saying 0.
    const render = panel.slice(
      panel.indexOf("const render = () => {"),
      panel.indexOf("const loadLiveWagers"),
    );
    expect(render.length).toBeGreaterThan(0);
    expect(render).not.toContain("if (all.length === 0) return");
    expect(render.indexOf("list.replaceChildren()")).toBeLessThan(
      render.indexOf("for (const wager of rows)"),
    );
    expect(render).toContain("No wagers in this list.");
    expect(render).toContain("No wager matches this filter.");
  });

  test("marks a stale capture as stale, in the KPI strip's wording", () => {
    expect(panel).toContain("body.freshness");
    expect(panel).toContain("freshness?.stale === true");
    expect(panel).toContain('...(stale ? ["STALE"] : [])');
    expect(panel).toContain("!provenance.partial && !stale");
    expect(panel).toContain('"file written"');
    // The server sends no age (it would defeat the body cache); the page derives it from asOf.
    expect(panel).toContain("Date.parse(freshness?.asOf");
    expect(panel).toContain("sdAge(ageSeconds)");
    expect(panel).toContain('one-off ${captured ? "capture" : "paste"}');
    // One age formatter shared by the ticker and the KPI strip.
    expect((moduleScript.match(/function sdAge\(/g) ?? []).length).toBe(1);
    expect(moduleScript).not.toContain("const age = ");
  });

  test("a successful load resets the note instead of keeping an old error", () => {
    expect(panel).toContain("defaultNote");
    expect(panel).toContain(
      'parts.length === 0 ? defaultNote : parts.join(" ")',
    );
  });

  test("keeps alert and blocked rows visible but de-emphasised and out of totals", () => {
    expect(html).toMatch(/\.lw-noise td\s*\{[^}]*var\(--sd-text-muted\)/);
    expect(panel).toContain('tr.className = "lw-noise"');
    expect(panel).toContain("excluded from the totals");
    expect(panel).toContain("alert:");
    expect(panel).toContain("blocked:");
    expect(html).toContain('id="lw-excluded"');
    expect(panel).toContain("summaryData.counted");
    expect(panel).toContain("`${counted} of ${total} rows`");
    expect(panel).toContain("usd(excluded.risk)");
  });

  test("names rejected source files in the note, not the normal older one", () => {
    expect(panel).toContain("body.skipped");
    expect(panel).toContain("entry.path");
    expect(panel).toContain("entry.reason");
    expect(panel).toContain('!entry.reason.startsWith("older than")');
  });

  test("every failed load clears the previous rows and totals", () => {
    const load = panel.slice(
      panel.indexOf("const loadLiveWagers"),
      panel.indexOf('addEventListener("sportsdesk-settings", loadLiveWagers)'),
    );
    const clear = panel.slice(
      panel.indexOf("const clearPanel"),
      panel.indexOf("const loadLiveWagers"),
    );
    expect(clear).toContain("all = []");
    expect(clear).toContain("stats.hidden = true");
    expect(clear).toContain("list.replaceChildren(tr)");
    // 404, missing token, and a thrown fetch or parse.
    expect(load.match(/clearPanel\(/g)?.length).toBe(3);
  });
});

describe("KPI ticker card", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  test("says how many alert/blocked rows the wager count excludes", () => {
    const strip = html.slice(
      html.indexOf('authed("/api/kpis"'),
      html.indexOf("No bet ticker. Run bun run capture:bet-ticker."),
    );
    expect(strip).toContain("ticker.excludedRows > 0");
    expect(strip).toContain("alert/blocked excluded");
  });
});

describe("Settings vocabulary drift", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  /** Pulls `const NAME = { ... };` out of the inline script and evaluates the literal. */
  const literal = (name: string): unknown => {
    const start = html.indexOf(`const ${name} = {`);
    if (start === -1) throw new Error(`settings literal ${name} not found`);
    const open = html.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < html.length; i++) {
      if (html[i] === "{") depth += 1;
      else if (html[i] === "}") {
        depth -= 1;
        if (depth === 0)
          return new Function(`return ${html.slice(open, i + 1)}`)();
      }
    }
    throw new Error(`settings literal ${name} is unterminated`);
  };

  test("the panel's timezone table matches lib/settings_prefs.ts", () => {
    // The dashboard carries its own copy because the page cannot import the module; this pins
    // the copy to the tested vocabulary so the two cannot drift apart silently.
    const inline = literal("ZONES") as Record<
      string,
      { label: string; offset: number }
    >;
    const expected = Object.fromEntries(
      TIMEZONES.map((zone) => [
        zone.value,
        { label: zone.label, offset: zone.offsetHours },
      ]),
    );
    expect(inline).toEqual(expected);
  });

  test("the panel's language table matches lib/settings_prefs.ts", () => {
    const inline = literal("LANGS") as Record<string, string>;
    const expected = Object.fromEntries(
      LANGUAGES.map((language) => [language.value, language.lang]),
    );
    expect(inline).toEqual(expected);
  });

  test("the panel's defaults match lib/settings_prefs.ts", () => {
    expect(literal("DEFAULTS")).toEqual({ ...DEFAULT_SETTINGS });
  });
});

describe("dashboard layout shell", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  test("there is exactly one main element, and it is the panel container", () => {
    // It used to be missing: the CSS said `main.tiles { … }` and the settings script called
    // querySelector("main"), so the Agent Menu choice resolved to null and changed nothing.
    const opens = (html.match(/<main[\s>]/g) ?? []).length;
    const closes = (html.match(/<\/main>/g) ?? []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
    expect(html).toMatch(/<main id="panels" class="panels">/);
  });

  test("the Agent Menu toggle has a real target", () => {
    // Guards the regression directly: the script asks for "main", so the markup must have one.
    expect(html).toContain('document.querySelector("main")');
    expect(html).toContain('classList.toggle("tiles"');
    expect((html.match(/<main[\s>]/g) ?? []).length).toBe(1);
  });

  test("tile mode is an explicit two-column grid", () => {
    // Explicit, not auto-fit: `grid-column: 1 / -1` resolves against explicit lines, and with
    // implicit tracks it silently spanned one column while the badge said TILES.
    expect(html).toMatch(/main\.tiles\s*\{[^}]*display:\s*grid/);
    expect(html).toMatch(
      /main\.tiles\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
    );
    expect(html).toContain("@media (max-width: 1100px)");
  });

  test("tile mode scrolls tables inside their card instead of leaving gaps", () => {
    // Full-width exceptions were tried: every full-width panel left an empty half-row beside the
    // previous one, so each card scrolls its own table instead.
    expect(html).toMatch(
      /main\.tiles > \.section-card\s*\{[^}]*overflow-x:\s*auto/,
    );
    expect(html).not.toContain("main.tiles > #live-wagers");
  });

  test("the panel stack is a grid in both modes, not a margin stack", () => {
    expect(html).toMatch(/\.panels\s*\{[^}]*display:\s*grid/);
    expect(html).toMatch(
      /\.panels\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  test("every --sd-* token used is declared in :root", () => {
    // The token gate exists because a made-up custom property renders as nothing at all.
    const rootBlock = /:root\s*\{([\s\S]*?)\n      \}/.exec(html)?.[1] ?? "";
    const declared = new Set(
      [...rootBlock.matchAll(/(--sd-[a-z0-9-]+)\s*:/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    const used = new Set(
      [...html.matchAll(/var\((--sd-[a-z0-9-]+)\)/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    expect(declared.size).toBeGreaterThan(10);
    const undeclared = [...used].filter((name) => !declared.has(name));
    expect(undeclared).toEqual([]);
  });
});

describe("money formatting", () => {
  const html = readFileSync(
    resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    ),
    "utf8",
  );

  const script = (() => {
    const blocks = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    const inline = blocks.find((block) => (block[1] ?? "").trim().length > 0);
    if (inline?.[1] === undefined) throw new Error("no inline script block");
    return inline[1];
  })();

  const usd = (() => {
    const source = /function usd\(cents\) \{[\s\S]*?\n {6}\}/.exec(script)?.[0];
    if (source === undefined) throw new Error("usd() not found");
    return new Function(`${source}; return usd;`)() as (
      cents: number,
    ) => string;
  })();

  test("there is one definition, not four", () => {
    // It was copied into four panels with two different bodies; the copies drifted.
    expect((script.match(/const usd = \(cents\)/g) ?? []).length).toBe(0);
    expect((script.match(/function usd\(cents\)/g) ?? []).length).toBe(1);
  });

  test("keeps exact cents below $100,000", () => {
    // The ticker's risk total is $1,066.55. It used to render as "$1K": one significant digit for
    // an operational figure, which is precisely the abbreviation this desk is meant to avoid.
    expect(usd(106_655)).toBe("$1,066.55");
    expect(usd(21_600)).toBe("$216.00");
    expect(usd(7_277)).toBe("$72.77");
    expect(usd(9_999_999)).toBe("$99,999.99");
  });

  test("compacts above $100,000, keeping one decimal of thousands", () => {
    expect(usd(10_000_000)).toBe("$100.0K");
    expect(usd(10_665_500)).toBe("$106.7K");
  });

  test("uses two decimals of millions, and keeps the sign outside the dollar", () => {
    expect(usd(279_000_000)).toBe("$2.79M");
    expect(usd(-500_000)).toBe("-$5,000.00");
  });

  test("renders zero as money, not as an empty cell", () => {
    expect(usd(0)).toBe("$0.00");
  });
});
