#!/usr/bin/env bun
/**
 * Parse an XML document and print the tree as JSON.
 *
 *   bun run xml:parse <file|- for stdin> [--tree]
 *
 * Input is passed to Bun.XML as bytes, so a BOM or the `<?xml encoding …?>`
 * declaration selects UTF-8, UTF-16 or ISO-8859-1 the way the XML spec requires.
 */
const args = process.argv.slice(2);
const file = args[0];
const tree = args.includes("--tree");
if (!file) {
  console.error("Usage: xml-parse <file|- for stdin> [--tree]");
  process.exit(1);
}
const input =
  file === "-" ? await Bun.stdin.bytes() : await Bun.file(file).bytes();
try {
  const parsed = tree
    ? Bun.XML.parse(input, { compact: false })
    : Bun.XML.parse(input);
  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`xml-parse: ${message}`);
  process.exit(1);
}
