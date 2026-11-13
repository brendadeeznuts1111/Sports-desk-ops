import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectLogoFilesFromLiveBets,
  defaultScoreboardSyncPaths,
  mergeLogoFilesIntoRegistryFile,
  mergeScoreboardIntoRegistryFile,
} from "../lib/unified_team_registry_scoreboard.ts";

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "team-registry-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(): { registryPath: string; scoreboardPath: string } {
  counter += 1;
  return {
    registryPath: join(root, `registry-${counter}.json`),
    scoreboardPath: join(root, `scoreboard-${counter}.json`),
  };
}

function writeRegistry(
  path: string,
  teams: readonly Record<string, unknown>[],
): void {
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion: 1, description: "test registry", teams }, null, 2)}\n`,
    "utf8",
  );
}

function writeScoreboard(path: string, games: readonly unknown[]): void {
  writeFileSync(path, `${JSON.stringify({ games }, null, 2)}\n`, "utf8");
}

function readRegistry(path: string): {
  schemaVersion: number;
  description?: string;
  teams: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("defaultScoreboardSyncPaths", () => {
  test("resolves the registry and scoreboard under data/", () => {
    expect(defaultScoreboardSyncPaths("/repo")).toEqual({
      registryPath: join("/repo", "data/unified_team_registry.json"),
      scoreboardPath: join("/repo", "data/scoreboard.json"),
    });
  });
});

describe("mergeScoreboardIntoRegistryFile", () => {
  test("adds new teams with league-scoped codes, logos and hints", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, []);
    writeScoreboard(scoreboardPath, [
      {
        league: "NFL",
        team1: { name: "Vikings", logo: "minnesota_vikings.png" },
        team2: { name: "Lions", logo: "detroit-lions.png" },
      },
      // "Jets" is NYJ in the NFL and WPG in the NHL; the league decides the code.
      { league: "NHL", team1: { name: "Jets", logo: "winnipeg-jets.png" } },
    ]);

    expect(
      mergeScoreboardIntoRegistryFile(registryPath, scoreboardPath),
    ).toEqual({
      added: 3,
      updated: 0,
      skipped: 0,
      total: 3,
    });

    const registry = readRegistry(registryPath);
    expect(registry.schemaVersion).toBe(1);
    expect(registry.description).toBe("test registry");
    expect(registry.teams.map((team) => team["id"])).toEqual([
      "nfl:lions",
      "nfl:vikings",
      "nhl:jets",
    ]);
    const vikings = registry.teams.find(
      (team) => team["id"] === "nfl:vikings",
    )!;
    expect(vikings).toMatchObject({
      league: "NFL",
      code: "MIN",
      displayName: "Vikings",
      nicknames: ["Vikings"],
      portalLogoFile: "minnesota_vikings.png",
    });
    const jets = registry.teams.find((team) => team["id"] === "nhl:jets")!;
    expect(jets).toMatchObject({
      league: "NHL",
      code: "WPG",
      displayName: "winnipeg jets",
    });
  });

  test("prefers the logo filename when it carries a dash, else the nickname", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, []);
    writeScoreboard(scoreboardPath, [
      { league: "NFL", team1: { name: "Bills", logo: "buffalo_bills.png" } },
      {
        league: "NFL",
        team1: { name: "Ravens", logo: "baltimore-ravens.png" },
      },
    ]);
    mergeScoreboardIntoRegistryFile(registryPath, scoreboardPath);
    const teams = readRegistry(registryPath).teams;
    expect(
      teams.find((team) => team["id"] === "nfl:bills")?.["displayName"],
    ).toBe("Bills");
    expect(
      teams.find((team) => team["id"] === "nfl:ravens")?.["displayName"],
    ).toBe("baltimore ravens");
  });

  test("updates an existing team matched by id, unioning nicknames", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, [
      {
        id: "nfl:vikings",
        league: "NFL",
        code: "MIN",
        displayName: "Minnesota Vikings",
        nicknames: ["Minnesota"],
        portalLogoFile: null,
      },
    ]);
    writeScoreboard(scoreboardPath, [
      {
        league: "NFL",
        team1: { name: "Vikings", logo: "minnesota_vikings.png" },
      },
    ]);
    expect(
      mergeScoreboardIntoRegistryFile(registryPath, scoreboardPath),
    ).toEqual({
      added: 0,
      updated: 1,
      skipped: 0,
      total: 1,
    });
    expect(readRegistry(registryPath).teams[0]).toMatchObject({
      id: "nfl:vikings",
      displayName: "Minnesota Vikings",
      nicknames: ["Minnesota", "Vikings"],
      portalLogoFile: "minnesota_vikings.png",
    });
  });

  test("updates an existing team matched by league and code under its own id", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, [
      {
        id: "custom-min",
        league: "NFL",
        code: "MIN",
        displayName: "Vikes",
        nicknames: [],
      },
    ]);
    writeScoreboard(scoreboardPath, [
      {
        league: "NFL",
        team1: { name: "Vikings", logo: "minnesota_vikings.png" },
      },
    ]);
    const result = mergeScoreboardIntoRegistryFile(
      registryPath,
      scoreboardPath,
    );
    expect(result).toEqual({ added: 0, updated: 1, skipped: 0, total: 1 });
    expect(readRegistry(registryPath).teams[0]).toMatchObject({
      id: "custom-min",
      nicknames: ["Vikings"],
    });
  });

  test("skips unknown nicknames, blank names, unmapped leagues and missing slots", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, []);
    writeScoreboard(scoreboardPath, [
      { league: "NFL", team1: { name: "Unknown Team" }, team2: { name: "  " } },
      { league: "NCAA", team1: { name: "Duke" } },
      { league: "NFL" },
      { league: "NBA", team1: { name: "Lakers" } },
    ]);
    expect(
      mergeScoreboardIntoRegistryFile(registryPath, scoreboardPath),
    ).toEqual({
      added: 1,
      updated: 0,
      skipped: 2,
      total: 1,
    });
    expect(readRegistry(registryPath).teams[0]).toMatchObject({
      id: "nba:lakers",
      code: "LAL",
    });
  });

  test("writes sorted ids and a trailing newline", () => {
    const { registryPath, scoreboardPath } = paths();
    writeRegistry(registryPath, []);
    writeScoreboard(scoreboardPath, [
      { league: "NBA", team1: { name: "Lakers" } },
      { league: "NFL", team1: { name: "Chiefs" } },
      { league: "NFL", team1: { name: "Bills" } },
    ]);
    mergeScoreboardIntoRegistryFile(registryPath, scoreboardPath);
    const text = readFileSync(registryPath, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"description": "test registry"');
    expect(readRegistry(registryPath).teams.map((team) => team["id"])).toEqual([
      "nba:lakers",
      "nfl:bills",
      "nfl:chiefs",
    ]);
  });
});

describe("collectLogoFilesFromLiveBets", () => {
  test("decodes percent-encoded names and dedupes", () => {
    const files = collectLogoFilesFromLiveBets({
      games: [
        {
          team1: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Akron%20Zips.png",
          },
          team2: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Akron%20Zips.png",
          },
        },
        {
          team1: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Notre Dame Fighting Irish.png",
          },
        },
        { team1: { logoUrl: "https://example.com/other.png" } },
        { team1: { logoUrl: null } },
      ],
    });
    expect(files).toEqual(["Akron Zips.png", "Notre Dame Fighting Irish.png"]);
  });

  test("classifies college by the game's subSport, not the filename shape", () => {
    const liveBets = {
      games: [
        {
          sport: "Football",
          subSport: "College",
          team1: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Akron%20Zips.png",
          },
        },
        {
          sport: "Football",
          subSport: "NFL",
          team1: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Arizona-Cardinals.png",
          },
        },
        {
          sport: "Basketball",
          subSport: "NCAA Sea Win",
          team1: {
            logoUrl:
              "https://cdn.fastassets.io/images/team-logos/Notre Dame Fighting Irish.png",
          },
        },
      ],
    };
    expect(collectLogoFilesFromLiveBets(liveBets)).toEqual([
      "Akron Zips.png",
      "Arizona-Cardinals.png",
      "Notre Dame Fighting Irish.png",
    ]);
    expect(
      collectLogoFilesFromLiveBets(liveBets, { collegeOnly: true }),
    ).toEqual(["Akron Zips.png", "Notre Dame Fighting Irish.png"]);
  });
});

describe("mergeLogoFilesIntoRegistryFile", () => {
  const team = (
    id: string,
    league: string,
    displayName: string,
    code = id.split(":")[1]!.toUpperCase(),
  ) => ({ id, league, code, displayName });

  test("attributes a State-spelled file to the longest matching school", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      team("cfb:fla", "CFB", "Florida"),
      team("cfb:fsu", "CFB", "Florida St."),
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [
      "Florida State Seminoles.png",
    ]);
    expect(result).toMatchObject({ updated: 1, total: 2 });
    expect(result.matched).toEqual([
      { teamId: "cfb:fsu", logoFile: "Florida State Seminoles.png" },
    ]);
    const teams = readRegistry(registryPath).teams;
    expect(
      teams.find((row) => row["id"] === "cfb:fsu")?.["portalLogoFile"],
    ).toBe("Florida State Seminoles.png");
    expect(
      teams.find((row) => row["id"] === "cfb:fla")?.["portalLogoFile"],
    ).toBeUndefined();
  });

  test("leaves pro leagues alone by default and can be scoped", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      team("nba:chi", "NBA", "Chicago"),
      team("cfb:akr", "CFB", "Akron"),
    ]);
    const files = ["Chicago-Bears.png", "Akron Zips.png"];
    const scoped = mergeLogoFilesIntoRegistryFile(registryPath, files);
    expect(scoped.updated).toBe(1);
    expect(scoped.matched).toEqual([
      { teamId: "cfb:akr", logoFile: "Akron Zips.png" },
    ]);
    expect(scoped.unmatchedFiles).toEqual(["Chicago-Bears.png"]);

    const pro = mergeLogoFilesIntoRegistryFile(registryPath, files, {
      leagues: ["NBA"],
      write: false,
    });
    expect(pro.updated).toBe(1);
    expect(pro.matched).toEqual([
      { teamId: "nba:chi", logoFile: "Chicago-Bears.png" },
    ]);
  });

  test("does not fall back to a shorter name when the longer match already has a logo", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      {
        ...team("cfb:psu", "CFB", "Penn St."),
        portalLogoFile: "Penn State Nittany Lions.png",
      },
      team("cfb:penn", "CFB", "Penn"),
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [
      "Penn State Nittany Lions.png",
    ]);
    expect(result.updated).toBe(0);
    const penn = readRegistry(registryPath).teams.find(
      (row) => row["id"] === "cfb:penn",
    );
    expect(penn?.["portalLogoFile"]).toBeUndefined();
  });

  test("reports ambiguous and unmatched files instead of guessing", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      team("cfb:a", "CFB", "Miami"),
      team("cfb:b", "CFB", "Miami"),
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [
      "Miami Hurricanes.png",
      "Nowhere State.png",
    ]);
    expect(result.updated).toBe(0);
    expect(result.matched).toEqual([]);
    expect(result.unmatchedFiles).toEqual([
      "Miami Hurricanes.png",
      "Nowhere State.png",
    ]);
  });

  test("does not overwrite an existing logo", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      { ...team("cfb:akr", "CFB", "Akron"), portalLogoFile: "Existing.png" },
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [
      "Akron Zips.png",
    ]);
    expect(result.updated).toBe(0);
    expect(result.unmatchedFiles).toEqual(["Akron Zips.png"]);
    expect(readRegistry(registryPath).teams[0]?.["portalLogoFile"]).toBe(
      "Existing.png",
    );
  });

  test("propagates a lone logo to an alias record with the same league and code", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      {
        ...team("nba:clippers", "NBA", "Los Angeles Clippers", "LAC"),
        portalLogoFile: "Los-Angeles-Clippers.png",
      },
      team("nba:lac", "NBA", "Los Angeles C", "LAC"),
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [], {
      leagues: ["NBA"],
    });
    expect(result).toMatchObject({ updated: 0, aliased: 1, total: 2 });
    const alias = readRegistry(registryPath).teams.find(
      (row) => row["id"] === "nba:lac",
    );
    expect(alias?.["portalLogoFile"]).toBe("Los-Angeles-Clippers.png");
  });

  test("does not propagate between different codes or across conflicting logos", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [
      {
        ...team("nba:cli", "NBA", "Los Angeles Clippers", "LAC"),
        portalLogoFile: "Clippers.png",
      },
      {
        ...team("nba:lac", "NBA", "Los Angeles C", "LAC"),
        portalLogoFile: "Other.png",
      },
      team("nba:phi", "NBA", "Philadelphia"),
    ]);
    const result = mergeLogoFilesIntoRegistryFile(registryPath, [], {
      leagues: ["NBA"],
    });
    expect(result.aliased).toBe(0);
    const rows = readRegistry(registryPath).teams;
    expect(
      rows.find((row) => row["id"] === "nba:lac")?.["portalLogoFile"],
    ).toBe("Other.png");
    expect(
      rows.find((row) => row["id"] === "nba:phi")?.["portalLogoFile"],
    ).toBeUndefined();
  });

  test("write:false resolves without touching the file", () => {
    const { registryPath } = paths();
    writeRegistry(registryPath, [team("cfb:akr", "CFB", "Akron")]);
    const before = readFileSync(registryPath, "utf8");
    const result = mergeLogoFilesIntoRegistryFile(
      registryPath,
      ["Akron Zips.png"],
      {
        write: false,
      },
    );
    expect(result.updated).toBe(1);
    expect(readFileSync(registryPath, "utf8")).toBe(before);
  });
});
