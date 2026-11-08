/**
 * @file tests/doc_template_hydrator.test.ts
 * @description Invariant tests for secure template hydration, key validation, sed escaping, and sentinel safety.
 */

import { describe, it, expect } from "bun:test";
import {
  checkUnresolvedSentinels,
  chooseDelimiter,
  buildSedScript,
  parseSubstitutionInput,
  redactSecretMatch,
  buildSubprocessEnv,
  SUBPROCESS_ENV_WHITELIST,
  resolveTemplateKind,
  listTemplateKinds,
  validateKindSubstitutions,
  DOC_TEMPLATE_REGISTRY,
} from "../lib/doc_template_hydrator.ts";

describe("doc_template_hydrator", () => {
  it("detects unresolved placeholders {{KEY}} and sentinels", () => {
    const rawTemplate = `
# Specification for Partner {{PARTNER_NAME}}
Customer Handle: {{PLAYER_HANDLE}}
Sub-Agent: AGENT-0000-UNBOUND
Initial Credit: {{STARTING_BALANCE}}
Fallback Login: SENTINEL_UNASSIGNED_LOGIN
    `.trim();

    const result = checkUnresolvedSentinels(rawTemplate);
    expect(result.valid).toBe(false);
    expect(result.hasUnresolved).toBe(true);
    expect(result.unresolvedPlaceholders).toContain("{{PARTNER_NAME}}");
    expect(result.unresolvedPlaceholders).toContain("{{PLAYER_HANDLE}}");
    expect(result.unresolvedPlaceholders).toContain("{{STARTING_BALANCE}}");
    expect(result.sentinelsFound).toContain("AGENT-0000-UNBOUND");
    expect(result.sentinelsFound).toContain("SENTINEL_UNASSIGNED_LOGIN");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("distinguishes .valid from .hasUnresolved when allowUnresolved is set (R6)", () => {
    const templateContent = "Hello {{NAME}}";
    const result = checkUnresolvedSentinels(templateContent, {
      allowUnresolved: true,
    });
    expect(result.valid).toBe(true);
    expect(result.hasUnresolved).toBe(true);
    expect(result.unresolvedPlaceholders).toContain("{{NAME}}");
  });

  it("supports opt-in stripping of nested code fences via ignoreCodeFences (P7)", () => {
    const docWithNestedFence = `
# Runbook Documentation
Example outer fence:
\`\`\`\`markdown
Outer wrapper with placeholder: {{PLAYER_HANDLE}}
\`\`\`bash
echo "{{AGENT_ID}}"
\`\`\`
\`\`\`\`
Real body text without placeholders.
    `.trim();

    // Default: flags placeholders inside code fences
    const strictResult = checkUnresolvedSentinels(docWithNestedFence);
    expect(strictResult.valid).toBe(false);
    expect(strictResult.unresolvedPlaceholders).toContain("{{PLAYER_HANDLE}}");

    // Opt-in: ignores placeholders inside multi-level code fences
    const relaxedResult = checkUnresolvedSentinels(docWithNestedFence, {
      ignoreCodeFences: true,
    });
    expect(relaxedResult.valid).toBe(true);
    expect(relaxedResult.unresolvedPlaceholders.length).toBe(0);
  });

  it("passes when all placeholders and sentinels are substituted", () => {
    const hydratedDoc = `
# Specification for Partner John-Pats-guy
Customer Handle: BB55103
Sub-Agent: MOOSEM
Initial Credit: $8,212.50
Fallback Login: NONE
    `.trim();

    const result = checkUnresolvedSentinels(hydratedDoc);
    expect(result.valid).toBe(true);
    expect(result.hasUnresolved).toBe(false);
    expect(result.unresolvedPlaceholders.length).toBe(0);
    expect(result.sentinelsFound.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("redacts sensitive pattern violations in error messages (H1)", () => {
    // Built at runtime to prevent static scanner false-positive
    const liveJwt = [
      "Bearer ",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      ".e30.",
      "t-IDN-6Ba-secret-tail",
    ].join("");
    const result = checkUnresolvedSentinels(liveJwt);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Found prohibited pattern match");
    expect(result.errors[0]).not.toContain("secret-tail");
    expect(result.errors[0]).toContain("len=");
  });

  it("detects extended sensitive pattern set by default (R2/M1)", () => {
    // AWS Key (assembled dynamically to avoid push-protection false positives)
    expect(
      checkUnresolvedSentinels(["AKIA", "IOSFODNN7EXAMPLE"].join("")).valid,
    ).toBe(false);
    // Google API Key (39 chars total: AIza + 35 chars)
    expect(
      checkUnresolvedSentinels(
        ["AIza", "SyD1234567890abcdefghijklmnopqrstuv"].join(""),
      ).valid,
    ).toBe(false);
    // GitHub fine-grained PAT
    expect(
      checkUnresolvedSentinels(
        ["github_", "pat_", "11ABCD_", "0".repeat(75)].join(""),
      ).valid,
    ).toBe(false);
    // Slack token
    expect(
      checkUnresolvedSentinels(
        ["xoxb-", "123456789012-", "abcdefghijklm"].join(""),
      ).valid,
    ).toBe(false);
    // Stripe live key
    expect(
      checkUnresolvedSentinels(
        ["sk_", "live_", "1234567890abcdefghijklmn"].join(""),
      ).valid,
    ).toBe(false);
    // PEM Private Key
    expect(
      checkUnresolvedSentinels(
        ["-----BEGIN ", "RSA ", "PRIVATE KEY-----"].join(""),
      ).valid,
    ).toBe(false);
  });

  it("selects safe collision-free delimiters for sed replacement (V1)", () => {
    expect(chooseDelimiter("KEY", "50/50")).toBe("|");
    expect(chooseDelimiter("KEY", "pipe|value")).toBe("/");
    expect(chooseDelimiter("KEY", "50/50 and pipe|value")).toBe("~");
  });

  it("fails closed when all candidate delimiters are exhausted (P6)", () => {
    // String containing all candidate delimiters: |, /, ~, @, #, %, !
    const exhaustedValue = "| / ~ @ # % ! all-used";
    expect(() => chooseDelimiter("KEY", exhaustedValue)).toThrow(
      "Cannot safely delimit sed operation for key",
    );
  });

  it("preserves literal & in replacement values without whole-match expansion (V1/C4)", () => {
    const vars = {
      COMPANY: "AT&T",
      SPLIT: "50/50",
    };
    const sedScript = buildSedScript(vars);
    expect(sedScript).toContain("s|{{COMPANY}}|AT&T|");
    expect(sedScript).toContain("s|{{SPLIT}}|50/50|");
  });

  it("sorts keys by length descending to prevent prefix collisions (M5)", () => {
    const vars = {
      PLAYER: "ShortVal",
      PLAYER_HANDLE: "LongVal",
    };

    const sedScript = buildSedScript(vars);
    const lines = sedScript.split("\n").filter((l) => l.startsWith("s"));

    expect(lines[0]).toBe("s|{{PLAYER_HANDLE}}|LongVal|");
    expect(lines[1]).toBe("s|{{PLAYER}}|ShortVal|");
  });

  it("supports raw sentinel replacements alongside placeholders (M4)", () => {
    const vars = {
      PARTNER: "John",
      SENTINEL_PLAYER_ID: "P-123",
      "ACCT-0000-MOCK": "A-999",
      "AGENT-0000-UNBOUND": "AG-001",
    };

    const sedScript = buildSedScript(vars);
    expect(sedScript).toContain("s|SENTINEL_PLAYER_ID|P-123|");
    expect(sedScript).toContain("s|ACCT-0000-MOCK|A-999|");
    expect(sedScript).toContain("s|AGENT-0000-UNBOUND|AG-001|");
  });

  it("rejects invalid substitution keys matching metacharacters at parse time (C3)", () => {
    expect(() => parseSubstitutionInput("A.B=val")).toThrow(
      "Invalid substitution key",
    );
    expect(() => parseSubstitutionInput("A/B=val")).toThrow(
      "Invalid substitution key",
    );
    expect(() => parseSubstitutionInput("A*B=val")).toThrow(
      "Invalid substitution key",
    );
    expect(() => parseSubstitutionInput("A[0]=val")).toThrow(
      "Invalid substitution key",
    );
    expect(() => parseSubstitutionInput("A B=val")).toThrow(
      "Invalid substitution key",
    );

    expect(() =>
      parseSubstitutionInput(JSON.stringify({ "A.B": "val" })),
    ).toThrow("Invalid substitution key");
    expect(() =>
      parseSubstitutionInput(JSON.stringify({ "A/B": "val" })),
    ).toThrow("Invalid substitution key");
  });

  it("rejects embedded newlines and carriage returns in substitution values (P6)", () => {
    expect(() => parseSubstitutionInput("KEY=line1\nline2")).toThrow(
      "Invalid variable line format",
    );
    expect(() =>
      parseSubstitutionInput(JSON.stringify({ KEY: "line1\nline2" })),
    ).toThrow("contains an embedded newline or carriage return");
    expect(() =>
      parseSubstitutionInput(JSON.stringify({ KEY: "line1\rline2" })),
    ).toThrow("contains an embedded newline or carriage return");
  });

  it("rejects duplicate keys and invalid value types (M6)", () => {
    const envDuplicate = `
PLAYER_HANDLE=BB55103
PLAYER_HANDLE=KP406
    `.trim();
    expect(() => parseSubstitutionInput(envDuplicate)).toThrow(
      "Duplicate substitution key",
    );

    const jsonInvalidType = JSON.stringify({
      PLAYER_HANDLE: null,
    });
    expect(() => parseSubstitutionInput(jsonInvalidType)).toThrow(
      "Invalid value type",
    );
  });

  it("strictly filters subprocess environment using explicit whitelist (P2/P8)", () => {
    const dirtyEnv = {
      PATH: "/bin:/usr/bin",
      HOME: "/home/user",
      AWS_SECRET_ACCESS_KEY: "SUPER_SECRET_AWS_KEY",
      GITHUB_TOKEN: "ghp_1234567890abcdefghijklmnopqrstuvwxyz",
      RANDOM_UNTRACKED_KEY: "PRIVATE_DATA",
      HTTP_PROXY: "http://proxy.local:8080",
    };

    const cleanEnv = buildSubprocessEnv("user@example.com", dirtyEnv);
    expect(cleanEnv.AGY_ACCOUNT).toBe("user@example.com");
    expect(cleanEnv.PATH).toBe("/bin:/usr/bin");
    expect(cleanEnv.HTTP_PROXY).toBe("http://proxy.local:8080");

    // Strictly excludes non-whitelisted secrets
    expect(cleanEnv.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(cleanEnv.GITHUB_TOKEN).toBeUndefined();
    expect(cleanEnv.RANDOM_UNTRACKED_KEY).toBeUndefined();

    // Verify all keys in cleanEnv belong to the whitelist or AGY_ACCOUNT
    for (const key of Object.keys(cleanEnv)) {
      expect(["AGY_ACCOUNT", ...SUBPROCESS_ENV_WHITELIST]).toContain(key);
    }
  });

  it("redacts secret matches safely", () => {
    expect(redactSecretMatch("short")).toBe("shor*** (len=5)");
    expect(redactSecretMatch("Bearer eyJhbGciOiJIUzI1NiI")).toBe(
      "Bearer e... (len=26)",
    );
  });

  describe("template kind registry and validation", () => {
    it("resolves registered template kinds and their required keys", () => {
      const specDef = resolveTemplateKind("spec");
      expect(specDef.kind).toBe("spec");
      expect(specDef.requiredKeys).toContain("DOC_TITLE");
      expect(specDef.templateId).toBe(
        "1BG3q9RKa760EfSQaB4kLDFm5XLJdZFJmytraOM6u3Mc",
      );

      const partnerDef = resolveTemplateKind("partner-review");
      expect(partnerDef.kind).toBe("partner-review");
      expect(partnerDef.requiredKeys).toContain("PLAYER_HANDLE");

      expect(() => resolveTemplateKind("nonexistent-kind")).toThrow(
        'Unknown template kind "nonexistent-kind"',
      );
    });

    it("lists all registered template kinds", () => {
      const kinds = listTemplateKinds();
      expect(kinds.length).toBe(Object.keys(DOC_TEMPLATE_REGISTRY).length);
      const kindNames = kinds.map((k) => k.kind);
      expect(kindNames).toContain("spec");
      expect(kindNames).toContain("partner-review");
      expect(kindNames).toContain("risk-audit");
      expect(kindNames).toContain("wager-dispute");
      expect(kindNames).toContain("settlement");
    });

    it("validates substitutions against required keys for a kind", () => {
      const validSubstitutions = {
        PLAYER_HANDLE: "MOOSEM",
        AGENT_ID: "118",
        REVIEW_PERIOD: "2026-Q4",
      };
      const checkValid = validateKindSubstitutions(
        "partner-review",
        validSubstitutions,
      );
      expect(checkValid.valid).toBe(true);
      expect(checkValid.missing).toHaveLength(0);

      const invalidSubstitutions = {
        PLAYER_HANDLE: "MOOSEM",
      };
      const checkInvalid = validateKindSubstitutions(
        "partner-review",
        invalidSubstitutions,
      );
      expect(checkInvalid.valid).toBe(false);
      expect(checkInvalid.missing).toContain("AGENT_ID");
      expect(checkInvalid.missing).toContain("REVIEW_PERIOD");
    });
  });
});
