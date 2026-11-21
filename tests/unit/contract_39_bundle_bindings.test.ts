import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// https://github.com/oven-sh/bun/commit/9eb082ab7fc6addd4307f7ab8c6d4cdff112b745
for (const minify of [false, true]) {
  test(`Contract #39: bundled hoisted bindings preserve values (minify=${minify})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "bun-binding-regression-"));
    try {
      const entry = join(directory, "entry.cjs");
      const output = join(directory, "output.cjs");
      await Bun.write(
        entry,
        `
        function foo() {
          { let exports2 = { value: 17 }; var exports = exports2; }
          return exports;
        }
        function parameter(exports2) {
          var exports;
          return [exports2, exports];
        }
        function caught() {
          try { throw "caught"; } catch (exports2) { var exports = "assigned"; }
          return exports;
        }
        function lexical(exports) {
          let exports2 = "body";
          return [exports, exports2];
        }
        function catchLexical() {
          try { throw "caught"; } catch (exports) {
            let exports2 = "body";
            return [exports, exports2];
          }
        }
        module.exports = { value: foo().value, parameter: parameter("argument"),
          caught: caught(), lexical: lexical("argument"), catchLexical: catchLexical() };
        console.log(JSON.stringify(module.exports));
      `,
      );
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=bun",
          "--format=cjs",
          "--outfile",
          output,
          ...(minify ? ["--minify"] : []),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [buildCode, , errors] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect({ buildCode, errors: buildCode === 0 ? "" : errors }).toEqual({
        buildCode: 0,
        errors: "",
      });
      const execution = Bun.spawn([process.execPath, "--no-env-file", output], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        execution.exited,
        new Response(execution.stdout).text(),
        new Response(execution.stderr).text(),
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(JSON.parse(stdout)).toEqual({
        value: 17,
        parameter: ["argument", null],
        caught: "assigned",
        lexical: ["argument", "body"],
        catchLexical: ["caught", "body"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
