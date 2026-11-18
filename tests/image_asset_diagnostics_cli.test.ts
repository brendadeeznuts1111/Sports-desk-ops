/**
 * @file tests/image_asset_diagnostics_cli.test.ts
 * @description `bun run assets:diagnostics` prints Bun.Image attributes, honors the visibility
 * tier, reports truncation honestly and exits non-zero when a file cannot be decoded.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DEFAULT_THUMBNAIL_EDGE,
  thumbnailDestination,
} from "../lib/bun_thumbnail.ts";
import {
  DEFAULT_ASSET_LIMIT,
  DEFAULT_MAX_ASSET_BYTES,
} from "../lib/bun_image_assets.ts";
import { formatByteCount } from "../lib/format_bytes.ts";
import {
  TOOL_VERSION,
  FLAG_SPECS,
  USAGE,
} from "../scripts/image_asset_cli_spec.ts";
import { makePng, png1x1 } from "./support/image_fixtures.ts";

const dir = mkdtempSync(join(tmpdir(), "sd-asset-cli-"));
writeFileSync(join(dir, "a.png"), png1x1());
writeFileSync(
  join(dir, "b.png"),
  Uint8Array.from([...png1x1(), ...new Uint8Array(64)]),
);
writeFileSync(join(dir, "c.png"), "not an image");
writeFileSync(join(dir, "note.txt"), "ignored");
mkdirSync(join(dir, "nested"), { recursive: true });
writeFileSync(join(dir, "nested", "d.png"), png1x1());

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface CliRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): CliRun {
  const child = Bun.spawnSync(
    [process.execPath, "scripts/image_asset_diagnostics.ts", ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

interface CliThumbnail {
  readonly source: string;
  readonly path?: string;
  readonly bytes?: number;
  readonly width?: number;
  readonly height?: number;
  readonly backend?: string;
  readonly error?: string;
}

interface CliDirectory {
  readonly root: string;
  readonly total: number;
  readonly truncated: boolean;
  readonly count: number;
  readonly assets: readonly {
    readonly type: string;
    readonly source: string;
    readonly code?: string;
    readonly requiredBytes?: number;
  }[];
  readonly thumbnails: readonly CliThumbnail[];
}

interface CliPayload {
  readonly ok: boolean;
  readonly visibility: string;
  readonly backend: string;
  readonly recursive: boolean;
  readonly filter: string | null;
  readonly exclude: string | null;
  readonly sort: string;
  readonly headerBytes: number | null;
  readonly budgetBytes: number | null;
  readonly maxDimension: number | null;
  readonly failures: number;
  readonly thumbnails: {
    readonly enabled: boolean;
    readonly maxEdge?: number;
    readonly quality?: number;
    readonly backend?: string;
  };
  readonly directories: readonly CliDirectory[];
}

test("--json reports every asset and exits 1 on a decode failure", () => {
  const result = runCli(["--json", "--limit=10", dir]);
  expect(result.code).toBe(1);
  const payload = JSON.parse(result.stdout) as CliPayload;
  expect(payload.ok).toBe(false);
  expect(payload.failures).toBe(1);
  expect(payload.visibility).toBe("RISK_MANAGER");
  const directory = payload.directories[0];
  expect(directory).toBeDefined();
  if (directory === undefined) throw new Error("missing directory report");
  expect(directory.total).toBe(3);
  expect(directory.count).toBe(3);
  expect(directory.truncated).toBe(false);
  expect(directory.assets.map((asset) => asset.source)).toEqual([
    "[REDACTED_DIR]/a.png",
    "[REDACTED_DIR]/b.png",
    "[REDACTED_DIR]/c.png",
  ]);
  expect(directory.assets[2]?.code).toBe("ERR_IMAGE_UNKNOWN_FORMAT");
});

test("--limit truncates honestly and skips the unreadable file", () => {
  const result = runCli([
    "--json",
    "--limit=1",
    "--visibility=AUDITOR_SANITIZED",
    dir,
  ]);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as CliPayload;
  expect(payload.ok).toBe(true);
  expect(payload.failures).toBe(0);
  expect(payload.visibility).toBe("AUDITOR_SANITIZED");
  const directory = payload.directories[0];
  if (directory === undefined) throw new Error("missing directory report");
  expect(directory.total).toBe(3);
  expect(directory.count).toBe(1);
  expect(directory.truncated).toBe(true);
  expect(directory.assets[0]?.source).toBe("[REDACTED_DIR]/a.png");
});

test("terminal output renders the BunImageAsset card", () => {
  const result = runCli(["--no-color", "--limit=10", dir]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("BunImageAsset PNG 1×1");
  expect(result.stdout).toContain("[REDACTED_DIR]/a.png");
  expect(result.stdout).toContain("1 asset(s) failed");
  expect(result.stdout).not.toContain("\x1b");
});

test("invalid arguments exit 2 with usage", () => {
  const badTier = runCli(["--visibility=bogus"]);
  expect(badTier.code).toBe(2);
  expect(badTier.stderr).toContain("--visibility must be one of");

  const badLimit = runCli(["--limit=0"]);
  expect(badLimit.code).toBe(2);
  expect(badLimit.stderr).toContain("--limit must be an integer in 1..100");

  const help = runCli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("image_asset_diagnostics");
});

test("--summary prints totals without cards", () => {
  const result = runCli(["--no-color", "--summary", "--limit=10", dir]);
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("total=3");
  expect(result.stdout).toContain("failures=1");
  expect(result.stdout).toContain("shown=3");
  expect(result.stdout).not.toContain("BunImageAsset PNG");
});

test("--filter narrows before the limit", () => {
  const result = runCli(["--json", "--filter=a", dir]);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as CliPayload;
  const directory = payload.directories[0];
  if (directory === undefined) throw new Error("missing directory report");
  expect(directory.total).toBe(1);
  expect(directory.count).toBe(1);
  expect(directory.assets[0]?.source).toBe("[REDACTED_DIR]/a.png");
});

test("--recursive walks subdirectories", () => {
  const shallow = runCli(["--json", "--limit=10", dir]);
  const shallowPayload = JSON.parse(shallow.stdout) as CliPayload;
  expect(shallowPayload.directories[0]?.total).toBe(3);

  const recursive = runCli(["--json", "--recursive", "--limit=10", dir]);
  const payload = JSON.parse(recursive.stdout) as CliPayload;
  expect(payload.recursive).toBe(true);
  const directory = payload.directories[0];
  if (directory === undefined) throw new Error("missing directory report");
  expect(directory.total).toBe(4);
  expect(directory.assets.map((asset) => asset.source)).toContain(
    "[REDACTED_DIR]/d.png",
  );
});

test("--sort=size returns the largest file first", () => {
  const alphabetical = runCli(["--json", "--limit=1", dir]);
  const alphabeticalPayload = JSON.parse(alphabetical.stdout) as CliPayload;
  expect(alphabeticalPayload.directories[0]?.assets[0]?.source).toBe(
    "[REDACTED_DIR]/a.png",
  );

  const bySize = runCli(["--json", "--sort=size", "--limit=1", dir]);
  const payload = JSON.parse(bySize.stdout) as CliPayload;
  expect(payload.sort).toBe("size");
  expect(payload.directories[0]?.assets[0]?.source).toBe(
    "[REDACTED_DIR]/b.png",
  );
});

test("--placeholders fills placeholderBytes for readable assets", () => {
  const result = runCli(["--json", "--placeholders", "--limit=1", dir]);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as {
    directories: readonly {
      assets: readonly { placeholderBytes: number | null }[];
    }[];
  };
  const asset = payload.directories[0]?.assets[0];
  expect(asset?.placeholderBytes).toBeGreaterThan(0);
});

test("--no-fail exits 0 despite a decode failure", () => {
  const result = runCli(["--json", "--no-fail", "--limit=10", dir]);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as CliPayload;
  expect(payload.ok).toBe(false);
  expect(payload.failures).toBe(1);
});

test("--version prints the tool and Bun versions", () => {
  const result = runCli(["--version"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`image_asset_diagnostics ${TOOL_VERSION}`);
  expect(result.stdout).toContain(`Bun ${Bun.version}`);
});

test("help is derived from the flag table and shared defaults", () => {
  expect(USAGE).toContain(`image_asset_diagnostics ${TOOL_VERSION}`);
  for (const spec of FLAG_SPECS) {
    expect(USAGE).toContain(spec.flags);
  }
  expect(USAGE).toContain(`default ${DEFAULT_ASSET_LIMIT}`);
  expect(USAGE).toContain(formatByteCount(DEFAULT_MAX_ASSET_BYTES));
  expect(USAGE).toContain(`default ${DEFAULT_THUMBNAIL_EDGE}`);

  const help = runCli(["--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout.trimEnd()).toBe(USAGE.trimEnd());
});

test("--thumbs writes portable WebP thumbnails and reports their geometry", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);

    const result = runCli(["--json", "--thumbs=40", thumbDir]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as CliPayload;
    expect(payload.thumbnails).toMatchObject({
      enabled: true,
      maxEdge: 40,
      quality: 80,
      backend: "bun",
    });
    const directory = payload.directories[0];
    if (directory === undefined) throw new Error("missing directory report");
    expect(directory.thumbnails.length).toBe(1);
    const thumb = directory.thumbnails[0];
    if (thumb === undefined) throw new Error("missing thumbnail report");
    expect(thumb.source).toBe("[REDACTED_DIR]/wide.png");
    const expectedDestination = thumbnailDestination(
      thumbDir,
      join(thumbDir, "wide.png"),
      join(thumbDir, ".thumbs"),
    );
    expect(thumb.path).toBe(`[REDACTED_DIR]/${basename(expectedDestination)}`);
    expect(thumb.width).toBe(40);
    expect(thumb.height).toBe(30);
    expect(thumb.backend).toBe("bun");
    expect(thumb.bytes).toBeGreaterThan(0);
    expect(await Bun.file(expectedDestination).exists()).toBe(true);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--thumbs-dir overrides the destination and requires --thumbs", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-out-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);
    const outDir = join(thumbDir, "custom-thumbs");
    const result = runCli([
      "--json",
      "--thumbs=24",
      `--thumbs-dir=${outDir}`,
      thumbDir,
    ]);
    expect(result.code).toBe(0);
    expect(
      await Bun.file(
        thumbnailDestination(thumbDir, join(thumbDir, "wide.png"), outDir),
      ).exists(),
    ).toBe(true);

    const missingThumbs = runCli([`--thumbs-dir=${outDir}`, thumbDir]);
    expect(missingThumbs.code).toBe(2);
    expect(missingThumbs.stderr).toContain("--thumbs-dir requires --thumbs");
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--recursive skips the hidden .thumbs directory", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-skip-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);
    expect(runCli(["--thumbs=16", thumbDir]).code).toBe(0);

    const result = runCli(["--json", "--recursive", "--limit=10", thumbDir]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as CliPayload;
    const directory = payload.directories[0];
    if (directory === undefined) throw new Error("missing directory report");
    expect(directory.total).toBe(1);
    expect(directory.assets.map((asset) => asset.source)).toEqual([
      "[REDACTED_DIR]/wide.png",
    ]);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--header-bytes reads a PNG from 24 bytes and labels a 23-byte slice", async () => {
  const headerDir = mkdtempSync(join(tmpdir(), "sd-cli-header-"));
  try {
    writeFileSync(join(headerDir, "a.png"), png1x1());

    const ok = runCli(["--json", "--header-bytes=24", headerDir]);
    expect(ok.code).toBe(0);
    const okPayload = JSON.parse(ok.stdout) as CliPayload;
    expect(okPayload.headerBytes).toBe(24);
    const okDirectory = okPayload.directories[0];
    if (okDirectory === undefined) throw new Error("missing directory report");
    expect(okDirectory.assets[0]).toMatchObject({
      type: "BunImageAssetDiagnostic",
      width: 1,
      height: 1,
      format: "png",
    });

    const short = runCli(["--json", "--header-bytes=23", headerDir]);
    expect(short.code).toBe(1);
    const shortPayload = JSON.parse(short.stdout) as CliPayload;
    const shortDirectory = shortPayload.directories[0];
    if (shortDirectory === undefined)
      throw new Error("missing directory report");
    expect(shortDirectory.assets[0]).toMatchObject({
      type: "BunImageAssetScanFailure",
      code: "ERR_IMAGE_HEADER_TRUNCATED",
      requiredBytes: 24,
    });
  } finally {
    rmSync(headerDir, { recursive: true, force: true });
  }
});

test("--header-bytes reports JPEG growth and resolves once the prefix is long enough", async () => {
  const headerDir = mkdtempSync(join(tmpdir(), "sd-cli-header-jpeg-"));
  try {
    const source = png1x1();
    writeFileSync(
      join(headerDir, "photo.jpg"),
      await new Bun.Image(source).resize(120, 90).jpeg({ quality: 80 }).bytes(),
    );

    const short = runCli(["--json", "--header-bytes=64", headerDir]);
    expect(short.code).toBe(1);
    const shortPayload = JSON.parse(short.stdout) as CliPayload;
    const shortDirectory = shortPayload.directories[0];
    if (shortDirectory === undefined)
      throw new Error("missing directory report");
    expect(shortDirectory.assets[0]?.code).toBe("ERR_IMAGE_HEADER_TRUNCATED");
    expect(shortDirectory.assets[0]?.requiredBytes).toBeGreaterThan(64);

    const ok = runCli(["--json", "--header-bytes=4096", headerDir]);
    expect(ok.code).toBe(0);
    const okPayload = JSON.parse(ok.stdout) as CliPayload;
    const okDirectory = okPayload.directories[0];
    if (okDirectory === undefined) throw new Error("missing directory report");
    expect(okDirectory.assets[0]).toMatchObject({
      type: "BunImageAssetDiagnostic",
      format: "jpeg",
      width: 120,
      height: 90,
    });
  } finally {
    rmSync(headerDir, { recursive: true, force: true });
  }
});

test("--header-bytes cannot be combined with --placeholders", () => {
  const result = runCli(["--header-bytes=24", "--placeholders", dir]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("cannot be combined with --placeholders");
});

test("positional file and glob inputs are expanded", () => {
  const single = runCli(["--json", join(dir, "a.png")]);
  expect(single.code).toBe(0);
  const singlePayload = JSON.parse(single.stdout) as CliPayload;
  const singleDirectory = singlePayload.directories[0];
  if (singleDirectory === undefined)
    throw new Error("missing directory report");
  expect(singleDirectory.count).toBe(1);
  expect(singleDirectory.assets[0]?.source).toBe("[REDACTED_DIR]/a.png");

  const glob = runCli(["--json", `${dir}/*.png`]);
  expect(glob.code).toBe(1); // c.png is not an image
  const globPayload = JSON.parse(glob.stdout) as CliPayload;
  const globDirectory = globPayload.directories[0];
  if (globDirectory === undefined) throw new Error("missing directory report");
  expect(globDirectory.count).toBe(3);

  const none = runCli(["--json", `${dir}/*.jpg`]);
  expect(none.code).toBe(0);
  const nonePayload = JSON.parse(none.stdout) as CliPayload;
  const noneDirectory = nonePayload.directories[0];
  if (noneDirectory === undefined) throw new Error("missing directory report");
  expect(noneDirectory.count).toBe(0);
  expect(noneDirectory.total).toBe(0);
});

test("--exclude removes matching names before the limit", () => {
  const result = runCli(["--json", "--exclude=c", "--limit=10", dir]);
  expect(result.code).toBe(0);
  const payload = JSON.parse(result.stdout) as CliPayload;
  expect(payload.exclude).toBe("c");
  const directory = payload.directories[0];
  if (directory === undefined) throw new Error("missing directory report");
  expect(directory.count).toBe(2);
  expect(directory.assets.map((asset) => asset.source)).toEqual([
    "[REDACTED_DIR]/a.png",
    "[REDACTED_DIR]/b.png",
  ]);
});

test("--budget-bytes fails only the over-budget asset", () => {
  const result = runCli(["--json", "--exclude=c", "--budget-bytes=100", dir]);
  expect(result.code).toBe(1);
  const payload = JSON.parse(result.stdout) as CliPayload;
  expect(payload.budgetBytes).toBe(100);
  const directory = payload.directories[0];
  if (directory === undefined) throw new Error("missing directory report");
  const assets = directory.assets;
  expect(assets.find((asset) => asset.source.endsWith("a.png"))?.type).toBe(
    "BunImageAssetDiagnostic",
  );
  expect(assets.find((asset) => asset.source.endsWith("b.png"))?.code).toBe(
    "ERR_ASSET_BUDGET_EXCEEDED",
  );
});

test("--max-dimension fails an oversized asset", async () => {
  const dimDir = mkdtempSync(join(tmpdir(), "sd-cli-dim-"));
  try {
    await makePng(join(dimDir, "wide.png"), 120, 90);
    const fail = runCli(["--json", "--max-dimension=100", dimDir]);
    expect(fail.code).toBe(1);
    const failPayload = JSON.parse(fail.stdout) as CliPayload;
    expect(failPayload.maxDimension).toBe(100);
    expect(failPayload.directories[0]?.assets[0]?.code).toBe(
      "ERR_ASSET_DIMENSION_EXCEEDED",
    );

    const pass = runCli(["--json", "--max-dimension=120", dimDir]);
    expect(pass.code).toBe(0);
    const passPayload = JSON.parse(pass.stdout) as CliPayload;
    expect(passPayload.directories[0]?.assets[0]?.type).toBe(
      "BunImageAssetDiagnostic",
    );
  } finally {
    rmSync(dimDir, { recursive: true, force: true });
  }
});

test("a thumbnail write failure exits 1 with an error code, not a host path", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-fail-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 60, 40);
    const blocker = join(thumbDir, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = runCli([
      "--json",
      "--thumbs=20",
      `--thumbs-dir=${join(blocker, "thumbs")}`,
      thumbDir,
    ]);
    expect(result.code).toBe(1);
    const payload = JSON.parse(result.stdout) as CliPayload;
    expect(payload.ok).toBe(false);
    expect(payload.failures).toBe(1);
    const directory = payload.directories[0];
    if (directory === undefined) throw new Error("missing directory report");
    const failed = directory.thumbnails[0];
    if (failed === undefined) throw new Error("missing thumbnail report");
    expect(failed.error).toBeDefined();
    expect(failed.error ?? "").not.toContain(thumbDir);
    expect(failed.error ?? "").toMatch(/^[A-Z_]+$/);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});
