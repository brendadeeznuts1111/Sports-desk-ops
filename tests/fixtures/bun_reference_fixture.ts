/**
 * @file tests/fixtures/bun_reference_fixture.ts
 * @description Synthetic bun.sh/reference payloads for the offline reference-audit tests.
 *
 * Three modules are enough to exercise every branch that does not need the live site: a documented
 * but absent value (`bun:foo`), a types-only claim (`bun:Bar`), a present global (`process`), a
 * present node member (`readFileSync`), sidebar kind badges (F/emerald, C/blue), the landing module
 * groups and the bun page's Modules sidebar (used for the module-source cross-check).
 */
import type { FetchJson } from "../../lib/bun_reference_audit.ts";

const landing = `<h1>API Reference</h1>
<h2>Bun modules</h2>
<a href="/reference/bun">Bun</a><a href="/reference/globals">Globals</a>
<h2>Node.js modules</h2>
<a href="/reference/node/fs">node:fs</a>
<p>Generated from Bun&#x27;s TypeScript definitions in <a href="https://github.com/oven-sh/bun/tree/main/packages/bun-types">packages/bun-types</a>.</p>`;

const moduleLinks = `<p>Modules</p><div><a href="/reference/bun">Bun</a><a href="/reference/globals">Globals</a><a href="/reference/node/fs">node:fs</a></div>`;

const bunPage = {
  props: {
    contentHtml: `<section id="functions"><li class="grid"><a href="/reference/bun/foo">foo</a><p>Best foo.</p></li></section>
<section id="classes"><li class="grid"><a href="/reference/bun/Bar">Bar</a><p>This class only exists in types</p></li></section>`,
    sidebarHtml: `${moduleLinks}
<a href="/reference/bun/foo" data-symbol="bun.foo"><span class="mono mr-2 inline-flex rounded bg-emerald-500/15 text-emerald-700">F</span><span class="truncate">foo</span></a>
<a href="/reference/bun/Bar" data-symbol="bun.Bar"><span class="mono mr-2 inline-flex rounded bg-blue-500/15 text-blue-700">C</span><span class="truncate">Bar</span></a>`,
  },
};

const globalsPage = {
  props: {
    contentHtml: `<section id="functions"><li class="grid"><a href="/reference/globals/process">process</a><p>The process object.</p></li></section>`,
    sidebarHtml: `<a href="/reference/globals/process" data-symbol="globals.process"><span class="mono mr-2 inline-flex rounded bg-emerald-500/15 text-emerald-700">F</span><span class="truncate">process</span></a>`,
  },
};

const nodeFsPage = {
  props: {
    contentHtml: `<section id="functions"><li class="grid"><a href="/reference/node/fs/readFileSync">readFileSync</a><p>Read a file.</p></li></section>`,
    sidebarHtml: `<a href="/reference/node/fs/readFileSync" data-symbol="node:fs.readFileSync"><span class="mono mr-2 inline-flex rounded bg-emerald-500/15 text-emerald-700">F</span><span class="truncate">readFileSync</span></a>`,
  },
};

const PAGES: Readonly<Record<string, unknown>> = {
  "https://bun.sh/reference.props.json": { props: { contentHtml: landing } },
  "https://bun.sh/reference/bun.props.json": bunPage,
  "https://bun.sh/reference/globals.props.json": globalsPage,
  "https://bun.sh/reference/node/fs.props.json": nodeFsPage,
};

/** Offline fetcher for the fixture pages; throws on an unexpected URL. */
export const fixtureFetch: FetchJson = async (url) => {
  const page = PAGES[url];
  if (page === undefined) throw new Error(`fixture: unexpected fetch ${url}`);
  return page;
};
