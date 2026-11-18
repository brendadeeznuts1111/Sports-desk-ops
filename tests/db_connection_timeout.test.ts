import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DB_CONNECT_TIMEOUT_SECONDS,
  resolveDbConnectionTimeout,
} from "../lib/db.ts";

describe("resolveDbConnectionTimeout", () => {
  test("defaults to 10 seconds", () => {
    expect(resolveDbConnectionTimeout({}, null)).toBe(
      DEFAULT_DB_CONNECT_TIMEOUT_SECONDS,
    );
  });

  test("honors SPORTSDESK_DB_CONNECT_TIMEOUT", () => {
    expect(
      resolveDbConnectionTimeout({ SPORTSDESK_DB_CONNECT_TIMEOUT: "30" }, null),
    ).toBe(30);
  });

  test("honors PGCONNECT_TIMEOUT", () => {
    expect(resolveDbConnectionTimeout({ PGCONNECT_TIMEOUT: "7" }, null)).toBe(
      7,
    );
  });

  test("repo override wins over PGCONNECT_TIMEOUT", () => {
    expect(
      resolveDbConnectionTimeout(
        { SPORTSDESK_DB_CONNECT_TIMEOUT: "30", PGCONNECT_TIMEOUT: "7" },
        null,
      ),
    ).toBe(30);
  });

  test("explicit URL connect_timeout wins", () => {
    expect(
      resolveDbConnectionTimeout(
        { SPORTSDESK_DB_CONNECT_TIMEOUT: "30", PGCONNECT_TIMEOUT: "7" },
        "3",
      ),
    ).toBe(3);
  });

  test("invalid and non-positive values fall through", () => {
    expect(
      resolveDbConnectionTimeout(
        { SPORTSDESK_DB_CONNECT_TIMEOUT: "zero", PGCONNECT_TIMEOUT: "-1" },
        "0",
      ),
    ).toBe(DEFAULT_DB_CONNECT_TIMEOUT_SECONDS);
    expect(
      resolveDbConnectionTimeout(
        { SPORTSDESK_DB_CONNECT_TIMEOUT: " ", PGCONNECT_TIMEOUT: "2.5" },
        "",
      ),
    ).toBe(2.5);
  });
});
