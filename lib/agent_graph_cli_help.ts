/** Shared Bun command reference for the three hierarchy pipeline entry points. */
export const hierarchyBunHelp = [
  "Native Bun commands:",
  "  bun run --silent <script> [script flags]   Hide the script command line",
  "  bun install (alias: bun i)                Install workspace dependencies",
  "    --config <path>, -c                     Select bunfig.toml",
  "    --registry <url>                        Override the default package registry",
  "    --filter <pattern>, -F                  Select matching workspaces",
  "    --offline                               Resolve from the local cache only",
  "    --frozen-lockfile                       Require an unchanged lockfile",
  "    --ignore-scripts                        Skip install lifecycle scripts",
  "    --dry-run                               Preview installation",
  "  bun install --help                        List all native install flags",
].join("\n");
