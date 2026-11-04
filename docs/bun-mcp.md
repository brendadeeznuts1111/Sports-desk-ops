# Bun docs MCP

Official server: POST `https://bun.sh/docs/mcp` (not `/docs` — that path without `/mcp` returns 405).

Transport SSOT: `https://bun.sh/docs/mcp` (dotfiles `lib/cli/bun-docs-mcp-url.ts`, probe `bun run check:bun-docs-mcp` from `~/dotfiles`).

OpenCode loads **`bun-docs`** from global config (`~/dotfiles/opencode/opencode.jsonc` → `~/.config/opencode/opencode.jsonc`). This repo does not ship a project `opencode.json` for it.

Tools: `search_bun`, `read_bun_page`, `list_bun_pages`, `grep_bun`. `/reference/**` is not indexed —
use the global `bun-reference` MCP for API reference pages.

Verify: `opencode mcp list` → `✓ bun-docs connected`.

Cursor: `"bun-docs": { "url": "https://bun.sh/docs/mcp" }` in `~/.cursor/mcp.json`.
