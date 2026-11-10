/**
 * @file tests/bun_assets_build_latency.test.ts
 * @description End-to-end verification suite for Bun.Image, Bun.file -> Bun.write staging,
 * Bun.build output caching/sidecars, and server hot-path latency optimizations.
 */

import { YAML } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectLogo, resizeLogo } from "../lib/logo_image.ts";
import {
  resetBatchedRankingCache,
  runBatchedRanking,
} from "../scripts/batch_rank_all_players.ts";
import { buildEnhancedDashboard } from "../scripts/build_dashboard.ts";
import { startDashboardServer } from "../scripts/dev_dashboard.ts";
import { runAssetOptimization } from "../scripts/optimize_assets.ts";
import { stageDist } from "../scripts/stage_dist.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";
import {
  resetLiveBetsResolverCache,
  resolveLiveBets,
} from "../src/live_bets/resolve.ts";

const ROOT = resolve(import.meta.dir, "..");

describe("Bun.Image, Bun.file & Bun.build Asset + Latency Suite", () => {
  test("1. optimize_assets generates deterministic ARCH-Guide.webp (>80% smaller than JPEG) & LQIP placeholders", async () => {
    const manifest = await runAssetOptimization({ root: ROOT, write: false });
    expect(manifest.backend).toBe("bun");

    const archJpg = manifest.images.find(
      (i) => i.path === "docs/assets/ARCH-Guide.jpg",
    );
    const archWebp = manifest.images.find(
      (i) => i.path === "docs/assets/ARCH-Guide.webp",
    );
    expect(archJpg).toBeDefined();
    expect(archWebp).toBeDefined();
    expect(archWebp!.format).toBe("webp");
    expect(archWebp!.width).toBe(archJpg!.width);
    expect(archWebp!.height).toBe(archJpg!.height);
    expect(archWebp!.bytes).toBeLessThan(archJpg!.bytes * 0.25);
    expect(archJpg!.savingsPct).toBeGreaterThan(80);
    expect(archWebp!.placeholder.startsWith("data:image/")).toBe(true);
  });

  test("2. bin/image-meta.ts preserves bare JSON shape and supports --full + --yaml", async () => {
    const bareProc = Bun.spawn(
      [process.execPath, "bin/image-meta.ts", "docs/assets/ARCH-Guide.webp"],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const bareText = await new Response(bareProc.stdout).text();
    expect(await bareProc.exited).toBe(0);
    expect(JSON.parse(bareText)).toEqual({
      width: 1200,
      height: 896,
      format: "webp",
    });

    const fullProc = Bun.spawn(
      [
        process.execPath,
        "bin/image-meta.ts",
        "--full",
        "--yaml",
        "docs/assets/ARCH-Guide.webp",
      ],
      { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
    );
    const fullText = await new Response(fullProc.stdout).text();
    expect(await fullProc.exited).toBe(0);
    const parsed = YAML.parse(fullText) as Record<string, unknown>;
    expect(parsed.format).toBe("webp");
    expect(parsed.contentType).toBe("image/webp");
    expect(typeof parsed.sha256).toBe("string");
    expect((parsed.sha256 as string).length).toBe(64);
    expect(String(parsed.placeholder).startsWith("data:image/")).toBe(true);
  });

  test("3. resizeLogo supports single-pass downscale + explicit targetFormat=webp transcoding", async () => {
    const pngBytes = new Uint8Array(
      await Bun.file(
        join(ROOT, "docs/assets/pipeline-10-mode-architecture.png"),
      ).arrayBuffer(),
    );
    const meta = await inspectLogo(pngBytes);
    expect(meta.format).toBe("png");

    const asWebp = await resizeLogo(pngBytes, meta, 256, "webp");
    expect(asWebp.resized).toBe(true);
    expect(asWebp.metadata.format).toBe("webp");
    expect(asWebp.metadata.contentType).toBe("image/webp");
    expect(asWebp.metadata.width).toBe(256);
    expect(asWebp.bytes.byteLength).toBeLessThan(pngBytes.byteLength / 10);
  });

  test("4. stageDist copies docs/ + assets/ via Bun.file -> Bun.write and emits stage-manifest.json", async () => {
    const manifest = await stageDist({ root: ROOT });
    expect(manifest.totalFiles).toBeGreaterThanOrEqual(27);
    const archWebpStaged = manifest.files.find(
      (f) => f.dest === "dist/assets/ARCH-Guide.webp",
    );
    expect(archWebpStaged).toBeDefined();
    expect(archWebpStaged!.sha256.length).toBe(64);
  });

  test("5. buildEnhancedDashboard emits BuildArtifact contentHash and .zst/.gz precompressed sidecars", async () => {
    const outdir = mkdtempSync(join(tmpdir(), "sd-build-sidecars-"));
    try {
      const manifest = await buildEnhancedDashboard({
        target: "prod",
        outdir,
        minify: true,
      });
      const jsArt = manifest.artifacts.find((a) => a.fileName.endsWith(".js"))!;
      expect(jsArt).toBeDefined();
      expect(jsArt.zstdBytes).toBeDefined();
      expect(jsArt.gzipBytes).toBeDefined();
      expect(jsArt.zstdBytes!).toBeLessThan(jsArt.bytes);
      expect(
        await Bun.file(join(outdir, `${jsArt.fileName}.zst`)).exists(),
      ).toBe(true);
      expect(
        await Bun.file(join(outdir, `${jsArt.fileName}.gz`)).exists(),
      ).toBe(true);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  });

  test("6. runBatchedRanking stat-memoizes JSONL stream and invalidates immediately on file growth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-rank-memo-"));
    const jsonlPath = join(dir, "sample-bets.jsonl");
    try {
      resetBatchedRankingCache();
      const row1 = JSON.stringify({
        Login: "SHARP01",
        AgentID: "AG01",
        AmountWagered: 50000,
        ToWinAmount: 45455,
        InsertDateTime: "2026-11-01 12:00:00",
        WagerType: "S",
        ShortDesc: "NFL - Chiefs -3",
      });
      await Bun.write(jsonlPath, `${row1}\n`);

      const first = await runBatchedRanking({
        corpusPath: jsonlPath,
        windowCutoff: "2026-10-01",
      });
      expect(first.inWindowWagers).toBe(1);

      const tWarm0 = performance.now();
      const warm = await runBatchedRanking({
        corpusPath: jsonlPath,
        windowCutoff: "2026-10-01",
        limitPlayers: 1,
      });
      const warmMs = performance.now() - tWarm0;
      expect(warm.inWindowWagers).toBe(1);
      expect(warmMs).toBeLessThan(15);

      // Append a second wager -> size changes -> cache MUST invalidate automatically
      await Bun.write(jsonlPath, `${row1}\n${row1}\n`);
      const updated = await runBatchedRanking({
        corpusPath: jsonlPath,
        windowCutoff: "2026-10-01",
      });
      expect(updated.inWindowWagers).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("7. webview server /assets/* supports ETag 304, zstd compression on SVG, and ?format=webp; /api/v2/live-bets supports ETag + zstd", async () => {
    resetLiveBetsResolverCache();
    const srv = startServer({
      port: 0,
      hostname: "127.0.0.1",
      development: false,
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // SVG with zstd + ETag + 304
      const svgRes = await fetch(
        `${base}/assets/pipeline-10-mode-architecture.svg`,
        {
          headers: { "Accept-Encoding": "zstd, gzip" },
        },
      );
      expect(svgRes.status).toBe(200);
      expect(svgRes.headers.get("content-encoding")).toBe("zstd");
      const etag = svgRes.headers.get("etag");
      expect(etag).toBeTruthy();

      const svg304 = await fetch(
        `${base}/assets/pipeline-10-mode-architecture.svg`,
        {
          headers: { "If-None-Match": etag! },
        },
      );
      expect(svg304.status).toBe(304);

      // ?format=webp serves WebP sibling for ARCH-Guide.jpg while bare .jpg remains image/jpeg
      const jpgRes = await fetch(`${base}/assets/ARCH-Guide.jpg`);
      expect(jpgRes.status).toBe(200);
      expect((await jpgRes.arrayBuffer()).byteLength).toBeGreaterThan(
        1_000_000,
      );

      const webpRes = await fetch(`${base}/assets/ARCH-Guide.jpg?format=webp`);
      expect(webpRes.status).toBe(200);
      expect(webpRes.headers.get("content-type")).toBe("image/webp");
      const webpLen = (await webpRes.arrayBuffer()).byteLength;
      expect(webpLen).toBeGreaterThan(50_000);
      expect(webpLen).toBeLessThan(350_000);

      // /api/v2/live-bets ETag + zstd
      const v2Res = await fetch(
        `${base}/api/v2/live-bets?source=fixture&fallback=sample`,
        {
          headers: { "Accept-Encoding": "zstd" },
        },
      );
      expect(v2Res.status).toBe(200);
      expect(v2Res.headers.get("content-encoding")).toBe("zstd");
      const v2Etag = v2Res.headers.get("etag");
      expect(v2Etag).toBeTruthy();
      const v2Json = (await v2Res.json()) as { provenance: { hash: string } };
      expect(v2Json.provenance.hash.length).toBe(64);

      const v2NotMod = await fetch(
        `${base}/api/v2/live-bets?source=fixture&fallback=sample`,
        {
          headers: { "If-None-Match": v2Etag! },
        },
      );
      expect(v2NotMod.status).toBe(304);

      // Warm stat-memoized resolveLiveBets latency check
      await resolveLiveBets(
        { source: "fixture", fallback: "sample" },
        { repoRoot: ROOT },
      );
      const t0 = performance.now();
      const resolvedWarm = await resolveLiveBets(
        { source: "fixture", fallback: "sample" },
        { repoRoot: ROOT },
      );
      const elapsed = performance.now() - t0;
      expect(resolvedWarm.provenance.hash?.length).toBe(64);
      expect(elapsed).toBeLessThan(20);
    } finally {
      srv.stop(true);
    }
  });

  test("8. dev_dashboard caches /index.js BuildArtifact with ETag 304 and zstd compression", async () => {
    const handle = startDashboardServer({ port: 0, watchFiles: false });
    try {
      const base = handle.url.href.replace(/\/$/, "");
      const res1 = await fetch(`${base}/index.js`, {
        headers: { "Accept-Encoding": "zstd" },
      });
      expect(res1.status).toBe(200);
      expect(res1.headers.get("content-encoding")).toBe("zstd");
      const etag = res1.headers.get("etag");
      expect(etag).toBeTruthy();
      expect((await res1.text()).length).toBeGreaterThan(10_000);

      const t0 = performance.now();
      const res304 = await fetch(`${base}/index.js`, {
        headers: { "If-None-Match": etag! },
      });
      const warmMs = performance.now() - t0;
      expect(res304.status).toBe(304);
      expect(warmMs).toBeLessThan(25);
    } finally {
      handle.stop(true);
    }
  });

  afterAll(() => {
    resetBatchedRankingCache();
    resetLiveBetsResolverCache();
  });
});
