import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function formatInTemp(ext: string, source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bun-fmt-semantics-"));
  try {
    const path = join(dir, `fixture.${ext}`);
    writeFileSync(path, source);
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "fmt", path],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bun fmt semantic preservation", () => {
  test("keeps the CSS escaped space", () => {
    const out = formatInTemp(
      "css",
      ".a { font-family: Font\\ Awesome, serif; }\n",
    );
    expect(out).toContain("Font\\ Awesome");
    expect(out).not.toContain("Font\\Awesome");
  });

  test("keeps descendant and namespace-qualified selectors distinct", () => {
    const source = readFileSync(
      join(import.meta.dir, "fixtures/fmt/combinator-vs-namespace.css"),
      "utf8",
    );
    const out = formatInTemp("css", source);
    // x |b is a descendant combinator; x|b is a namespace qualifier. Both stay.
    expect(out).toMatch(/x\s+\|b\s*\{/);
    expect(out).toMatch(/x\|b\s*\{/);
    expect(out.match(/\|b/g)?.length).toBe(2);
    expect(out).toContain("@namespace x url");
  });

  test("fmt --debug-check accepts the selector fixture", () => {
    const fixture = join(
      import.meta.dir,
      "fixtures/fmt/combinator-vs-namespace.css",
    );
    const proc = Bun.spawnSync({
      cmd: [process.execPath, "fmt", "--debug-check", fixture],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, proc.stderr.toString()).toBe(0);
  });

  test("leaves spec-invalid selector spacing untouched", () => {
    // Measured on 1.4.4: neither `x| b` nor `x |b` is normalized into a valid form.
    const out = formatInTemp(
      "css",
      "x| b { color: red; }\nx |b { color: blue; }\n",
    );
    expect(out).toContain("x| b");
    expect(out).toContain("x |b");
  });

  test("keeps Handlebars doctype and script comment lines", () => {
    const out = formatInTemp(
      "hbs",
      "<!DOCTYPE html>\n<div>{{value}}</div>\n<script>\n// keep this comment\nconst x = 1;\n</script>\n",
    );
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toMatch(/\/\/ keep this comment\s*\n\s*const x = 1;/);
    expect(out).not.toContain("// keep this comment const x = 1;");
  });
});
