// @ts-check
/**
 * Stryker mutation testing for the Code Mode profile tools.
 *
 * Mutates the query/getProfile implementation and the QuickJS bridge that hosts it. The suite
 * must keep the aggregate score at or above `break` or the gate fails.
 *
 *   bunx stryker run
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  // Explicit path: the isolated linker does not expose the plugin to Stryker's own resolution
  // root, and the loader resolves relative paths against the project cwd.
  plugins: ["./node_modules/@hughescr/stryker-bun-runner/dist/index.js"],
  testRunner: "bun",
  mutate: ["lib/profile_query_tools.ts", "lib/quickjs_code_mode.ts"],
  testFiles: [
    "tests/code_mode/profile_query.unit.test.ts",
    "tests/code_mode/profile_query.property.test.ts",
    "tests/code_mode/quickjs_guest.test.ts",
    "tests/code_mode/profile_query.parser.test.ts",
    "tests/code_mode/profile_query.synthetic.test.ts",
    "tests/code_mode/profile_query.differential.test.ts",
    "tests/code_mode/quickjs_marshal.test.ts",
    "tests/code_mode/oracle.arguments.test.ts",
  ],
  coverageAnalysis: "perTest",
  thresholds: { high: 80, low: 60, break: 60 },
  reporters: ["clear-text", "html", "json", "progress"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  inPlace: true,
  timeoutMS: 30_000,
  bun: { timeout: 120_000 },
};
