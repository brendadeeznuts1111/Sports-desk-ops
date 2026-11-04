#!/usr/bin/env bun
/** Keep a GitHub token in the OS keychain via `Bun.secrets` and check who it belongs to.
 *
 *  This is the tool from Bun's secrets docs (get -> ask if missing -> store -> `GET /user`),
 *  with the token verified before it is stored and never printed. The token is never accepted on
 *  argv; pipe it on stdin or type it at the prompt (the prompt echoes, so prefer a pipe).
 *
 *    op read "op://Private/github/token" | bun run secrets:github set
 *    GH_TOKEN="$(bun run secrets:github token)" gh pr merge ...
 */

import { parseCliArgs, printHelp, wantsHelp } from "../lib/cli_args.ts";
import {
  bunGithubTokenStore,
  GITHUB_TOKEN_SECRET,
  login,
  readStoredToken,
  replaceToken,
  type LoginResult,
} from "../lib/github_token.ts";

const HELP = `
secrets:github — GitHub token in the OS keychain

Usage:
  bun run secrets:github [login]     verify the stored token; ask for one if none is stored
  <token source> | bun run secrets:github set
                                     verify a token and replace the stored one
  bun run secrets:github token       print the stored token (refused on a terminal)
  bun run secrets:github delete      remove the stored token

Options:
  -h, --help        This text

Keychain entry:
  service ${GITHUB_TOKEN_SECRET.service}
  name    ${GITHUB_TOKEN_SECRET.name}

Exit codes: 0 ok, 1 GitHub or keychain failure, 2 usage or no token supplied.

Examples:
  bun run secrets:github
  op read "op://Private/github/token" | bun run secrets:github set
  GH_TOKEN="$(bun run secrets:github token)" gh auth status
`.trim();

/** Piped stdin wins; at a terminal the docs' `prompt()` is used (it echoes: prefer a pipe). */
async function readNewToken(): Promise<string | null> {
  if (process.stdin.isTTY) {
    console.error(
      "secrets:github: the prompt echoes what you type; prefer piping the token on stdin.",
    );
    return prompt("Please enter your GitHub token");
  }
  return Bun.stdin.text();
}

function report(result: LoginResult): number {
  switch (result.status) {
    case "ok":
      console.log(`Logged in as ${result.login}`);
      if (result.source === "new") console.error("GitHub token stored");
      return 0;
    case "no-token":
      console.error(
        "secrets:github: no token stored and none supplied; pipe one on stdin:",
      );
      console.error(
        '  op read "op://Private/github/token" | bun run secrets:github set',
      );
      return 2;
    case "unauthorized":
      console.error(
        result.source === "keychain"
          ? "secrets:github: GitHub rejected the stored token; replace it with `set`."
          : "secrets:github: GitHub rejected that token; nothing was stored.",
      );
      return 1;
    case "error":
      console.error(`secrets:github: ${result.message}`);
      return 1;
  }
}

const parsed = parseCliArgs(process.argv.slice(2), { valueFlags: [] });
if (wantsHelp(parsed)) {
  printHelp(HELP);
  process.exit(0);
}

const store = bunGithubTokenStore();
const command = parsed.positionals[0] ?? "login";

switch (command) {
  case "login":
    process.exit(report(await login({ store, readNewToken })));
  case "set":
    process.exit(report(await replaceToken({ store, readNewToken })));
  case "token": {
    if (process.stdout.isTTY) {
      console.error(
        "secrets:github: refusing to print the token to a terminal; capture it instead:",
      );
      console.error('  GH_TOKEN="$(bun run secrets:github token)" <command>');
      process.exit(2);
    }
    const stored = await readStoredToken(store);
    if (stored.status === "ok") {
      process.stdout.write(stored.token);
      process.exit(0);
    }
    console.error(
      stored.status === "absent"
        ? "secrets:github: no token stored; run `bun run secrets:github set`."
        : `secrets:github: ${stored.message}`,
    );
    process.exit(stored.status === "absent" ? 2 : 1);
  }
  case "delete": {
    const removed = await store.delete(GITHUB_TOKEN_SECRET);
    console.error(
      removed
        ? "secrets:github: removed the stored GitHub token"
        : "secrets:github: no stored token to remove",
    );
    process.exit(0);
  }
  default:
    console.error(
      `secrets:github: unknown command "${command}" (login|set|token|delete).`,
    );
    process.exit(2);
}
