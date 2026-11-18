#!/usr/bin/env bun
/**
 * Parse an XML document and print the tree as JSON, or serialize it back to XML.
 *
 *   bun run xml:parse <file|- for stdin>             # compact Document as JSON
 *   bun run xml:parse <file|-> --tree                # full Node/Document as JSON
 *   bun run xml:parse <file|-> --xml [--indent 2]    # full tree back to XML
 *
 * Input is passed to Bun.XML as bytes, so a BOM or the `<?xml encoding …?>`
 * declaration selects UTF-8, UTF-16 or ISO-8859-1 the way the XML spec requires.
 * --xml is the writer path: it drops the XML/DOCTYPE declaration and re-escapes
 * text, so it is for inspection/round-trips, not for byte-identical archives.
 */
import {
  assertXmlIngestBytesNotHtmlOn200,
  parseXmlCompactDocument,
} from "../src/lib/xml_ingest_preflight.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "Usage: xml-parse <file|- for stdin> [--tree | --xml [--indent 0..10]]",
      "",
      "  <file>      XML file path; `-` reads stdin",
      "  --tree      full Node/Document tree as JSON (default: compact Document)",
      "  --xml       serialize the parsed tree back to XML",
      "  --indent N  indent for --xml, 0..10",
      "  -h, --help  this help",
      "",
      "Input is passed to Bun.XML as bytes; a BOM or <?xml encoding?> selects the encoding.",
    ].join("\n"),
  );
  process.exit(0);
}
const file = args[0];
const tree = args.includes("--tree");
const xml = args.includes("--xml");
const indentAt = args.indexOf("--indent");
const indentRaw = indentAt >= 0 ? args[indentAt + 1] : undefined;

function usage(message?: string): never {
  if (message !== undefined) console.error(`xml-parse: ${message}`);
  console.error(
    "Usage: xml-parse <file|- for stdin> [--tree | --xml [--indent 0..10]]",
  );
  process.exit(1);
}

if (!file) usage();
if (file.startsWith("-") && file !== "-") usage(`unknown argument: ${file}`);
if (tree && xml) usage("--tree and --xml are mutually exclusive");
let indent: number | undefined;
if (indentAt >= 0) {
  if (!xml) usage("--indent requires --xml");
  if (indentRaw === undefined || !/^\d+$/.test(indentRaw)) {
    usage("--indent needs an integer 0..10");
  }
  indent = Number(indentRaw);
  if (indent > 10) usage("--indent needs an integer 0..10");
}

const input =
  file === "-" ? await Bun.stdin.bytes() : await Bun.file(file).bytes();
try {
  assertXmlIngestBytesNotHtmlOn200(input);
  const parsed =
    tree || xml
      ? Bun.XML.parse(input, { compact: false })
      : parseXmlCompactDocument(input);
  if (xml) {
    const serialized = Bun.XML.stringify(parsed, null, indent);
    if (serialized === undefined) {
      throw new Error("XML.stringify returned undefined");
    }
    console.log(serialized);
  } else {
    console.log(JSON.stringify(parsed, null, 2));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`xml-parse: ${message}`);
  process.exit(1);
}
