import { describe, expect, test } from "bun:test";

import { detectPhase, externalDeps, inspectPace } from "../cli/info.ts";

describe("capture phase", () => {
  test("login-form page classified as pre-auth", () => {
    const html = `<form data-security="form">
      <input data-field="user"><input data-field="pass">
    </form>`;
    expect(detectPhase(html)).toBe("login-form");
  });

  test("bet-ticker page classified as authenticated", () => {
    const html = `<div data-action="get-bet-ticker"></div>
                  <div class="pace pace-active"></div>`;
    expect(detectPhase(html)).toBe("authenticated");
  });

  test("no clear signals → unknown", () => {
    expect(detectPhase("<body></body>")).toBe("unknown");
  });
});

describe("Pace refresh baseline", () => {
  test("37-minute span implies 7 five-minute renewals", () => {
    const html = `<body class="pace-running">
      <div class="pace pace-active"><div class="pace-progress" style="width: 2%;"></div></div>
    </body>`;
    const pace = inspectPace(html, 37 * 60_000);
    expect(pace.refreshBaseline).toBe(7);
  });

  test("without a time span the baseline is unknown", () => {
    expect(
      inspectPace(
        '<body class="pace-running"><div class="pace pace-active"><div class="pace-progress" style="width: 2%;"></div></div></body>',
      ).refreshBaseline,
    ).toBeNull();
  });
});

describe("external dependencies", () => {
  test("groups iframes, scripts and stylesheets by origin", () => {
    const html = `
      <iframe src="https://captcha.sportswidgets.pro/cloud/c-render.php?section=0"></iframe>
      <script src="https://cdn.fastassets.io/a.js"></script>
      <script src="https://cdn.fastassets.io/b.js"></script>
      <link rel="stylesheet" href="https://cdn.fastassets.io/x.css">
    `;
    const deps = externalDeps(html);
    expect(deps).toEqual([
      { origin: "https://cdn.fastassets.io", kind: "script", count: 3 },
      {
        origin: "https://captcha.sportswidgets.pro",
        kind: "iframe",
        count: 1,
      },
    ]);
  });
});
