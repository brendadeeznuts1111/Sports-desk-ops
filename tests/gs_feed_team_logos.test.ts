import { describe, expect, test } from "bun:test";
import {
  collectFeedTeams,
  deriveLogoFileCandidates,
} from "../lib/gs_feed_team_logos.ts";

describe("collectFeedTeams", () => {
  test("reads teams from a single event and from a rotation map", () => {
    const single = {
      rotation: 1,
      teams: [{ name: "Los Angeles Chargers", nick_name: "Chargers" }],
    };
    const mapped = {
      123: { teams: [{ name: "Chicago Bulls", nick_name: "Bulls" }] },
      456: { teams: [{ name: "Buffalo Sabres" }] },
    };
    expect(collectFeedTeams([single])).toEqual([
      { name: "Los Angeles Chargers", nickName: "Chargers" },
    ]);
    expect(collectFeedTeams([mapped])).toEqual([
      { name: "Chicago Bulls", nickName: "Bulls" },
      { name: "Buffalo Sabres", nickName: null },
    ]);
  });

  test("dedupes by name and keeps a nickname learned later", () => {
    const payloads = [
      { teams: [{ name: "Akron Zips" }] },
      { teams: [{ name: "Akron Zips", nick_name: "Zips" }] },
    ];
    expect(collectFeedTeams(payloads)).toEqual([
      { name: "Akron Zips", nickName: "Zips" },
    ]);
  });

  test("ignores malformed entries", () => {
    expect(
      collectFeedTeams([
        null,
        [],
        { teams: "nope" },
        { teams: [null, 42, { name: "  " }, { nick_name: "x" }] },
      ]),
    ).toEqual([]);
  });
});

describe("deriveLogoFileCandidates", () => {
  test("emits both filename spellings plus the city-nickname form", () => {
    expect(
      deriveLogoFileCandidates([
        { name: "Los Angeles Chargers", nickName: "Chargers" },
      ]),
    ).toEqual([
      "Los Angeles Chargers.png",
      "Los-Angeles-Chargers.png",
      "Los Angeles-Chargers.png",
    ]);
  });

  test("collapses duplicate spellings", () => {
    expect(
      deriveLogoFileCandidates([{ name: "Akron Zips", nickName: "Zips" }]),
    ).toEqual(["Akron Zips.png", "Akron-Zips.png"]);
  });

  test("skips the city form when the nickname is not a suffix", () => {
    expect(
      deriveLogoFileCandidates([
        { name: "Los Angeles Rams", nickName: "Chargers" },
      ]),
    ).toEqual(["Los Angeles Rams.png", "Los-Angeles-Rams.png"]);
  });

  test("emits the plain forms when there is no nickname", () => {
    expect(
      deriveLogoFileCandidates([{ name: "Buffalo Sabres", nickName: null }]),
    ).toEqual(["Buffalo Sabres.png", "Buffalo-Sabres.png"]);
  });

  test("dedupes across teams and ignores blank names", () => {
    expect(
      deriveLogoFileCandidates([
        { name: "Chicago Bulls", nickName: "Bulls" },
        { name: "Chicago Bulls", nickName: "Bulls" },
        { name: "   ", nickName: null },
      ]),
    ).toEqual(
      ["Chicago Bulls.png", "Chicago-Bulls.png", "Chicago-Bulls.png"].filter(
        (file, index, all) => all.indexOf(file) === index,
      ),
    );
  });
});
