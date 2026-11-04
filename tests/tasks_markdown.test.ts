import { describe, expect, test } from "bun:test";

const GFM = {
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: true,
  tagFilter: true,
  noHtmlBlocks: true,
  noHtmlSpans: true,
  headings: { autolink: false, ids: true },
} as const;

const markdown = await Bun.file("docs/REMAINING_TASKS.md").text();
const html = Bun.markdown.html(markdown, GFM);

describe("remaining-tasks markdown", () => {
  test("every open task carries an id, a done-when and a blocker", () => {
    const open = markdown.match(/^- \[ \] .+$/gm) ?? [];
    expect(open.length).toBeGreaterThan(0);
    for (const line of open) {
      expect(line).toMatch(/^- \[ \] \*\*P[0-2]\.\d /);
    }
    const doneWhen = (markdown.match(/\*\*Done when:\*\*/g) ?? []).length;
    const blockedBy = (markdown.match(/\*\*Blocked by:\*\*/g) ?? []).length;
    const doneItems = (markdown.match(/^- \[x\]/gm) ?? []).length;
    expect(doneWhen + doneItems).toBeGreaterThanOrEqual(open.length);
    expect(blockedBy).toBeGreaterThanOrEqual(open.length);
  });

  test("Bun.markdown renders every task as a GFM checkbox", () => {
    const open = (markdown.match(/^- \[ \]/gm) ?? []).length;
    const done = (markdown.match(/^- \[x\]/gm) ?? []).length;
    const checkboxes = (html.match(/type="checkbox"/g) ?? []).length;
    const checked = (html.match(/type="checkbox"[^>]*checked/g) ?? []).length;
    expect(checkboxes).toBe(open + done);
    expect(checked).toBe(done);
  });

  test("GFM tables render and no renderer placeholder leaks", () => {
    expect(html).toContain("<table>");
    const sample = Bun.markdown.html("# T\n\n| A |\n| --- |\n| 1 |");
    expect(sample).not.toContain("undefined");
    expect(sample).not.toContain("[object Object]");
  });

  test("ANSI rendering keeps task markers and omits HTML", () => {
    // `ansi()` takes an AnsiTheme, not parser options. Columns 0 is the no-wrap log mode.
    const ansi = Bun.markdown.ansi(markdown, { colors: false, columns: 0 });
    expect(ansi).toContain("[ ]");
    expect(ansi).toContain("[x]");
    expect(ansi).not.toContain("<table>");
    expect(ansi).not.toContain('type="checkbox"');
    expect(ansi).not.toContain("\u001b[");
    const colored = Bun.markdown.ansi(markdown, { colors: true, columns: 0 });
    expect(colored).toContain("\u001b[");
  });

  test("tagFilter is not a sanitizer; noHtml* removes raw HTML", () => {
    expect(html).toContain('id="p0-trust-blockers"');
    const filtered = Bun.markdown.html("<img src=x onerror=alert(1)>", {
      tagFilter: true,
    });
    // The GFM tag filter escapes a tag allowlist; it does not strip attributes or URL schemes.
    expect(filtered).toContain("onerror=alert(1)");
    const disabled = Bun.markdown.html("<img src=x onerror=alert(1)>", {
      tagFilter: true,
      noHtmlBlocks: true,
      noHtmlSpans: true,
    });
    expect(disabled).toContain("&lt;img");
    expect(disabled).not.toContain("<img");
  });

  test("tasklists: false disables the gate by design", () => {
    const noTasks = Bun.markdown.html("- [x] done", { tasklists: false });
    expect(noTasks).not.toContain('type="checkbox"');
  });

  test("the task doc avoids constructs that can diverge", () => {
    // Measured on 1.4.4: only wikiLinks changes HTML output; underline/latexMath are inert and ansi()
    // leaves all three literal. Wiki brackets stay banned so the artifact cannot opt into a link the
    // terminal view does not render (see tests/markdown_modes.test.ts).
    expect(markdown).not.toContain("[[");
    expect(markdown).not.toMatch(/__/);
    expect(markdown).not.toMatch(/\$/);
  });

  test("render(): listItem.checked distinguishes bullets from task state", () => {
    const seen: Array<boolean | undefined> = [];
    Bun.markdown.render(
      "- plain\n- [ ] open\n- [x] done\n",
      {
        listItem: (_children, meta) => {
          seen.push(meta.checked);
          return "";
        },
      },
      { tasklists: true },
    );
    expect(seen).toEqual([undefined, false, true]);
  });

  test("every open task carries a Ref that resolves in the references table", () => {
    const lines = markdown.split("\n");
    const taskRefs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.startsWith("- [ ] ")) continue;
      const refs: string[] = [];
      for (
        let j = i + 1;
        j < lines.length && /^\s{2,}\S/.test(lines[j]!);
        j++
      ) {
        const match = /^\s+- \*\*Ref:\*\* `(RT-[A-Z0-9-]+)`$/.exec(lines[j]!);
        if (match) refs.push(match[1]!);
      }
      expect(refs.length).toBe(1);
      taskRefs.push(refs[0]!);
    }
    expect(taskRefs.length).toBe((markdown.match(/^- \[ \]/gm) ?? []).length);

    const tableRefs = [
      ...markdown.matchAll(/^\|\s*`(RT-[A-Z0-9-]+)`\s*\|/gm),
    ].map((m) => m[1]!);
    expect(tableRefs.length).toBe(new Set(tableRefs).size);
    const table = new Set(tableRefs);
    for (const ref of taskRefs) expect(table.has(ref)).toBe(true);
    for (const ref of table) {
      if (ref.startsWith("RT-RENDER-") || ref.startsWith("RT-DOCS-")) continue;
      expect(taskRefs).toContain(ref);
    }
  });

  test("the references table cites resolved Bun records, not memory", () => {
    const records = [
      "doc:runtime/markdown",
      "api:Bun.markdown.html",
      "api:Bun.markdown.ansi",
      "api:Bun.markdown.render",
      "api:Bun.markdown.Options",
      "api:Bun.markdown.ListItemMeta",
    ];
    for (const record of records) expect(markdown).toContain(record);
    // ANSI takes a theme, not Options; the doc must not claim otherwise.
    expect(markdown).toContain("ansi(input, theme?: AnsiTheme): string");
  });

  test("srcdoc escaping survives the parser's entity decode", async () => {
    // A stock `srcdoc` attribute is entity-decoded once before its contents are parsed, so a
    // `"`-only escape decodes the `&lt;img …&gt;` that noHtml* produced straight back to markup.
    const payload = `<img src=x onerror="parent.document.title='XSS'">`;
    const rendered = Bun.markdown.html(payload, {
      noHtmlBlocks: true,
      noHtmlSpans: true,
    });
    const ENTITIES = {
      "&amp;": "&",
      "&quot;": '"',
      "&lt;": "<",
      "&gt;": ">",
    } as const;
    // One pass, no re-scan: that is what the HTML parser does with an attribute value.
    const decodeOnce = (s: string): string =>
      s.replace(
        /&(?:amp|quot|lt|gt);/g,
        (entity) => ENTITIES[entity as keyof typeof ENTITIES],
      );
    expect(decodeOnce(rendered.replaceAll('"', "&quot;"))).toContain("<img");

    const fixture = "scratch/iframe-fixture.md";
    const out = "scratch/iframe-fixture.html";
    await Bun.write(fixture, payload);
    try {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/render_tasks.ts",
          "--source",
          fixture,
          "--format",
          "iframe",
          "--out",
          out,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await proc.exited).toBe(0);
      const page = await Bun.file(out).text();
      expect(page).toContain("sandbox");
      expect(page).toContain('title="Remaining tasks');
      const attr = /srcdoc="([^"]*)"/.exec(page)?.[1] ?? "";
      expect(attr).not.toBe("");
      const decoded = decodeOnce(attr);
      expect(decoded).toBe(rendered);
      expect(decoded).not.toContain("<img");
    } finally {
      await Bun.file(fixture).delete();
      await Bun.file(out).delete();
    }
  });

  test("the zero-code CLI loader renders the document", async () => {
    const proc = Bun.spawn(["bun", "docs/REMAINING_TASKS.md"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await proc.stdout.text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("Remaining tasks");
    expect(out).toContain("P0.1");
  });
});
