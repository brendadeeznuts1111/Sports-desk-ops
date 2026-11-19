import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * `README.md` carries a Contents list of in-page anchors. GitHub generates them from the heading
 * text, so a heading rename silently breaks navigation with nothing to catch it.
 *
 * The slug rule here was not guessed: the anchors were read back from the rendered
 * `github.com/.../blob/main/README.md` (`id="user-content-…"`) and matched against these headings.
 * Lowercase; drop every character outside `[a-z0-9\\s-]`; each remaining space becomes one hyphen.
 * Note the consequences that the rendered page confirmed:
 *
 * - `&` is dropped, so `Runtime Architecture & Server Policies` → `runtime-architecture--server-policies`
 * - the leading emoji in `🚀 Day-1 …` is dropped, leaving a leading hyphen
 * - the en dash in `18–28` is dropped, so `Qwen3.5-4B (Layers 18–28)` → `qwen35-4b-layers-1828`
 */

const README = join(import.meta.dir, "..", "README.md");

/** GitHub's anchor for a heading, as measured against the rendered page. */
export function githubAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[ \t]/g, "-");
}

async function readmeSource(): Promise<string> {
  return Bun.file(README).text();
}

describe("README anchors", () => {
  test("every Contents link resolves to a heading", async () => {
    const text = await readmeSource();
    const anchors = new Set(
      text
        .split("\n")
        .map((line) => /^(#{2,3}) (.+)$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => githubAnchor(match[2]!.trim()))
        .filter((anchor) => anchor !== "contents"),
    );
    const links = [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);

    expect(links.length).toBeGreaterThan(10);
    expect(links.filter((link) => !anchors.has(link))).toEqual([]);
  });

  test("every section heading is reachable from Contents", async () => {
    const text = await readmeSource();
    const headings = text
      .split("\n")
      .map((line) => /^(#{2,3}) (.+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => githubAnchor(match[2]!.trim()))
      .filter((anchor) => anchor !== "contents");
    const links = new Set(
      [...text.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!),
    );

    expect(headings.filter((anchor) => !links.has(anchor))).toEqual([]);
  });

  test("the slug rule matches the rendered page", () => {
    // Cases confirmed against the anchors GitHub rendered for this README.
    expect(githubAnchor("SportsDesk & Fantasy402 Operations Suite")).toBe(
      "sportsdesk--fantasy402-operations-suite",
    );
    expect(
      githubAnchor("🚀 Day-1 Operator Onboarding & 60-Second Triage Guide"),
    ).toBe("-day-1-operator-onboarding--60-second-triage-guide");
    expect(
      githubAnchor(
        "Qwen3.5-4B (Layers 18–28) Token Architecture & Single Source of Truth",
      ),
    ).toBe("qwen35-4b-layers-1828-token-architecture--single-source-of-truth");
    expect(githubAnchor("Plane 3 — append-only ingestion JSONL replay")).toBe(
      "plane-3--append-only-ingestion-jsonl-replay",
    );
  });
});
