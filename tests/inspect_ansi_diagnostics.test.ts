/**
 * @file tests/inspect_ansi_diagnostics.test.ts
 * @description Pins the measured Bun 1.4.4 route/request surfaces the diagnostic cards depend on:
 * `MatchedRoute.query` is params-merged, `filePath` is absolute, `pathname` carries the decoded
 * query string, raw getters hand back the same mutable object, `depth: 0` selects the shallow
 * formatter branch, and each visibility tier masks paths, addresses and identities differently.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { BunRequest } from "bun";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunRequestDiagnostic,
  MatchedRouteDiagnostic,
  inspectBunImageAsset,
  maskAssetSource,
  splitRouteQuery,
  wrapMatchedRouteDiagnostic,
  type DiagnosticRequest,
} from "../lib/inspect_diagnostics.ts";
import { scanBunImageAssets } from "../lib/bun_image_assets.ts";
import {
  redactDiagnosticSurface,
  runWithInspectVisibility,
  sanitizeRouteRecord,
} from "../lib/inspect_redactor.ts";
import { png1x1 } from "./support/image_fixtures.ts";

type InspectOptions = NonNullable<Parameters<typeof Bun.inspect>[1]>;

/**
 * `@types/bun` 1.4.4 types `depth` as `number | undefined`, while the runtime accepts `null` and
 * clamps it to its internal maximum (measured: the formatter receives 8). The cast keeps the
 * documented call in the test instead of substituting an arbitrary depth number.
 */
function inspectUnbounded(
  value: unknown,
  options: { readonly colors?: boolean; readonly showHidden?: boolean } = {},
): string {
  return Bun.inspect(value, {
    ...options,
    depth: null,
  } as unknown as InspectOptions);
}

const dir = mkdtempSync(join(tmpdir(), "sd-route-diag-"));
const realDir = realpathSync(dir);
mkdirSync(join(dir, "modes", "[0]", "[slug]"), { recursive: true });
writeFileSync(
  join(dir, "modes", "[0]", "[slug]", "index.ts"),
  "export default {};",
);
const router = new Bun.FileSystemRouter({ dir, style: "nextjs" });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Assembled at runtime: a contiguous JWT literal trips the repo's secret scanner
// (dsh-plugin sportsdesk_security), the same reason check_secrets.test.ts joins parts.
const RAW_JWT = [
  "eyJhbGciOiJIUzI1NiJ9",
  "eyJtb2RlIjo2fQ",
  "secret_sig_991122",
].join(".");
const TOKEN = "tok_live_secret_888";
const MATCH_URL =
  `/modes/6/weblog-ip?0=live&filter=sharp&token=${TOKEN}` +
  `&X-Amz-Signature=deadbeef123&jwt=${RAW_JWT}` +
  "&client_ip=198.51.100.47&login=SYN-1234";

describe("MatchedRouteDiagnostic", () => {
  test("raw match leaks; the card does not", () => {
    const match = router.match(MATCH_URL);
    expect(match).not.toBeNull();

    // Measured on 1.4.4: inspecting the native match evaluates every getter, so the token, the
    // absolute host path and the decoded query string all reach the formatter. If Bun ever stops
    // doing this, this assertion is the first thing to relax.
    const raw = inspectUnbounded(match, { showHidden: true });
    expect(raw).toContain(TOKEN);
    expect(raw).toContain(realDir);
    expect(raw).toContain("client_ip=198.51.100.47");
    expect(Object.isFrozen(match!.query)).toBe(false);

    // The same match reached twice returns the same mutable object.
    const throwaway = router.match("/modes/9/probe");
    expect(throwaway).not.toBeNull();
    throwaway!.query["injected"] = "1";
    expect(throwaway!.query["injected"]).toBe("1");

    const diag = wrapMatchedRouteDiagnostic(match, {
      assetPrefix: router.assetPrefix,
    });
    expect(diag).not.toBeNull();
    expect(Object.getOwnPropertyNames(diag)).toEqual([]);
    expect(wrapMatchedRouteDiagnostic(null)).toBeNull();
  });

  test("query is params-merged, so the card shows query-only state", () => {
    const match = router.match(MATCH_URL)!;

    expect(match.params["0"]).toBe("6");
    expect(match.params.slug).toBe("weblog-ip");
    // Bun merges params into query and the param wins the `0` collision.
    expect(match.query["0"]).toBe("6");
    expect(match.query["slug"]).toBe("weblog-ip");
    expect(match.pathname).toContain("0=live&filter=sharp");

    const queryOnly = splitRouteQuery(match);
    expect(Object.getPrototypeOf(queryOnly)).toBeNull();
    expect(Object.hasOwn(queryOnly, "0")).toBe(false);
    expect(Object.hasOwn(queryOnly, "slug")).toBe(false);
    expect(queryOnly.filter).toBe("sharp");
    expect(queryOnly.login).toBe("SYN-1234");
  });

  test("AUDITOR_SANITIZED masks the host path, addresses, identities and secrets", () => {
    const diag = new MatchedRouteDiagnostic(router.match(MATCH_URL)!);
    const text = runWithInspectVisibility("AUDITOR_SANITIZED", () =>
      inspectUnbounded(diag, { colors: false, showHidden: true }),
    );

    expect(text.includes("\x1b")).toBe(false);
    expect(text).toContain("[ROUTE_DYNAMIC]");
    expect(text).toContain('params:   { 0="6", slug="weblog-ip" }');
    expect(text).toContain('filter="sharp"');
    expect(text).toContain('token="[REDACTED_SECRET]"');
    expect(text).toContain('X-Amz-Signature="[REDACTED_SECRET]"');
    expect(text).toContain('jwt="[REDACTED_SECRET]"');
    expect(text).toContain('client_ip="[REDACTED_IP]"');
    expect(text).toContain('login="[REDACTED_ID]"');
    expect(text).toContain("target:   [REDACTED_DIR]/index.ts");
    expect(text).toContain("login=[REDACTED_ID]");

    for (const surface of [text, JSON.stringify(diag)]) {
      expect(surface).not.toContain(TOKEN);
      expect(surface).not.toContain("deadbeef123");
      expect(surface).not.toContain(RAW_JWT);
      expect(surface).not.toContain("198.51.100.47");
      expect(surface).not.toContain(realDir);
    }
  });

  test("RISK_MANAGER keeps the workspace-relative target and the /24 subnet", () => {
    const diag = new MatchedRouteDiagnostic({
      route: router.match(MATCH_URL)!,
      visibility: "RISK_MANAGER",
    });
    const text = Bun.inspect(diag, { colors: true });

    expect(text).toContain("\x1b[48;2;");
    expect(text).toContain("ROUTE_DYNAMIC");
    expect(text).toContain(
      "modes/[0]/[slug]/index.ts (visibility=RISK_MANAGER)",
    );
    expect(text).toContain("198.51.100.0/24");
    expect(text).toContain("***1234");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(RAW_JWT);
    expect(text).not.toContain(realDir);
  });

  test("OWNER_ADMIN keeps the absolute path but still scrubs credentials", () => {
    const diag = new MatchedRouteDiagnostic({
      route: router.match(MATCH_URL)!,
      visibility: "OWNER_ADMIN",
    });
    const text = Bun.inspect(diag, { colors: false });

    expect(text).toContain(realDir);
    expect(text).toContain('client_ip="198.51.100.47"');
    expect(text).toContain('login="SYN-1234"');
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(RAW_JWT);
  });

  test("origin + assetPrefix never leaks into the RISK target", () => {
    const prefixed = new Bun.FileSystemRouter({
      dir,
      style: "nextjs",
      origin: "https://example.test",
      assetPrefix: "/static/",
    });
    const diag = new MatchedRouteDiagnostic({
      route: prefixed.match("/modes/6/weblog-ip?filter=sharp")!,
      assetPrefix: prefixed.assetPrefix,
      visibility: "RISK_MANAGER",
    });
    const text = Bun.inspect(diag, { colors: false });

    expect(diag.assetPrefix).toBe("/static/");
    expect(text).toContain('assetPrefix="/static/"');
    expect(text).toContain("target:   modes/[0]/[slug]/index.ts");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain(realDir);
  });

  test("getters return frozen null-prototype copies", () => {
    const diag = new MatchedRouteDiagnostic(router.match(MATCH_URL)!);
    const params = diag.params;
    expect(Object.getPrototypeOf(params)).toBeNull();
    expect(Object.isFrozen(params)).toBe(true);
    expect(() => {
      (params as Record<string, string>)["slug"] = "mutated";
    }).toThrow(TypeError);
    expect(diag.params["slug"]).toBe("weblog-ip");
  });

  test("depth 0 is the shallow branch and depth null is the full card", () => {
    const diag = new MatchedRouteDiagnostic(router.match(MATCH_URL)!);
    const shallow = Bun.inspect(diag, { colors: false, depth: 0 });
    expect(
      shallow.startsWith("[MatchedRoute [ROUTE_DYNAMIC] /modes/6/weblog-ip"),
    ).toBe(true);
    expect(shallow.includes("\n")).toBe(false);

    const full = inspectUnbounded(diag, { colors: false });
    expect(full).toContain("target:");
  });
});

describe("sanitizeRouteRecord", () => {
  test("scrubs active secret-manifest values under arbitrary keys", () => {
    // @types/bun marks `Bun.env` entries read-only, but the object is the process environment.
    const env = Bun.env as Record<string, string | undefined>;
    const original = env.GSLIVE_SESSION_ID;
    const secret = "gslive_session_abc123456";
    env.GSLIVE_SESSION_ID = secret;
    try {
      const safe = sanitizeRouteRecord(
        { custom_param: secret, filter: "sharp" },
        "RISK_MANAGER",
      );
      expect(safe["custom_param"]).toBe("[REDACTED_SECRET]");
      expect(safe["filter"]).toBe("sharp");
      expect(redactDiagnosticSurface(`prefix ${secret} suffix`)).not.toContain(
        secret,
      );
    } finally {
      if (original === undefined) delete env.GSLIVE_SESSION_ID;
      else env.GSLIVE_SESSION_ID = original;
    }
  });

  test("cannot be polluted through __proto__", () => {
    const bag = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"filter":"sharp"}',
    ) as Record<string, string>;
    const safe = sanitizeRouteRecord(bag, "AUDITOR_SANITIZED");
    expect(Object.getPrototypeOf(safe)).toBeNull();
    expect(Object.hasOwn(safe, "__proto__")).toBe(true);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
  });
});

describe("BunRequestDiagnostic", () => {
  test("cookies are lazy and values never reach the card", () => {
    let cookieReads = 0;
    const request: DiagnosticRequest = {
      url:
        `https://desk.test/modes/6/weblog?filter=sharp&token=${TOKEN}` +
        "&client_ip=198.51.100.47",
      method: "GET",
      headers: new Headers({
        authorization: `Bearer ${RAW_JWT}`,
        cookie: "sid=super-secret-cookie; theme=dark",
        "content-type": "application/json",
        "x-api-key": "key_live_123456789",
        "x-probe": "Bearer abcdef123456",
      }),
      params: { mode: "6", slug: "weblog" },
      get cookies() {
        cookieReads += 1;
        return [
          ["sid", "super-secret-cookie"],
          ["theme", "dark"],
        ] as Iterable<readonly [string, string]>;
      },
    };

    const diag = new BunRequestDiagnostic({
      request,
      visibility: "RISK_MANAGER",
    });
    expect(cookieReads).toBe(0);
    expect(diag.params["mode"]).toBe("6");
    expect(cookieReads).toBe(0);

    const cookies = diag.cookies;
    expect(cookieReads).toBe(1);
    expect(cookies["sid"]).toBe("[REDACTED_COOKIE]");
    expect(Object.isFrozen(cookies)).toBe(true);

    const headers = diag.headers;
    expect(headers["authorization"]).toBe("[REDACTED_HEADER]");
    expect(headers["cookie"]).toBe("[REDACTED_HEADER]");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBe("[REDACTED_HEADER]");
    expect(headers["x-probe"]).toBe("Bearer [REDACTED_SECRET]");

    const text = Bun.inspect(diag, { colors: false });
    expect(text).toContain('params:   { mode="6", slug="weblog" }');
    expect(text).toContain("sid, theme (2, values redacted)");
    expect(text).toContain("client_ip=198.51.100.0/24");
    expect(text).not.toContain("super-secret-cookie");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(RAW_JWT);
    expect(JSON.stringify(diag)).not.toContain("super-secret-cookie");
  });

  test("a live Bun.serve handler pairs params, cookies and headers", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: {
        "/modes/:mode/:slug": (
          req: BunRequest<"/modes/:mode/:slug">,
        ): Response => {
          const diag = new BunRequestDiagnostic({
            request: req,
            visibility: "RISK_MANAGER",
          });
          return Response.json({
            inspect: Bun.inspect(diag, { colors: false }),
            json: diag.toJSON(),
          });
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/modes/6/weblog?filter=sharp&token=${TOKEN}`,
        {
          headers: {
            cookie: "sid=super-secret-cookie; theme=dark",
            authorization: `Bearer ${RAW_JWT}`,
            "x-probe": "probe-value",
          },
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        inspect: string;
        json: Record<string, unknown>;
      };

      expect(body.inspect).toContain('params:   { mode="6", slug="weblog" }');
      expect(body.inspect).toContain(
        "cookies:  sid, theme (2, values redacted)",
      );
      expect(body.inspect).toContain('authorization="[REDACTED_HEADER]"');
      expect(body.inspect).toContain('cookie="[REDACTED_HEADER]"');
      expect(body.inspect).toContain('x-probe="probe-value"');
      expect(body.inspect).not.toContain("super-secret-cookie");
      expect(body.inspect).not.toContain(TOKEN);
      expect(body.inspect).not.toContain(RAW_JWT);
      expect(body.json).toMatchObject({
        type: "BunRequestDiagnostic",
        visibility: "RISK_MANAGER",
        params: { mode: "6", slug: "weblog" },
      });
    } finally {
      server.stop(true);
    }
  });
});

describe("BunImageAssetDiagnostic", () => {
  test("reads header attributes without decoding pixels", async () => {
    const png = png1x1();
    const asset = await inspectBunImageAsset(png, {
      displaySource: join(process.cwd(), "docs/assets/logo.png"),
      visibility: "RISK_MANAGER",
    });

    expect(asset.format).toBe("png");
    expect(asset.width).toBe(1);
    expect(asset.height).toBe(1);
    expect(asset.aspectRatio).toBe(1);
    expect(asset.bytes).toBe(png.byteLength);
    expect(asset.source).toBe("docs/assets/logo.png");

    const text = Bun.inspect(asset, { colors: false });
    expect(text).toContain("BunImageAsset PNG 1×1");
    expect(text).toContain("docs/assets/logo.png (visibility=RISK_MANAGER)");
    expect(Bun.inspect(asset, { colors: false, depth: 0 })).toBe(
      "[BunImageAsset PNG 1×1]",
    );
    expect(JSON.parse(JSON.stringify(asset))).toMatchObject({
      type: "BunImageAssetDiagnostic",
      width: 1,
      height: 1,
      format: "png",
    });
  });

  test("masks workspace paths, leaf names and presigned URLs", () => {
    const workspacePath = join(process.cwd(), "docs/assets/logo.png");
    expect(maskAssetSource(workspacePath, "RISK_MANAGER")).toBe(
      "docs/assets/logo.png",
    );
    expect(maskAssetSource(workspacePath, "AUDITOR_SANITIZED")).toBe(
      "[REDACTED_DIR]/logo.png",
    );
    expect(maskAssetSource(workspacePath, "OWNER_ADMIN")).toBe(workspacePath);

    const presigned =
      "https://r2.test/blobs/a.webp?X-Amz-Signature=deadbeef123&expires=60";
    const masked = maskAssetSource(presigned, "RISK_MANAGER");
    expect(masked).toContain("[REDACTED_SECRET]");
    expect(masked).not.toContain("deadbeef123");
  });

  test("scan is name-sorted, extension-filtered and failure-labeled", async () => {
    const scanDir = mkdtempSync(join(tmpdir(), "sd-assets-"));
    try {
      const png = png1x1();
      writeFileSync(join(scanDir, "b.png"), png);
      writeFileSync(join(scanDir, "a.png"), png);
      writeFileSync(join(scanDir, "note.txt"), "ignored");
      writeFileSync(join(scanDir, "c.png"), "not an image");

      const entries = await scanBunImageAssets(scanDir, {
        visibility: "AUDITOR_SANITIZED",
        limit: 10,
      });
      expect(entries.map((entry) => entry.source)).toEqual([
        "[REDACTED_DIR]/a.png",
        "[REDACTED_DIR]/b.png",
        "[REDACTED_DIR]/c.png",
      ]);
      const failure = entries[2];
      if (
        failure === undefined ||
        failure.type !== "BunImageAssetScanFailure"
      ) {
        throw new Error("expected the malformed png to be a scan failure");
      }
      expect(failure.code).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
    } finally {
      rmSync(scanDir, { recursive: true, force: true });
    }
  });
});
