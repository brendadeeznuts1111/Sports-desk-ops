/**
 * Language coverage ratchet.
 *
 * Every tracked file extension must declare how it is formatted, parsed or gated. Bun fmt
 * covers JS/TS/JSX/TSX, JSON/JSON5, Markdown, HTML, YAML and TOML; the other source languages
 * get a real syntax/parse check here. A new extension cannot enter the tree unclassified.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const COVERAGE: Readonly<Record<string, string>> = {
  ts: "bun fmt + oxlint + bun check + tests",
  tsx: "bun fmt + oxlint + bun check + tests",
  mts: "bun fmt + oxlint + bun check + tests",
  cts: "bun fmt + oxlint + bun check + tests",
  js: "bun fmt + oxlint + bun check + tests",
  jsx: "bun fmt + oxlint + bun check + tests",
  mjs: "bun fmt + oxlint + bun check + tests",
  cjs: "bun fmt + oxlint + bun check + tests",
  json: "bun fmt + schema/docs gates + JSON5.parse",
  json5: "Bun.JSON5.parse",
  jsonl: "Bun.JSONL.parseChunk",
  md: "bun fmt + test:docs + verify:docs",
  html: "bun fmt + check:innerhtml + check:fetch-init",
  css: "bun fmt",
  xml: "Bun.XML.parse",
  svg: "Bun.XML.parse + check:innerhtml",
  yml: "bun fmt + YAML parse",
  yaml: "bun fmt + YAML parse",
  toml: "bun fmt + Bun.TOML.parse",
  sh: "bash -n",
  py: "python3 compile",
  csv: "CSV width check + fixture tests",
  webp: "binary asset",
  png: "binary asset",
  jpg: "binary asset",
  jpeg: "binary asset",
  gif: "binary asset",
  ico: "binary asset",
  sha256: "checksum data",
  lock: "lockfile",
  cfg: "config",
  example: "template",
  npmrc: "config",
  gitignore: "config",
  "git-blame-ignore-revs": "config",
  "bun-version": "runtime pin",
  gitkeep: "placeholder",
  mmd: "Mermaid verification artifact",
  tla: "TLA+ verification artifact",
  plist: "launchd template (macOS operator)",
  txt: "plain text document",
};

const EXACT_FILES: Readonly<Record<string, string>> = {
  _headers: "Cloudflare Pages headers gate",
  "infra/pages/_headers": "Cloudflare Pages headers gate",
  "bin/dx": "bash -n",
};

function trackedFiles(): string[] {
  const result = Bun.spawnSync({
    cmd: ["git", "ls-files"],
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim().split("\n").filter(Boolean);
}

/** `bunfig.toml` → toml; `.gitignore` → gitignore; `_headers` → (none). */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "" || base === "." || base === "..") return "(none)";
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return base.slice(1);
  }
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "(none)";
}

const FILES = trackedFiles();

function filesWith(extension: string): string[] {
  return FILES.filter((path) => extensionOf(path) === extension);
}

describe("language coverage", () => {
  test("every tracked extension or extensionless file declares a format/gate", () => {
    const unknown = FILES.filter((path) => {
      const extension = extensionOf(path);
      return extension === "(none)"
        ? !(path in EXACT_FILES)
        : !(extension in COVERAGE);
    });
    expect([...new Set(unknown)].sort()).toEqual([]);
  });

  test("the declared format, lint and tag gates are wired in package.json", async () => {
    const pkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    expect(scripts["format:check"]).toBe("bun fmt --check");
    expect(scripts["lint:check"]).toContain("oxlint --deny-warnings");
    expect(scripts["check:innerhtml"]).toBe("bun run bin/check-innerhtml.ts");
    expect(scripts["check:fetch-init"]).toBe("bun run bin/check-fetch-init.ts");
    expect(scripts["verify:docs"]).toContain("check:spec-citations");
  });

  test("shell sources pass bash -n", () => {
    const failures: string[] = [];
    for (const path of FILES.filter(
      (candidate) => candidate.endsWith(".sh") || candidate === "bin/dx",
    )) {
      const result = Bun.spawnSync({
        cmd: ["bash", "-n", join(ROOT, path)],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        failures.push(`${path}: ${result.stderr.toString().trim()}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("python sources compile", () => {
    const python = Bun.which("python3");
    expect(python).not.toBeNull();
    const failures: string[] = [];
    for (const path of filesWith("py")) {
      const result = Bun.spawnSync({
        cmd: [
          python ?? "python3",
          "-c",
          "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')",
          join(ROOT, path),
        ],
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) {
        failures.push(`${path}: ${result.stderr.toString().trim()}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("JSON5, JSONL, XML/SVG, YAML and TOML files parse", async () => {
    const failures: string[] = [];
    for (const path of filesWith("json5")) {
      try {
        Bun.JSON5.parse(await Bun.file(join(ROOT, path)).text());
      } catch (error) {
        failures.push(`${path}: ${String(error)}`);
      }
    }
    for (const path of filesWith("jsonl")) {
      const parsed = Bun.JSONL.parseChunk(
        await Bun.file(join(ROOT, path)).text(),
      );
      if (!parsed.done || parsed.error !== null) {
        failures.push(`${path}: ${String(parsed.error ?? "truncated")}`);
      }
    }
    for (const extension of ["xml", "svg"]) {
      for (const path of filesWith(extension)) {
        try {
          // Bytes, not text: Bun.XML decodes the BOM/encoding declaration itself.
          const node = Bun.XML.parse(await Bun.file(join(ROOT, path)).bytes(), {
            compact: false,
          });
          const serialized = Bun.XML.stringify(node);
          if (serialized === undefined) {
            failures.push(`${path}: XML.stringify returned undefined`);
            continue;
          }
          const roundTrip = Bun.XML.parse(serialized, { compact: false });
          if (!Bun.deepEquals(node, roundTrip)) {
            failures.push(`${path}: XML.stringify round-trip changed the tree`);
          }
        } catch (error) {
          failures.push(`${path}: ${String(error)}`);
        }
      }
    }
    for (const extension of ["yml", "yaml"]) {
      for (const path of filesWith(extension)) {
        try {
          Bun.YAML.parse(await Bun.file(join(ROOT, path)).text());
        } catch (error) {
          failures.push(`${path}: ${String(error)}`);
        }
      }
    }
    for (const path of filesWith("toml")) {
      try {
        Bun.TOML.parse(await Bun.file(join(ROOT, path)).text());
      } catch (error) {
        failures.push(`${path}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("CSV fixtures keep a rectangular shape", async () => {
    const failures: string[] = [];
    for (const path of filesWith("csv")) {
      const lines = (await Bun.file(join(ROOT, path)).text())
        .trimEnd()
        .split("\n");
      const width = lines[0]?.split(",").length ?? 0;
      for (const [index, line] of lines.entries()) {
        if (line.split(",").length !== width) {
          failures.push(`${path}:${index + 1} has a different column count`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
