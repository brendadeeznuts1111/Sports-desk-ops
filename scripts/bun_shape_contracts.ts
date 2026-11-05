#!/usr/bin/env bun
/**
 * @file scripts/bun_shape_contracts.ts
 * @description Render docs/runbooks/bun_shape_contracts_runbook.md from the committed
 * shape data: the manifest (`lib/bun_shapes.ts`), the member snapshot
 * (`tests/bun_shape_members.json`) and the permalink statuses
 * (`tests/bun_shape_links.json`).
 *
 *   bun scripts/bun_shape_contracts.ts --write          # rewrite the catalog (offline)
 *   bun scripts/bun_shape_contracts.ts --refresh-links  # re-check permalinks (network)
 *
 * The links file is the only network-derived input, refreshed deliberately, so the
 * catalog can be regenerated from a clean checkout without touching bun.com.
 */
import * as ts from "typescript";
import { listSourceFiles } from "../lib/source_files.ts";
import {
  BUN_SHAPES,
  BUN_SHAPE_PINS,
  SHAPE_SECTIONS,
  VOLATILE_SHAPES,
  surfaceMembers,
} from "../lib/bun_shapes.ts";

const root = process.cwd();
const files = (await listSourceFiles(root, ["ts", "mjs", "js"])).filter(
  (f) =>
    !f.includes(".test.") &&
    !f.startsWith("tests/") &&
    !f.startsWith("verification/"),
);

const perShape = new Map<string, Map<string, number>>();
for (const file of files) {
  const text = await Bun.file(file).text();
  const kind = file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const visit = (node: ts.Node) => {
    const hit =
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun"
        ? node.name.text
        : ts.isQualifiedName(node) &&
            ts.isIdentifier(node.left) &&
            node.left.text === "Bun"
          ? node.right.text
          : undefined;
    if (hit !== undefined) {
      const m = perShape.get(hit) ?? new Map<string, number>();
      m.set(file, (m.get(file) ?? 0) + 1);
      perShape.set(hit, m);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

const b = Bun as unknown as Record<string, unknown>;
const descriptor = (name: string) => {
  const d = Object.getOwnPropertyDescriptor(b, name);
  if (d === undefined)
    return { label: "type-only", writable: "n/a", enumerable: "n/a" };
  return {
    label: typeof d.value,
    writable: String(d.writable),
    enumerable: String(d.enumerable),
  };
};

const LINKS_PATH = "tests/bun_shape_links.json";
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter(
  (a) => a !== "--write" && a !== "--refresh-links",
);
if (unknown.length > 0) {
  console.error(`unknown option(s): ${unknown.join(", ")}`);
  process.exit(2);
}

if (args.has("--refresh-links")) {
  const refreshed: Record<string, number> = {};
  for (const shape of BUN_SHAPES) {
    const url = `https://bun.com/reference/globals/bun/${shape.name}`;
    try {
      const res = await fetch(url, { redirect: "follow" });
      refreshed[shape.name] = res.status;
      await res.body?.cancel();
    } catch {
      refreshed[shape.name] = 0;
    }
  }
  await Bun.write(LINKS_PATH, `${JSON.stringify(refreshed, null, 2)}\n`);
  console.log(`refreshed ${Object.keys(refreshed).length} permalink statuses`);
  process.exit(0);
}

const permalinks = new Map(
  Object.entries((await Bun.file(LINKS_PATH).json()) as Record<string, number>),
);

const deepDive: Record<string, string> = {
  JSONL: "§8.4",
  WebView: "§9",
  markdown: "§12",
  FetchSession: "§7.3",
  connect: "§8.2",
  listen: "§8.1",
  udpSocket: "§8.3",
  serve: "§2",
  Server: "§2",
  FetchProxyOption: "§7.2",
};

const sectionInvariants: Record<string, string[]> = {
  process: [
    "`Bun.argv` is an array, `Bun.env` an object, `Bun.main` a string — `proc.shell`.",
    "`Bun.stdin` / `Bun.stdout` are Blob-like with `text()`; nothing here reads them — `proc.stdio`.",
    "`Bun.nanoseconds()` is monotonic and `Bun.sleepSync(5)` blocks for at least 5 ms — `proc.timing`.",
    '`Bun.spawnSync(["echo","ok"])` returns `stdout` + `exitCode`; `Bun.gc(false)` returns a value that is `undefined` — `proc.spawn`.',
    '`Bun.which` honours a `PATH` override; `Bun.resolveSync` resolves against a directory; `Bun.fileURLToPath("file:///tmp/x.ts")` → `/tmp/x.ts`; `Bun.openInEditor` is a 1-arity function — `proc.paths`.',
    "`Bun.Terminal` is a constructor; `Bun.FileSink` has no runtime value — `proc.terminal`.",
  ],
  text: [
    '`Bun.stringWidth("漢")` → 2 and ANSI escape codes are ignored by default; `Bun.wrapAnsi` wraps at the given column width — `text.width`.',
    '`Bun.color("red", "hex")` → `#ff0000`; `Bun.enableANSIColors` is a boolean; `Bun.escapeHTML` escapes `&`, `<`, `>` — `text.ansi`.',
    "`Bun.inspect({a:[1]})` renders a stable multi-line form — `text.inspect`; `Bun.markdown` is exercised by the `markdown` surface check.",
  ],
  data: [
    "`Bun.JSON5` / `Bun.TOML` / `Bun.YAML` / `Bun.XML` / `Bun.JSONL` each parse a tiny document in-process — `data.parse`; `Bun.JSONC` also accepts comments — `data.json`.",
    '`new Bun.Glob("*.ts").match("a.ts")` → true, `"a.js"` → false — `data.glob`.',
    "`Bun.deepEquals` compares structure, not identity — `data.compare`.",
    '`new Bun.Cookie("a","b")` and `new Bun.CookieMap("a=b").get("a")` agree on the pair — `data.cookies`.',
    '`Bun.semver.satisfies("1.2.3", "^1.0.0")` → true and `Bun.semver.order("1.0.0", "1.0.1")` → -1 — `data.semver`.',
  ],
  storage: [
    '`Bun.SQL`, `Bun.S3Client`, `Bun.RedisClient` are constructors; `Bun.Archive` round-trips in memory — write `{"a.txt":"hi"}`, read `files()` back to the same key — `storage.archive`.',
    "`Bun.cron` returns a `CronJob`; `Bun.CronController` is a type (no runtime value).",
    "`Bun.secrets.get` is covered by the `secrets.get` surface check.",
  ],
  crypto: [
    '`new Bun.CryptoHasher("sha256").update("x").digest("hex")` is 64 hex chars; `Bun.hash("x")` returns a bigint while `Bun.hash.crc32`/`adler32` return numbers; `Bun.randomUUIDv7()` is 36 chars with version nibble `7` — `crypto.hash`.',
    "zstd and gzip round-trip: compress → decompress returns the input; `new Bun.ArrayBufferSink()` and `Bun.concatArrayBuffers` exist — `crypto.compress`.",
  ],
  network: [
    "`Bun.fetch`, `Bun.serve`, `Bun.connect`, `Bun.listen`, `Bun.udpSocket`, `Bun.FetchSession` are functions (surface checks + capabilities test).",
    "`Bun.dns` is an object; the reference documents only `lookup`/`prefetch`/`getCacheStats` while the binary also has 15 resolver methods — see the drift section in ../bun-upstream-reference.md.",
    "`Bun.Server` and `Bun.FetchProxyOption` are types (`Server<WebSocketData>` takes a type argument).",
  ],
  image: [
    '`Bun.Image` and `Bun.WebView` are constructors; `metadata()` on a 1×1 PNG reads `{width:1, height:1, format:"png"}` — `image.metadata`. Both have deep contracts in the server shapes runbook.',
  ],
  meta: [
    "`Bun.version` and `Bun.revision` are strings; `Bun.version_with_sha` is `v<version> (<short sha>)` where the short sha is a prefix of `Bun.revision` — `proc.meta`.",
    "`Bun.env` is the process environment object (`proc.shell`); `Bun.Env` is a type.",
  ],
};

const link = (shape: string, status: number | undefined) =>
  status === 200
    ? `[reference](https://bun.com/reference/globals/bun/${shape})`
    : "no reference page (declaration only)";

const out: string[] = [];
out.push(
  `# Bun shape contracts — the ${BUN_SHAPES.length} shapes this repository calls`,
);
out.push("");
out.push(
  `The single source of truth is layered, and nothing here restates upstream text: **declarations** come from \`bun-types@${BUN_SHAPE_PINS.typesVersion}\` (the surface the reference site renders), **behaviour** from probes against the local \`Bun ${BUN_SHAPE_PINS.bunVersion}\` binary (\`tests/bun_baseline.json\`), **property attributes** from the pinned Bun commit \`${BUN_SHAPE_PINS.bunCommit.slice(0, 10)}\`. When they disagree: declarations win on names and signatures, the Bun source wins on attributes, and the measured binary wins on behaviour.`,
);
out.push("");
out.push(
  `Each entry names its declaration, what the binary says about the member (kind and descriptor), the files that call it, the local evidence, and — where one exists — the deep dive that already owns the detail. Call sites are bare paths, never line numbers: \`check:spec-citations\` does not audit runbooks, so a line number here would rot silently.`,
);
out.push("");
out.push(
  `Adding a \`Bun.*\` call without an entry in \`lib/bun_shapes.ts\` fails \`tests/bun_shapes_coverage.test.ts\`; the same test fails when an entry goes stale, loses its heading, or cites evidence that no longer exists.`,
);
out.push("");
out.push(`## Upgrading`);

out.push("");
out.push(
  `When upstream moves: bump \`packageManager\`, \`engines.bun\`, \`.bun-version\` and \`@types/bun\` together, run \`bun run probe:bun\` (baseline drift is the behaviour diff), then re-derive the declared surface with \`./bin/dx bun --types\`. Regenerate the member snapshot with \`bun scripts/bun_shape_members.ts --baseline tests/bun_shape_members.json\` and the catalog with \`bun scripts/bun_shape_contracts.ts --write\` (\`--refresh-links\` re-checks the permalinks), then review the diff. The coverage test reports the name diff before any prose is touched. Canary builds are out of scope.`,
);
out.push("");
out.push(`---`);
out.push("");

for (const [sub, title] of Object.entries(SHAPE_SECTIONS)) {
  // The block above (or the previous section's shape) already left one blank line.
  out.push(`## ${title}`);
  out.push("");
  for (const line of sectionInvariants[sub] ?? []) out.push(`- ${line}`);
  out.push("");
  for (const shape of BUN_SHAPES.filter((s) => s.subsystem === sub)) {
    const filesForShape = [...(perShape.get(shape.name) ?? new Map())].sort(
      (a, c) => c[1] - a[1],
    );
    const top = filesForShape.slice(0, 2).map(([f]) => `\`${f}\``);
    const d = descriptor(shape.name);
    const kindLine =
      shape.kind === "type"
        ? "type-only: declared, no runtime value"
        : `value: \`${d.label}\` · writable ${d.writable} · enumerable ${d.enumerable}`;
    out.push(`#### ${shape.heading}`);
    // Markdown formatter keeps a blank line after a heading; emit it so --write and bun fmt agree.
    out.push("");
    out.push(
      `- **Source:** declared in \`bun-types@${BUN_SHAPE_PINS.typesVersion}\` · ${link(shape.name, permalinks.get(shape.name))}`,
    );
    out.push(`- **Shape:** ${kindLine}`);
    if (shape.status === "declared-only") {
      out.push(
        `- **Status:** declared-only — in the declaration surface, called nowhere; the gate flips this entry the moment it is used`,
      );
    }
    if (shape.kind === "value" && !VOLATILE_SHAPES.has(shape.name)) {
      const value = (Bun as unknown as Record<string, unknown>)[shape.name];
      if (typeof value === "object" || typeof value === "function") {
        const members = surfaceMembers(value);
        if (members.length > 0) {
          out.push(
            `- **Members (${members.length}):** ${members.length <= 12 ? members.map((m) => `\`${m}\``).join(", ") : "snapshot in tests/bun_shape_members.json"}`,
          );
        }
      }
    }
    out.push(
      `- **Here:** ${top.length === 0 ? "no call site" : top.join(", ")}`,
    );
    out.push(
      `- **Evidence:** ${shape.evidence.map((e) => `\`${e}\``).join(", ")}${deepDive[shape.name] ? ` · deep dive: [${deepDive[shape.name]}](./bun_server_runtime_shapes_runbook.md)` : ""}`,
    );
    out.push("");
  }
}

await Bun.write("docs/runbooks/bun_shape_contracts_runbook.md", out.join("\n"));
const okLinks = [...permalinks.values()].filter((s) => s === 200).length;
console.log(
  `wrote catalog: ${BUN_SHAPES.length} shapes, ${okLinks} live permalinks`,
);
