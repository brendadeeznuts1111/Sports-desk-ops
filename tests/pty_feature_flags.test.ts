import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBlogTerminalWriteHelloExample,
  spawnBunInPty,
  stripPtyCapture,
  TerminalSession,
  TerminalTimeoutError,
  TerminalUnauthorizedError,
} from "../lib/bun_terminal.ts";
import { hasPty } from "./support/capabilities.ts";

describe.skipIf(!hasPty)(
  "Bun.Terminal PTY with compile-time feature flags",
  () => {
    test("subprocess sees a real PTY under spawnBunInPty", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-feat-"));
      const script = join(dir, "check_tty.ts");
      try {
        await Bun.write(
          script,
          `
        console.log("IS_TTY=" + process.stdout.isTTY);
        `,
        );

        const result = await spawnBunInPty(script);
        expect(result.code).toBe(0);
        expect(result.out).toContain("IS_TTY=true");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("target: 'dev' activates DEBUG and captures trace output in PTY", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-feat-"));
      const script = join(dir, "app.ts");
      try {
        await Bun.write(
          script,
          `
        import { feature } from "bun:bundle";
        if (feature("DEBUG")) {
          console.log("[PTY_TRACE] Debug mode enabled in PTY session");
        } else {
          console.log("[PTY_CLEAN] Clean production mode in PTY session");
        }
        `,
        );

        const devResult = await spawnBunInPty(script, [], { target: "dev" });
        expect(devResult.code).toBe(0);
        expect(devResult.out).toContain(
          "[PTY_TRACE] Debug mode enabled in PTY session",
        );
        expect(devResult.out).not.toContain("[PTY_CLEAN]");

        const prodResult = await spawnBunInPty(script, [], { target: "prod" });
        expect(prodResult.code).toBe(0);
        expect(prodResult.out).toContain(
          "[PTY_CLEAN] Clean production mode in PTY session",
        );
        expect(prodResult.out).not.toContain("[PTY_TRACE]");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("arbitrary feature subset enables selected flags in PTY", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-feat-"));
      const script = join(dir, "matrix.ts");
      try {
        await Bun.write(
          script,
          `
        import { feature } from "bun:bundle";
        const analytics = feature("ANALYTICS") ? "ANALYTICS_ON" : "ANALYTICS_OFF";
        const debug = feature("DEBUG") ? "DEBUG_ON" : "DEBUG_OFF";
        console.log(\`OUT: \${analytics} | \${debug}\`);
        `,
        );

        const result = await spawnBunInPty(script, [], {
          features: ["ANALYTICS"],
        });
        expect(result.code).toBe(0);
        expect(result.out).toContain("OUT: ANALYTICS_ON | DEBUG_OFF");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("standalone Bun.Terminal instance supports resize, raw mode, and async disposal", async () => {
      let captured = "";
      {
        await using term = new Bun.Terminal({
          cols: 100,
          rows: 30,
          data(_term, chunk) {
            captured += new TextDecoder().decode(chunk);
          },
        });

        // Test resize and raw mode
        term.resize(120, 40);
        term.setRawMode(false);

        const proc = Bun.spawn(
          [process.execPath, "-e", "console.log('PTY_TEST_OK')"],
          {
            terminal: term,
          },
        );

        await proc.exited;
      }

      expect(stripPtyCapture(captured)).toContain("PTY_TEST_OK");
    });

    test("verbatim Bun v1.4 blog example executes cleanly", async () => {
      const result = await runBlogTerminalWriteHelloExample();
      expect(result.code).toBe(0);
      expect(result.out).toContain("Hello from PTY!");
    });

    test("TerminalSession drives interactive bash session and waits for output", async () => {
      await using session = await TerminalSession.start(["bash"]);
      expect(session.active).toBe(true);
      expect(session.pid).toBeGreaterThan(0);

      session.writeLine("echo 'Agent terminal ready'");
      const output = await session.waitForOutput("Agent terminal ready");
      expect(output).toContain("Agent terminal ready");

      session.writeLine("echo 'Step 2 complete'");
      await session.waitForOutput("Step 2 complete");

      session.writeLine("exit 0");
      const exitCode = await session.wait();
      expect(exitCode).toBe(0);
      expect(session.active).toBe(false);
      expect(session.text).toContain("Step 2 complete");
    });

    test("TerminalSession distinguishes proc.exited from PTY stream close", async () => {
      await using session = await TerminalSession.start([
        "bash",
        "-c",
        "exit 42",
      ]);
      const exitCode = await session.wait();
      expect(exitCode).toBe(42);
      // Subprocess exit code reflects bash exit 42
      expect(session.exitCode).toBe(42);
      expect(session.ptyExitCode).toBeNull();

      // PTY stream close is distinct: closing the PTY triggers the exit callback (0 for EOF)
      session.close();
      expect(session.ptyExitCode).toBe(0);
    });

    test("TerminalSession preserves raw ANSI bytes while .text provides plain text", async () => {
      await using session = await TerminalSession.start([
        "bash",
        "-c",
        "echo -e '\\x1b[32mGREEN_SUCCESS\\x1b[0m'; exit 0",
      ]);
      await session.wait();
      expect(session.raw).toContain("\x1b[32mGREEN_SUCCESS\x1b[0m");
      expect(session.text).toContain("GREEN_SUCCESS");
      expect(session.text).not.toContain("\x1b[32m");
    });

    test("TerminalSession enforces authorization policy", async () => {
      const options = {
        authorize: (cmd: readonly string[]) => !cmd.includes("danger"),
      };

      await expect(
        TerminalSession.start(["bash", "-c", "danger"], options),
      ).rejects.toThrow(TerminalUnauthorizedError);
    });

    test("TerminalSession records audit events across lifecycle", async () => {
      await using session = await TerminalSession.start(["bash"]);
      session.resize(100, 30);
      session.writeLine("echo 'audited'; exit 0");
      await session.wait();

      const types = session.auditEvents.map((e) => e.type);
      expect(types).toContain("start");
      expect(types).toContain("resize");
      expect(types).toContain("write");
      expect(types).toContain("exit");
    });

    test("TerminalSession wait times out and stops process", async () => {
      await using session = await TerminalSession.start(["sleep", "10"]);
      await expect(session.wait(100)).rejects.toThrow(TerminalTimeoutError);
    });

    test("TerminalSession.startBun runs with compile-time feature flags under PTY", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pty-session-feat-"));
      const script = join(dir, "agent_tui.ts");
      try {
        await Bun.write(
          script,
          `
        import { feature } from "bun:bundle";
        if (feature("DEBUG")) {
          console.log("[AGENT] Interactive debug session online");
        } else {
          console.log("[AGENT] Production session online");
        }
        `,
        );

        await using devSession = await TerminalSession.startBun(script, [], {
          target: "dev",
        });
        const devExit = await devSession.wait();
        expect(devExit).toBe(0);
        expect(devSession.text).toContain(
          "[AGENT] Interactive debug session online",
        );

        await using prodSession = await TerminalSession.startBun(script, [], {
          target: "prod",
        });
        const prodExit = await prodSession.wait();
        expect(prodExit).toBe(0);
        expect(prodSession.text).toContain("[AGENT] Production session online");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
