import { expect, test } from "bun:test";

test("CSRF NaN options throw RangeError instead of using defaults", () => {
  expect(() => Bun.CSRF.generate("secret", { expiresIn: Number.NaN })).toThrow(
    RangeError,
  );

  const token = Bun.CSRF.generate("secret", { expiresIn: 60_000 });
  expect(Bun.CSRF.verify(token, { secret: "secret", maxAge: 60_000 })).toBe(
    true,
  );
  expect(() =>
    Bun.CSRF.verify(token, { secret: "secret", maxAge: Number.NaN }),
  ).toThrow(RangeError);
});
