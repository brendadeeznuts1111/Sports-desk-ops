import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  extractExternalAssets,
  normalizeAssetUrl,
} from "../lib/f402_cdn_assets.ts";
import {
  appModuleCoverage,
  appModuleUrl,
  extractAmdModuleIds,
  loadCdnManifest,
  parseCdnManifest,
  pinnedAssetFetchUrl,
  sriFor,
} from "../lib/f402_cdn_pin.ts";
import type { CdnAssetPin, CdnManifest } from "../lib/f402_cdn_pin.ts";
import { applySriToHtml, findSriIssues } from "../lib/f402_sri.ts";

const ROOT = join(import.meta.dir, "..");
const EMPTY_SRI =
  "sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb";

function pin(overrides: Partial<CdnAssetPin> = {}): CdnAssetPin {
  return {
    sha256: "0".repeat(64),
    sri: EMPTY_SRI,
    sriEnforceable: true,
    bytes: 0,
    role: "portal-js",
    source: "document",
    sameOrigin: false,
    externalReferences: [],
    etag: null,
    lastModified: null,
    fetchedAt: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(assets: Record<string, CdnAssetPin>): CdnManifest {
  return {
    schemaVersion: 1,
    host: "www.fantasy402.com",
    documentUrl: "https://www.fantasy402.com/manager.html",
    pinnedAt: "2026-11-03T00:00:00.000Z",
    vendorVersion: "1.0.280",
    assets,
  };
}

describe("sriFor", () => {
  test("matches the published sha384 of an empty response", async () => {
    expect(await sriFor(new Uint8Array(0))).toBe(EMPTY_SRI);
  });
});

describe("extractExternalAssets", () => {
  test("keeps scripts and stylesheets, distinguishes less, skips inline/preload/protocol-relative", () => {
    const html = [
      '<script src="https://a.example/x.js"></script>',
      '<link rel="stylesheet" href="https://a.example/x.css">',
      '<link rel="stylesheet/less" href="https://a.example/x.less?v=1">',
      '<link rel="preload" as="script" href="https://a.example/pre.js">',
      "<script>inline()</script>",
      '<script src="//a.example/proto.js"></script>',
    ].join("\n");

    const refs = extractExternalAssets(html);
    expect(refs.map((ref) => ref.kind)).toEqual([
      "script",
      "stylesheet",
      "stylesheet-less",
    ]);
    expect(refs.map((ref) => ref.line)).toEqual([1, 2, 3]);
  });

  test("dedupes by URL unless asked not to", () => {
    const html =
      '<script src="https://a.example/x.js"></script><script src="https://a.example/x.js"></script>';
    expect(extractExternalAssets(html)).toHaveLength(1);
    expect(extractExternalAssets(html, { dedupe: false })).toHaveLength(2);
  });
});

describe("normalizeAssetUrl", () => {
  test("redacts credential-bearing query values", () => {
    const normalized = normalizeAssetUrl(
      "https://maps.googleapis.com/maps/api/js?v=3.exp&key=AIza-not-a-real-key",
    );
    expect(normalized).toContain("v=3.exp");
    expect(normalized).toContain("key=%3Credacted%3E");
    expect(normalized).not.toContain("AIza");
  });

  test("keeps vendor cache-busts, which are drift signals", () => {
    expect(
      normalizeAssetUrl("https://cdn.example/css/manager.less?v=103"),
    ).toContain("v=103");
  });
});

describe("findSriIssues", () => {
  const url = "https://cdn.example/x.js";

  test("accepts a pinned tag with the manifest hash and crossorigin", () => {
    const html = `<script src="${url}" integrity="${EMPTY_SRI}" crossorigin="anonymous"></script>`;
    expect(findSriIssues(html, manifest({ [url]: pin() }))).toEqual([]);
  });

  test("rejects an unpinned external asset", () => {
    const html = `<script src="${url}"></script>`;
    expect(findSriIssues(html, manifest({}))).toHaveLength(1);
    expect(findSriIssues(html, manifest({}))[0]?.message).toContain(
      "not pinned",
    );
  });

  test("rejects a missing or wrong integrity value", () => {
    const missing = `<script src="${url}" crossorigin="anonymous"></script>`;
    expect(
      findSriIssues(missing, manifest({ [url]: pin() }))[0]?.message,
    ).toContain("missing integrity");

    const wrong = `<script src="${url}" integrity="sha384-wrong" crossorigin="anonymous"></script>`;
    expect(
      findSriIssues(wrong, manifest({ [url]: pin() }))[0]?.message,
    ).toContain("does not match");
  });

  test("requires crossorigin=anonymous for SRI on a cross-origin asset", () => {
    const html = `<script src="${url}" integrity="${EMPTY_SRI}"></script>`;
    expect(
      findSriIssues(html, manifest({ [url]: pin() }))[0]?.message,
    ).toContain("crossorigin");
  });

  test("does not require integrity on rel=stylesheet/less", () => {
    const lessUrl = "https://cdn.example/x.less?v=1";
    const html = `<link rel="stylesheet/less" href="${lessUrl}">`;
    expect(
      findSriIssues(html, manifest({ [lessUrl]: pin({ role: "portal-css" }) })),
    ).toEqual([]);
    expect(findSriIssues(html, manifest({}))).toHaveLength(1);
  });

  test("rejects integrity on an origin that sends no ACAO (the browser would block it)", () => {
    const maps = normalizeAssetUrl(
      "https://maps.googleapis.com/maps/api/js?v=3.exp&key=secret",
    );
    const unpinnedTag = `<script src="https://maps.googleapis.com/maps/api/js?v=3.exp&key=secret"></script>`;
    expect(
      findSriIssues(
        unpinnedTag,
        manifest({ [maps]: pin({ sriEnforceable: false }) }),
      ),
    ).toEqual([]);

    const signedTag = `<script src="https://maps.googleapis.com/maps/api/js?v=3.exp&key=secret" integrity="${EMPTY_SRI}" crossorigin="anonymous"></script>`;
    expect(
      findSriIssues(
        signedTag,
        manifest({ [maps]: pin({ sriEnforceable: false }) }),
      )[0]?.message,
    ).toContain("will block");
  });
});

describe("applySriToHtml", () => {
  test("signs eligible tags from the manifest and leaves less alone", () => {
    const script = "https://cdn.example/x.js";
    const lessUrl = "https://cdn.example/x.less?v=1";
    const html = [
      `<script src="${script}"></script>`,
      `<link rel="stylesheet/less" href="${lessUrl}">`,
    ].join("\n");

    const result = applySriToHtml(
      html,
      manifest({
        [script]: pin(),
        [lessUrl]: pin({ role: "portal-css" }),
      }),
    );

    expect(result.applied).toEqual([script]);
    expect(result.html).toContain(`integrity="${EMPTY_SRI}"`);
    expect(result.html).toContain('crossorigin="anonymous"');
    expect(result.html).toContain(`href="${lessUrl}"`);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      "SRI is not honoured on rel=stylesheet/less",
    ]);
  });

  test("replaces an existing integrity value instead of duplicating it", () => {
    const script = "https://cdn.example/x.js";
    const html = `<script src="${script}" integrity="sha384-stale" crossorigin="anonymous"></script>`;
    const result = applySriToHtml(html, manifest({ [script]: pin() }));
    expect(result.html.match(/integrity=/g)).toHaveLength(1);
    expect(result.html).not.toContain("sha384-stale");
  });
});

describe("app module graph", () => {
  test("extracts AMD module ids from define and require arrays, skipping plugin resources", () => {
    const js =
      'define(["core/class","ui/ui"],function(a,b){});' +
      'require(["manager/module/bet-ticker","text!x.html"],function(c,d){});';
    expect(extractAmdModuleIds(js)).toEqual([
      "core/class",
      "manager/module/bet-ticker",
      "ui/ui",
    ]);
  });

  test("resolves app module URLs and rejects traversal or foreign paths", () => {
    expect(appModuleUrl("www.fantasy402.com", "manager/manager")).toBe(
      "https://www.fantasy402.com/app/manager/manager.js",
    );
    expect(appModuleUrl("www.fantasy402.com", "/app/setting/version.js")).toBe(
      "https://www.fantasy402.com/app/setting/version.js",
    );
    expect(appModuleUrl("www.fantasy402.com", "../evil")).toBeNull();
    expect(appModuleUrl("www.fantasy402.com", "/elsewhere.js")).toBeNull();
  });

  test("flags app modules the controller requires but the manifest does not pin", () => {
    const host = "www.fantasy402.com";
    const managerJs = 'require(["manager/module/bet-ticker"]);';
    const pinnedManager = appModuleUrl(host, "manager/manager");
    expect(pinnedManager).not.toBeNull();
    const base = manifest({});
    if (pinnedManager === null) return;
    const checkerUrl = appModuleUrl(host, "manager/module/bet-ticker");
    expect(checkerUrl).not.toBeNull();
    expect(appModuleCoverage(managerJs, base)).toContain(checkerUrl ?? "");
    expect(appModuleCoverage(managerJs, base)).toContain(pinnedManager);

    const covered = manifest({
      [pinnedManager]: pin({ source: "app", sameOrigin: true }),
      [appModuleUrl(host, "manager/module/bet-ticker") ?? ""]: pin({
        source: "app",
        sameOrigin: true,
      }),
    });
    // Boot modules remain unpinned in this minimal fixture; the two required files are covered.
    expect(
      appModuleCoverage(managerJs, covered).filter(
        (url) => url === pinnedManager || url.endsWith("bet-ticker.js"),
      ),
    ).toEqual([]);
  });

  test("covers variable-selected dynamic modules the AMD literal scan cannot see", () => {
    const host = "www.fantasy402.com";
    // The controller chooses these through a variable, so extractAmdModuleIds misses them.
    const managerJs =
      'var a="manager/module/weekly-figure";"thin"===t.type&&(a="manager/module/weekly-figure-thin");require([a]);';
    const base = manifest({});
    expect(extractAmdModuleIds(managerJs)).toEqual([]);
    expect(appModuleCoverage(managerJs, base)).toContain(
      appModuleUrl(host, "manager/module/weekly-figure") ?? "",
    );
    expect(appModuleCoverage(managerJs, base)).toContain(
      appModuleUrl(host, "manager/module/weekly-figure-thin") ?? "",
    );
  });

  test("only same-origin app pins get the AMD bust query", () => {
    const cdn = pin();
    const app = pin({ source: "app", sameOrigin: true });
    expect(
      pinnedAssetFetchUrl("https://cdn.example/x.js", cdn, "1.0.281"),
    ).toBe("https://cdn.example/x.js");
    expect(
      pinnedAssetFetchUrl(
        "https://www.fantasy402.com/app/manager/manager.js",
        app,
        "1.0.281",
      ),
    ).toBe("https://www.fantasy402.com/app/manager/manager.js?bust=1.0.281");
  });
});

describe("pinned repository manifest", () => {
  test("parses, covers every asset the tracked pages load, and enforces SRI", async () => {
    const pinned = await loadCdnManifest();
    expect(Object.keys(pinned.assets).length).toBeGreaterThan(0);

    for (const page of [
      "static/customer-churn-simulation-dashboard.html",
      "static/telegram-miniapp-dashboard.html",
    ]) {
      const html = await Bun.file(join(ROOT, page)).text();
      expect(findSriIssues(html, pinned)).toEqual([]);
    }
  });

  test("fails closed on a malformed pin", () => {
    expect(() =>
      parseCdnManifest(
        {
          schemaVersion: 1,
          host: "h",
          documentUrl: "https://h/manager.html",
          pinnedAt: "t",
          assets: { "https://h/x.js": { sha256: "not-hex" } },
        },
        "test",
      ),
    ).toThrow();
  });
});
