#!/usr/bin/env bun
/**
 * Parse an XML document and print the compact tree as JSON.
 *
 *   bun run xml:parse <file|- for stdin> [--tree]
 */
const args = process.argv.slice(2);
const file = args[0];
const tree = args.includes("--tree");
if (!file) {
  console.error("Usage: xml-parse <file|- for stdin> [--tree]");
  process.exit(1);
}
const bytes =
  file === "-" ? await Bun.stdin.bytes() : await Bun.file(file).bytes();
const text = new TextDecoder().decode(bytes);
try {
  const parsed = tree
    ? Bun.XML.parse(text, { compact: false })
    : Bun.XML.parse(text);
  console.log(JSON.stringify(parsed, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`xml-parse: ${message}`);
  process.exit(1);
}
