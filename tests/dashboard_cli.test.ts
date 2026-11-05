import { describe, expect, test } from "bun:test";
import {
  DASHBOARD_COMMANDS,
  helpText,
  parseDashboardInvocation,
  resolveDashboardRuntime,
  type DashboardCommand,
  type DashboardFlags,
} from "../lib/dashboard_cli.ts";

function mustParse(...argv: readonly string[]) {
  const result = parseDashboardInvocation(argv);
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
  return result.value;
}

function mustFail(...argv: readonly string[]) {
  const result = parseDashboardInvocation(argv);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

const baseFlags: DashboardFlags = {
  url: "http://127.0.0.1:4020",
  rows: 25,
  columns: null,
  out: "",
  intervalSeconds: 10,
  color: null,
  light: false,
  help: false,
};

const runtimeInput = {
  stdoutIsTTY: true,
  stdoutColumns: 132,
  env: {},
} as const;

describe("dashboard CLI commands", () => {
  test("no command defaults to ansi and says so", () => {
    const invocation = mustParse();
    expect(invocation.command).toBe("ansi");
    expect(invocation.source).toBe("default");
  });

  test("a positional is the command", () => {
    for (const command of Object.keys(
      DASHBOARD_COMMANDS,
    ) as DashboardCommand[]) {
      const invocation = mustParse(command);
      expect(invocation.command).toBe(command);
      expect(invocation.source).toBe("positional");
    }
  });

  test("legacy --format and --watch resolve into the command layer", () => {
    expect(mustParse("--format", "html").command).toBe("html");
    expect(mustParse("--format", "markdown").source).toBe("legacy");
    const watch = mustParse("--watch", "5");
    expect(watch.command).toBe("watch");
    expect(watch.flags.intervalSeconds).toBe(5);
  });

  test("unknown commands list the alternatives and an example", () => {
    const error = mustFail("htm");
    expect(error).toContain('unknown command "htm"');
    expect(error).toContain("ansi, html, markdown, watch");
    expect(error).toContain("bun run dashboard:view ansi --help");
  });

  test("a command and --format cannot disagree", () => {
    expect(mustFail("html", "--format", "markdown")).toContain("conflicts");
    expect(mustFail("html", "markdown")).toContain("expected one command");
  });
});

describe("dashboard CLI flags", () => {
  test("defaults are only what a flag did not set", () => {
    expect(mustParse("html").flags).toEqual({ ...baseFlags });
  });

  test("numeric flags are range-checked with a corrected invocation", () => {
    expect(mustFail("--rows", "0")).toContain(
      "--rows expects an integer 1..200",
    );
    expect(mustFail("--rows", "many")).toContain('got "many"');
    expect(mustFail("ansi", "--columns", "-1")).toContain("--columns");
    expect(mustFail("watch", "--interval", "0")).toContain("--interval");
    expect(mustParse("ansi", "--columns", "0").flags.columns).toBe(0);
    expect(mustParse("ansi", "--rows", "200").flags.rows).toBe(200);
  });

  test("--out belongs to file commands only", () => {
    expect(mustParse("html", "--out", "x.html").flags.out).toBe("x.html");
    expect(mustParse("markdown", "--out", "x.md").flags.out).toBe("x.md");
    expect(mustFail("ansi", "--out", "x.html")).toContain(
      "--out is not valid for the ansi command",
    );
    expect(mustFail("watch", "--out", "x.html")).toContain(
      "--out is not valid for the watch command",
    );
  });

  test("--interval belongs to watch only; --columns to terminal commands only", () => {
    expect(mustFail("ansi", "--interval", "5")).toContain(
      "--interval is only valid for the watch command",
    );
    expect(mustFail("markdown", "--columns", "80")).toContain(
      "--columns, --light, --color and --no-color only apply to ansi/watch",
    );
  });

  test("colour switches are mutually exclusive", () => {
    expect(mustFail("--color", "--no-color")).toContain("mutually exclusive");
    expect(mustParse("--color").flags.color).toBe(true);
    expect(mustParse("--no-color").flags.color).toBe(false);
  });

  test("--url must be an http(s) URL", () => {
    expect(mustFail("--url", "not a url")).toContain("is not a URL");
    expect(mustFail("--url", "file:///tmp/x")).toContain(
      "must be http or https",
    );
    expect(mustParse("--url", "http://127.0.0.1:4020/").flags.url).toBe(
      "http://127.0.0.1:4020",
    );
    // `${server.url}/api` would be `//api`: the base is stripped so every path joins once.
    expect(mustParse("--url", "http://127.0.0.1:4020///").flags.url).toBe(
      "http://127.0.0.1:4020",
    );
    expect(mustParse("--url", "http://127.0.0.1:4020/desk/").flags.url).toBe(
      "http://127.0.0.1:4020/desk",
    );
  });

  test("--watch 0 no longer means 'render once'", () => {
    expect(mustFail("--watch", "0")).toContain("For a single render");
  });
});

describe("dashboard runtime", () => {
  test("colour is a capability, not a flag default", () => {
    expect(
      resolveDashboardRuntime("ansi", baseFlags, {
        ...runtimeInput,
        stdoutIsTTY: false,
      }).color,
    ).toBe(false);
    expect(resolveDashboardRuntime("ansi", baseFlags, runtimeInput).color).toBe(
      true,
    );
    expect(
      resolveDashboardRuntime("markdown", baseFlags, runtimeInput).color,
    ).toBe(false);
  });

  test("explicit colour wins over the terminal and NO_COLOR", () => {
    expect(
      resolveDashboardRuntime(
        "ansi",
        { ...baseFlags, color: true },
        {
          ...runtimeInput,
          stdoutIsTTY: false,
          env: { NO_COLOR: "1" },
        },
      ).color,
    ).toBe(true);
    expect(
      resolveDashboardRuntime(
        "ansi",
        { ...baseFlags, color: false },
        runtimeInput,
      ).color,
    ).toBe(false);
    expect(
      resolveDashboardRuntime("ansi", baseFlags, {
        ...runtimeInput,
        env: { NO_COLOR: "1" },
      }).color,
    ).toBe(false);
  });

  test("columns come from the flag, then the terminal, then 100", () => {
    expect(
      resolveDashboardRuntime("ansi", baseFlags, runtimeInput).columns,
    ).toBe(132);
    expect(
      resolveDashboardRuntime(
        "ansi",
        { ...baseFlags, columns: 0 },
        runtimeInput,
      ).columns,
    ).toBe(0);
    expect(
      resolveDashboardRuntime("ansi", baseFlags, {
        ...runtimeInput,
        stdoutColumns: undefined,
      }).columns,
    ).toBe(100);
  });

  test("the token is runtime input, never a flag", () => {
    const runtime = resolveDashboardRuntime("ansi", baseFlags, {
      ...runtimeInput,
      env: { SPORTSDESK_ADMIN_TOKEN: "  secret  " },
    });
    expect(runtime.token).toBe("secret");
    expect(mustParse("ansi").flags).not.toHaveProperty("token");
  });
});

describe("dashboard help", () => {
  test("the index lists every command", () => {
    const help = helpText(null);
    for (const command of Object.keys(DASHBOARD_COMMANDS)) {
      expect(help).toContain(command);
    }
    expect(help).toContain(
      "bun run dashboard:view html --out dist/dashboard-view.html",
    );
  });

  test("each command owns its examples and relevant flags", () => {
    expect(helpText("html")).toContain("--out <path>");
    expect(helpText("html")).not.toContain("--interval");
    expect(helpText("watch")).toContain("--interval <seconds>");
    expect(helpText("watch")).not.toContain("--out");
    expect(helpText("markdown")).toContain("markdown | less");
  });
});
