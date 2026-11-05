import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TRACKER_CSS,
  mdCell,
  renderTrackerPage,
  safeHref,
  trackerBody,
  trackerMarkdown,
  type TrackerState,
} from "../lib/tracker_dashboard.ts";
import {
  ciOf,
  countMentions,
  loadMainCi,
  loadPullRequests,
  loadSecrets,
  loadTasks,
  loadTrackerState,
  type RunResult,
  type Runner,
  type TrackerSources,
} from "../lib/tracker_sources.ts";
import { startServer } from "../services/sportsdesk_webview_server.ts";

const ROOT = resolve(import.meta.dir, "..");

const STATE: TrackerState = {
  generatedAt: "2026-11-04T17:30:00.000Z",
  mainCi: "success @ e546b77",
  tasks: {
    kind: "rows",
    rows: [
      {
        id: "TASK-1",
        title: "Store the token",
        status: "blocked",
        blockedBy: "operator",
        next: "run secrets:env set",
      },
      {
        id: "TASK-2",
        title: "Ship it",
        status: "done",
        blockedBy: "-",
        next: "-",
      },
    ],
  },
  prs: {
    kind: "rows",
    rows: [
      {
        number: 34,
        title: "fix(deploy): install locked dependencies",
        state: "open",
        head: "fix/vps-bun-ci",
        base: "main",
        url: "https://github.com/bw496915-cmyk/Sports-desk-ops/pull/34",
        ci: "pass",
      },
    ],
  },
  secrets: {
    kind: "rows",
    rows: [
      {
        name: "R2_ACCESS_KEY_ID",
        groups: ["r2"],
        injectable: true,
        source: "keychain",
        mentions: { total: 12, files: 4, tests: 3 },
      },
      {
        name: "TELEGRAM_BOT_TOKEN",
        groups: [],
        injectable: true,
        source: "missing",
        mentions: null,
      },
    ],
  },
};

describe("trackerMarkdown", () => {
  test("every task, PR and secret has its own table row", () => {
    const md = trackerMarkdown(STATE);
    const rows = md
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| ---"));
    // 3 header rows + 2 tasks + 1 PR + 2 secrets
    expect(rows).toHaveLength(8);
    expect(md).toContain("| TASK-1 | Store the token | blocked |");
    expect(md).toContain("| `TELEGRAM_BOT_TOKEN` |");
  });

  test("a secret whose mentions could not be counted says n/a, not 0", () => {
    const md = trackerMarkdown(STATE);
    expect(md).toContain("| missing | n/a | n/a | n/a |");
  });

  test("an unavailable section says so instead of showing an empty table", () => {
    const md = trackerMarkdown({
      ...STATE,
      tasks: { kind: "unavailable", reason: "no task file" },
    });
    expect(md).toContain("Not available on this host: no task file.");
    expect(md).not.toContain("| TASK-1 |");
  });

  test("mdCell keeps one value in one cell", () => {
    expect(mdCell("a | b\nc")).toBe("a \\| b c");
    expect(mdCell("[x](https://evil.example)")).toBe(
      "\\[x\\](https://evil.example)",
    );
    expect(mdCell("![i](http://x)")).toBe("\\!\\[i\\](http://x)");
    expect(mdCell("<b>x</b>")).toBe("\\<b\\>x\\</b\\>");
  });
});

describe("renderTrackerPage", () => {
  const html = renderTrackerPage(STATE);

  test("is a complete document with the report in it", () => {
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).toContain("<h1>SportsDesk ops report</h1>");
    expect(html).toContain("<td>TASK-1</td>");
    expect(html).toContain(
      '<a href="https://github.com/bw496915-cmyk/Sports-desk-ops/pull/34" rel="noreferrer">#34</a>',
    );
  });

  test("known words in a cell become badges", () => {
    expect(html).toContain('<span class="b warn">blocked</span>');
    expect(html).toContain('<span class="b ok">done</span>');
    expect(html).toContain('<span class="b info">open</span>');
    expect(html).toContain('<span class="b ok">pass</span>');
    expect(html).toContain('<span class="b warn">missing</span>');
  });

  test("the cards count what the sections hold", () => {
    expect(html).toContain('<div class="card"><b>1</b>open PRs</div>');
    expect(html).toContain('<div class="card"><b>1</b>open tasks</div>');
    expect(html).toContain('<div class="card"><b>1</b>secrets missing</div>');
    expect(html).toContain('<div class="card"><b>2</b>secrets tracked</div>');
  });

  test("the page carries no script and no event handler", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("the stylesheet reaches the page byte for byte, with nothing for React to escape", () => {
    expect(TRACKER_CSS).not.toMatch(/[&<>"']/);
    expect(html).toContain(`<style>${TRACKER_CSS}</style>`);
  });

  test("hostile titles cannot add markup, links or images", () => {
    const hostile = renderTrackerPage({
      ...STATE,
      tasks: {
        kind: "rows",
        rows: [
          {
            id: "TASK-9",
            title:
              "<script>alert(1)</script><img src=x onerror=alert(2)> [go](https://evil.example) ![i](https://evil.example/i.png) [js](javascript:alert(3))",
            status: "todo",
            blockedBy: "a | b",
            next: "`code`",
          },
        ],
      },
      prs: {
        kind: "rows",
        rows: [
          {
            number: 99,
            title: "<b>bold</b>",
            state: "open",
            head: "h`ead",
            base: "main",
            url: "javascript:alert(4)",
            ci: "none",
          },
        ],
      },
    });
    expect(hostile).not.toContain("<script");
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toContain("<b>bold");
    // `javascript:` may appear as visible text; what must not exist is a link that uses it.
    const hrefs = [...hostile.matchAll(/href="([^"]*)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(hrefs).toEqual(["/"]);
    expect(hostile).not.toMatch(/<a [^>]*evil/);
    // A PR whose URL is not https keeps its number as plain text inside an anchor with no href.
    expect(hostile).toContain('<a rel="noreferrer">#99</a>');
    // The text is still shown, as text.
    expect(hostile).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(hostile).toContain("a | b");
  });
});

describe("trackerBody", () => {
  test("renders React 18 elements, the version the pinned react-dom renders", () => {
    const body = trackerBody("# Hi") as unknown as { $$typeof: symbol };
    const first = Array.isArray(body) ? body[0] : body;
    expect((first as { $$typeof: symbol }).$$typeof).toBe(
      Symbol.for("react.element"),
    );
  });

  test("raw HTML and images in markdown are dropped, not escaped into elements", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        trackerBody("<script>x()</script>\n\n![i](https://evil.example/i.png)"),
      ),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<html");
  });

  test("only an https link keeps its href", () => {
    expect(safeHref("https://github.com/a/b")).toBe("https://github.com/a/b");
    expect(safeHref("http://github.com/a/b")).toBeUndefined();
    expect(safeHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHref("/relative")).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});

// ---- sources ------------------------------------------------------------------------------

const ok = (out: string): RunResult => ({ ok: true, out, err: "" });
const fail = (err: string): RunResult => ({ ok: false, out: "", err });

function sources(
  over: Partial<TrackerSources> & { run?: Runner } = {},
): TrackerSources {
  return {
    root: "/nowhere",
    run: async () => fail("not found"),
    now: () => new Date("2026-11-04T17:30:00.000Z"),
    readTasksFile: async () => null,
    readFile: async () => null,
    secretStatus: async () => [],
    ...over,
  };
}

describe("loadTasks", () => {
  test("no file means unavailable, not an empty list", async () => {
    expect((await loadTasks(sources())).kind).toBe("unavailable");
  });
  test("invalid JSON and the wrong shape are named", async () => {
    const a = await loadTasks(sources({ readTasksFile: async () => "{" }));
    const b = await loadTasks(
      sources({ readTasksFile: async () => '[{"id":1}]' }),
    );
    expect(a).toEqual({
      kind: "unavailable",
      reason: "the task file is not valid JSON",
    });
    expect(b.kind).toBe("unavailable");
  });
  test("a bad status is refused rather than rendered", async () => {
    const text = JSON.stringify([
      { id: "T", title: "t", status: "maybe", blockedBy: "-", next: "-" },
    ]);
    expect(
      (await loadTasks(sources({ readTasksFile: async () => text }))).kind,
    ).toBe("unavailable");
  });
  test("a valid file loads", async () => {
    const text = JSON.stringify([
      { id: "T", title: "t", status: "todo", blockedBy: "-", next: "-" },
    ]);
    const out = await loadTasks(sources({ readTasksFile: async () => text }));
    expect(out.kind === "rows" && out.rows[0]?.id).toBe("T");
  });
});

describe("pull requests and main CI", () => {
  test("gh missing is unavailable with its message", async () => {
    const out = await loadPullRequests(sources());
    expect(out).toEqual({ kind: "unavailable", reason: "gh: not found" });
    expect(await loadMainCi(sources())).toBeNull();
  });

  test("gh JSON becomes rows with CI folded to one word", async () => {
    const json = JSON.stringify([
      {
        number: 5,
        title: "t",
        state: "MERGED",
        headRefName: "a",
        baseRefName: "main",
        url: "https://github.com/x/y/pull/5",
        statusCheckRollup: [{ conclusion: "SUCCESS", status: "COMPLETED" }],
      },
      {
        number: 6,
        title: "u",
        state: "OPEN",
        headRefName: "b",
        baseRefName: "main",
        url: "https://github.com/x/y/pull/6",
        statusCheckRollup: [],
      },
    ]);
    const out = await loadPullRequests(sources({ run: async () => ok(json) }));
    expect(
      out.kind === "rows" && out.rows.map((r) => [r.number, r.state, r.ci]),
    ).toEqual([
      [5, "merged", "pass"],
      [6, "open", "none"],
    ]);
  });

  test("ciOf: running beats fail beats pass", () => {
    expect(ciOf(undefined)).toBe("none");
    expect(ciOf([{ conclusion: "SUCCESS", status: "COMPLETED" }])).toBe("pass");
    expect(ciOf([{ conclusion: "FAILURE", status: "COMPLETED" }])).toBe("fail");
    expect(
      ciOf([
        { conclusion: "FAILURE", status: "COMPLETED" },
        { conclusion: null, status: "IN_PROGRESS" },
      ]),
    ).toBe("running");
  });

  test("main CI reads the latest run", async () => {
    const json = JSON.stringify([
      { conclusion: "success", status: "completed", headSha: "e546b77abcdef" },
    ]);
    expect(await loadMainCi(sources({ run: async () => ok(json) }))).toBe(
      "success @ e546b77",
    );
  });
});

describe("secrets and mentions", () => {
  test("a keychain that cannot be reached makes the section unavailable", async () => {
    const out = await loadSecrets(
      sources({
        secretStatus: async () => {
          throw new Error("no secret service");
        },
      }),
    );
    expect(out).toEqual({
      kind: "unavailable",
      reason: "secret status: no secret service",
    });
  });

  test("mentions count whole words, split out tests, and skip the defining files", async () => {
    const files: Record<string, string> = {
      "lib/a.ts": "R2_BUCKET_NAME R2_BUCKET_NAME_X R2_BUCKET_NAME",
      "tests/a.test.ts": "R2_BUCKET_NAME",
      "lib/secret_manifest.ts": "R2_BUCKET_NAME R2_BUCKET_NAME R2_BUCKET_NAME",
    };
    const counted = await countMentions(
      sources({
        run: async () => ok(`${Object.keys(files).join("\n")}\n`),
        readFile: async (f) => files[f] ?? null,
      }),
    );
    expect(counted?.get("R2_BUCKET_NAME")).toEqual({
      total: 3,
      files: 2,
      tests: 1,
    });
  });

  test("without git the counts are null, and the rows say n/a", async () => {
    const out = await loadSecrets(
      sources({
        secretStatus: async () => [
          {
            name: "R2_BUCKET_NAME",
            groups: ["r2"],
            injectable: true,
            source: { kind: "unset" },
          },
        ],
      }),
    );
    expect(out.kind === "rows" && out.rows[0]).toEqual({
      name: "R2_BUCKET_NAME",
      groups: ["r2"],
      injectable: true,
      source: "unset (environment only)",
      mentions: null,
    });
  });

  test("a host with none of the sources still produces a state", async () => {
    const state = await loadTrackerState(sources());
    expect(state.generatedAt).toBe("2026-11-04T17:30:00.000Z");
    expect(state.tasks.kind).toBe("unavailable");
    expect(state.prs.kind).toBe("unavailable");
    expect(state.mainCi).toBeNull();
    expect(renderTrackerPage(state)).toContain("Not available on this host");
  });
});

// ---- the route ----------------------------------------------------------------------------

describe("GET /tracker", () => {
  const server = startServer({
    port: 0,
    hostname: "127.0.0.1",
    // The injected state keeps this test off gh, git and the real keychain.
    trackerState: async () => STATE,
  });
  const base = `http://127.0.0.1:${server.port}`;
  afterAll(() => {
    server.stop(true);
  });

  test("loopback gets the page with a locked-down CSP", async () => {
    const res = await fetch(`${base}/tracker`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const body = await res.text();
    expect(body).toContain("<h1>SportsDesk ops report</h1>");
    expect(body).toContain("TASK-1");
  });

  test("only GET is answered", async () => {
    const res = await fetch(`${base}/tracker`, { method: "POST" });
    expect(res.status).not.toBe(200);
  });

  test("the index links to it", async () => {
    const html = await Bun.file(
      resolve(ROOT, "static/customer-churn-simulation-dashboard.html"),
    ).text();
    expect(html).toContain('href="/tracker"');
  });
});
