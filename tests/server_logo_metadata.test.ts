import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startServer } from "../services/sportsdesk_webview_server.ts";

/**
 * The logo proxy measured what the portal actually sends.
 *
 * `LogoTeam1`/`LogoTeam2` are file names — `Boston-Celtics.png`, `Notre Dame Fighting Irish.png`,
 * `miami_dolphins_logo.png`, `toronto.png`, and `NHL.png` in a team slot — so the caller cannot
 * assume a team logo, a square, or a sane size. The route now decodes the bytes (the upstream
 * content-type was only a claim), reports the dimensions, and can downscale.
 *
 * `SPORTSDESK_LOGO_BASE_URL` points the proxy at a fixture upstream; the real CDN is never used.
 */

const PNG = resolve(
  import.meta.dir,
  "../docs/assets/pipeline-10-mode-architecture.png",
);
const savedBase = Bun.env["SPORTSDESK_LOGO_BASE_URL"];
const savedToken = Bun.env["SPORTSDESK_ADMIN_TOKEN"];

let upstreamHits = 0;
/** A 20px-wide logo, so "never upscale" has something small to leave alone. */
const tinyPng = new Uint8Array(
  await new Bun.Image(Bun.file(PNG)).resize(20).png().bytes(),
);
/** Past the 4 MP `maxPixels` ceiling in lib/logo_image.ts: 3000×1725. */
const hugePng = new Uint8Array(
  await new Bun.Image(Bun.file(PNG)).resize(3000).png().bytes(),
);
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const name = decodeURIComponent(
      new URL(req.url).pathname.split("/").pop() ?? "",
    );
    if (name === "missing.png") return new Response("nope", { status: 404 });
    if (name === "not-an-image.png") {
      return new Response("<html>portal</html>", {
        headers: { "Content-Type": "text/html" },
      });
    }
    if (name === "truncated.png") {
      return new Response(tinyPng.subarray(0, 60), {
        headers: { "Content-Type": "image/png" },
      });
    }
    if (name === "huge.png") {
      return new Response(hugePng, {
        headers: { "Content-Type": "image/png" },
      });
    }
    upstreamHits += 1;
    const body = name === "tiny.png" ? tinyPng : await Bun.file(PNG).bytes();
    return new Response(body, { headers: { "Content-Type": "image/png" } });
  },
});

Reflect.set(
  Bun.env,
  "SPORTSDESK_LOGO_BASE_URL",
  `http://127.0.0.1:${upstream.port}/images/team-logos/`,
);
Reflect.deleteProperty(Bun.env, "SPORTSDESK_ADMIN_TOKEN");

const server = startServer({
  port: 0,
  hostname: "127.0.0.1",
  development: false,
});
const base = `http://127.0.0.1:${server.port}`;

afterAll(() => {
  server.stop(true);
  upstream.stop(true);
  if (savedBase === undefined)
    Reflect.deleteProperty(Bun.env, "SPORTSDESK_LOGO_BASE_URL");
  else Reflect.set(Bun.env, "SPORTSDESK_LOGO_BASE_URL", savedBase);
  if (savedToken === undefined)
    Reflect.deleteProperty(Bun.env, "SPORTSDESK_ADMIN_TOKEN");
  else Reflect.set(Bun.env, "SPORTSDESK_ADMIN_TOKEN", savedToken);
});

describe("logo bytes carry their measurement", () => {
  test("a real image answers with the format and dimensions it actually has", async () => {
    const response = await fetch(`${base}/api/logo/Boston-Celtics.png`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-image-format")).toBe("png");
    expect(response.headers.get("x-image-width")).toBe("1600");
    expect(response.headers.get("x-image-height")).toBe("920");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });

  test("a name with spaces is still a name, not a path", async () => {
    const response = await fetch(
      `${base}/api/logo/${encodeURIComponent("Notre Dame Fighting Irish.png")}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-image-format")).toBe("png");
  });

  test("?w= downsizes and keeps the aspect ratio", async () => {
    const full = await fetch(`${base}/api/logo/toronto.png`);
    const small = await fetch(`${base}/api/logo/toronto.png?w=64`);
    expect(small.status).toBe(200);
    expect(small.headers.get("x-image-width")).toBe("64");
    expect(Number(small.headers.get("x-image-height"))).toBeLessThan(920);
    const fullBytes = (await full.arrayBuffer()).byteLength;
    const smallBytes = (await small.arrayBuffer()).byteLength;
    expect(smallBytes).toBeLessThan(fullBytes / 10);
  });

  test("?w= never upscales a small logo", async () => {
    const response = await fetch(`${base}/api/logo/tiny.png?w=1024`);
    expect(response.headers.get("x-image-width")).toBe("20");
  });

  test("?meta=1 answers the measurement without the pixels", async () => {
    const response = await fetch(
      `${base}/api/logo/miami_dolphins_logo.png?meta=1&w=64`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["width"]).toBe(64);
    expect(body["height"]).toBeLessThan(920);
    expect(body["format"]).toBe("png");
    expect(body["resized"]).toBe(true);
    expect(body["requestedWidth"]).toBe(64);
    expect(String(body["source"])).toContain("miami_dolphins_logo.png");
  });

  test("the same logo is fetched from upstream once", async () => {
    upstreamHits = 0;
    for (let i = 0; i < 3; i++) {
      await (await fetch(`${base}/api/logo/Sann-DiegoLA.png`)).arrayBuffer();
    }
    expect(upstreamHits).toBe(1);
  });
});

describe("upstream failures are described, not guessed", () => {
  test("a non-2xx upstream status is passed through", async () => {
    const response = await fetch(`${base}/api/logo/missing.png`);
    expect(response.status).toBe(404);
  });

  test("an HTML error page is 502, not an image", async () => {
    const response = await fetch(`${base}/api/logo/not-an-image.png`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
  });

  test("a PNG cut off mid-header reports the decoder's code", async () => {
    const response = await fetch(`${base}/api/logo/truncated.png`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("ERR_IMAGE_DECODE_FAILED");
  });

  test("a logo over the pixel ceiling reports maxPixels, not a decode failure", async () => {
    const response = await fetch(`${base}/api/logo/huge.png`);
    expect(response.status).toBe(502);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("ERR_IMAGE_TOO_MANY_PIXELS");
  });

  test("a broken percent-escape is a client error", async () => {
    expect((await fetch(`${base}/api/logo/%E0%A4%A`)).status).toBe(400);
  });
});
