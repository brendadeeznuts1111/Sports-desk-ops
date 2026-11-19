import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("probe honors userconfig, checks every advertised host and measures info calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bun-registry-probe-"));
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const host = hits++ === 0 ? "unexpected.example" : "cdn.example";
      const version = {
        name: "@local/probe",
        version: "1.0.0",
        dist: { tarball: `https://${host}/a.tgz?signature=hidden` },
      };
      return Response.json({
        name: version.name,
        "dist-tags": { latest: version.version },
        versions: { "1.0.0": version },
      });
    },
  });
  try {
    const config = join(dir, "user.npmrc");
    await Bun.write(config, "@local:registry=" + server.url.href + "\n");
    const run = async (count: string) => {
      const p = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/probe-registry.ts"),
          "@local/probe",
          "-n",
          count,
          "--expect-host",
          "cdn.example",
          "--json",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            NPM_CONFIG_USERCONFIG: config,
            BUN_INSTALL_CACHE_DIR: dir,
            SPORTSDESK_PROFILE: "qa",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, stdout, stderr] = await Promise.all([
        p.exited,
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
      ]);
      return { code, stdout, stderr };
    };
    const mixed = await run("2");
    expect(mixed.code, mixed.stderr).toBe(2);
    const report = JSON.parse(mixed.stdout);
    expect(
      report.samples.map((s: { tarballHost: string }) => s.tarballHost),
    ).toEqual(["unexpected.example", "cdn.example"]);
    expect(report.medianMs).toBe((report.minMs + report.maxMs) / 2);
    expect(report.profile).toBe("qa");
    expect(mixed.stdout).not.toContain("signature=");
    expect((await run("1")).code).toBe(0);
    expect((await run("0")).code).toBe(1);
    expect(hits).toBe(3);
  } finally {
    server.stop(true);
    await rm(dir, { force: true, recursive: true });
  }
});

test("user config diagnostics match local registry requests and project precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bun-userconfig-"));
  const home = join(dir, "home"),
    cwd = join(dir, "project"),
    xdg = join(dir, "xdg");
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      paths.push(new URL(req.url).pathname.split("/")[1]!);
      const version = {
        name: "@local/probe",
        version: "1.0.0",
        dist: { tarball: "https://cdn.example/p.tgz" },
      };
      return Response.json({
        name: version.name,
        "dist-tags": { latest: version.version },
        versions: { [version.version]: version },
      });
    },
  });
  try {
    const config = (label: string) =>
      "@local:registry=" + server.url.origin + "/" + label + "/\n";
    await Bun.write(join(home, ".npmrc"), config("home"));
    await Bun.write(join(home, "explicit"), config("explicit"));
    await Bun.write(join(xdg, ".npmrc"), config("xdg"));
    await Bun.write(join(cwd, "relative"), config("relative"));
    await Bun.write(join(cwd, "package.json"), "{}");
    await Bun.write(
      join(cwd, "bunfig.toml"),
      '[install]\nregistry="' + server.url.origin + '/fallback/"',
    );
    async function check(
      env: Record<string, string>,
      source: string,
      path: string,
      exists: boolean,
      target: string,
      project = false,
    ) {
      paths.length = 0;
      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/probe-registry.ts"),
          "@local/probe",
          "-n",
          "1",
          "--json",
        ],
        {
          cwd,
          env: { PATH: process.env.PATH, HOME: home, ...env },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(exit, err).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        npmrc: {
          source,
          rawEnv: env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || null,
          userConfigPath: path,
          userConfigExists: exists,
          projectConfigPath: join(cwd, ".npmrc"),
          projectConfigExists: project,
        },
        userConfig: { source, path, exists },
        cwdConfig: { path: join(cwd, ".npmrc"), exists: project },
      });
      expect(paths).toEqual([target]);
    }
    await check({}, "HOME", join(home, ".npmrc"), true, "home");
    await check(
      { XDG_CONFIG_HOME: xdg },
      "XDG_CONFIG_HOME",
      join(xdg, ".npmrc"),
      true,
      "xdg",
    );
    await check(
      { XDG_CONFIG_HOME: dir },
      "HOME",
      join(home, ".npmrc"),
      true,
      "home",
    );
    await check(
      { npm_config_userconfig: "relative" },
      "npm_config_userconfig",
      join(cwd, "relative"),
      true,
      "relative",
    );
    await check(
      {
        NPM_CONFIG_USERCONFIG: "~/explicit",
        npm_config_userconfig: "relative",
      },
      "NPM_CONFIG_USERCONFIG",
      join(home, "explicit"),
      true,
      "explicit",
    );
    await check(
      { NPM_CONFIG_USERCONFIG: "missing" },
      "NPM_CONFIG_USERCONFIG",
      join(cwd, "missing"),
      false,
      "fallback",
    );
    await Bun.write(join(cwd, ".npmrc"), config("project"));
    await check(
      { NPM_CONFIG_USERCONFIG: "relative" },
      "NPM_CONFIG_USERCONFIG",
      join(cwd, "relative"),
      true,
      "project",
      true,
    );
  } finally {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
