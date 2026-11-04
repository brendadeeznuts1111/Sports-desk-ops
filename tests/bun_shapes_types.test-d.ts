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
export type CronControllerShape = Bun.CronController;
export type ServerShape = Bun.Server<undefined>;

export type ImportKindShape = Bun.ImportKind;

/** A runtime shape stays usable in a type position too. */
export type FileShape = ReturnType<typeof Bun.file>;

/** Bun.CSRF is declared in types/bun-api.d.ts (not yet in @types/bun). */
export type CsrfGenerateShape = typeof Bun.CSRF.generate;
export type CsrfVerifyShape = typeof Bun.CSRF.verify;
