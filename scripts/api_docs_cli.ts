#!/usr/bin/env bun
/**
 * @file scripts/api_docs_cli.ts
 * @description Operator entry point for the deployed API docs (Scalar portal, R2 mirrors) and the
 * GSLive Manager deep-link section published inside them.
 *
 * Usage:
 *   bun run scripts/api_docs_cli.ts            # portal + mirror URLs and GSLive surface summary
 *   bun run scripts/api_docs_cli.ts gslive     # full GSLive operator-link documentation
 *   bun run scripts/api_docs_cli.ts --json     # x-sportsdesk-gslive extension as JSON
 *   bun run scripts/api_docs_cli.ts --open     # open the Scalar portal in the browser
 */

import { join } from "node:path";
import { CANONICAL_DOMAINS } from "../lib/canonical_osc8_links.ts";
import { renderGSLiveDocsMarkdown } from "../lib/gslive_api_docs.ts";

const repoRoot = join(import.meta.dirname, "..");
const specPath = join(repoRoot, "docs", "openapi.json");

interface GsLiveSurface {
  readonly id?: string;
  readonly route?: string;
  readonly purpose?: string;
}

interface GsLiveExtension {
  readonly provider?: string;
  readonly kind?: string;
  readonly origin?: string;
  readonly managerPath?: string;
  readonly partnerId?: number;
  readonly cli?: string;
  readonly contractDoc?: string;
  readonly surfaces?: readonly GsLiveSurface[];
}

const spec = (await Bun.file(specPath).json()) as Record<
  string,
  unknown
>;
const extension = spec["x-sportsdesk-gslive"] as GsLiveExtension | undefined;
const args = process.argv.slice(2);

const scalarUrl = `${CANONICAL_DOMAINS.DOCS_PORTAL}/`;
const r2 = CANONICAL_DOMAINS.R2_PUBLIC_GATEWAY;

if (args.includes("--json")) {
  console.log(JSON.stringify(extension ?? null, null, 2));
  process.exit(0);
}

if (args.includes("gslive")) {
  process.stdout.write(renderGSLiveDocsMarkdown());
  process.exit(0);
}

if (args.includes("--open")) {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  Bun.spawn([opener, scalarUrl], { stdout: "inherit", stderr: "inherit" });
}

console.log(
  "================================================================================",
);
console.log("  📚 DEPLOYED API DOCS (Scalar · Cloudflare R2 · local dist)");
console.log(
  "================================================================================",
);
console.log(`  • Scalar portal        : ${scalarUrl}`);
console.log(
  `  • Custom docs domain   : ${CANONICAL_DOMAINS.CUSTOM_DOCS_DOMAIN}/`,
);
console.log(`  • R2 OpenAPI 3.1 spec  : ${r2}/openapi.json`);
console.log(`  • R2 surveillance graph: ${r2}/graph.html`);
console.log(`  • Local spec           : docs/openapi.json`);
console.log(`  • Local markdown       : docs/api-reference.md`);
console.log(
  "--------------------------------------------------------------------------------",
);
if (extension === undefined) {
  console.error(
    "  ✗ docs/openapi.json has no x-sportsdesk-gslive extension (run `bun run docs:openapi`).",
  );
  process.exit(1);
}
console.log(
  `  🎯 GSLive              : ${extension.provider} (${extension.kind})`,
);
console.log(
  `     • Console           : ${extension.origin}${extension.managerPath}`,
);
console.log(`     • Partner ID        : ${extension.partnerId}`);
console.log(`     • Contract doc      : ${extension.contractDoc}`);
console.log(`     • CLI               : ${extension.cli}`);
for (const surface of extension.surfaces ?? []) {
  console.log(
    `     • ${String(surface.id).padEnd(20)} ${String(surface.route).padEnd(20)} ${surface.purpose ?? ""}`,
  );
}
console.log(
  "--------------------------------------------------------------------------------",
);
console.log(
  "  Next: `./bin/dx docs gslive` for the full section, `./bin/dx gslive <LOGIN>` for links.",
);
console.log(
  "================================================================================",
);
