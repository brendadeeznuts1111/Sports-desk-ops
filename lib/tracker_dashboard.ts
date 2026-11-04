/**
 * The ops tracker page: tasks, pull requests and the secret inventory, as one markdown report
 * rendered to React 18 elements by `Bun.markdown.react` and to HTML by `react-dom/server`.
 *
 * Pure: it takes a `TrackerState` and returns strings. Where the data comes from (gh, git, the
 * keychain, a task file) is `lib/tracker_sources.ts`, so this file can be tested without any of them.
 *
 * The page is static markup with no script. Everything that came from outside (PR titles, task
 * text) goes through React's text escaping, raw HTML in the markdown is dropped, images are
 * dropped and only https links keep their href.
 *
 * `reactVersion: 18` selects the `react.element` symbol, which is what the pinned `react@18` and
 * `react-dom@18` render. Passing the default (19) elements to React 18 would not render.
 */
import { createElement as h, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export const TASK_STATUSES = [
  "todo",
  "in-review",
  "blocked",
  "failing",
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TrackerTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly blockedBy: string;
  readonly next: string;
}

export interface TrackerPr {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  readonly head: string;
  readonly base: string;
  readonly url: string;
  readonly ci: "pass" | "fail" | "running" | "none";
}

export interface TrackerMentions {
  readonly total: number;
  readonly files: number;
  readonly tests: number;
}

export interface TrackerSecret {
  readonly name: string;
  readonly groups: readonly string[];
  readonly injectable: boolean;
  /** Where the value would come from. Names and kinds only; the value is never read into state. */
  readonly source: string;
  /** `null` when the repository could not be searched on this host. */
  readonly mentions: TrackerMentions | null;
}

/** A section either has rows or says why it has none; there is no empty-but-fine third state. */
export type Section<T> =
  | { readonly kind: "rows"; readonly rows: readonly T[] }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface TrackerState {
  readonly generatedAt: string;
  /** e.g. `success @ e546b77`, or `null` when `gh` could not say. */
  readonly mainCi: string | null;
  readonly tasks: Section<TrackerTask>;
  readonly prs: Section<TrackerPr>;
  readonly secrets: Section<TrackerSecret>;
}

/**
 * One line of table-cell text. Whitespace collapses, and every character markdown could read as
 * syntax (pipes, brackets, backticks, emphasis, angle brackets, `!`) is backslash-escaped, so a PR
 * title cannot add a column, a link, an image or a tag. A backslash before ASCII punctuation is an
 * escape in CommonMark and renders as the bare character.
 */
export function mdCell(value: unknown): string {
  return String(value)
    .replaceAll(/\s+/g, " ")
    .trim()
    .replaceAll(/[\\|`*_[\]<>!~]/g, "\\$&");
}

/** A link destination that cannot end early: spaces and parentheses are percent-encoded. */
export function mdUrl(value: unknown): string {
  return String(value)
    .replaceAll(/\s/g, "%20")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29");
}

/** Text for a code span: no backtick can close it, and nothing inside is interpreted. */
export function mdCode(value: unknown): string {
  return String(value).replaceAll(/\s+/g, " ").replaceAll("`", "'").trim();
}

function unavailable(reason: string): string[] {
  return [`Not available on this host: ${mdCell(reason)}.`, ""];
}

export function trackerMarkdown(state: TrackerState): string {
  const lines: string[] = [
    "# SportsDesk ops report",
    "",
    `Generated ${mdCell(state.generatedAt)}. Main CI: ${mdCell(state.mainCi ?? "unknown")}.`,
    "",
    "## Tasks",
    "",
  ];

  if (state.tasks.kind === "unavailable") {
    lines.push(...unavailable(state.tasks.reason));
  } else {
    lines.push(
      "| ID | Item | Status | Blocked by | Next |",
      "| --- | --- | :---: | --- | --- |",
      ...state.tasks.rows.map(
        (t) =>
          `| ${mdCell(t.id)} | ${mdCell(t.title)} | ${t.status} | ${mdCell(t.blockedBy)} | ${mdCell(t.next)} |`,
      ),
      "",
    );
  }

  lines.push("## Pull requests", "");
  if (state.prs.kind === "unavailable") {
    lines.push(...unavailable(state.prs.reason));
  } else {
    lines.push(
      "| PR | Title | State | CI | Branch |",
      "| --- | --- | :---: | :---: | --- |",
      ...state.prs.rows.map(
        (p) =>
          `| [#${p.number}](${mdUrl(p.url)}) | ${mdCell(p.title)} | ${p.state} | ${p.ci} | \`${mdCode(p.head)}\` to \`${mdCode(p.base)}\` |`,
      ),
      "",
    );
  }

  lines.push(
    "## Secrets",
    "",
    "Names and sources only. Mentions are word matches in tracked code.",
    "",
  );
  if (state.secrets.kind === "unavailable") {
    lines.push(...unavailable(state.secrets.reason));
  } else {
    lines.push(
      "| Variable | Groups | Inject | Source | Mentions | Files | In tests |",
      "| --- | --- | :---: | :---: | ---: | ---: | ---: |",
      ...state.secrets.rows.map((s) => {
        const m = s.mentions;
        return `| \`${mdCode(s.name)}\` | ${mdCell(s.groups.join(" + "))} | ${s.injectable ? "yes" : "no"} | ${mdCell(s.source)} | ${m?.total ?? "n/a"} | ${m?.files ?? "n/a"} | ${m?.tests ?? "n/a"} |`;
      }),
      "",
    );
  }
  return lines.join("\n");
}

const TONE: Readonly<Record<string, string>> = {
  merged: "ok",
  done: "ok",
  pass: "ok",
  keychain: "ok",
  env: "ok",
  open: "info",
  "in-review": "info",
  running: "info",
  blocked: "warn",
  missing: "warn",
  failing: "bad",
  fail: "bad",
};

/** Plain text of a cell's children, so a cell that is exactly a known word becomes a badge. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return "";
}

/** Only an https URL keeps its href; `javascript:`, `data:` and relative links lose it. */
export function safeHref(href: unknown): string | undefined {
  if (typeof href !== "string") return undefined;
  try {
    return new URL(href).protocol === "https:" ? href : undefined;
  } catch {
    return undefined;
  }
}

interface CellProps {
  readonly children?: ReactNode;
  readonly align?: "left" | "center" | "right";
}

interface LinkProps {
  readonly children?: ReactNode;
  readonly href?: string;
}

export function trackerBody(markdown: string): ReactNode {
  return Bun.markdown.react(
    markdown,
    {
      a: ({ children, href }: LinkProps) =>
        h("a", { href: safeHref(href), rel: "noreferrer" }, children),
      img: () => null,
      html: () => null,
      td: ({ children, align }: CellProps) => {
        const text = textOf(children).trim();
        const tone = TONE[text];
        return h(
          "td",
          { align },
          tone === undefined
            ? children
            : h("span", { className: `b ${tone}` }, children),
        );
      },
    },
    { reactVersion: 18 },
  );
}

// No quotes, ampersands or angle brackets: React escapes text children, and this is passed as text
// so the page needs no raw-HTML escape hatch. tests/tracker_dashboard.test.ts pins that.
export const TRACKER_CSS = [
  ":root{color-scheme:light dark;--bg:#fff;--fg:#1c1e21;--line:#d8dbe0;--mute:#6b7280}",
  "@media (prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e6e8eb;--line:#2b2f36;--mute:#9aa1ab}}",
  "body{margin:0;padding:24px;max-width:1200px;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}",
  "h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin-top:28px}",
  "table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}",
  "th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}",
  "code{font:12.5px ui-monospace,Menlo,monospace}a{color:inherit}",
  ".cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}",
  ".card{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:130px}",
  ".card b{display:block;font-size:20px}",
  "td:first-child{white-space:nowrap}",
  ".b{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line);white-space:nowrap}",
  ".ok{background:#1f8f4e22;border-color:#1f8f4e}.info{background:#2b6cd822;border-color:#2b6cd8}",
  ".warn{background:#c7860022;border-color:#c78600}.bad{background:#d1313122;border-color:#d13131}",
  ".nav{margin-bottom:12px;color:var(--mute)}",
].join("\n");

function counts(state: TrackerState): readonly [string, string][] {
  const open =
    state.prs.kind === "rows"
      ? String(state.prs.rows.filter((p) => p.state === "open").length)
      : "n/a";
  const openTasks =
    state.tasks.kind === "rows"
      ? String(state.tasks.rows.filter((t) => t.status !== "done").length)
      : "n/a";
  const missing =
    state.secrets.kind === "rows"
      ? String(state.secrets.rows.filter((s) => s.source === "missing").length)
      : "n/a";
  const tracked =
    state.secrets.kind === "rows" ? String(state.secrets.rows.length) : "n/a";
  return [
    [open, "open PRs"],
    [openTasks, "open tasks"],
    [missing, "secrets missing"],
    [tracked, "secrets tracked"],
  ];
}

/** The whole page, doctype included. */
export function renderTrackerPage(state: TrackerState): string {
  const page = h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("meta", { charSet: "utf-8" }),
      h("title", null, "SportsDesk ops tracker"),
      h("style", null, TRACKER_CSS),
    ),
    h(
      "body",
      null,
      h("div", { className: "nav" }, h("a", { href: "/" }, "Desk home")),
      h(
        "div",
        { className: "cards" },
        counts(state).map(([value, label]) =>
          h(
            "div",
            { className: "card", key: label },
            h("b", null, value),
            label,
          ),
        ),
      ),
      trackerBody(trackerMarkdown(state)),
    ),
  );
  return `<!doctype html>${renderToStaticMarkup(page)}`;
}

/**
 * Response headers for the page. The CSP allows only the page's own inline style: no script, no
 * connections, no framing, no base or form targets, because PR titles are text from outside.
 */
export const TRACKER_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  Vary: "Origin, Authorization",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
