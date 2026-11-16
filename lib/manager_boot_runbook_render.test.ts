import { describe, expect, test } from "bun:test";

import {
  MANAGER_BOOT_OPERATOR_APPENDIX,
  renderManagerBootRunbookTerminal,
} from "./manager_boot_runbook_render.ts";

describe("manager_boot_runbook_render", () => {
  test("render applies heading and strong hooks", () => {
    const out = renderManagerBootRunbookTerminal(
      "# Title\n\n**gate** wired\n",
      {
        colors: true,
      },
    );
    expect(out).toContain("Title");
    expect(out).toContain("gate");
    expect(out).toContain("\x1b[");
  });

  test("plain mode omits ANSI escapes", () => {
    const out = renderManagerBootRunbookTerminal("# Title\n\n**bold**\n", {
      colors: false,
    });
    expect(out).not.toContain("\x1b[");
    expect(out).toContain("Title");
    expect(out).toContain("bold");
  });

  test("operator appendix documents probe and ingest", () => {
    expect(MANAGER_BOOT_OPERATOR_APPENDIX).toContain("probe:parse-tree");
    expect(MANAGER_BOOT_OPERATOR_APPENDIX).toContain(
      "manager:ingest-hierarchy",
    );
  });

  test("renders encoded OSC-8 hyperlinks for https and local .md paths without spaces breaking file URLs", () => {
    const out = renderManagerBootRunbookTerminal(
      "[utils](https://bun.sh/docs) · [notes](./space%20note.md) · [local](./doc with spaces.md)\n",
      { colors: true },
    );
    expect(out).toContain(
      "\u001b]8;;https://bun.sh/docs\u0007utils\u001b]8;;\u0007",
    );
    expect(out).toContain("file://");
    expect(out).toContain("line=1&column=1");
  });
});
