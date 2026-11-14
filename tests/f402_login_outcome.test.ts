import { describe, expect, test } from "bun:test";
import {
  F402LoginError,
  classifyF402LoginSnapshot,
  isLoginApiUrl,
  portalAuthFromStorageEvaluate,
} from "../lib/f402_login_outcome.ts";

describe("classifyF402LoginSnapshot", () => {
  test("names bad-credentials from the portal alert or a 204 login response", () => {
    expect(
      classifyF402LoginSnapshot({
        hasPassword: true,
        hasToken: false,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: false,
        hasOtp: false,
        dialogMessage: "Wrong User or Password",
      }),
    ).toEqual({ status: "failure", reason: "bad-credentials" });
    expect(
      classifyF402LoginSnapshot({
        hasPassword: true,
        hasToken: false,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: false,
        hasOtp: false,
        loginHttpStatus: 204,
      }),
    ).toEqual({ status: "failure", reason: "bad-credentials" });
  });

  test("names captcha and otp before a token appears", () => {
    expect(
      classifyF402LoginSnapshot({
        hasPassword: true,
        hasToken: false,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: true,
        hasOtp: false,
      }),
    ).toEqual({ status: "failure", reason: "captcha-required" });
    expect(
      classifyF402LoginSnapshot({
        hasPassword: true,
        hasToken: false,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: false,
        hasOtp: true,
      }),
    ).toEqual({ status: "failure", reason: "otp-required" });
  });

  test("succeeds when sessionStorage holds a token or MASTER_ID", () => {
    expect(
      classifyF402LoginSnapshot({
        hasPassword: false,
        hasToken: true,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: false,
        hasOtp: false,
      }),
    ).toEqual({ status: "success" });
  });

  test("stays pending while the password field remains and no signal has arrived", () => {
    expect(
      classifyF402LoginSnapshot({
        hasPassword: true,
        hasToken: false,
        hasCredentials: false,
        hasMasterId: false,
        hasCaptcha: false,
        hasOtp: false,
      }),
    ).toEqual({ status: "pending" });
  });
});

describe("F402LoginError", () => {
  test("puts the named reason in the message", () => {
    const error = new F402LoginError(
      "timeout",
      "sessionStorage token was not set after submit",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("F402LoginError");
    expect(error.reason).toBe("timeout");
    expect(error.message).toBe(
      "F402 login failed: timeout: sessionStorage token was not set after submit",
    );
  });
});

describe("portalAuthFromStorageEvaluate", () => {
  test("builds a Bearer header and prefers MASTER_ID over customerID", () => {
    const auth = portalAuthFromStorageEvaluate({
      token: "portal-code",
      masterId: "MASTER1",
      customerId: "CUST1",
    });
    expect(auth.authorizationHeader).toBe("Bearer portal-code");
    expect(auth.agentId).toBe("MASTER1");
    expect(auth.agentOwner).toBe("MASTER1");
  });

  test("reads a token from credentials JSON and leaves the prefix intact", () => {
    const auth = portalAuthFromStorageEvaluate({
      credentials: JSON.stringify({ code: "jwt-value" }),
      token: "",
    });
    expect(auth.authorizationHeader).toBe("Bearer jwt-value");
    expect(
      portalAuthFromStorageEvaluate({ token: "Bearer already" })
        .authorizationHeader,
    ).toBe("Bearer already");
  });
});

describe("isLoginApiUrl", () => {
  test("matches customer and agent authenticate paths", () => {
    expect(
      isLoginApiUrl(
        "https://www.fantasy402.com/cloud/api/System/authenticateCustomer",
      ),
    ).toBe(true);
    expect(
      isLoginApiUrl(
        "https://www.fantasy402.com/cloud/api/System/authenticateCustomerforAgent",
      ),
    ).toBe(true);
    expect(
      isLoginApiUrl(
        "https://www.fantasy402.com/cloud/api/Manager/getBetTicker",
      ),
    ).toBe(false);
  });
});
