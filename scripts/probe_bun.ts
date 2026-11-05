#!/usr/bin/env bun
/**
 * Records what the running Bun actually does for the behaviours in docs/bun-eval-pitfalls.md.
 *
 *   bun scripts/probe_bun.ts                      JSON report on stdout
 *   bun scripts/probe_bun.ts --baseline <file>    write the report
 *   bun scripts/probe_bun.ts --check <file>       exit 1 if stdout/code/signal drifted
 *   --include-crash-probes                        also run probes that kill their child (mmap)
 *
 * Every probe is a child of this binary with a pinned env and a scratch cwd; paths are replaced
 * with <bun>/<cwd> so a baseline is portable. A drift is a behaviour change to review, not a
 * failure by itself: tests/bun_eval_patterns.test.ts pins the patterns we depend on.
 *
 * Not automated, by design:
 * - Bun.secrets: a macOS get can block on a keychain dialog with no timeout. Measured by hand on
 *   2026-11-02 (Bun 1.4.4, macOS): invalid `persist` throws ERR_INVALID_ARG_VALUE before the
 *   backend; `allowUnrestrictedAccess` is not type-checked. Linux without a daemon: unverified.
 * - Heap snapshots past ~2 GiB: needs a runner with the memory. Reported upstream, not verified.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

type Probe = {
  id: string;
  note: string;
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  crash?: true;
};

type Result = {
  note: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | number | null;
  timedOut: boolean;
};

const DIFFED = ["stdout", "code", "signal", "timedOut"] as const;
const TIMEOUT_MS = 5_000;
const SELF = process.execPath;

const lines = "for await (const l of console) console.log(JSON.stringify(l))";
const colors = "console.log(JSON.stringify(Bun.enableANSIColors))";

const probes: Probe[] = [
  {
    id: "ns.own",
    note: "typeof and own property names per Bun member",
    argv: [
      "-p",
      `JSON.stringify(["$","Build","CSRF","dns","Image","inspect","JSON5","JSONC","JSONL","markdown","Password","peek","RedisClient","Security","semver","Serve","Spawn","SQL","TOML","udp","unsafe","WebAssembly","WebView","XML","YAML"].map(k => ({ k, t: typeof Bun[k], own: Bun[k] != null ? Object.getOwnPropertyNames(Bun[k]).sort() : null })))`,
    ],
  },
  {
    id: "ns.ctor",
    note: "usable with new, checked without invoking the constructor",
    argv: [
      "-p",
      `JSON.stringify(["Image","WebView","inspect","SQL"].map(k => { try { Reflect.construct(String, [], Bun[k]); return [k, "new"] } catch { return [k, "no-new"] } }))`,
    ],
  },
  {
    id: "ns.pw",
    note: "Bun.Password is not a runtime alias of Bun.password",
    argv: [
      "-p",
      "JSON.stringify([typeof Bun.Password, typeof Bun.password, Bun.Password === Bun.password])",
    ],
  },

  {
    id: "eval.obj.p",
    note: "-p with a bare object literal",
    argv: ["-p", "{a:1}"],
  },
  {
    id: "eval.obj.repl",
    note: "repl -p with a bare object literal",
    argv: ["repl", "-p", "{a:1}"],
  },
  {
    id: "eval.argv",
    note: "Bun.argv in an eval",
    argv: ["-p", "JSON.stringify(Bun.argv)", "x", "y"],
  },
  {
    id: "eval.argv.dashdash",
    note: "Bun.argv after --",
    argv: ["-p", "JSON.stringify(Bun.argv)", "--", "-n", "5"],
  },
  {
    id: "eval.main",
    note: "import.meta.main in an eval",
    argv: ["-p", "String(import.meta.main)"],
  },
  {
    id: "eval.req",
    note: "typeof require alone",
    argv: ["-p", "typeof require"],
  },
  {
    id: "eval.mix",
    note: "require and import.meta together",
    argv: ["-p", 'typeof require + " " + import.meta.dir'],
  },
  {
    id: "eval.str",
    note: "the word require inside a string, with import.meta",
    argv: ["-p", '"require " + typeof import.meta.dir'],
  },
  {
    id: "eval.cmt",
    note: "the word require inside a comment, with import.meta",
    argv: ["-p", "/* require */ typeof import.meta.dir"],
  },
  {
    id: "eval.meta.require",
    note: "import.meta.require keeps ESM",
    argv: ["-p", 'typeof import.meta.require + " " + typeof import.meta.dir'],
  },
  {
    id: "eval.print.str",
    note: "-p prints strings unquoted",
    argv: ["-p", '"hi"'],
  },

  {
    id: "stdin.lf",
    note: "console iterator, LF input",
    argv: ["-e", lines],
    stdin: "a\nb\n",
  },
  {
    id: "stdin.crlf",
    note: "console iterator, CRLF input",
    argv: ["-e", lines],
    stdin: "a\r\nb\r\n",
  },
  {
    id: "stdin.noeol",
    note: "console iterator, no final newline",
    argv: ["-e", lines],
    stdin: "a\nb",
  },

  {
    id: "archive.files",
    note: ".files() on a real tgz built in the scratch dir",
    argv: [
      "-p",
      'const f = await new Bun.Archive(await Bun.file("x.tgz").bytes()).files(); JSON.stringify([...f.keys()])',
    ],
  },
  {
    id: "archive.extract.nopath",
    note: ".extract() without a path",
    argv: [
      "-e",
      'try { await new Bun.Archive(await Bun.file("x.tgz").bytes()).extract() } catch (e) { console.log(e.name, e.code, e.message) }',
    ],
  },
  {
    id: "archive.bunfile",
    note: "constructor given a BunFile instead of bytes",
    argv: [
      "-e",
      'try { await new Bun.Archive(Bun.file("x.tgz")).files() } catch (e) { console.log(e.name, e.message) }',
    ],
  },

  {
    id: "colors.desc",
    note: "enableANSIColors property descriptor",
    argv: [
      "-p",
      'const d = Object.getOwnPropertyDescriptor(Bun, "enableANSIColors"); JSON.stringify(d && Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "function" ? "fn" : v])))',
    ],
  },
  {
    id: "colors.set",
    note: "assigning enableANSIColors in an ESM eval",
    argv: [
      "-e",
      "const b = Bun.enableANSIColors; try { Bun.enableANSIColors = !b; console.log('assigned') } catch (e) { console.log('threw', e.name) } console.log(b, Bun.enableANSIColors)",
    ],
  },
  { id: "colors.default", note: "piped, no colour env", argv: ["-e", colors] },
  {
    id: "colors.no1",
    note: "piped, NO_COLOR=1",
    argv: ["-e", colors],
    env: { NO_COLOR: "1" },
  },
  {
    id: "colors.force1",
    note: "piped, FORCE_COLOR=1",
    argv: ["-e", colors],
    env: { FORCE_COLOR: "1" },
  },
  {
    id: "colors.both",
    note: "piped, NO_COLOR=1 FORCE_COLOR=1",
    argv: ["-e", colors],
    env: { NO_COLOR: "1", FORCE_COLOR: "1" },
  },

  {
    id: "spawn.stdin.end",
    note: "pipe stdin, write, end(): the child exits",
    argv: [
      "-e",
      'const p = Bun.spawn(["cat"], { stdin: "pipe", stdout: "pipe" }); p.stdin.write("hi\\n"); p.stdin.end(); console.log(JSON.stringify(await new Response(p.stdout).text()), await p.exited)',
    ],
  },
  {
    id: "sql.bare.path",
    note: "adapter chosen for a bare path",
    argv: ["-p", 'new Bun.SQL("app.db").options.adapter'],
  },

  {
    id: "mmap.truncate",
    note: "read past the end of a mapped file truncated to 0",
    crash: true,
    argv: [
      "-e",
      'const m = Bun.mmap("mapped.bin"); (await import("node:fs")).truncateSync("mapped.bin", 0); console.log(m[m.length - 1])',
    ],
  },

  // --- bun_shapes coverage: one probe per family of lib/bun_shapes.ts entries ---
  {
    id: "proc.shell",
    note: "Bun.$, argv, env, main are runtime values",
    argv: [
      "-p",
      "JSON.stringify({dollar: typeof Bun.$, argv: Math.min(Bun.argv.length, 9), env: typeof Bun.env, envHasKeys: Object.keys(Bun.env).length > 0, main: typeof Bun.main})",
    ],
  },
  {
    id: "proc.stdio",
    note: "stdin/stdout exist with the Blob text() method",
    argv: [
      "-p",
      "JSON.stringify({stdin: typeof Bun.stdin, stdout: typeof Bun.stdout, stdinText: typeof Bun.stdin.text, stdoutText: typeof Bun.stdout.text})",
    ],
  },
  {
    id: "proc.timing",
    note: "nanoseconds is monotonic, process-relative and sleepSync blocks",
    argv: [
      "-p",
      "(function(){const t=Bun.nanoseconds();const u=process.uptime()*1e9;Bun.sleepSync(5);const d=Bun.nanoseconds()-t;return JSON.stringify({monotonic:d>0, sleptAtLeast5ms:d>=5e6, sleep:typeof Bun.sleep, processRelative:Math.abs(t-u)<5e7})})()",
    ],
  },
  {
    id: "proc.spawn",
    note: "spawnSync returns stdout/exitCode and gc returns undefined",
    argv: [
      "-p",
      '(function(){const r=Bun.spawnSync(["echo","ok"]);const g=Bun.gc(false);return JSON.stringify({out:r.stdout.toString().trim(),code:r.exitCode,gc:g===undefined})})()',
    ],
  },
  {
    id: "proc.paths",
    note: "which/resolveSync/fileURLToPath/openInEditor shapes",
    argv: [
      "-p",
      'JSON.stringify({which:Bun.which("bun")!==null,resolve:Bun.resolveSync("./package.json",process.cwd()).endsWith("package.json"),fileURL:Bun.fileURLToPath("file:///tmp/x.ts"),openInEditor:Bun.openInEditor.length})',
    ],
  },
  {
    id: "proc.meta",
    note: "version, revision and version_with_sha shapes",
    argv: [
      "-p",
      "JSON.stringify({version:Bun.version,revisionLen:Bun.revision.length,sha:Bun.version_with_sha})",
    ],
  },
  {
    id: "proc.terminal",
    note: "Terminal is a value; FileSink is a type only",
    argv: [
      "-p",
      'JSON.stringify({terminal:typeof Bun.Terminal,terminalArity:Bun.Terminal.length,fileSink:String((Bun as unknown as Record<string,unknown>)["FileSink"])})',
    ],
  },
  {
    id: "text.width",
    note: "stringWidth and wrapAnsi agree on wide and ANSI input",
    argv: [
      "-p",
      'JSON.stringify([Bun.stringWidth("漢"),Bun.stringWidth(String.fromCharCode(27)+"[31mhi"+String.fromCharCode(27)+"[39m"),Bun.wrapAnsi("a b c",3)])',
    ],
  },
  {
    id: "text.ansi",
    note: "color, enableANSIColors and escapeHTML shapes",
    argv: [
      "-p",
      'JSON.stringify([Bun.color("red","hex"),Bun.color("red","ansi"),typeof Bun.enableANSIColors,Bun.escapeHTML("<b>&")])',
    ],
  },
  {
    id: "data.json",
    note: "JSONC.parse reads JSON with comments",
    argv: [
      "-p",
      'JSON.stringify([Bun.JSONC.parse("[1,2]"),Bun.JSONC.parse("[1,2] // trailing"),typeof Bun.JSONC.parse])',
    ],
  },
  {
    id: "data.glob",
    note: "Glob.match respects the pattern",
    argv: [
      "-p",
      'JSON.stringify([new Bun.Glob("*.ts").match("a.ts"),new Bun.Glob("*.ts").match("a.js")])',
    ],
  },
  {
    id: "data.compare",
    note: "deepEquals compares structure, not identity",
    argv: [
      "-p",
      "JSON.stringify([Bun.deepEquals({a:[1]},{a:[1]}),Bun.deepEquals({a:1},{a:2})])",
    ],
  },
  {
    id: "data.cookies",
    note: "Cookie and CookieMap parse the same header pair",
    argv: [
      "-p",
      'JSON.stringify([new Bun.Cookie("a","b").name,new Bun.CookieMap("a=b").get("a"),new Bun.Cookie("a","b").value])',
    ],
  },
  {
    id: "crypto.hash",
    note: "CryptoHasher digest, Bun.hash and UUID v7 shapes",
    argv: [
      "-p",
      'JSON.stringify([new Bun.CryptoHasher("sha256").update("x").digest("hex").length,typeof Bun.hash("x"),Bun.randomUUIDv7().length,Bun.randomUUIDv7().slice(14,15)])',
    ],
  },
  {
    id: "crypto.compress",
    note: "zstd and gzip round-trip; sink and concat shapes",
    argv: [
      "-p",
      '(function(){const e=new TextEncoder(),d=new TextDecoder();const s=e.encode("hello");const z=Bun.zstdCompressSync(s),g=Bun.gzipSync(s);return JSON.stringify([d.decode(Bun.zstdDecompressSync(z)),d.decode(Bun.gunzipSync(g)),typeof Bun.zstdCompress,typeof Bun.concatArrayBuffers,typeof new Bun.ArrayBufferSink()])})()',
    ],
  },
  {
    id: "data.parse",
    note: "JSONL, JSON5, TOML, YAML and XML parse inline",
    argv: [
      "-p",
      'JSON.stringify([Bun.JSONL.parse("1\\n2\\n"),Bun.JSON5.parse("{a:1}"),Bun.TOML.parse("a = 1"),Bun.YAML.parse("a: 1"),Bun.XML.parse("<a>1</a>")])',
    ],
  },
  {
    id: "data.semver",
    note: "semver.satisfies and semver.order answer version questions",
    argv: [
      "-p",
      'JSON.stringify([Bun.semver.satisfies("1.2.3","^1.0.0"),Bun.semver.order("1.0.0","1.0.1")])',
    ],
  },
  {
    id: "text.inspect",
    note: "inspect renders a stable multi-line form",
    argv: ["-p", 'JSON.stringify([Bun.inspect({a:[1]}),Bun.inspect("x")])'],
  },
  {
    id: "storage.archive",
    note: "Archive round-trips through bytes and files()",
    argv: [
      "-e",
      '(async()=>{const b=await new Bun.Archive({"a.txt":"hi"}).bytes();const f=await new Bun.Archive(b).files();console.log(JSON.stringify([b.length>0,[...f.keys()],new TextDecoder().decode(f.get("a.txt"))]))})()',
    ],
  },
  {
    id: "image.metadata",
    note: "Image.metadata reads a 1x1 PNG header",
    argv: [
      "-e",
      'const png=Uint8Array.fromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==");(async()=>{console.log(JSON.stringify(await new Bun.Image(png).metadata()))})()',
    ],
  },
];

async function prepareScratch(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "probe-bun-"));
  await Bun.write(
    path.join(dir, "x.tgz"),
    new Bun.Archive({ "f.txt": "hi\n" }, { compress: "gzip" }),
  );
  return dir;
}

function run(probe: Probe, cwd: string): Result {
  if (probe.crash)
    writeFileSync(path.join(cwd, "mapped.bin"), Buffer.alloc(65_536, 0x61));
  const p = Bun.spawnSync([SELF, ...probe.argv], {
    cwd,
    env: {
      PATH: Bun.env.PATH ?? "",
      HOME: Bun.env.HOME ?? "",
      TERM: "dumb",
      ...probe.env,
    },
    stdin: probe.stdin === undefined ? "ignore" : Buffer.from(probe.stdin),
    timeout: TIMEOUT_MS,
  });
  const scrub = (s: string) =>
    s
      .replaceAll(SELF, "<bun>")
      .replaceAll(cwd, "<cwd>")
      .replaceAll(cwd.replace(/^\/private/, ""), "<cwd>")
      .trimEnd();
  return {
    note: probe.note,
    stdout: scrub(p.stdout.toString()),
    stderr: scrub(p.stderr.toString()),
    code: p.exitCode,
    signal: p.signalCode ?? null,
    timedOut: p.exitedDueToTimeout === true,
  };
}

const USAGE =
  "usage: bun scripts/probe_bun.ts [--baseline <file> | --check <file>] [--include-crash-probes]";

function parseCli() {
  try {
    return parseArgs({
      args: Bun.argv.slice(2),
      options: {
        baseline: { type: "string" },
        check: { type: "string" },
        "include-crash-probes": { type: "boolean", default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    process.exit(2);
  }
}

const values = parseCli();
if (values.baseline && values.check) {
  console.error(`--baseline and --check are exclusive\n${USAGE}`);
  process.exit(2);
}

const scratch = await prepareScratch();
const report: Record<string, Result> = {
  _bun: {
    note: "runtime",
    stdout: Bun.version_with_sha,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  },
};
try {
  for (const probe of probes) {
    if (probe.crash && !values["include-crash-probes"]) continue;
    report[probe.id] = run(probe, scratch);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (values.baseline) {
  await Bun.write(values.baseline, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `wrote ${Object.keys(report).length - 1} probes for Bun ${Bun.version} to ${values.baseline}`,
  );
} else if (values.check) {
  const was: Record<string, Partial<Result>> = await Bun.file(
    values.check,
  ).json();
  let drift = 0;
  for (const [id, now] of Object.entries(report)) {
    if (id === "_bun") continue;
    const prev = was[id];
    if (prev === undefined) {
      console.log(`NEW      ${id}`);
      continue;
    }
    for (const field of DIFFED) {
      if (!Bun.deepEquals(prev[field], now[field], true)) {
        console.log(
          `DIFF     ${id}.${field}\n  was: ${JSON.stringify(prev[field])}\n  now: ${JSON.stringify(now[field])}`,
        );
        drift++;
      }
    }
  }
  for (const id of Object.keys(was)) {
    if (id !== "_bun" && !(id in report)) console.log(`MISSING  ${id}`);
  }
  console.log(
    `${drift} drift(s) against ${was._bun?.stdout ?? "unknown Bun"}; running ${Bun.version_with_sha}`,
  );
  process.exit(drift === 0 ? 0 : 1);
} else {
  console.log(JSON.stringify(report, null, 2));
}
