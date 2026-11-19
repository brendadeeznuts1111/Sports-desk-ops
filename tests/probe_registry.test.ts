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
