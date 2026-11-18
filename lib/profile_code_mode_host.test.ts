import { afterEach, describe, expect, test } from "bun:test";
import { attachProfileHostTools } from "../tests/helpers/attachProfileHostTools.ts";
import {
  PROFILE_CODE_MODE_HOST_ENV,
  PROFILE_CODE_MODE_TOOL_NAMES,
  createProfileQueryHostRunner,
} from "./profile_code_mode_host.ts";

describe("profile_code_mode_host", () => {
  const prev = process.env[PROFILE_CODE_MODE_HOST_ENV];

  afterEach(() => {
    if (prev === undefined) delete process.env[PROFILE_CODE_MODE_HOST_ENV];
    else process.env[PROFILE_CODE_MODE_HOST_ENV] = prev;
  });

  test("createProfileQueryHostRunner is gated on env", () => {
    delete process.env[PROFILE_CODE_MODE_HOST_ENV];
    expect(() => createProfileQueryHostRunner()).toThrow(
      PROFILE_CODE_MODE_HOST_ENV,
    );
    process.env[PROFILE_CODE_MODE_HOST_ENV] = "1";
    expect(createProfileQueryHostRunner().listTools().length).toBe(3);
  });

  test("registerProfileCodeModeHostTools is not gated (tests build runners manually)", () => {
    const runner = attachProfileHostTools();
    const dts = runner.generateTypeDeclarations();
    for (const name of PROFILE_CODE_MODE_TOOL_NAMES) {
      expect(runner.getTool(name)?.name).toBe(name);
      expect(dts).toContain(`${name}(`);
    }
  });

  test("zod rejects non-literal includeSentinels", async () => {
    process.env[PROFILE_CODE_MODE_HOST_ENV] = "1";
    const runner = createProfileQueryHostRunner();
    const script = `
      const r = await tools.query_profiles({
        field: "clv",
        includeSentinels: "yes",
      });
      return r.rows.some((row) => row.sentinel);
    `;
    const result = await runner.execute(script);
    expect(result.success).toBe(false);
  });
});
