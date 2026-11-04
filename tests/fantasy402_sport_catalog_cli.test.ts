import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveCollisionsFromSports,
  loadFantasy402SportCatalogFromFile,
} from "../catalog/fantasy402_sport_catalog.ts";

const FIXTURE = join(
  import.meta.dir,
  "fixtures/fantasy402-sport-catalog-2026-10-21.json",
);

const CLI = join(import.meta.dir, "../cli/sportsdesk_catalog_cli.ts");
const TMP = mkdtempSync(join(tmpdir(), "sportsdesk-catalog-cli-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

async function runCatalog(
  args: string[],
): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: join(import.meta.dir, ".."),
  });
  const [exit, out, err] = await Promise.all([
    proc.exited,
    proc.stdout.text(),
    proc.stderr.text(),
  ]);
  return { exit, out, err: out + err };
}

describe("fantasy402_sport_catalog_cli", () => {
  test("validate fixture exits 0", async () => {
    const { exit, out } = await runCatalog(["validate", "--fixture", FIXTURE]);
    expect(exit).toBe(0);
    expect(out).toContain("validate: ok");
  });

  test("diff identical probe exits 0 with markdown table", async () => {
    const { exit, out } = await runCatalog([
      "diff",
      "--fixture",
      FIXTURE,
      "--probe",
      FIXTURE,
    ]);
    expect(exit).toBe(0);
    expect(out).toContain("| Category | Before | After | Detail |");
  });

  test("diff new collision exits 3", async () => {
    const base = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const probe = structuredClone(base);
    probe.sports.push({
      sport: "Racquet",
      subSports: [{ code: "ATP", name: "Racquet ATP" }],
      periods: [{ name: "Game", number: 0 }],
    });
    probe.sports
      .find((s) => s.sport === "Tennis")!
      .subSports.push({ code: "ATP", name: "Tennis ATP" });
    probe.collisions = deriveCollisionsFromSports(probe.sports);
    probe.sportCount = probe.sports.length;
    probe.subSportCount = probe.sports.reduce(
      (n, s) => n + s.subSports.length,
      0,
    );
    probe.sportPeriodCount = probe.sports.reduce(
      (n, s) => n + s.periods.length,
      0,
    );

    const tmp = join(TMP, `catalog-atp-${Date.now()}.json`);
    await Bun.write(tmp, JSON.stringify(probe));
    try {
      const { exit, out } = await runCatalog([
        "diff",
        "--fixture",
        FIXTURE,
        "--probe",
        tmp,
      ]);
      expect(exit).toBe(3);
      expect(out).toContain("collision_set_changed");
      expect(out).toContain("ATP");
    } finally {
      await Bun.write(tmp, "");
    }
  });

  test("diff stale collision registry exits 6 before table", async () => {
    const base = await loadFantasy402SportCatalogFromFile(FIXTURE);
    const probe = structuredClone(base);
    probe.collisions = [
      { code: "Arena", sports: ["Football", "Horse Racing", "Tennis"] },
      { code: "NCAA Extra", sports: ["Basketball", "Hockey"] },
    ];

    const tmp = join(TMP, `catalog-badreg-${Date.now()}.json`);
    await Bun.write(tmp, JSON.stringify(probe));
    try {
      const { exit, err } = await runCatalog([
        "diff",
        "--fixture",
        FIXTURE,
        "--probe",
        tmp,
      ]);
      expect(exit).toBe(6);
      expect(err).toContain("collision_registry_mismatch");
      expect(err).not.toContain("| Category |");
    } finally {
      await Bun.write(tmp, "");
    }
  });

  test("refresh propose keeps collisions, writes proposedCollisions", async () => {
    const tmpIn = join(TMP, `catalog-in-${Date.now()}.json`);
    const tmpOut = join(TMP, `catalog-out-${Date.now()}.json`);
    const broken = await loadFantasy402SportCatalogFromFile(FIXTURE);
    broken.collisions = [];
    await Bun.write(tmpIn, JSON.stringify(broken));
    try {
      const { exit, out } = await runCatalog([
        "refresh",
        "--from",
        tmpIn,
        "--propose",
        "--out",
        tmpOut,
      ]);
      expect(exit).toBe(0);
      expect(out).toContain("proposedCollisions");
      const raw = await Bun.file(tmpOut).json();
      expect(raw.collisions).toEqual([]);
      expect(raw.proposedCollisions?.length).toBe(2);
    } finally {
      await Bun.write(tmpIn, "");
      await Bun.write(tmpOut, "");
    }
  });

  test("refresh default does not rewrite collisions", async () => {
    const tmpIn = join(TMP, `catalog-in2-${Date.now()}.json`);
    const tmpOut = join(TMP, `catalog-out2-${Date.now()}.json`);
    const src = await loadFantasy402SportCatalogFromFile(FIXTURE);
    src.collisions = [{ code: "Arena", sports: ["Football", "Horse Racing"] }];
    src.sportCount = 0;
    await Bun.write(tmpIn, JSON.stringify(src));
    try {
      const { exit } = await runCatalog([
        "refresh",
        "--from",
        tmpIn,
        "--out",
        tmpOut,
      ]);
      expect(exit).toBe(0);
      const refreshed = await loadFantasy402SportCatalogFromFile(tmpOut);
      expect(refreshed.sportCount).toBe(19);
      expect(refreshed.collisions).toHaveLength(1);
    } finally {
      await Bun.write(tmpIn, "");
      await Bun.write(tmpOut, "");
    }
  });
});
