# Bun one-liner pitfalls

Why the `bun -e` / `bun -p` patterns pinned by
[`tests/bun_eval_patterns.test.ts`](../tests/bun_eval_patterns.test.ts) are written the way they
are. Each heading is the id a test name cites; the test pins the safe pattern, this page keeps the
mechanism.

- **Measured:** Bun 1.4.4 (`38afee6c8`), macOS arm64, 2026-11-02, every probe in a child process.
  The raw observations live in [`tests/bun_baseline.json`](../tests/bun_baseline.json); after a
  Bun upgrade, `bun run probe:bun` diffs the new runtime against it.
- **Not verified:** heap snapshots past ~2 GiB returning `""` or throwing `RangeError` (reported
  upstream, not reproduced: a 2 GiB allocation is flaky on any runner); `Bun.secrets` with
  `persist: "local"` (Windows only, never run).

### Upstream Bun docs

Not runtime SSOT. Routing table and pins: [bun-upstream-reference.md](./bun-upstream-reference.md).

## eval-module-mode

An eval is classified from its source. Referencing a CommonJS identifier (`require`, `module`,
`exports`, `__dirname`) as code evaluates it as CommonJS, and any `import.meta` in the same snippet
is then `SyntaxError: import.meta is only valid inside modules`. The word inside a string or a
comment does not trigger it. Keep one module system per eval; inside ESM use `import.meta.require`.
Static and dynamic `import` both work.

## eval-argv

`Bun.argv` in an eval is `[bun, ...userArgs]`: no flag, no `[eval]` entry, so the user arguments
start at index 1, not 2 as in a file. Arguments that start with `-` need `--` before them or Bun
parses them as its own flags (`error: Invalid Argument '-n'`).

## eval-print-json

`bun -p` prints the final value through `Bun.inspect`, so a string prints unquoted. Wrap the
expression in `JSON.stringify` when the output is parsed. A leading `{` is a block, not an object:
`bun -p '{a:1}'` prints `1` (label `a`), while `bun repl -p '{a:1}'` prints the object. Write
`({a:1})`.

`bun repl` (native since 1.4.0) is a second entrypoint with different expression semantics,
measured on 1.4.4: `bun repl -e` evaluates **without** printing the value (`-e '{a:1}'` prints
nothing; `console.log` still prints), `bun repl -p` prints the value through `Bun.inspect` to
**stdout** (an object is pretty-printed across lines, so pipe it through `JSON.stringify` when
parsing), and top-level `await` works in both. With piped stdin the REPL reads to EOF and exits 0
(`printf '1+1\n' | bun repl` prints `2`), so it cannot hang a caller; the
`~/.bun_repl_history` file is written by **any REPL session that reads stdin** — interactive or
piped (`printf '6*7\n' | bun repl` creates it, mode 0600) — while `-e`/`-p` one-shots do not.
Every repl probe in the tests therefore sets `HOME` to the scratch directory, so measuring the
REPL can never read or append the operator's real history. The 1.4 `-e`/`-p` flags make
this entrypoint usable in scripts when object-literal semantics matter; the safe pattern for both
older runtimes remains `({a:1})` with `bun -p`.

## main-guard

In an eval `import.meta.main` is always `true`, so the guard is redundant there, not unavailable. A
file the eval imports still sees `false`, which is what keeps `bun -e 'await import("./x.ts")'`
from running `x.ts`'s side effects.

## stdin-lines

`for await (const l of console)` splits on `\n` only: CRLF input keeps the `\r`, and input ending in
a newline yields one extra `""`. For bounded input read `Bun.stdin.text()`, split on `/\r?\n/` and
drop a final empty element; the iterator is for streams that never end.

## color-env

`Bun.enableANSIColors` is a writable data property (no getter). Measured on Bun `1.4.4+38afee6c8`,
it is `true` even when stdout is piped (`process.stdout.isTTY === undefined`) unless `NO_COLOR=1`
is set; `FORCE_COLOR=1` overrides `NO_COLOR=1`. Assigning `Bun.enableANSIColors` mutates the global
flag, so read it once at startup or gate through `useColor()` (`lib/ansi_color.ts`), which checks
`FORCE_COLOR` (`"1"|"2"|"3"|"true"` / `"0"`) -> `"NO_COLOR" in env` (any value, even empty) ->
`isTTY && Bun.enableANSIColors`. `FORCE_COLOR=0` and `NO_COLOR=0`
do **not** disable colour on a TTY in Bun itself, unlike Node and the no-color.org convention. Use
`NO_COLOR=1` (or `useColor()`). Agent shells often export both variables already, so clear them
before measuring.

## mmap-truncate

A `Bun.mmap` view is the file, not a snapshot. Shrinking the file while mapped kills the process
with `SIGBUS` on the next read past the new end (`exitCode` is `null`, read `signalCode`); no
`try`/`catch` sees it. Unlinking is safe on macOS. An empty file throws `EINVAL` at map time. Map
in a child process when anything else may write the file.

## spawn-stdin-end

`Bun.spawn(..., { stdin: "pipe" })` gives a `FileSink`; the child sees EOF only after
`proc.stdin.end()`. Without it `cat` waits forever.

## archive-files

`new Bun.Archive(bytes)` needs bytes (`await Bun.file(p).bytes()`). Passing the
handle itself is _type-correct_ — `Blob` is a legal `ArchiveInput`, and `S3File`
extends `Blob` — but the runtime then splits by method (measured 2026-11-17 on
1.4.4, pinned in `tests/bun_runtime_contracts.test.ts`):

- `.bytes()` / `.blob()` re-serialise the member set: **0 bytes, no error**
- `.files()` throws `Unrecognized archive format`; `.extract(dir)` throws too

So a forgotten `await` is silent only if the caller never parses. `.files()` is
the in-memory listing (`Map<path, File>`, regular files only); `.extract(dir)`
writes to disk and returns the entry count. Also: `{ compress: "gzip" }` is
honoured by `bytes()` / `blob()` / static `write()`, but **not** by
`Bun.write(destination, archiveInstance)`, which writes an uncompressed tar —
see `lib/eod_archive.ts` and #353.

## sql-sqlite-url

`new Bun.SQL("app.db")` is a PostgreSQL host. SQLite needs `sqlite://`, `file://` or `:memory:`.

## shell-escape

`$` escapes every interpolation; `${{ raw: s }}` does not and runs whatever `s` contains.
