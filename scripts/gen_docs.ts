import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURES, BUILD_FEATURES, DESCRIPTIONS } from "../types/features.ts";

for (const f of FEATURES) {
  if (!(f in DESCRIPTIONS)) throw new Error(`Missing description for ${f}`);
}

const START = "<!-- FLAGS:START -->";
const END = "<!-- FLAGS:END -->";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const readmePath = join(scriptDir, "../types/README.md");
const readme = readFileSync(readmePath, "utf8");

const table = [
  "| Flag | Purpose |",
  "| :--- | :--- |",
  ...FEATURES.map((f) => `| \`${f}\` | ${DESCRIPTIONS[f]} |`),
].join("\n");

const s = readme.indexOf(START);
const e = readme.indexOf(END);
if (s === -1 || e === -1 || e < s) {
  throw new Error(`Missing or misordered ${START} / ${END} in types/README.md`);
}

writeFileSync(
  readmePath,
  readme.slice(0, s + START.length) + "\n" + table + "\n" + readme.slice(e),
);

// Synchronize dashboard SSOT config directly from types/features.ts
const dashboardPath = join(
  scriptDir,
  "../examples/feature_flags/dashboard.html",
);
if (existsSync(dashboardPath)) {
  let html = readFileSync(dashboardPath, "utf8");
  const ssotConfig = `<script id="sportsdesk-ssot-config">
      window.CANONICAL_FEATURES = ${JSON.stringify(FEATURES)};
      window.CANONICAL_BUILD_FEATURES = ${JSON.stringify(BUILD_FEATURES)};
      window.CANONICAL_DESCRIPTIONS = ${JSON.stringify(DESCRIPTIONS)};
    </script>`;
  html = html.replace(
    /<script id="sportsdesk-ssot-config">[\s\S]*?<\/script>/,
    ssotConfig,
  );
  writeFileSync(dashboardPath, html);
}
