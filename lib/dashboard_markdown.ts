/**
 * One dashboard model, two renderers: HTML for the web and ANSI for a terminal.
 *
 * The model is Markdown rather than a second HTML template. `Bun.markdown.html()` and
 * `Bun.markdown.ansi()` then produce the two outputs from the same strings, so a section cannot
 * exist in one view and be missing from the other. The section order is deliberate: operational
 * panels (pending exposure, watchlist, WebLog, review, live wagers) come before the reference
 * panels (contests, game board, sport catalog, analysis), and admin last.
 */

export type DashboardSectionState =
  "measured" | "locked" | "unavailable" | "not_measured";

export type DashboardSectionGroup =
  "headline" | "live" | "risk" | "markets" | "ops" | "admin";

export interface DashboardSection {
  readonly id: string;
  readonly title: string;
  readonly group: DashboardSectionGroup;
  readonly state: DashboardSectionState;
  /** Source / as-of / stale / partial sentence, rendered as a blockquote. */
  readonly provenance?: string;
  /** Markdown lines for the section body (tables, lists, paragraphs). */
  readonly body: readonly string[];
}

export interface DashboardSnapshot {
  readonly generatedAt: string;
  readonly source: string;
  readonly sections: readonly DashboardSection[];
}

/**
 * Rendering order. Every section has an explicit H2; the reference tables stay below the
 * operational panels and `admin` is last.
 */
export const DASHBOARD_SECTION_ORDER = [
  "headline",
  "live-desk",
  "watchlist",
  "weblog",
  "review",
  "live-wagers",
  "contests",
  "game-admin",
  "sports-catalog",
  "analysis",
  "automation",
  "admin",
] as const;

const STATE_LABEL: Readonly<Record<DashboardSectionState, string>> = {
  measured: "MEASURED",
  locked: "LOCKED",
  unavailable: "UNAVAILABLE",
  not_measured: "NOT MEASURED",
};

/** Escape one Markdown table cell. Long prose belongs outside the table. */
export function markdownCell(value: unknown): string {
  const text = value === null || value === undefined ? "—" : String(value);
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** A GitHub-flavored Markdown table, with escaped cells. */
export function markdownTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string[] {
  const head = `| ${headers.map(markdownCell).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  return [
    head,
    rule,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ];
}

/** Build the shared Markdown document. Unknown section ids are appended after the known ones. */
export function buildDashboardMarkdown(snapshot: DashboardSnapshot): string {
  const byId = new Map(
    snapshot.sections.map((section) => [section.id, section]),
  );
  const ordered = DASHBOARD_SECTION_ORDER.flatMap((id) => {
    const section = byId.get(id);
    return section === undefined ? [] : [section];
  });
  const known = new Set<string>(DASHBOARD_SECTION_ORDER);
  const extra = snapshot.sections.filter((section) => !known.has(section.id));

  const lines = [
    "# SportsDesk & Fantasy402 Dashboard",
    "",
    `> Generated ${snapshot.generatedAt} · source: ${snapshot.source}`,
    "",
  ];

  for (const section of [...ordered, ...extra]) {
    lines.push(`## ${section.title}`, "");
    if (section.provenance !== undefined && section.provenance !== "") {
      lines.push(`> ${section.provenance}`, "");
    }
    lines.push(`**Status:** ${STATE_LABEL[section.state]}`, "");
    lines.push(...section.body, "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
