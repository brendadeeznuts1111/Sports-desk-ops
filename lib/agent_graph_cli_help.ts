/** Shared Bun command reference for the three hierarchy pipeline entry points. */
export const hierarchyBunHelp = [
  "Root package.json fields:",
  "  scripts   Script name -> shell command (bun run <script name>)",
  "  bin       Binary name -> executable file (e.g. sportsdesk -> cli/sportsdesk_cli.ts)",
  "",
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
