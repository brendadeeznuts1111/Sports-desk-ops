/** Parse a TOML document with Bun's native parser. */
export function parseToml(text: string): unknown {
  return Bun.TOML.parse(text);
}