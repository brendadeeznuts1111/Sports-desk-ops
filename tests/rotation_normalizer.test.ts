import { describe, expect, it } from "bun:test";
import {
  areRotationsCoincident,
  extractRotationFromText,
  normalizeRotationNumber,
  resolveCanonicalRotationKey,
  to1hRotation,
  to2hRotation,
  toAltRotation,
  toLiveRotation,
} from "../lib/rotation_normalizer.ts";

describe("Rotation Normalizer & Bidirectional Translation Suite", () => {
  describe("1. Pregame Main Rotation Normalization", () => {
    it("classifies standard 3-digit rotation numbers and home/away pairings", () => {
      const away = normalizeRotationNumber(501); // LAL Away
      expect(away.rawRotation).toBe(501);
      expect(away.parentRotation).toBe(501);
      expect(away.parentGameNumber).toBe(250);
      expect(away.isAwayTeam).toBe(true);
      expect(away.isHomeTeam).toBe(false);
      expect(away.rotationKind).toBe("PREGAME_MAIN");
      expect(away.period).toBe("GAME");
      expect(away.isLive).toBe(false);
      expect(away.canonicalRotationKey).toBe("ROT 501");

      const home = normalizeRotationNumber(502); // BOS Home
      expect(home.parentRotation).toBe(502);
      expect(home.parentGameNumber).toBe(251);
      expect(home.isAwayTeam).toBe(false);
      expect(home.isHomeTeam).toBe(true);
      expect(home.canonicalRotationKey).toBe("ROT 502");
    });
  });

  describe("2. Derivative & In-Play Offsets Normalization", () => {
    it("normalizes DGS 1H (+1000) rotation numbers back to parent", () => {
      const res = normalizeRotationNumber(1501);
      expect(res.rotationKind).toBe("FIRST_HALF");
      expect(res.period).toBe("1H");
      expect(res.parentRotation).toBe(501);
      expect(res.isDerivative).toBe(true);
      expect(res.isLive).toBe(false);
      expect(res.canonicalRotationKey).toBe("ROT 501");
    });

    it("normalizes DGS 2H (+2000) rotation numbers back to parent", () => {
      const res = normalizeRotationNumber(2501);
      expect(res.rotationKind).toBe("SECOND_HALF");
      expect(res.period).toBe("2H");
      expect(res.parentRotation).toBe(501);
      expect(res.isDerivative).toBe(true);
      expect(res.canonicalRotationKey).toBe("ROT 501");
    });

    it("normalizes DGS Alternate Spreads/Totals (+5000) back to parent", () => {
      const res = normalizeRotationNumber(5501);
      expect(res.rotationKind).toBe("ALT_SPREAD_TOTAL");
      expect(res.parentRotation).toBe(501);
      expect(res.isAlt).toBe(true);
      expect(res.isDerivative).toBe(true);
      expect(res.canonicalRotationKey).toBe("ROT 501");
    });

    it("normalizes ASI/DGS Live #9000-series rotation numbers back to parent", () => {
      const res = normalizeRotationNumber(9501);
      expect(res.rotationKind).toBe("LIVE_IN_PLAY");
      expect(res.period).toBe("LIVE");
      expect(res.parentRotation).toBe(501);
      expect(res.isLive).toBe(true);
      expect(res.isDerivative).toBe(true);
      expect(res.canonicalRotationKey).toBe("ROT 501");
    });
  });

  describe("3. Bidirectional Translation (Pregame -> Derivative / Live)", () => {
    it("translates parent rotation #451 to all derivative and live counterparts", () => {
      expect(toLiveRotation(451)).toBe(9451);
      expect(to1hRotation(451)).toBe(1451);
      expect(to2hRotation(451)).toBe(2451);
      expect(toAltRotation(451)).toBe(5451);
    });

    it("handles pre-offset inputs idempotently", () => {
      expect(toLiveRotation(5451)).toBe(9451);
      expect(toAltRotation(9451)).toBe(5451);
    });
  });

  describe("4. Ticket Description Parsing", () => {
    it("extracts rotation numbers from diverse wire formats", () => {
      const live = extractRotationFromText("NBA LIVE #9501 LAL -3.5");
      expect(live?.parentRotation).toBe(501);
      expect(live?.isLive).toBe(true);

      const alt = extractRotationFromText("GameNum 5501 LAL Alt -7.5");
      expect(alt?.parentRotation).toBe(501);
      expect(alt?.isAlt).toBe(true);

      const standard = extractRotationFromText("NFL KC #451 -2.5");
      expect(standard?.parentRotation).toBe(451);
      expect(standard?.rotationKind).toBe("PREGAME_MAIN");

      const rotPrefix = extractRotationFromText("ROT 516 timeUntilScore -8.0s");
      expect(rotPrefix?.parentRotation).toBe(516);
      expect(rotPrefix?.canonicalRotationKey).toBe("ROT 516");
    });
  });

  describe("5. Coincidence & Cross-System Resolution", () => {
    it("resolves canonical surveillance index keys", () => {
      expect(resolveCanonicalRotationKey(9501)).toBe("ROT 501");
      expect(resolveCanonicalRotationKey("LIVE #9501")).toBe("ROT 501");
      expect(resolveCanonicalRotationKey("ROT 501")).toBe("ROT 501");
      expect(resolveCanonicalRotationKey("GameNum 5501")).toBe("ROT 501");
    });

    it("identifies matching parent events across pregame, live, and derivative tickets", () => {
      // Live vs Pregame
      expect(areRotationsCoincident(9501, 501)).toBe(true);
      expect(areRotationsCoincident("LIVE #9501", "#501")).toBe(true);

      // Alt vs 1H
      expect(areRotationsCoincident("GameNum 5501", "1H #1501")).toBe(true);

      // Live vs Alt
      expect(areRotationsCoincident(9501, 5501)).toBe(true);

      // Different teams
      expect(areRotationsCoincident(9501, 9502)).toBe(false);
      expect(areRotationsCoincident(9501, 451)).toBe(false);
    });
  });
});
