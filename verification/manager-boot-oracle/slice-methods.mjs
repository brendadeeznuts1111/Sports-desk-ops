#!/usr/bin/env node
/**
 * Re-extract AMD method bodies from pinned manager.js after bust drift.
 * Usage: node verification/manager-boot-oracle/slice-methods.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node script (see pinned/README): import.meta.dir is Bun-only.
// ast-grep-ignore: bun-import-meta-dir
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const managerPath = path.join(__dirname, "pinned/manager.js");
const outDir = path.join(__dirname, "extracted");

const src = fs.readFileSync(managerPath, "utf8");

function sliceMethod(name) {
  const needle = `${name}:function(`;
  const start = src.indexOf(needle);
  if (start < 0) throw new Error(`method not found: ${name}`);
  let i = src.indexOf("{", start);
  if (i < 0) throw new Error(`no brace for ${name}`);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const head = src.slice(start, i + 1);
        const inner = src.slice(i + 1, j);
        return `${head}${inner}}`;
      }
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const methods = [
  "baseHeriarchy",
  "buildTree",
  "findInTree",
  "setCompleteHeriarchy",
];

for (const m of methods) {
  const body = sliceMethod(m);
  const out = path.join(outDir, `${m}.body.min.js`);
  fs.writeFileSync(out, body, "utf8");
  console.log(`wrote ${out} (${body.length} bytes)`);
}
