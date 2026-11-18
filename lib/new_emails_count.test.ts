import { describe, expect, test } from "bun:test";
import { projectNewEmailsCount } from "./new_emails_count.ts";

describe("new emails count", () => {
  test("an empty list with COUNT.total=0 is a measured zero", () => {
    expect(
      projectNewEmailsCount({ INFO: { LIST: [], COUNT: { total: 0 } } }),
    ).toMatchObject({
      total: 0,
      listed: 0,
    });
  });

  test("a missing COUNT is null, not zero", () => {
    expect(projectNewEmailsCount({ INFO: { LIST: [] } })).toMatchObject({
      total: null,
      listed: 0,
    });
  });

  test("refuses a response without INFO", () => {
    expect(() => projectNewEmailsCount({})).toThrow("INFO");
  });
});
