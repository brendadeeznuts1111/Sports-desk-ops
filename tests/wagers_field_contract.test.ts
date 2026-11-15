import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  checkCrossCaptureAgreement,
  checkRegistryShape,
  validateWagersFieldContract,
  type SemanticStatus,
} from "../scripts/validate_wagers_field_contract.ts";

const SEMANTICS = (status: SemanticStatus = "evidenced") => ({
  lifecycle_mutability: {
    status,
    citations: ["docs/evidence/manager-betreport-field-contract.md:52"],
    ...(status === "evidenced" ? {} : { review_by: "2027-02-01" }),
  },
  consumer_obligation: { status: "evidenced", citations: ["tests/x.test.ts"] },
  origin: {
    status: "evidenced",
    citations: ["docs/evidence/manager-betreport-field-contract.md"],
  },
  liveness: {
    status: "evidenced",
    citations: ["tests/fixtures/live-wagers-LIST-100.json"],
  },
});

function registry(overrides: Record<string, unknown> = {}) {
  return {
    statuses: { evidenced: "x", unverified: "x", conflicting: "x" },
    captureSets: {
      cap: {
        path: "c.json",
        sha256: "x",
        skeletonPath: "response.bodySkeleton.fields.List.items.fields",
      },
    },
    fields: {
      WagerType: {
        capture: "cap",
        enum_source: {
          value: "observed",
          citation: "scripts/capture/schema.ts:191",
        },
        semantics: SEMANTICS(),
      },
    },
    ...overrides,
  };
}

const skeleton = {
  response: {
    bodySkeleton: {
      fields: {
        List: {
          items: {
            fields: {
              WagerType: {
                type: "string",
                nullable: false,
                enumCandidates: ["L", "M"],
              },
            },
          },
        },
      },
    },
  },
};

describe("wagers field contract registry", () => {
  test("committed registry passes with no failures and no warnings", async () => {
    const { fails, warns } = await validateWagersFieldContract();
    expect(fails).toEqual([]);
    expect(warns).toEqual([]);
  });

  test("a missing semantic axis fails", () => {
    const r = registry();
    delete (r.fields.WagerType.semantics as Record<string, unknown>).liveness;
    const fails = checkRegistryShape(r, {
      skeletons: new Map([["cap", skeleton]]),
    }).filter((i) => i.level === "fail");
    expect(fails.some((i) => i.message.includes("axis is absent"))).toBe(true);
  });

  test("unverified without review_by fails; past review_by warns (TTL)", () => {
    const r = registry();
    const lifecycle = r.fields.WagerType.semantics
      .lifecycle_mutability as Record<string, unknown>;
    lifecycle.status = "unverified";
    delete lifecycle.review_by;
    const missingTtl = checkRegistryShape(r, { skeletons: new Map() });
    expect(
      missingTtl.some(
        (i) => i.level === "fail" && i.message.includes("review_by"),
      ),
    ).toBe(true);

    lifecycle.review_by = "2020-01-01T00:00:00Z";
    const stale = checkRegistryShape(r, {
      now: new Date("2026-11-14T00:00:00Z"),
      skeletons: new Map(),
    });
    expect(
      stale.some((i) => i.level === "warn" && i.message.includes("re-review")),
    ).toBe(true);
  });

  test("a capture that no longer carries the cited field fails (drift)", () => {
    const emptySkeleton = {
      response: {
        bodySkeleton: { fields: { List: { items: { fields: {} } } } },
      },
    };
    const fails = checkRegistryShape(registry(), {
      skeletons: new Map([["cap", emptySkeleton]]),
    }).filter((i) => i.level === "fail");
    expect(fails.some((i) => i.message.includes("capture drifted"))).toBe(true);
  });

  test("an invalid enum_source fails", () => {
    const r = registry();
    r.fields.WagerType.enum_source = { value: "guessed", citation: "" };
    const fails = checkRegistryShape(r, {
      skeletons: new Map([["cap", skeleton]]),
    }).filter((i) => i.level === "fail");
    expect(fails.some((i) => i.message.includes("declared or observed"))).toBe(
      true,
    );
    expect(fails.some((i) => i.message.includes("requires a citation"))).toBe(
      true,
    );
  });

  test("two captures disagreeing on nullable/enum warns instead of picking a winner", () => {
    const r = registry({
      captureSets: {
        cap: {
          path: "a.json",
          sha256: "x",
          skeletonPath: "response.bodySkeleton.fields.List.items.fields",
        },
        cap2: {
          path: "b.json",
          sha256: "y",
          skeletonPath: "response.bodySkeleton.fields.List.items.fields",
        },
      },
    });
    const second = structuredClone(skeleton);
    second.response.bodySkeleton.fields.List.items.fields.WagerType.enumCandidates =
      ["L", "C"];
    const warns = checkCrossCaptureAgreement(
      r,
      new Map([
        ["cap", skeleton],
        ["cap2", second],
      ]),
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.level).toBe("warn");
    expect(warns[0]?.message).toContain("disagree");
  });

  test("a tampered capture sha fails through the filesystem wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sd-wagers-contract-"));
    const path = join(dir, "contract.json");
    try {
      const source = (await Bun.file(
        "schema/wagers_field_contract.json",
      ).json()) as Record<string, unknown>;
      const captureSets = source.captureSets as Record<
        string,
        { sha256: string }
      >;
      captureSets["getBetTicker-2026-10-31"]!.sha256 = "0".repeat(64);
      await Bun.write(path, JSON.stringify(source));

      const { fails } = await validateWagersFieldContract(path);
      expect(fails.some((i) => i.message.includes("sha256 drifted"))).toBe(
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
