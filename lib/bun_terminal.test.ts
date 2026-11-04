import { expect, test } from "bun:test";

import {
  BUN_TERMINAL_SPAWN_PTY_EXAMPLE,
  BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE,
  BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL,
  BUN_TERMINAL_SPAWN_PTY_WRITE_PAYLOAD,
  BUN_TERMINAL_V14_BLOG_URL,
  driveBashScript,
  runBlogTerminalWriteHelloExample,
  spawnInPty,
  stripPtyCapture,
} from "./bun_terminal.ts";
import { BUN_TERMINAL_PTY_TEST_NAME } from "./bun_terminal_test_names.ts";
import {
  capabilityDiagnostics,
  hasPty,
} from "../tests/support/capabilities.ts";

if (!hasPty) {
  console.log(
    `[bun_terminal] skipping PTY assertions: ${capabilityDiagnostics.pty.reason}`,
  );
}

const BUN_V14_BLOG_SPAWN_PTY_EXAMPLE_VERBATIM = `const proc = Bun.spawn(["bash"], {
  terminal: {
    cols: 80,
    rows: 24,
    data(term, data) {
      process.stdout.write(data);
    },
  },
});

proc.terminal.write("echo Hello from PTY!\\n");`;

test(BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogUrlAndSpawnSnippetPinned, () => {
  expect(BUN_TERMINAL_V14_BLOG_URL).toBe(
    "https://bun.com/blog/bun-v1.4#bun-terminal",
  );
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toBe(
    BUN_V14_BLOG_SPAWN_PTY_EXAMPLE_VERBATIM,
  );
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).not.toContain("terminal:const proc");
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE.match(/Bun\.spawn/g)?.length).toBe(1);
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("cols: 80");
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("rows: 24");
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain("data(term, data)");
  expect(BUN_TERMINAL_SPAWN_PTY_EXAMPLE).toContain(
    'proc.terminal.write("echo Hello from PTY!\\n")',
  );
  expect(BUN_TERMINAL_SPAWN_PTY_WRITE_PAYLOAD).toBe("echo Hello from PTY!\n");
});

const BUN_V14_BLOG_TERMINAL_CAPABILITIES_URL_VERBATIM =
  "https://bun.com/blog/bun-v1.4#bun-terminal:~:text=Pass%20terminal%20to%20Bun.spawn%2C%20write%20input%2C%20resize%2C%20and%20read%20the%20colored%20output.%20It%20works%20on%20Linux%2C%20macOS%2C%20and%20Windows.%20%2325415%20%2329522";

test(BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogCapabilitiesShipNote, () => {
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL).toBe(
    BUN_V14_BLOG_TERMINAL_CAPABILITIES_URL_VERBATIM,
  );
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL).toContain("25415");
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_URL).toContain("29522");
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE).toContain(
    "Pass terminal to Bun.spawn",
  );
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE).toContain("resize");
  expect(BUN_TERMINAL_V14_BLOG_CAPABILITIES_SHIP_NOTE).toContain(
    "colored output",
  );
});

test.skipIf(!hasPty || Bun.which("bash") === null)(
  BUN_TERMINAL_PTY_TEST_NAME.meta.v14BlogSpawnExampleRunnable,
  async () => {
    const result = await runBlogTerminalWriteHelloExample();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Hello from PTY");
  },
);

test.skipIf(!hasPty)(
  BUN_TERMINAL_PTY_TEST_NAME.spawn.childReportsIsTty,
  async () => {
    const result = await spawnInPty([
      process.execPath,
      "-e",
      "console.log(process.stdout.isTTY)",
    ]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toBe("true");
  },
);

test(BUN_TERMINAL_PTY_TEST_NAME.util.stripAnsiSgr, () => {
  expect(stripPtyCapture("\x1b[31mhi\x1b[0m")).toBe("hi");
});

test.skipIf(!hasPty || Bun.which("bash") === null)(
  BUN_TERMINAL_PTY_TEST_NAME.spawn.driveBashEchoCapture,
  async () => {
    const result = await driveBashScript(["echo pty-helper", "exit"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("pty-helper");
  },
);

test.skipIf(!hasPty || Bun.which("bash") === null)(
  BUN_TERMINAL_PTY_TEST_NAME.spawn.terminalWriteResizeColored,
  async () => {
    let raw = "";
    const proc = Bun.spawn(["bash"], {
      terminal: {
        cols: 10,
        rows: 5,
        data(_terminal, data) {
          raw += data;
        },
      },
    });
    proc.terminal!.resize(100, 30);
    proc.terminal!.write("echo $COLUMNS $LINES\nexit\n");
    const code = await proc.exited;
    proc.terminal?.close();
    expect(code).toBe(0);
    expect(raw).toMatch(/100/);
    expect(raw).toMatch(/\s30/);

    let colorRaw = "";
    const colorProc = Bun.spawn(
      ["bash", "-lc", 'printf "\\033[31mred\\033[0m\\n"'],
      {
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, data) {
            colorRaw += data;
          },
        },
      },
    );
    const colorCode = await colorProc.exited;
    colorProc.terminal?.close();
    expect(colorCode).toBe(0);
    expect(colorRaw).toContain("\x1b[31m");
    expect(stripPtyCapture(colorRaw)).toContain("red");
  },
);
