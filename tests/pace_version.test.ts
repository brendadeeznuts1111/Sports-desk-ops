import { describe, expect, test } from "bun:test";

import { detectPaceVersion, inspectPace } from "../cli/info.ts";

describe("Pace version fingerprint", () => {
  test("detects 0.4.x by style='width: X%'", () => {
    const html = `<div class="pace pace-active">
      <div class="pace-progress" data-progress-text="2%" data-progress="02"
           style="width: 2.96362%;">
        <div class="pace-progress-inner"></div>
      </div>
    </div>`;
    expect(detectPaceVersion(html)).toBe("0.4.x");
  });

  test("detects 1.x by style='transform: translate3d(...)'", () => {
    const html = `<div class="pace pace-active">
      <div class="pace-progress" data-progress-text="2%" data-progress="02"
           style="transform: translate3d(2.96362%, 0px, 0px);">
        <div class="pace-progress-inner"></div>
      </div>
    </div>`;
    expect(detectPaceVersion(html)).toBe("1.x");
  });

  test("detects vendor-prefixed 1.x variants", () => {
    const html = `<div class="pace-progress"
                        style="-webkit-transform: translate3d(2%, 0px, 0px);">`;
    expect(detectPaceVersion(html)).toBe("1.x");
  });

  test("unknown when no .pace-progress", () => {
    expect(detectPaceVersion("<body></body>")).toBe("unknown");
  });

  test("bet-ticker.html is confirmed 0.4.x", async () => {
    const html = await Bun.file("tests/fixtures/bet-ticker.html").text();
    const pace = inspectPace(html);
    expect(pace.version).toBe("0.4.x");
    expect(pace.verdict).toBe("mid-load");
    expect(pace.cause).toBe("ajaxComplete-restart");
  });
});
