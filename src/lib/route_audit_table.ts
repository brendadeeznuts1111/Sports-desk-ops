/**
 * @file src/lib/route_audit_table.ts
 * @description Zero-exception `URL.parse()` and `URLPattern` route audit table renderer via `Bun.inspect.table`.
 */

import {
  BUN_UTILS_DOC_PATH,
  buildRuntimePinnedDocUrl,
} from "./bun_doc_linker.ts";
import { osc8Link } from "./terminal_links.ts";

export interface RouteSpec {
  readonly name: string;
  readonly pattern: URLPattern;
  readonly sampleUrl: URL;
  readonly docUrl: URL;
}

export interface DaemonRouteInput {
  readonly path: string;
  readonly surface: string | null;
}

/** Build `URLPattern`-backed `RouteSpec[]` from `DAEMON_ROUTES` with `Bun.revision`-pinned docs. */
export function daemonRoutesToSpecs(
  routes: readonly DaemonRouteInput[],
  baseOrigin = "http://127.0.0.1:4020",
  docPath: string = BUN_UTILS_DOC_PATH,
): readonly RouteSpec[] {
  const origin = baseOrigin.replace(/\/+$/, "");
  const out: RouteSpec[] = [];
  for (const r of routes) {
    const isPrefix = r.path.endsWith("*") || r.path.endsWith("/");
    const patternPath =
      r.path.length > 1 && r.path.endsWith("/") ? `${r.path}*` : r.path;
    const samplePath =
      isPrefix && r.path !== "/"
        ? `${r.path.replace(/\*$/, "")}sample`
        : r.path;
    const sampleUrl = URL.parse(`${origin}${samplePath}`);
    if (sampleUrl === null) continue;
    const docUrl = buildRuntimePinnedDocUrl(docPath, r.surface ?? r.path);
    out.push({
      name: r.surface ?? r.path,
      pattern: new URLPattern({ pathname: patternPath }),
      sampleUrl,
      docUrl,
    });
  }
  return out;
}

/** Safely build a `RouteSpec` without throwing on malformed sample or doc URLs. */
export function parseRouteSpec(input: {
  readonly name: string;
  readonly pathname: string;
  readonly sampleUrl: string;
  readonly docUrl: string;
}): RouteSpec | null {
  const sampleUrl = URL.parse(input.sampleUrl);
  const docUrl = URL.parse(input.docUrl);
  if (sampleUrl === null || docUrl === null) {
    return null;
  }
  return {
    name: input.name,
    pattern: new URLPattern({ pathname: input.pathname }),
    sampleUrl,
    docUrl,
  };
}

/** Render an aligned ANSI table of `URLPattern` match checks and clickable OSC-8 doc links. */
export function renderRouteAuditTable(
  routes: readonly RouteSpec[],
  options: { readonly colors?: boolean } = {},
): string {
  const rows = routes.map((r) => ({
    Route: r.name,
    Pathname: r.pattern.pathname,
    MatchesSample: r.pattern.test(r.sampleUrl),
    DocLink: osc8Link(r.docUrl, r.docUrl.pathname.split("/").pop() ?? "doc"),
  }));

  return Bun.inspect.table(
    rows,
    ["Route", "Pathname", "MatchesSample", "DocLink"],
    {
      colors: options.colors ?? true,
    },
  );
}
