import { resolve } from "node:path";

/**
 * Spawn a repository entrypoint inside `packages/sportsdesk-ops/bin/*` so every `bin` linked into
 * `node_modules/.bin/` by Bun workspaces executes via `bun x <bin>` (`bun x dx`, `bun x sportsdesk`,
 * `bun x nsh-desk`, etc.) with clean exit-code propagation.
 */
export async function runRepoBin(
  repoRelativeTarget: string,
  opts?: { readonly runtime?: "bun" | "bash" },
): Promise<never> {
  const repoRoot = resolve(import.meta.dir, "..", "..", "..");
  const target = resolve(repoRoot, repoRelativeTarget);
  const args = Bun.argv.slice(2);
  const cmd =
    opts?.runtime === "bash"
      ? ["bash", target, ...args]
      : [process.execPath, target, ...args];
  const child = Bun.spawn(cmd, {
    stdio: ["inherit", "inherit", "inherit"],
    env: Bun.env,
  });
  process.exit(await child.exited);
}
