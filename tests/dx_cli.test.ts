import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  filterScripts,
  groupScripts,
  scriptPrefix,
} from "../scripts/dx_scripts.ts";
import { parseModeFilter } from "../scripts/dx_modes.ts";

/**
 * `bin/dx` runs for every operator command, so these spawn the real script against a scratch
 * `$HOME` and a fixture dotfiles checkout: nothing here can touch the developer's own home.
 */

const ROOT = path.join(import.meta.dir, "..");
const DX = path.join(ROOT, "bin/dx");
const SCRATCH = mkdtempSync(path.join(tmpdir(), "dx-cli-"));

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function fixtureDotfiles(dir: string): Promise<string> {
  const files: Record<string, string> = {
    "git/gitconfig": "[user]\n\tname = fixture\n",
    "git/config/ignore": "*.swp\n",
    "git/config/credential-gh-owner": "#!/bin/sh\n",
    "git/config/profiles/.keep": "",
    "shell/config/.keep": "",
    "shell/.zshenv": "# fixture zshenv\n",
    "shell/.zshrc": "# fixture zshrc\n",
    "shell/.bash_profile": "# fixture bash_profile\n",
    "bun/bunfig.toml": "",
  };
  // Bun.write creates missing parent directories.
  for (const [rel, body] of Object.entries(files)) {
    await Bun.write(path.join(dir, rel), body);
  }
  return dir;
}

let home = "";
let dotfiles = "";

beforeEach(async () => {
  home = mkdtempSync(path.join(SCRATCH, "home-"));
  dotfiles = await fixtureDotfiles(
    mkdtempSync(path.join(SCRATCH, "dotfiles-")),
  );
});

async function dx(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<Run> {
  const child = Bun.spawn([DX, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: ROOT,
    env: {
      ...Bun.env,
      HOME: home,
      DX_DOTFILES_DIR: dotfiles,
      DX_STATUS_OFFLINE: "1",
      CLOUDFLARE_API_TOKEN: "",
      ...env,
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

function isSymlinkTo(file: string, target: string): boolean {
  return lstatSync(file).isSymbolicLink() && readlinkSync(file) === target;
}

describe("Cloudflare Pages credential file", () => {
  async function pagesEnv(body: string): Promise<void> {
    await Bun.write(
      path.join(home, ".config", "cloudflare", "pages.env"),
      body,
    );
  }
  const probe = [
    "exec",
    "sh",
    "-c",
    'printf "%s|%s|%s" "$CLOUDFLARE_API_TOKEN" "${R2_SECRET_ACCESS_KEY:-unset}" "${INJECTED:-unset}"',
  ];

  test("only the two Pages names are read from the file", async () => {
    await pagesEnv(
      'export CLOUDFLARE_API_TOKEN="pages-token"\nR2_SECRET_ACCESS_KEY=leak\nINJECTED=$(touch /tmp/never)\n',
    );
    const result = await dx(probe);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("pages-token|unset|unset");
  });

  test("a value already in the environment wins over the file", async () => {
    await pagesEnv("CLOUDFLARE_API_TOKEN=from-file\n");
    const result = await dx(probe, { CLOUDFLARE_API_TOKEN: "from-env" });
    expect(result.stdout).toBe("from-env|unset|unset");
  });
});

describe("dx exec --with", () => {
  const R2_ENV = {
    R2_ACCESS_KEY_ID: "test-access-id",
    R2_SECRET_ACCESS_KEY: "test-secret-value",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    R2_BUCKET_NAME: "test-bucket",
  };

  // Every requested name is already in the environment, so the keychain is never read: a test
  // must not reach the real keychain (see the "Hard rules" note in AGENTS.md).
  test("--with r2 delivers exactly the r2 group to the child", async () => {
    const result = await dx(["exec", "--with", "r2", "--", "env"], R2_ENV);
    expect(result.code).toBe(0);
    const childEnv = new Map(
      result.stdout
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    for (const [name, value] of Object.entries(R2_ENV)) {
      expect(childEnv.get(name)).toBe(value);
    }
  });

  test("the injection summary names sources and never a value", async () => {
    const result = await dx(["exec", "--with", "r2", "--", "true"], R2_ENV);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("secrets: injecting");
    expect(result.stderr).toContain("R2_ACCESS_KEY_ID←env");
    for (const value of Object.values(R2_ENV)) {
      expect(result.stderr).not.toContain(value);
    }
  });

  test("an unknown group is refused with exit 2 and runs nothing", async () => {
    const result = await dx(["exec", "--with", "r3", "--", "echo", "ran"]);
    expect(result.code).toBe(2);
    expect(result.stdout).not.toContain("ran");
  });

  test("plain `dx exec` still passes through without injecting", async () => {
    const result = await dx(["exec", "echo", "plain"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("plain");
    expect(result.stderr).not.toContain("secrets: injecting");
  });
});

describe("dx command dispatch", () => {
  test("an unknown command exits 2 with a suggestion instead of `exec: … not found`", async () => {
    const result = await dx(["stauts"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'stauts'");
    expect(result.stderr).toContain("did you mean: ./bin/dx status");
    expect(result.stderr).not.toContain("exec:");
  });

  test("a command with no near match still exits 2 and points at help", async () => {
    const result = await dx(["zzzzzzzzzz"]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("did you mean");
    expect(result.stderr).toContain("./bin/dx help");
  });

  test("a real program on PATH still runs through dx", async () => {
    const result = await dx(["echo", "passthrough-ok"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("passthrough-ok");
  });

  test("every dispatch case is a declared command, and every declared command has a case", async () => {
    const source = await Bun.file(DX).text();
    const declared =
      /^DX_COMMANDS="([^"]+)"/m.exec(source)?.[1]?.split(/\s+/) ?? [];
    const dispatch = source.slice(source.indexOf('case "$cmd" in'));
    const cases = [...dispatch.matchAll(/^ {2}([a-z][a-z0-9|-]*)\)$/gm)]
      .flatMap((match) => (match[1] ?? "").split("|"))
      .filter((name) => !name.startsWith("-")); // `help|--help|-h` flag spellings
    expect(declared.length).toBeGreaterThan(10);
    expect(cases.filter((name) => !declared.includes(name))).toEqual([]);
    expect(
      declared.filter((name) => name !== "help" && !cases.includes(name)),
    ).toEqual([]);
  });

  test("help documents every primary command (aliases excluded)", async () => {
    const aliases = new Set(["api-docs", "api", "crossdomain", "screenshot"]);
    const source = await Bun.file(DX).text();
    const declared =
      /^DX_COMMANDS="([^"]+)"/m.exec(source)?.[1]?.split(/\s+/) ?? [];
    const help = (await dx(["help"])).stdout;
    const missing = declared.filter(
      (name) =>
        name !== "help" &&
        !aliases.has(name) &&
        !help.includes(`./bin/dx ${name}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("dx modes", () => {
  test("rejects a mode outside 1..10 with exit 2", async () => {
    for (const bad of ["99", "0", "abc", "1.5"]) {
      const result = await dx(["modes", bad]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("mode must be an integer 1..10");
      expect(result.stdout).toBe("");
    }
  });

  test("an option-looking or surplus argument is a usage error, not 'all modes'", async () => {
    for (const bad of [["-1"], ["--nope"], ["1", "2"]]) {
      const result = await dx(["modes", ...bad]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("usage: ./bin/dx modes [1..10]");
      expect(result.stdout).toBe("");
    }
  });

  test("a valid mode prints only that mode's detail line", async () => {
    const result = await dx(["modes", "9"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[Mode 9 · Pending Exposure]");
    expect(result.stdout).not.toContain("[Mode 10 ·");
  });

  test("parseModeFilter: no argument means every mode", () => {
    expect(parseModeFilter(undefined)).toBeNull();
    expect(parseModeFilter("")).toBeNull();
    expect(parseModeFilter("1")).toBe(1);
    expect(parseModeFilter("10")).toBe(10);
    expect(() => parseModeFilter("11")).toThrow("1..10");
  });
});

describe("dx home links never destroy data", () => {
  test("creates missing links, and a second run leaves them untouched", async () => {
    expect((await dx(["status"])).code).toBe(0);
    const zshrc = path.join(home, ".zshrc");
    expect(isSymlinkTo(zshrc, path.join(dotfiles, "shell/.zshrc"))).toBe(true);
    const before = lstatSync(zshrc).mtimeMs;
    await Bun.sleep(20);
    expect((await dx(["status"])).code).toBe(0);
    expect(lstatSync(zshrc).mtimeMs).toBe(before);
  });

  test("a real ~/.zshrc is left in place and reported, not replaced", async () => {
    const zshrc = path.join(home, ".zshrc");
    await Bun.write(zshrc, "# my real zshrc\n");
    const result = await dx(["status"]);
    expect(result.code).toBe(0);
    expect(lstatSync(zshrc).isSymbolicLink()).toBe(false);
    expect(await Bun.file(zshrc).text()).toBe("# my real zshrc\n");
    expect(result.stdout).toContain(zshrc);
    expect(result.stdout).toContain("setup --replace");
  });

  test("`setup --replace` backs the real file up before linking", async () => {
    const zshrc = path.join(home, ".zshrc");
    await Bun.write(zshrc, "# my real zshrc\n");
    const result = await dx(["setup", "--replace"]);
    expect(result.code).toBe(0);
    expect(isSymlinkTo(zshrc, path.join(dotfiles, "shell/.zshrc"))).toBe(true);
    const backups = readdirSync(home).filter((name) =>
      name.startsWith(".zshrc.dx-backup-"),
    );
    expect(backups).toHaveLength(1);
    expect(await Bun.file(path.join(home, backups[0] ?? "")).text()).toBe(
      "# my real zshrc\n",
    );
  });

  test("a stale symlink is repointed", async () => {
    const zshrc = path.join(home, ".zshrc");
    Bun.spawnSync(["ln", "-s", "/nonexistent/old-zshrc", zshrc]);
    expect((await dx(["status"])).code).toBe(0);
    expect(isSymlinkTo(zshrc, path.join(dotfiles, "shell/.zshrc"))).toBe(true);
  });
});

describe("dx status reports only what it measured", () => {
  test("no hardcoded readiness claims, and credential lines say what is missing", async () => {
    const result = await dx(["status"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("SigV4 Ready");
    expect(result.stdout).not.toContain("re-anchored from host");
    expect(result.stdout).toContain("Pages token");
    expect(result.stdout).toContain("CLOUDFLARE_API_TOKEN unset");
    expect(result.stdout).toContain("not probed: DX_STATUS_OFFLINE=1");
  });

  test("XDG_CONFIG_HOME is reported as re-anchored only when it changed", async () => {
    const same = await dx(["status"], {
      XDG_CONFIG_HOME: path.join(home, ".config"),
    });
    expect(same.stdout).toContain("(unchanged)");
    const moved = await dx(["status"], {
      XDG_CONFIG_HOME: "/somewhere/else/.config",
    });
    expect(moved.stdout).toContain("re-anchored from /somewhere/else/.config");
  });
});

describe("dx scripts", () => {
  const scripts = {
    "schema:gate": "bun a",
    "schema:dump": "bun b",
    "capture:har": "bun c",
    test: "bun test",
  };

  test("scriptPrefix groups by the part before the first colon", () => {
    expect(scriptPrefix("schema:gate")).toBe("schema");
    expect(scriptPrefix("test")).toBe("(none)");
    expect(scriptPrefix(":odd")).toBe("(none)");
  });

  test("groupScripts orders the largest group first and sorts names", () => {
    const grouped = groupScripts(scripts);
    expect([...grouped.keys()]).toEqual(["schema", "(none)", "capture"]);
    expect(grouped.get("schema")).toEqual(["schema:dump", "schema:gate"]);
  });

  test("filterScripts matches on the name, case-insensitively", () => {
    expect(filterScripts(scripts, "SCHEMA").map(([name]) => name)).toEqual([
      "schema:dump",
      "schema:gate",
    ]);
    expect(filterScripts(scripts, "nope")).toEqual([]);
  });

  test("the CLI lists real scripts and exits 1 on a filter with no match", async () => {
    const hit = await dx(["scripts", "verify:docs"]);
    expect(hit.code).toBe(0);
    expect(hit.stdout).toContain("verify:docs");
    const miss = await dx(["scripts", "definitely-not-a-script-name"]);
    expect(miss.code).toBe(1);
    expect(miss.stderr).toContain("no script name contains");
  });
});
