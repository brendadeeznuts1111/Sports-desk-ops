#!/usr/bin/env bun
/**
 * @file examples/bun_markdown_ansi.ts
 * @description The five official `Bun.markdown.ansi` examples, cited and checked.
 *
 * Source:  https://bun.com/reference/bun/markdown/ansi
 * Fetched: 2026-11-14 · Measured on Bun 1.4.4 (arm64-darwin)
 *
 * The snippets below are copied from the reference page. `longText` is the only
 * binding the page leaves undefined, so it is defined here; nothing else is
 * hand-rolled. The measured invariants live in `check()`, so this file is a
 * runnable citation rather than prose.
 *
 *   bun examples/bun_markdown_ansi.ts          # print the five examples
 *   bun examples/bun_markdown_ansi.ts --check  # assert measured invariants
 *
 * Prose: docs/runbooks/bun_server_runtime_shapes_runbook.md §12
 */

import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ESC built from a char code: a literal control char in a regex trips no-control-regex.
const ESC = String.fromCharCode(27);

// The page uses an undefined `longText` in its `columns` example.
const longText =
  "The quick brown fox jumps over the lazy dog and keeps running through the terminal width test until it wraps.";

// `--probe-bg` renders one inline-code span and prints its background index.
// `check()` spawns this file with different COLORFGBG values because Bun reads
// the variable at process start; mutating `process.env` later has no effect.
if (process.argv.includes("--probe-bg")) {
  const theme = process.argv.includes("--light")
    ? { light: true }
    : process.argv.includes("--dark")
      ? { light: false }
      : {};
  const bg =
    new RegExp(`${ESC}\\[48;5;(\\d+)m`).exec(
      Bun.markdown.ansi("`code`", theme),
    )?.[1] ?? "none";
  console.log(bg);
  process.exit(0);
}

// --- official examples, verbatim -------------------------------------------

const out = Bun.markdown.ansi("# Hello\n\n**bold** and *italic*\n");

// Plain text, no escape codes
const plain = Bun.markdown.ansi("# Hello", { colors: false });

// Enable clickable OSC 8 hyperlinks
const linked = Bun.markdown.ansi("[docs](https://bun.com)", {
  hyperlinks: true,
});

// Inline images via Kitty Graphics Protocol
const withImg = Bun.markdown.ansi("![alt](./logo.png)", {
  kittyGraphics: true,
});

// Custom width
const wrapped = Bun.markdown.ansi(longText, { columns: 60 });

// --- checks ----------------------------------------------------------------

/** Strip ANSI so widths can be compared to `columns`. */
function visible(text: string): string {
  const ANSI_RE = new RegExp(
    `${ESC}\\[[0-9;]*m|${ESC}\\]8;;[^${ESC}]*${ESC}\\\\`,
    "g",
  );
  return text.replace(ANSI_RE, "");
}

const ONE_PX_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function check(): Promise<void> {
  // 1. Defaults: colours on, heading rule uses box drawing.
  assert.ok(
    out.startsWith("\u001b[1m\u001b[35mHello"),
    "heading is bold magenta",
  );
  assert.ok(
    out.includes("\u2550\u2550\u2550\u2550\u2550"),
    "heading rule is ═ (box drawing)",
  );
  assert.ok(out.includes("\u001b[1mbold\u001b[22m"), "bold uses SGR 1/22");

  // 2. colors:false is not "strip ANSI": the chrome switches to ASCII.
  assert.ok(!plain.includes("\u001b"), "plain output has no escapes");
  assert.ok(
    plain.includes("Hello\n====="),
    "heading rule is ASCII = when colors are off",
  );

  // 3. hyperlinks: OSC 8 wraps the visible text.
  assert.ok(
    linked.includes("\u001b]8;;https://bun.com\u001b\\"),
    "OSC 8 opener",
  );
  assert.ok(linked.includes("docs"), "link text survives");
  assert.ok(linked.includes("\u001b[4m"), "link is underlined");

  // 4. kittyGraphics: local file -> file-mode transmit; remote -> alt text.
  const tmp = join(tmpdir(), `sd-ansi-kitty-${process.pid}.png`);
  await Bun.write(tmp, Buffer.from(ONE_PX_PNG, "base64"));
  try {
    const kitty = Bun.markdown.ansi(`![shot](${tmp})`, { kittyGraphics: true });
    assert.ok(kitty.includes("\u001b_G"), "Kitty graphics escape present");
    // The payload is the base64 absolute path: enabling this leaks host layout.
    assert.ok(
      kitty.includes(Buffer.from(tmp).toString("base64")),
      "Kitty payload carries the base64 absolute path",
    );
    assert.ok(
      !kitty.includes("\u{1F4F7}"),
      "no emoji fallback for a local file",
    );
  } finally {
    await rm(tmp, { force: true });
  }
  const remote = Bun.markdown.ansi("![shot](https://example.com/x.png)", {
    kittyGraphics: true,
  });
  assert.ok(
    !remote.includes("\u001b_G"),
    "remote URL never transmits graphics",
  );
  assert.ok(
    remote.includes("\u{1F4F7} shot"),
    "remote URL falls back to alt text",
  );

  // 5. columns wraps on word boundaries; 0 disables wrapping.
  const width = Bun.markdown.ansi(longText, { columns: 0 });
  assert.equal(
    width.split("\n").filter(Boolean).length,
    1,
    "columns:0 does not wrap",
  );
  const lines = wrapped.split("\n").filter(Boolean);
  assert.ok(lines.length > 1, "columns:60 wraps");
  for (const line of lines) {
    assert.ok(
      visible(line).length <= 60,
      `line exceeds 60 columns: ${visible(line)}`,
    );
  }
  // Pin the trailing reset: an "escape-free" assertion must tolerate it.
  assert.ok(
    wrapped.endsWith("\u001b[0m\n"),
    "wrapped output ends with a reset",
  );

  // 6. The page's summary says "By default, enables all GFM extensions plus
  // wikilinks, underline, and LaTeX math." Measured on 1.4.4 that does not hold
  // for ansi(); these assertions pin the divergence, so a release that
  // implements the claim fails here instead of drifting silently.
  const wiki = Bun.markdown.ansi("[[Desk Policy]]");
  assert.ok(wiki.includes("[[Desk Policy]]"), "wikilink brackets are kept");
  assert.ok(!wiki.includes("\u001b]8;;"), "wikilink is not an OSC 8 link");

  const math = Bun.markdown.ansi("$E = mc^2$");
  assert.ok(math.includes("$E = mc^2$"), "inline math stays literal");

  const strong = Bun.markdown.ansi("__under__");
  assert.ok(strong.includes("\u001b[1m"), "__x__ renders as GFM strong");
  assert.ok(!strong.includes("\u001b[4m"), "__x__ is not underline");

  // 7. `light` defaults to detecting from COLORFGBG (`fg;bg`; the last field is
  // the background index). Read at process start, so probe in a child.
  const baseEnv = { ...process.env } as Record<string, string>;
  delete baseEnv.COLORFGBG;
  const probeBg = (args: string[], extra: Record<string, string> = {}) => {
    const run = Bun.spawnSync(
      ["bun", import.meta.path, "--probe-bg", ...args],
      {
        env: { ...baseEnv, ...extra },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    assert.equal(run.exitCode, 0, run.stderr.toString());
    return run.stdout.toString().trim();
  };
  assert.equal(probeBg([]), "236", "no COLORFGBG -> dark palette");
  assert.equal(probeBg([], { COLORFGBG: "15;0" }), "236", "bg 0 -> dark");
  assert.equal(probeBg([], { COLORFGBG: "0;7" }), "254", "bg 7 -> light");
  assert.equal(probeBg([], { COLORFGBG: "0;15" }), "254", "bg 15 -> light");
  assert.equal(probeBg([], { COLORFGBG: "a;b" }), "236", "malformed -> dark");
  assert.equal(
    probeBg(["--dark"], { COLORFGBG: "0;15" }),
    "236",
    "explicit light:false wins over COLORFGBG",
  );

  console.log(
    "✓ official examples verified; the default-extension claim diverges as measured",
  );
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    await check();
  } else {
    console.log("default      ", JSON.stringify(out));
    console.log("plain        ", JSON.stringify(plain));
    console.log("linked       ", JSON.stringify(linked));
    console.log("image        ", JSON.stringify(withImg));
    console.log("wrapped      ", JSON.stringify(wrapped));
    console.log("\nrun with --check to assert the measured invariants");
  }
}
