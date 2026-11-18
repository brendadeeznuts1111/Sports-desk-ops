/**
 * @file tests/image_asset_diagnostics_cli.test.ts
 * @description `bun run assets:diagnostics` prints Bun.Image attributes, honors the visibility
 * tier, reports truncation honestly and exits non-zero when a file cannot be decoded.
 */
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DEFAULT_ASSET_LIMIT,
  DEFAULT_MAX_ASSET_BYTES,
} from "../lib/bun_image_assets.ts";
import {
  DEFAULT_THUMBNAIL_EDGE,
  thumbnailDestination,
} from "../lib/bun_thumbnail.ts";
import { formatByteCount } from "../lib/format_bytes.ts";
import {
  FLAG_SPECS,
  TOOL_VERSION,
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

const CLI_ENTRY = join(
  import.meta.dir,
  "..",
  "scripts",
  "image_asset_diagnostics.ts",
);

function runCli(args: readonly string[], cwd?: string): CliRun {
  const child = Bun.spawnSync([process.execPath, CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd === undefined ? {} : { cwd }),
  });
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
  readonly skipped?: boolean;
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

interface CliBaselineDrift {
  readonly compared: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
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
  readonly baseline: CliBaselineDrift | null;
  readonly baselineError: string | null;
  readonly baselineWritten: string | null;
  readonly failures: number;
  readonly thumbnails: {
    readonly enabled: boolean;
    readonly mode?: string;
    readonly force?: boolean;
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

test("--thumbs skips a fresh destination and --thumbs-force rewrites it", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-fresh-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);

    const first = runCli(["--json", "--thumbs=40", thumbDir]);
    expect(first.code).toBe(0);
    const firstPayload = JSON.parse(first.stdout) as CliPayload;
    const firstThumb = firstPayload.directories[0]?.thumbnails[0];
    if (firstThumb === undefined) throw new Error("missing thumbnail report");
    expect(firstThumb.skipped).toBeUndefined();
    expect(firstThumb.width).toBe(40);

    const second = runCli(["--json", "--thumbs=40", thumbDir]);
    expect(second.code).toBe(0);
    const secondPayload = JSON.parse(second.stdout) as CliPayload;
    const secondThumb = secondPayload.directories[0]?.thumbnails[0];
    if (secondThumb === undefined) throw new Error("missing thumbnail report");
    expect(secondThumb.skipped).toBe(true);
    expect(secondThumb.bytes).toBeUndefined();
    expect(secondPayload.thumbnails.mode).toBe("write");

    const forced = runCli([
      "--json",
      "--thumbs=40",
      "--thumbs-force",
      thumbDir,
    ]);
    expect(forced.code).toBe(0);
    const forcedPayload = JSON.parse(forced.stdout) as CliPayload;
    const forcedThumb = forcedPayload.directories[0]?.thumbnails[0];
    if (forcedThumb === undefined) throw new Error("missing thumbnail report");
    expect(forcedThumb.skipped).toBeUndefined();
    expect(forcedThumb.width).toBe(40);
    expect(forcedPayload.thumbnails.force).toBe(true);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--thumbs-check reports missing and stale thumbnails without writing", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-check-"));
  try {
    const source = join(thumbDir, "wide.png");
    await makePng(source, 120, 90);

    const missing = runCli([
      "--json",
      "--thumbs=40",
      "--thumbs-check",
      thumbDir,
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stdout) as CliPayload;
    expect(missingPayload.thumbnails.mode).toBe("check");
    expect(missingPayload.directories[0]?.thumbnails[0]?.error).toBe(
      "ERR_THUMBNAIL_MANIFEST_MISSING",
    );

    expect(runCli(["--thumbs=40", thumbDir]).code).toBe(0);

    const fresh = runCli(["--json", "--thumbs=40", "--thumbs-check", thumbDir]);
    expect(fresh.code).toBe(0);
    const freshPayload = JSON.parse(fresh.stdout) as CliPayload;
    expect(freshPayload.directories[0]?.thumbnails[0]?.skipped).toBe(true);

    const future = new Date(Date.now() + 5_000);
    utimesSync(source, future, future);
    const stale = runCli(["--json", "--thumbs=40", "--thumbs-check", thumbDir]);
    expect(stale.code).toBe(1);
    const stalePayload = JSON.parse(stale.stdout) as CliPayload;
    expect(stalePayload.directories[0]?.thumbnails[0]?.error).toBe(
      "ERR_THUMBNAIL_STALE",
    );
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--thumbs-check and --thumbs-force require --thumbs", () => {
  for (const flag of ["--thumbs-check", "--thumbs-force"]) {
    const result = runCli([flag, dir]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`${flag} requires --thumbs`);
  }
});

test("--write-baseline writes a bun-fmt-clean artifact and --baseline compares it", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "sd-cli-baseline-"));
  try {
    const source = join(baseDir, "wide.png");
    await makePng(source, 120, 90);
    const baselinePath = join(baseDir, "baseline.json");

    const write = runCli([
      "--json",
      `--write-baseline=${baselinePath}`,
      baseDir,
    ]);
    expect(write.code).toBe(0);
    const writePayload = JSON.parse(write.stdout) as CliPayload;
    expect(writePayload.baselineWritten).toBe(baselinePath);
    expect(writePayload.baseline).toBeNull();
    expect(await Bun.file(baselinePath).exists()).toBe(true);

    const formatted = Bun.spawnSync(
      [process.execPath, "fmt", "--check", baselinePath],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(formatted.exitCode).toBe(0);

    const clean = runCli(["--json", `--baseline=${baselinePath}`, baseDir]);
    expect(clean.code).toBe(0);
    const cleanPayload = JSON.parse(clean.stdout) as CliPayload;
    expect(cleanPayload.baseline).toMatchObject({
      compared: 1,
      added: [],
      removed: [],
      changed: [],
    });

    await makePng(source, 60, 40);
    const changed = runCli(["--json", `--baseline=${baselinePath}`, baseDir]);
    expect(changed.code).toBe(1);
    const changedPayload = JSON.parse(changed.stdout) as CliPayload;
    expect(changedPayload.baseline?.changed.length).toBe(1);

    writeFileSync(join(baseDir, "extra.png"), png1x1());
    const added = runCli(["--json", `--baseline=${baselinePath}`, baseDir]);
    expect(added.code).toBe(1);
    const addedPayload = JSON.parse(added.stdout) as CliPayload;
    expect(addedPayload.baseline?.added.length).toBe(1);

    const noFail = runCli([
      "--json",
      `--baseline=${baselinePath}`,
      "--no-fail",
      baseDir,
    ]);
    expect(noFail.code).toBe(0);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("--baseline compares from any cwd, not just the one that wrote it", async () => {
  // Same defect class as the thumbnail manifest key: a cwd-relative key means a
  // baseline written higher up the tree cannot be compared from a subdirectory.
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "sd-cli-baseline-cwd-")),
  );
  const assets = join(parent, "assets");
  try {
    mkdirSync(assets, { recursive: true });
    await makePng(join(assets, "wide.png"), 120, 90);
    const baselinePath = join(assets, "baseline.json");

    expect(
      runCli(["--json", `--write-baseline=${baselinePath}`, assets], parent)
        .code,
    ).toBe(0);
    const keys = Object.keys(
      (
        (await Bun.file(baselinePath).json()) as {
          assets: Record<string, unknown>;
        }
      ).assets,
    ).sort();
    expect(keys).toEqual(["wide.png"]);

    const fromParent = runCli(
      ["--json", `--baseline=${baselinePath}`, assets],
      parent,
    );
    expect(fromParent.code).toBe(0);
    expect(
      (JSON.parse(fromParent.stdout) as CliPayload).baseline,
    ).toMatchObject({
      compared: 1,
      added: [],
      removed: [],
      changed: [],
    });

    const fromChild = runCli(
      ["--json", `--baseline=${baselinePath}`, assets],
      assets,
    );
    expect(fromChild.code).toBe(0);
    expect((JSON.parse(fromChild.stdout) as CliPayload).baseline).toMatchObject(
      {
        compared: 1,
        added: [],
        removed: [],
        changed: [],
      },
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("--baseline reports a missing artifact and removed assets", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "sd-cli-baseline-removed-"));
  try {
    const source = join(baseDir, "wide.png");
    await makePng(source, 120, 90);
    const baselinePath = join(baseDir, "baseline.json");
    expect(
      runCli(["--json", `--write-baseline=${baselinePath}`, baseDir]).code,
    ).toBe(0);

    rmSync(source);
    const removed = runCli(["--json", `--baseline=${baselinePath}`, baseDir]);
    expect(removed.code).toBe(1);
    const removedPayload = JSON.parse(removed.stdout) as CliPayload;
    expect(removedPayload.baseline?.removed.length).toBe(1);

    const missing = runCli([
      "--json",
      `--baseline=${join(baseDir, "absent.json")}`,
      baseDir,
    ]);
    expect(missing.code).toBe(1);
    const missingPayload = JSON.parse(missing.stdout) as CliPayload;
    expect(missingPayload.baseline).toBeNull();
    expect(missingPayload.baselineError).toBe("ERR_ASSET_BASELINE_MISSING");

    const both = runCli([
      `--baseline=${baselinePath}`,
      `--write-baseline=${baselinePath}`,
      baseDir,
    ]);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("mutually exclusive");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("--thumbs writes a manifest artifact and leaves it untouched when nothing changes", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-manifest-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);
    expect(runCli(["--json", "--thumbs=40", thumbDir]).code).toBe(0);

    const manifestPath = join(thumbDir, ".thumbs", "manifest.json");
    expect(await Bun.file(manifestPath).exists()).toBe(true);
    const manifest = (await Bun.file(manifestPath).json()) as {
      version: number;
      maxEdge: number;
      quality: number;
      backend: string;
      entries: Record<
        string,
        { width: number; height: number; bytes: number; hash: string }
      >;
    };
    expect(manifest).toMatchObject({
      version: 2,
      maxEdge: 40,
      quality: 80,
      backend: "bun",
    });
    const entries = Object.values(manifest.entries);
    expect(entries.length).toBe(1);
    expect(entries[0]?.width).toBe(40);
    expect(entries[0]?.height).toBe(30);
    expect(entries[0]?.bytes).toBeGreaterThan(0);
    expect(entries[0]?.hash).toMatch(/^[0-9a-f]+$/);

    const before = await Bun.file(manifestPath).text();
    expect(runCli(["--json", "--thumbs=40", thumbDir]).code).toBe(0);
    expect(await Bun.file(manifestPath).text()).toBe(before);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--thumbs keys the manifest on the artifact directory, not the cwd", async () => {
  // The asset must live *inside* the invocation directory for the old
  // cwd-relative key to differ: `parent` is above it, `nested` is below it, so
  // the same file was `assets/wide.png`, `../wide.png` and `wide.png`.
  const parent = realpathSync(
    mkdtempSync(join(tmpdir(), "sd-cli-thumbs-cwd-")),
  );
  const thumbDir = join(parent, "assets");
  try {
    mkdirSync(join(thumbDir, "nested"), { recursive: true });
    await makePng(join(thumbDir, "wide.png"), 120, 90);

    const manifestPath = join(thumbDir, ".thumbs", "manifest.json");
    const readKeys = async (): Promise<string[]> =>
      Object.keys(
        (
          (await Bun.file(manifestPath).json()) as {
            entries: Record<string, unknown>;
          }
        ).entries,
      ).sort();

    expect(runCli(["--json", "--thumbs=40", thumbDir], parent).code).toBe(0);
    expect(await readKeys()).toEqual(["wide.png"]);

    // Same manifest, invoked from a subdirectory: the key must not move, and the
    // check must not report the thumbnail missing.
    const fromNested = runCli(
      ["--json", "--thumbs=40", "--thumbs-check", thumbDir],
      join(thumbDir, "nested"),
    );
    expect(fromNested.code).toBe(0);

    // A rewrite from another cwd updates the one entry instead of adding a second.
    expect(runCli(["--json", "--thumbs=40", thumbDir], thumbDir).code).toBe(0);
    expect(await readKeys()).toEqual(["wide.png"]);
    expect(runCli(["--json", "--thumbs=40", thumbDir], parent).code).toBe(0);
    expect(await readKeys()).toEqual(["wide.png"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("--thumbs prunes entries for deleted sources, but never on a --limit run", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-prune-"));
  try {
    await makePng(join(thumbDir, "wide.png"), 120, 90);
    await makePng(join(thumbDir, "tall.png"), 60, 120);
    const manifestPath = join(thumbDir, ".thumbs", "manifest.json");
    const readKeys = async (): Promise<string[]> =>
      Object.keys(
        (
          (await Bun.file(manifestPath).json()) as {
            entries: Record<string, unknown>;
          }
        ).entries,
      ).sort();

    expect(runCli(["--json", "--thumbs=40", thumbDir]).code).toBe(0);
    expect(await readKeys()).toEqual(["tall.png", "wide.png"]);

    // A partial scan saw one of two files: pruning here would delete a live entry.
    expect(runCli(["--json", "--thumbs=40", "--limit=1", thumbDir]).code).toBe(
      0,
    );
    expect(await readKeys()).toEqual(["tall.png", "wide.png"]);

    // So would a filter that legitimately matches only one of them.
    const filtered = runCli([
      "--json",
      "--thumbs=40",
      "--filter=wide",
      thumbDir,
    ]);
    expect(filtered.code).toBe(0);
    expect(
      (JSON.parse(filtered.stdout) as CliPayload).directories[0]?.assets.length,
    ).toBe(1);
    expect(await readKeys()).toEqual(["tall.png", "wide.png"]);

    // And an explicit path list is a subset by definition.
    expect(
      runCli(["--json", "--thumbs=40", thumbDir, join(thumbDir, "wide.png")])
        .code,
    ).toBe(0);
    expect(await readKeys()).toEqual(["tall.png", "wide.png"]);

    // The deleted source is an orphan even though the survivor is still fresh.
    rmSync(join(thumbDir, "tall.png"));
    expect(runCli(["--json", "--thumbs=40", thumbDir]).code).toBe(0);
    expect(await readKeys()).toEqual(["wide.png"]);
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--thumbs-check catches config drift and a corrupted artifact", async () => {
  const thumbDir = mkdtempSync(join(tmpdir(), "sd-cli-thumbs-mismatch-"));
  try {
    const source = join(thumbDir, "wide.png");
    await makePng(source, 120, 90);
    expect(runCli(["--thumbs=40", thumbDir]).code).toBe(0);

    const drift = runCli(["--json", "--thumbs=32", "--thumbs-check", thumbDir]);
    expect(drift.code).toBe(1);
    const driftPayload = JSON.parse(drift.stdout) as CliPayload;
    expect(driftPayload.directories[0]?.thumbnails[0]?.error).toBe(
      "ERR_THUMBNAIL_CONFIG_DRIFT",
    );

    const thumbPath = thumbnailDestination(
      thumbDir,
      source,
      join(thumbDir, ".thumbs"),
    );
    writeFileSync(
      thumbPath,
      Uint8Array.from([...(await Bun.file(thumbPath).bytes()), 0]),
    );
    const corrupt = runCli([
      "--json",
      "--thumbs=40",
      "--thumbs-check",
      thumbDir,
    ]);
    expect(corrupt.code).toBe(1);
    const corruptPayload = JSON.parse(corrupt.stdout) as CliPayload;
    expect(corruptPayload.directories[0]?.thumbnails[0]?.error).toBe(
      "ERR_THUMBNAIL_HASH_MISMATCH",
    );
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
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
    expect(payload.failures).toBe(2);
    const directory = payload.directories[0];
    if (directory === undefined) throw new Error("missing directory report");
    expect(directory.thumbnails.length).toBe(2);
    for (const failed of directory.thumbnails) {
      expect(failed.error).toBeDefined();
      expect(failed.error ?? "").not.toContain(thumbDir);
      expect(failed.error ?? "").toMatch(/^[A-Z_]+$/);
    }
  } finally {
    rmSync(thumbDir, { recursive: true, force: true });
  }
});

test("--markdown renders a table and escapes pipes", async () => {
  const mdDir = mkdtempSync(join(tmpdir(), "sd-cli-md-"));
  try {
    writeFileSync(join(mdDir, "a.png"), png1x1());
    writeFileSync(join(mdDir, "pipe|name.png"), png1x1());
    writeFileSync(join(mdDir, "broken.png"), "not an image");

    const result = runCli(["--markdown", "--limit=10", mdDir]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("# Image assets");
    expect(result.stdout).toContain(
      "| Source | Format | Dimensions | Bytes | Status |",
    );
    expect(result.stdout).toContain("pipe\\|name.png");
    expect(result.stdout).toContain("ERR_IMAGE_UNKNOWN_FORMAT");
    expect(result.stdout).not.toContain("\x1b");
  } finally {
    rmSync(mdDir, { recursive: true, force: true });
  }
});

test("--markdown includes thumbnail and baseline sections", async () => {
  const mdDir = mkdtempSync(join(tmpdir(), "sd-cli-md-thumbs-"));
  try {
    await makePng(join(mdDir, "wide.png"), 120, 90);
    const baselinePath = join(mdDir, "baseline.json");

    const written = runCli([
      "--markdown",
      "--thumbs=40",
      `--write-baseline=${baselinePath}`,
      mdDir,
    ]);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain("### Thumbnails");
    expect(written.stdout).toContain("| written |");
    expect(written.stdout).toContain("Baseline written");

    const compared = runCli([
      "--markdown",
      `--baseline=${baselinePath}`,
      mdDir,
    ]);
    expect(compared.code).toBe(0);
    expect(compared.stdout).toContain(
      "Baseline drift · compared=1 added=0 removed=0 changed=0",
    );

    const conflict = runCli(["--markdown", "--json", mdDir]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("mutually exclusive");
  } finally {
    rmSync(mdDir, { recursive: true, force: true });
  }
});
