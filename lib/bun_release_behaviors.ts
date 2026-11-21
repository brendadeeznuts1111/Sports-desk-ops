/**
 * @file lib/bun_release_behaviors.ts
 * @description Derive the measured Bun release-behavior registry from its two real anchors.
 *
 * A behavior is declared next to the artifact that proves it:
 *   - `docs/bun-upstream-reference.md`: `<!-- bun-behavior: <id> -->` immediately above the
 *     section heading (the heading becomes `docSection`)
 *   - a contract test: `// @bun-behavior: <id>` in the file header (one line per behavior).
 *     Keep it off line 1: on Bun 1.4.4 a leading `// @...` line makes the file parse as JavaScript.
 *
 * Only the metadata that cannot be derived (human title, docs page, shape names) stays in the
 * overlay below. `readBunReleaseBehaviors` merges the three and fails closed when an id appears
 * in one place but not the others.
 */

import { join } from "node:path";

export interface BunReleaseBehavior {
  /** Stable id shared by the doc marker and the test annotation. */
  readonly id: string;
  readonly title: string;
  /** Exact heading text in `docs/bun-upstream-reference.md`. */
  readonly docSection: string;
  /** Bun docs MCP page path when the behavior has a docs page. */
  readonly docsPage: string | null;
  /** Contract tests that carry `@bun-behavior: <id>`. */
  readonly contractTests: readonly string[];
  /** `BUN_SHAPES` names whose docs coverage backs the behavior. */
  readonly shapes: readonly string[];
}

interface BehaviorMetadata {
  readonly title: string;
  readonly docsPage: string | null;
  readonly shapes: readonly string[];
}

/** Human metadata only; ids, doc sections and contract tests are derived. */
const BEHAVIOR_METADATA: Readonly<Record<string, BehaviorMetadata>> = {
  "xml-parse": {
    title: "Bun.XML parse/stringify",
    docsPage: "/docs/runtime/xml",
    shapes: ["XML"],
  },
  "bun-x-catalog": {
    title: "bun x bin catalogue and help contract",
    docsPage: "/docs/cli/bunx",
    shapes: [],
  },
  "package-catalogs": {
    title: "catalog: ranges and Yarn Berry migration",
    docsPage: "/docs/install/catalogs",
    shapes: [],
  },
  "install-flags": {
    title: "npm/Yarn/pnpm flag translation and rejection",
    docsPage: "/docs/cli/install",
    shapes: [],
  },
  "semver-wildcards": {
    title: "Bun.semver.satisfies wildcards and the 2^64 ceiling",
    docsPage: "/docs/runtime/semver",
    shapes: ["semver"],
  },
  "bun-fmt": {
    title: "bun fmt check/edit contract",
    docsPage: "/guides/format/migrate-from-oxfmt",
    shapes: [],
  },
  "bun-test-api": {
    title: "bun:test API surface",
    docsPage: "/reference/bun/test",
    shapes: [],
  },
  "bun-test-runner": {
    title: "bun test runner knobs",
    docsPage: "/docs/test",
    shapes: [],
  },
  "bun-test-writing": {
    title: "writing tests: timeouts, retries and modifiers",
    docsPage: "/docs/test",
    shapes: [],
  },
  "bun-test-config": {
    title: "bunfig.toml [test] configuration",
    docsPage: "/docs/test/configuration",
    shapes: [],
  },
  "bun-test-runtime": {
    title: "test runtime integration and environment defaults",
    docsPage: "/docs/test/runtime",
    shapes: [],
  },
  "bun-test-coverage-and-snapshots": {
    title:
      "bun test --coverage accounting, lcov DA hit counts, --update-snapshots --bail preservation, and --changed scoping",
    docsPage: "/docs/test/code-coverage",
    shapes: [],
  },
  "publish-recursive": {
    title: "bun publish --recursive workspace publishing",
    docsPage: "/docs/cli/publish",
    shapes: [],
  },
  "link-paths": {
    title: "link: path dependencies",
    docsPage: "/docs/cli/link",
    shapes: [],
  },
  "bunx-cwd-env-file": {
    title: "bunx --cwd and --env-file",
    docsPage: "/docs/cli/bunx",
    shapes: [],
  },
  "bunx-minimum-release-age": {
    title: "bunx --minimum-release-age on downloaded packages",
    docsPage: "/docs/cli/bunx",
    shapes: [],
  },
  "bunx-trust": {
    title: "bunx --trust lifecycle scripts",
    docsPage: "/docs/cli/bunx",
    shapes: [],
  },
  "deprecated-packages": {
    title: "bun add deprecated-package warnings and resolution",
    docsPage: "/docs/cli/add",
    shapes: [],
  },
  "package-extensions": {
    title: "packageExtensions for undeclared dependencies",
    docsPage: "/docs/install/lifecycle",
    shapes: [],
  },
  "minimum-release-age": {
    title: "minimumReleaseAge units and exclusions",
    docsPage: "/docs/install/lifecycle",
    shapes: [],
  },
  "install-resolution-and-lockb": {
    title:
      "bun install version-selection edge cases and mutated bun.lockb resilience",
    docsPage: "/docs/cli/install",
    shapes: [],
  },
  "serve-static-vs-file-routes": {
    title:
      "Bun.serve static buffered (.bytes()) vs file-backed (Bun.file()) routes",
    docsPage: "/docs/api/http",
    shapes: ["serve"],
  },
  "serve-directory-routes": {
    title:
      "Bun.serve directory routes ({ dir, statCache }): canonical paths, If-Range, case sensitivity, and macOS symlink drift",
    docsPage: "/docs/runtime/http/routing",
    shapes: ["serve"],
  },
  "websocket-client-options": {
    title:
      "WebSocket client options (protocols, headers, tls, proxy, proxy.tls isolation, perMessageDeflate)",
    docsPage: "/reference/bun/WebSocketOptions",
    shapes: ["WebSocket"],
  },
  "terminal-write-buffer-source": {
    title:
      "Bun.Terminal.write(string | BufferSource): UTF-8/byteLength returns, view slicing, SharedArrayBuffer, internal buffering/drain, and closed/invalid refusals",
    docsPage: "/reference/bun/Terminal/write",
    shapes: ["Terminal"],
  },
  "formats-and-utilities": {
    title:
      "Built-in Formats (YAML/TOML/JSON5/JSONC/JSONL/markdown, native config imports) and core Bun.* utilities (escapeHTML, ANSI/color, deepEquals/deepMatch, peek, UUIDv5/v7, zstd, binary/stream helpers, cookies)",
    docsPage: "/docs/runtime/utils",
    shapes: [
      "YAML",
      "TOML",
      "JSON5",
      "JSONC",
      "JSONL",
      "markdown",
      "escapeHTML",
      "stringWidth",
      "stripANSI",
      "wrapAnsi",
      "sliceAnsi",
      "color",
      "deepEquals",
      "deepMatch",
      "peek",
      "randomUUIDv7",
      "randomUUIDv5",
      "zstdCompressSync",
      "concatArrayBuffers",
      "ArrayBufferSink",
      "readableStreamToFormData",
      "Cookie",
      "CookieMap",
    ],
  },
  "bun-s3-globals": {
    title: "Bun s3 / S3Client default export, presign, and lazy S3File",
    docsPage: "/docs/runtime/s3",
    shapes: ["s3", "S3Client"],
  },
  "bun-shell-globals": {
    title:
      "Bun $ shell escaping, streaming redirection, and tooling-only policy",
    docsPage: "/docs/runtime/shell",
    shapes: ["$"],
  },
  "bun-sql-globals": {
    title:
      "Bun sql / SQL tagged template parameterization, identifiers, and transactions",
    docsPage: "/docs/runtime/sql",
    shapes: ["sql", "SQL"],
  },
  "blob-image-pipeline": {
    title: "FileBlob.image() lazy decode, resize, encode and write",
    docsPage: "/reference/bun/FileBlob",
    shapes: ["Image"],
  },
};

const DOC_PATH = "docs/bun-upstream-reference.md";
const DOC_MARKER = /^<!-- bun-behavior: ([a-z0-9-]+) -->$/;
const TEST_TAG = /@bun-behavior:\s*([a-z0-9-]+)/g;
const TEST_GLOB = "tests/*.test.ts";

/** Marker id → the heading immediately below it. */
export function parseBehaviorDocSections(
  markdown: string,
): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  const lines = markdown.split("\n");
  for (let index = 0; index < lines.length - 1; index++) {
    const marker = DOC_MARKER.exec(lines[index]?.trim() ?? "");
    if (marker === null) continue;
    const id = marker[1] as string;
    // Markdown formatters insert a blank line between an HTML comment and the heading.
    let cursor = index + 1;
    while (cursor < lines.length && (lines[cursor]?.trim() ?? "") === "") {
      cursor += 1;
    }
    const heading = lines[cursor]?.trim() ?? "";
    if (!/^#{2,3} /.test(heading)) {
      throw new Error(
        `ERR_BEHAVIOR_DOC_MARKER_NO_HEADING: ${id} must be followed by a section heading`,
      );
    }
    if (sections.has(id)) {
      throw new Error(`ERR_BEHAVIOR_DOC_MARKER_DUPLICATE: ${id}`);
    }
    sections.set(id, heading);
  }
  return sections;
}

/** Behavior id → tracked contract-test paths that carry its tag. */
export function parseBehaviorTestTags(
  files: ReadonlyMap<string, string>,
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map<string, string[]>();
  for (const [path, text] of files) {
    for (const match of text.matchAll(TEST_TAG)) {
      const id = match[1] as string;
      const list = byId.get(id) ?? [];
      if (!list.includes(path)) list.push(path);
      byId.set(id, list);
    }
  }
  return new Map(
    [...byId.entries()].map(([id, paths]) => [id, [...paths].sort()]),
  );
}

async function readContractTestSources(
  root: string,
): Promise<ReadonlyMap<string, string>> {
  const files = new Map<string, string>();
  for (const relativePath of new Bun.Glob(TEST_GLOB).scanSync({
    cwd: root,
    onlyFiles: true,
  })) {
    files.set(relativePath, await Bun.file(join(root, relativePath)).text());
  }
  return files;
}

/**
 * Merge doc markers, test annotations and the metadata overlay. Fails when an id appears in one
 * source but not the others, so a renamed test or removed heading cannot silently drop a row.
 */
export async function readBunReleaseBehaviors(
  root: string,
): Promise<readonly BunReleaseBehavior[]> {
  const doc = await Bun.file(join(root, DOC_PATH)).text();
  const sections = parseBehaviorDocSections(doc);
  const tests = parseBehaviorTestTags(await readContractTestSources(root));

  const ids = new Set<string>([
    ...sections.keys(),
    ...tests.keys(),
    ...Object.keys(BEHAVIOR_METADATA),
  ]);

  const rows: BunReleaseBehavior[] = [];
  for (const id of [...ids].sort()) {
    const metadata = BEHAVIOR_METADATA[id];
    const docSection = sections.get(id);
    const contractTests = tests.get(id) ?? [];
    if (metadata === undefined) {
      throw new Error(`ERR_BEHAVIOR_METADATA_MISSING: ${id}`);
    }
    if (docSection === undefined) {
      throw new Error(`ERR_BEHAVIOR_DOC_MARKER_MISSING: ${id}`);
    }
    if (contractTests.length === 0) {
      throw new Error(`ERR_BEHAVIOR_TEST_TAG_MISSING: ${id}`);
    }
    rows.push({
      id,
      title: metadata.title,
      docSection,
      docsPage: metadata.docsPage,
      contractTests,
      shapes: metadata.shapes,
    });
  }
  return rows;
}
