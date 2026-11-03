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

**Doc voice SSOT (not runtime):** When editing Bun upstream docs or mirroring their tone in this
repo, use the voice section in
[`oven-sh/bun` @ `6cdb3835`](https://github.com/oven-sh/bun/tree/6cdb3835d90f8e05e4ebff86c7135078c9eb7e88/docs#contributing)
(source: `docs/project/contributing.mdx`). That commit is ahead of the **1.4.4** tag (`38afee6c8`);
do not treat it as a behavior pin. Live site: [contributing#voice](https://bun.com/docs/project/contributing#voice).

**Guides index (not runtime):** [`guides.jsx` @ `6a380492`](https://github.com/oven-sh/bun/blob/6a38049270e99f0989c912aaa335f177c9d1bbf0/docs/snippets/guides.jsx) lists every `/guides/*` href for the docs site; content lives in MDX elsewhere. Live: [bun.com/guides](https://bun.com/guides).

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

## main-guard

In an eval `import.meta.main` is always `true`, so the guard is redundant there, not unavailable. A
file the eval imports still sees `false`, which is what keeps `bun -e 'await import("./x.ts")'`
from running `x.ts`'s side effects.

## stdin-lines

`for await (const l of console)` splits on `\n` only: CRLF input keeps the `\r`, and input ending in
a newline yields one extra `""`. For bounded input read `Bun.stdin.text()`, split on `/\r?\n/` and
drop a final empty element; the iterator is for streams that never end.

## color-env

`Bun.enableANSIColors` is a writable data property (no getter), `false` when piped; assigning it
changes the value, so read it once at startup rather than trusting it after other code ran. `NO_COLOR=1` disables and `FORCE_COLOR=1`
enables; `FORCE_COLOR=0` and `NO_COLOR=0` do **not** disable colour on a TTY, unlike Node and the
no-color.org convention. Use `NO_COLOR=1`. Agent shells often export both variables already, so
clear them before measuring.

## mmap-truncate

A `Bun.mmap` view is the file, not a snapshot. Shrinking the file while mapped kills the process
with `SIGBUS` on the next read past the new end (`exitCode` is `null`, read `signalCode`); no
`try`/`catch` sees it. Unlinking is safe on macOS. An empty file throws `EINVAL` at map time. Map
in a child process when anything else may write the file.

## spawn-stdin-end

`Bun.spawn(..., { stdin: "pipe" })` gives a `FileSink`; the child sees EOF only after
`proc.stdin.end()`. Without it `cat` waits forever.

## archive-files

`new Bun.Archive(bytes)` needs bytes (`await Bun.file(p).bytes()`); a `BunFile` is "Unrecognized
archive format". `.files()` is the in-memory listing (`Map<path, Blob>`); `.extract(dir)` writes to
disk and requires the path.

## sql-sqlite-url

`new Bun.SQL("app.db")` is a PostgreSQL host. SQLite needs `sqlite://`, `file://` or `:memory:`.

## shell-escape

`$` escapes every interpolation; `${{ raw: s }}` does not and runs whatever `s` contains.
