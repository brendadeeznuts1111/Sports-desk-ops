# Bun docs MCP

The official Bun documentation server at `https://bun.com/docs/mcp` searches bun.com (docs, guides,
blog, site pages). This repo configures it as the remote server `bun-docs` in `opencode.json`.

Everything below was measured on 2026-11-03 against OpenCode `v2.2.5` by POSTing JSON-RPC to the
endpoint. Where a value is a guess rather than a measurement, it says so.

## Configuration

`opencode.json` at the repo root is **tracked**, and the block below is byte-identical to it. The
shape is V2-only (`mcp.servers`, `disabled`, `timeout` as an object) and verified against OpenCode
`v2.2.5`. Do not port it into a V1 config: a V1 client rejects the file rather than ignoring the
block, which takes the rest of the config with it.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "bun-docs": {
        "type": "remote",
        "url": "https://bun.com/docs/mcp",
        "protocol": "legacy",
        "oauth": false,
        "codemode": true,
        "timeout": {
          "startup": 30000,
          "catalog": 30000,
          "execution": 60000
        }
      }
    }
  }
}
```

| Field      | Value                      | Why                                                                                                                                                                                                    |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`     | `remote`                   | Streamable HTTP; no local process to supervise.                                                                                                                                                        |
| `url`      | `https://bun.com/docs/mcp` | Canonical origin — the one every returned page self-reports as. `bun.sh` is an alias of the same deployment (200, identical body, no redirect); `https://bun.com/docs` without `/mcp` returns **405**. |
| `protocol` | `legacy`                   | `initialize` reports `protocolVersion: "2025-06-18"`; `server/discover` returns **-32601**. `auto` and `2026-07-28` cannot help here.                                                                  |
| `oauth`    | `false`                    | `tools/list` returns 200 with no credentials. If the endpoint ever 401s, that should be a loud error, not a browser sign-in prompt.                                                                    |
| `codemode` | `true`                     | The default, pinned because agents call these as `tools["bun-docs"].*` inside `execute`.                                                                                                               |
| `timeout`  | `execution: 60000`         | Defaults are startup 30 s / catalog 30 s / **execution 12 h**. A 12-hour ceiling on a doc read is not a timeout. Measured calls: 100–200 ms.                                                           |

### Why the name is `bun-docs`

`~/.config/opencode/opencode.jsonc` already defines `bun-docs` as a local stdio proxy
(`~/.config/opencode/mcp/bun-docs-proxy.ts`) that POSTs to `https://bun.com/docs` — the 405 URL — so
that global entry fails at startup. A higher-precedence project config **replaces the entire server
object with the same name**, so naming this one `bun-docs` overrides the broken proxy for this repo
instead of adding a second namespace over the same corpus. Tool names are `<server>_<tool>`, which
Code Mode groups as `tools["bun-docs"].<tool>`.

To instead run two independent connections, rename this server and repeat every required field.

## Tool surface

`tools/list` returns exactly four tools. Any other name (`search_bun_docs`, `grep_bun_docs`,
`read_bun_doc`, `list_bun_docs`) does not exist and will fail.

| Tool             | Required  | Parameters                                                                            |
| ---------------- | --------- | ------------------------------------------------------------------------------------- |
| `search_bun`     | `query`   | `query`, `limit` (1–25, default 10), `section` (`docs`/`guides`/`blog`/`site`)        |
| `read_bun_page`  | `path`    | `path` only                                                                           |
| `list_bun_pages` | —         | `path` (prefix, default `/`)                                                          |
| `grep_bun`       | `pattern` | `pattern`, `paths`, `ignoreCase`, `context` (0–10), `maxMatches` (1–500), `filesOnly` |

Two things the surface settles: `section` is plural **`guides`**, and `read_bun_page` has no page
parameter — it returns a whole page, so any "paginated, one page at a time" advice is wrong.

## Return shape

Code Mode returns a **plain string**; it has already unwrapped `result.content[0].text`.

```ts
const page = await tools["bun-docs"].read_bun_page({
  path: "/docs/runtime/jsonl",
});
// typeof page === "string"; page.startsWith("# JSONL")
```

A raw JSON-RPC POST still returns the envelope: `{ result: { content: [{ type: "text", text }] } }`.
Reaching for `.result.content[0].text` on the Code Mode value throws
`Cannot read properties of undefined (reading 'content')`.

## Call discipline

1. `list_bun_pages` — discover what exists under a prefix.
2. `search_bun` — rank candidate pages; exact API names beat prose.
3. `grep_bun` — confirm a signature or edge case with line numbers.
4. `read_bun_page` — only when the snippet is not enough.

The server is stateless, one POST per message, no session, no handshake per call. Parallel calls are
safe for that reason; `Promise.all` is merely how they are issued, and JSON-RPC `id` values are
decorative across separate POSTs (HTTP already binds each response to its request).

## Measured facts

| Probe                             | Result                                                                      |
| --------------------------------- | --------------------------------------------------------------------------- |
| `initialize` (2025-11-25 offered) | 200, `protocolVersion: "2025-06-18"`, serverInfo `Bun` / `Bun docs` 1.0.0   |
| `server/discover`                 | -32601 Method not found                                                     |
| `tools/list`, no credentials      | 200, 4 tools                                                                |
| `resources/list`                  | 1 resource, `bun://skill` (a Bun primer)                                    |
| POST `https://bun.com/docs`       | 405, empty body                                                             |
| POST `https://bun.sh/docs/mcp`    | 200, `application/json`                                                     |
| POST `https://bun.com/docs/mcp`   | 200, identical body, **no redirect**, same `cf-ray` prefix (one deployment) |
| POST with a trailing `/docs/mcp/` | 200 on both hosts; the slash changes nothing                                |
| GET `https://bun.sh/docs/mcp`     | 405 — POST only                                                             |

## What it does not cover

- **`/reference/**` is not indexed.** `list_bun_pages` under `/reference` returns a single stub page,
  and `grep_bun` for `Bun.Image` under `/reference` finds nothing. The global `bun-reference` server
  (offline, currently disabled) is the one that covers `/reference/globals/bun`.
- **No resources beyond `bun://skill`**, and no resource templates.
- **Prose queries return nothing.** `search_bun` wants API-shaped terms: `wrapAnsi`, `stringWidth`,
  `Bun.JSONL.parseChunk`. A query like "Bun.serve options" comes back empty.

## Verification

```sh
opencode mcp list
```

Expect **exactly one** Bun docs server, connected — not a `✓` line and a `✗` line, and not two
entries over the same corpus:

```text
○ bun-dev        disabled
✓ bun-docs       connected
○ bun-reference  disabled
```

A second Bun docs entry means the project key differs from the global one. Server objects are
replaced only on **key** collision, measured by renaming this key from `bun` to `bun-docs`: before,
`mcp list` showed `✓ bun connected` **and** `✗ bun-docs failed: Request timed out`; after, the failing
line vanished into `✓ bun-docs connected`.

```ts
// inside execute
await tools["bun-docs"].list_bun_pages({ path: "/docs/runtime/jsonl" });
// "1 page under /docs/runtime/jsonl:\n/docs/runtime/jsonl — JSONL — ..."
```

### The global proxy this replaces

`~/.config/opencode/mcp/bun-docs-proxy.ts` (99 lines, global `bun-docs` entry) is a pure stdio
bridge. Read end to end, it forwards each JSON-RPC message, handles both newline and
`Content-Length` framing, sets `mcp-protocol-version: 2025-06-18`, and does nothing else: no header
injection, no tool filtering or renaming, no pagination, no caching, `TIMEOUT_MS = 8_000`,
`MAX_RETRIES = 0`. There is no behavior in it worth porting into the project config — its only
distinguishing detail is `ENDPOINT = "https://bun.com/docs"`, missing the `/mcp` segment, which is
why the global entry fails.

It stays in the dotfiles repository rather than being deleted here; removing it from
`~/.config/opencode/opencode.jsonc` is a separate change to global config, and `bun-reference` /
`bun-dev` continue to come from there.
