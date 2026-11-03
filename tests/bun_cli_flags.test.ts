import { describe, expect, test } from "bun:test";

import { z } from "zod";

import { file, semver, version } from "bun";

import {
  bunFlagsInScripts,
  missingRequiredFlags,
  parseBunHelpFlags,
  readBunCliSurface,
  readBunHelpFlags,
  REQUIRED_BUN_CLI_FLAGS,
  unsupportedScriptFlags,
} from "../lib/bun_cli_flags.ts";

const SURFACE = readBunCliSurface();

describe("pinned Bun CLI surface (1.4.4)", () => {
  test("every flag our tooling depends on is declared by the runtime", () => {
    expect(missingRequiredFlags(SURFACE)).toEqual([]);
    for (const flag of REQUIRED_BUN_CLI_FLAGS) {
      expect(SURFACE.flags.has(flag)).toBe(true);
    }
  });

  test("package.json scripts only ask Bun to parse flags it declares", async () => {
    const pkg = z
      .object({
        engines: z.object({ bun: z.string() }).optional(),
        scripts: z.record(z.string(), z.string()).optional(),
      })
      .parse(await file(new URL("../package.json", import.meta.url)).json());
    const scripts = pkg.scripts ?? {};
    expect(unsupportedScriptFlags(scripts, SURFACE)).toEqual([]);
    // The watch daemon is the one long-running script: it must not outlive its parent.
    expect(scripts["wagers:watch"]).toContain("--no-orphans");
    // Bun.semver gates the pinned runtime against package.json engines.
    expect(pkg.engines?.bun).toBeDefined();
    expect(semver.satisfies(version, pkg.engines?.bun ?? "")).toBe(true);
  });

  test("help parsing reads flag declarations, not prose or values", () => {
    const flags = parseBunHelpFlags(
      [
        "  -e, --eval=<val>                    Evaluate argument as a script",
        "      --port=<val>                    Set the default port for Bun.serve",
        "  -u, --update-snapshots              Update snapshot files",
        "  --do-not-treat-this-as-a-flag",
      ].join("\n"),
    );
    expect(flags.has("--eval")).toBe(true);
    expect(flags.has("--port")).toBe(true);
    expect(flags.has("--update-snapshots")).toBe(true);
    // An indented prose line without declaration columns is not a flag.
    expect(flags.has("--do-not-treat-this-as-a-flag")).toBe(false);
  });

  test("script flag extraction stops at the entrypoint/command", () => {
    const flags = bunFlagsInScripts({
      watch:
        "bun --no-orphans run scripts/x.ts --watch --cron '0,15,30,45 * * * *'",
      plain: "bun run scripts/x.ts --json",
    });
    expect([...(flags.get("watch") ?? [])]).toEqual(["--no-orphans"]);
    expect(flags.has("plain")).toBe(false);
  });

  test("records the known 1.4.4 gap instead of pretending --origin exists", () => {
    // Docs snippets sometimes show `--origin`/`-u`; this runtime does not declare --origin, and
    // -u is a *test* flag. If an upgrade adds --origin, this assertion is the reminder to revisit.
    expect(SURFACE.flags.has("--origin")).toBe(false);
    expect(readBunHelpFlags(["test", "--help"]).has("--update-snapshots")).toBe(
      true,
    );
  });
});
