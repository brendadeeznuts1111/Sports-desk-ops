/**
 * Compile-time half of the shape gate.
 *
 * The five type-only entries in `lib/bun_shapes.ts` have no runtime value
 * (`typeof Bun.X === "undefined"`), so they can only be used in type positions.
 * `tests/bun_shapes_coverage.test.ts` checks that the declaration text exists;
 * this file makes `bun run typecheck` prove the compiler resolves each one, which
 * is what callers actually depend on.
 */
export type FileSinkShape = Bun.FileSink;
export type EnvShape = Bun.Env;
export type FetchProxyOptionShape = Bun.FetchProxyOption;
export type FetchSessionInitShape = Bun.FetchSessionInit;
export type FetchSessionCloseShape = Bun.FetchSession["close"];
export type FetchSessionDisposeShape = Bun.FetchSession[typeof Symbol.dispose];
export type FetchSessionPreconnectForbidden =
  "preconnect" extends keyof Bun.FetchSession ? never : true;
export const verifyNoFetchSessionPreconnect: FetchSessionPreconnectForbidden = true;
export const verifyFetchSessionInitShape: Bun.FetchSessionInit = {
  unix: "/tmp/example.sock",
  tls: { rejectUnauthorized: true },
  keepAlive: { idleTimeout: 30, maxIdleSockets: 8 },
};
export type CronControllerShape = Bun.CronController;
export type ServerShape = Bun.Server<undefined>;

export type ImportShape = Bun.Import;
export type ImportKindShape = Bun.ImportKind;

/**
 * Exhaustive switch: a new Bun.ImportKind member fails `bun check` here, and a removed member
 * fails the case label comparison. This pins the documented 9-member union.
 */
export function describeImportKind(kind: Bun.ImportKind): string {
  switch (kind) {
    case "import-statement":
    case "require-call":
    case "require-resolve":
    case "dynamic-import":
    case "import-rule":
    case "url-token":
    case "internal":
    case "entry-point-run":
    case "entry-point-build":
      return kind;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/** A runtime shape stays usable in a type position too. */
export type FileShape = ReturnType<typeof Bun.file>;
