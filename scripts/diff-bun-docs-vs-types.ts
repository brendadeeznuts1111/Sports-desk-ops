// scripts/diff-bun-docs-vs-types.ts
// Usage:
//   bun run scripts/diff-bun-docs-vs-types.ts
//   R2_SNAPSHOT=1 bun run scripts/diff-bun-docs-vs-types.ts --strict

import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const LLMS_URL = "https://bun.sh/llms.txt";
const STRICT = Bun.argv.includes("--strict");
const WRITE_R2 = Bun.env.R2_SNAPSHOT === "1";

interface LlmsLink {
  title: string;
  url: string;
  normalizedUrl: string;
}

interface TargetSpec {
  id: "Bun.Image" | "S3File";
  linkPattern: RegExp;
  typeBlockPatterns: RegExp[];
  /** Bare or static calls the docs write without a receiver (no generic `.foo()` rule). */
  docExtraPatterns?: RegExp[];
  getRuntimeMembers: () => Set<string>;
}

const TARGETS: TargetSpec[] = [
  {
    id: "Bun.Image",
    linkPattern: /\b(bun\.image|\/image(\.md|\/|$)|image\s+api)\b/i,
    typeBlockPatterns: [
      /\b(?:export\s+)?class\s+Image\b[^{]*\{/g,
      /\b(?:export\s+)?interface\s+Image\b[^{]*\{/g,
    ],
    docExtraPatterns: [
      /\b(?:clipboardChangeCount|hasClipboardImage|metadata|placeholder)\(\)/g,
    ],
    getRuntimeMembers: () => {
      const ctor = (Bun as Record<string, unknown>).Image as
        { prototype?: object } | undefined;
      if (!ctor) return new Set();
      return new Set([
        ...Object.getOwnPropertyNames(ctor).filter(
          (k) => !["length", "name", "prototype"].includes(k),
        ),
        ...(ctor.prototype
          ? Object.getOwnPropertyNames(ctor.prototype).filter(
              (k) => k !== "constructor",
            )
          : []),
      ]);
    },
  },
  {
    id: "S3File",
    linkPattern: /\b(s3file|\/s3(\.md|\/|$)|s3\s+api)\b/i,
    // S3File extends Blob, so its declared type surface includes the Blob members too.
    typeBlockPatterns: [
      /\b(?:export\s+)?interface\s+S3File\b[^{]*\{/g,
      /\binterface\s+Blob\b[^{]*\{/g,
    ],
    getRuntimeMembers: () => {
      try {
        const probe = Bun.s3.file("__ast_probe__");
        const proto = Object.getPrototypeOf(probe);
        if (!proto) return new Set();
        return new Set(
          Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor"),
        );
      } catch {
        return new Set();
      }
    },
  },
];

// 1. Fetch & SHA-256 snapshot bun.sh/llms.txt
async function fetchLlmsSnapshot() {
  const res = await fetch(LLMS_URL, {
    headers: { Accept: "text/plain;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`llms.txt fetch failed: ${res.status} ${res.statusText}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const text = new TextDecoder().decode(bytes);

  const r2Key = `snapshots/bun-llms/${sha256}.txt`;
  if (WRITE_R2) {
    await Bun.s3.file(r2Key).write(bytes, {
      type: "text/plain; charset=utf-8",
    });
  }

  const links: LlmsLink[] = [];
  for (const [, title, url] of text.matchAll(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
  )) {
    if (title === undefined || url === undefined) continue;
    links.push({
      title: title.trim(),
      url,
      normalizedUrl: url.replace(/\/index\.md$/, ".md"),
    });
  }

  return {
    sha256,
    bytes: bytes.byteLength,
    deployment: res.headers.get("x-version") ?? "unknown",
    mintlify: res.headers.get("x-mintlify-client-version") ?? "unknown",
    r2Key: WRITE_R2 ? r2Key : null,
    links,
  };
}

/**
 * Markdown parser options passed to `Bun.markdown.render()` for doc extraction.
 * Disables raw HTML blocks/spans so MDX tags (e.g. `<Tabs><Tab>`) do not hide nested
 * code fences/spans, while keeping GFM tables enabled for API summary tables.
 */
export const DOC_MARKDOWN_PARSE_OPTIONS = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: false,
  headings: false,
  tagFilter: false,
} as const satisfies Bun.markdown.Options;

const RECEIVER_BACKTICK_MEMBER_RE =
  /^(?:Bun\.Image|image|img|s3file|s3File|file)\.([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\(\))?$/;
const RECEIVER_CALL_RE =
  /\b(?:Bun\.Image|Image|img|image|myImage|s3file|s3File|file|myFile)\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
const NON_MEMBER_FILE_EXTS = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "js",
  "json",
  "jsx",
  "md",
  "png",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "webp",
  "yaml",
]);

function collectPatterns(
  source: string,
  extraPatterns: readonly RegExp[],
  members: Set<string>,
): void {
  RECEIVER_CALL_RE.lastIndex = 0;
  for (const [, name] of source.matchAll(RECEIVER_CALL_RE)) {
    if (name !== undefined) members.add(name);
  }
  for (const re of extraPatterns) {
    re.lastIndex = 0;
    for (const [match] of source.matchAll(re)) {
      // Target-owned patterns name the member literally; take the last identifier token.
      const name = match.match(/[a-zA-Z_$][a-zA-Z0-9_$]*(?=\(\))/g)?.at(-1);
      if (name !== undefined) members.add(name);
    }
  }
}

/**
 * Extracts documented member identifiers from a Markdown document by walking
 * `Bun.markdown.render()` AST callbacks (`code`, `codespan`, `heading`) rather
 * than regex-scanning raw prose.
 */
export function extractDocMembersFromMarkdown(
  md: string,
  extraPatterns: readonly RegExp[] = [],
): Set<string> {
  const members = new Set<string>();

  // trusted-markdown: parser pass over docs markdown; every callback returns "" (no output).
  Bun.markdown.render(
    md,
    {
      code(children) {
        collectPatterns(children, extraPatterns, members);
        return "";
      },
      codespan(children) {
        const trimmed = children.trim();
        const backtickMatch = trimmed.match(RECEIVER_BACKTICK_MEMBER_RE);
        if (backtickMatch?.[1] !== undefined) {
          const hasParens = trimmed.endsWith("()");
          if (hasParens || !NON_MEMBER_FILE_EXTS.has(backtickMatch[1])) {
            members.add(backtickMatch[1]);
          }
        }
        collectPatterns(trimmed, extraPatterns, members);
        return children;
      },
      heading(children) {
        // Plain section titles (e.g. "## Metadata", "## Clipboard") are ignored;
        // backticked members inside headings are handled by `codespan`, and explicit
        // receiver calls in headings (e.g. "### img.resize()") are still picked up.
        RECEIVER_CALL_RE.lastIndex = 0;
        for (const [, name] of children.matchAll(RECEIVER_CALL_RE)) {
          if (name !== undefined) members.add(name);
        }
        return "";
      },
      paragraph() {
        return "";
      },
      html() {
        return "";
      },
    },
    DOC_MARKDOWN_PARSE_OPTIONS,
  );

  return members;
}

// 2. Fetch matched .md doc pages and extract documented member identifiers
async function extractDocMembers(
  links: LlmsLink[],
  extraPatterns: readonly RegExp[] = [],
): Promise<{
  members: Set<string>;
  fetchedUrls: string[];
  failedUrls: string[];
}> {
  const members = new Set<string>();
  const fetchedUrls: string[] = [];
  const failedUrls: string[] = [];

  const uniqueUrls = [...new Set(links.map((l) => l.normalizedUrl))];

  await Promise.all(
    uniqueUrls.map(async (url) => {
      const res = await fetch(url, {
        headers: { Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.8" },
        redirect: "follow",
      });
      if (!res.ok) {
        failedUrls.push(`${res.status} ${url}`);
        return;
      }
      fetchedUrls.push(url);
      const md = await res.text();
      for (const name of extractDocMembersFromMarkdown(md, extraPatterns)) {
        members.add(name);
      }
    }),
  );

  return { members, fetchedUrls, failedUrls };
}

// 3. Extract @types/bun declaration members via brace-balanced .d.ts scan
function extractBalancedBlock(source: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(openBraceIdx + 1, i);
    }
  }
  return "";
}

function parseMembersFromBlock(block: string): string[] {
  // Strip block comments and line comments
  const cleaned = block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  const names: string[] = [];
  // Only capture top-level members inside the interface/class body (depth 0)
  let depth = 0;
  for (const rawLine of cleaned.split("\n")) {
    const line = rawLine.trim();
    if (depth === 0 && line.length > 0) {
      const m = line.match(
        /^(?:readonly\s+|static\s+|public\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\??\s*(?:<[^>]+>)?\s*[:(]/,
      );
      if (m?.[1] !== undefined && m[1] !== "constructor") {
        names.push(m[1]);
      }
    }
    for (const ch of line) {
      if (ch === "{" || ch === "(") depth++;
      else if (ch === "}" || ch === ")") depth = Math.max(0, depth - 1);
    }
  }
  return names;
}

async function extractTypesBunMembers(
  patterns: RegExp[],
): Promise<{ typesVersion: string; members: Set<string> }> {
  const pkgPath = Bun.resolveSync("@types/bun/package.json", process.cwd());
  const pkg = await Bun.file(pkgPath).json();
  // @types/bun is only `/// <reference types="bun-types" />`; the declarations live in the
  // sibling `bun-types` package of the realpath'd install (Bun's global store link). Resolving
  // from the symlink path fails, so follow it first.
  const typesRoot = realpathSync(dirname(pkgPath));
  const bunTypesPath = Bun.resolveSync("bun-types/package.json", typesRoot);
  const rootDir = dirname(bunTypesPath);

  const glob = new Bun.Glob("**/*.d.ts");
  const members = new Set<string>();

  for await (const relPath of glob.scan({ cwd: rootDir })) {
    const content = await Bun.file(join(rootDir, relPath)).text();
    for (const re of patterns) {
      re.lastIndex = 0;
      for (const match of content.matchAll(re)) {
        const openIdx = match.index! + match[0].length - 1;
        const block = extractBalancedBlock(content, openIdx);
        for (const name of parseMembersFromBlock(block)) {
          members.add(name);
        }
      }
    }
  }

  return { typesVersion: String(pkg.version ?? "unknown"), members };
}

// 4. Execute 3-way diff: Docs (llms.txt) vs @types/bun vs Runtime
async function main(): Promise<void> {
  const snapshot = await fetchLlmsSnapshot();

  console.log({
    bunRuntime: Bun.version_with_sha,
    llmsSha256: snapshot.sha256,
    llmsBytes: snapshot.bytes,
    deployment: snapshot.deployment,
    mintlify: snapshot.mintlify,
    r2SnapshotKey: snapshot.r2Key,
    totalLinks: snapshot.links.length,
  });

  let hasDrift = false;

  for (const target of TARGETS) {
    const matchedLinks = snapshot.links.filter((l) =>
      target.linkPattern.test(`${l.title} ${l.url}`),
    );

    const [docs, types] = await Promise.all([
      extractDocMembers(matchedLinks, target.docExtraPatterns),
      extractTypesBunMembers(target.typeBlockPatterns),
    ]);
    const runtime = target.getRuntimeMembers();

    const union = [
      ...new Set([...docs.members, ...types.members, ...runtime]),
    ].sort();
    const rows = union.map((symbol) => {
      const inDocs = docs.members.has(symbol);
      const inTypes = types.members.has(symbol);
      const inRuntime = runtime.has(symbol);
      const status =
        inDocs && inTypes && inRuntime
          ? "SYNC"
          : inTypes && inRuntime && !inDocs
            ? "UNDOCUMENTED"
            : inDocs && !inTypes
              ? "MISSING_IN_TYPES"
              : inTypes && !inRuntime
                ? "TYPES_ONLY"
                : "RUNTIME_ONLY";
      if (status !== "SYNC") hasDrift = true;
      return {
        symbol,
        docs: inDocs ? "✓" : "—",
        types: inTypes ? "✓" : "—",
        runtime: inRuntime ? "✓" : "—",
        status,
      };
    });

    console.log(`\n=== ${target.id} (@types/bun@${types.typesVersion}) ===`);
    console.log({
      matchedDocPages: docs.fetchedUrls.length,
      failedDocPages: docs.failedUrls,
      counts: {
        docs: docs.members.size,
        types: types.members.size,
        runtime: runtime.size,
      },
    });
    console.table(rows);
  }

  if (STRICT && hasDrift) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
