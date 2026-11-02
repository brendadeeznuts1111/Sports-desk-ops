import { describe, expect, test } from "bun:test";
import {
  type LoginView,
  MissingF402CredentialsError,
  REQUEST_SUBMIT_EXPRESSION,
  SECRET_NAMES,
  SECRETS_SERVICE,
  loadF402Credentials,
  loginF402,
  resolveF402Credentials,
} from "../scripts/capture/f402_login.ts";

const TEST_CREDS = {
  agentId: "agent-118",
  password: "not-a-real-secret",
};

const SUBMIT_SELECTOR = "button.btn.btn-primary";
const PASS_SELECTOR = 'input[type="password"]';

interface StubOptions {
  /** Whether the pre-fill probe finds a submit button (default true). */
  readonly hasSubmit?: boolean;
  /**
   * Which form the submit expression resolves: the password field's own `form`
   * (default `"document"` keeps the old single-form page shape).
   */
  readonly formSource?: "password" | "document" | "none";
  /** Whether the resolved form has `requestSubmit` (default true). */
  readonly requestSubmit?: boolean;
  /** What `form.checkValidity()` reports (default true). */
  readonly valid?: boolean;
}

/**
 * Records every view call. `passwordGone` flips only on the actions that would
 * really submit a hydrated login: clicking the submit button, a successful
 * `requestSubmit`, or the final Enter key press.
 */
function stubView(
  options: StubOptions = {},
  overrides: Partial<LoginView> = {},
): {
  view: LoginView;
  calls: string[];
} {
  const calls: string[] = [];
  const hasSubmit = options.hasSubmit ?? true;
  const formSource = options.formSource ?? "document";
  const requestSubmit = options.requestSubmit ?? true;
  const valid = options.valid ?? true;
  let passwordGone = false;
  const view: LoginView = {
    async navigate(url) {
      calls.push(`navigate:${url}`);
    },
    async waitForSelector(selector) {
      calls.push(`waitFor:${selector}`);
    },
    async evaluate(expression) {
      if (expression === REQUEST_SUBMIT_EXPRESSION) {
        calls.push("evaluate:requestSubmit");
        // Mirrors the page expression: no form / no requestSubmit → false, and a
        // form that fails constraint validation → false without submitting.
        const submitted = formSource !== "none" && requestSubmit && valid;
        if (submitted) passwordGone = true;
        return submitted;
      }
      if (expression.includes("!== null")) {
        calls.push("evaluate:submit-probe");
        return hasSubmit;
      }
      if (expression.includes("=== null")) {
        calls.push("evaluate:password-check");
        return passwordGone;
      }
      calls.push("evaluate:other");
      return null;
    },
    async fill(selector, text) {
      calls.push(
        `fill:${selector}:${text === TEST_CREDS.password ? "<password>" : text}`,
      );
    },
    async click(selector) {
      calls.push(`click:${selector}`);
      if (selector === SUBMIT_SELECTOR) passwordGone = true;
    },
    async press(key) {
      calls.push(`press:${key}`);
      passwordGone = true;
    },
    ...overrides,
  };
  return { view, calls };
}

const noSleep = async (): Promise<void> => {};

describe("F402 login", () => {
  test("requires explicit credentials object (not process env)", () => {
    expect(() => resolveF402Credentials()).toThrow(MissingF402CredentialsError);
    expect(() =>
      resolveF402Credentials({ agentId: "a", password: " " }),
    ).toThrow(MissingF402CredentialsError);
    const credentials = resolveF402Credentials(TEST_CREDS);
    expect(credentials.agentId).toBe("agent-118");
    expect(credentials.password).toBe(TEST_CREDS.password);
  });

  test("fills both fields, clicks submit, and waits for the form to disappear", async () => {
    const { view, calls } = stubView();
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(TEST_CREDS),
      baseUrl: "https://www.fantasy402.com",
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.loginUrl).toBe("https://www.fantasy402.com/");
    expect(outcome.usedSubmitButton).toBe(true);
    expect(calls).toContain('fill:input[name="customerID"]:agent-118');
    expect(calls).toContain(`fill:${PASS_SELECTOR}:<password>`);
    expect(calls).toContain(`click:${SUBMIT_SELECTOR}`);
    expect(calls).not.toContain("evaluate:requestSubmit");
    expect(calls.some((call) => call.startsWith("press:"))).toBe(false);
  });

  test("without a submit button, uses requestSubmit and never presses Enter", async () => {
    const { view, calls } = stubView({ hasSubmit: false, requestSubmit: true });
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(TEST_CREDS),
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.usedSubmitButton).toBe(false);
    expect(calls).toContain("evaluate:requestSubmit");
    expect(calls.some((call) => call.startsWith("press:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("click:"))).toBe(false);
  });

  test("derives the submit form from the password field, not the first form on the page", async () => {
    const { view, calls } = stubView({
      hasSubmit: false,
      formSource: "password",
      requestSubmit: true,
      valid: true,
    });
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(TEST_CREDS),
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.usedSubmitButton).toBe(false);
    expect(calls).toContain("evaluate:requestSubmit");
    expect(calls.some((call) => call.startsWith("press:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("click:"))).toBe(false);
  });

  test("an invalid form returns false and falls through to click + Enter", async () => {
    const { view, calls } = stubView({
      hasSubmit: false,
      formSource: "password",
      requestSubmit: true,
      valid: false,
    });
    await loginF402(view, {
      credentials: resolveF402Credentials(TEST_CREDS),
      hydrationMs: 0,
      sleep: noSleep,
    });
    const requestSubmitAt = calls.indexOf("evaluate:requestSubmit");
    const clickPass = calls.indexOf(`click:${PASS_SELECTOR}`);
    const pressEnter = calls.indexOf("press:Enter");
    expect(requestSubmitAt).toBeGreaterThanOrEqual(0);
    expect(clickPass).toBeGreaterThan(requestSubmitAt);
    expect(pressEnter).toBeGreaterThan(clickPass);
  });

  test("submit expression resolves the form from the password field and checks validity", () => {
    // Guards the shape: `requestSubmit()` alone reports success even when
    // constraint validation blocked the submission.
    expect(REQUEST_SUBMIT_EXPRESSION).toContain("input[type=password]");
    expect(REQUEST_SUBMIT_EXPRESSION).toContain("p.form");
    expect(REQUEST_SUBMIT_EXPRESSION).toContain("checkValidity");
    expect(REQUEST_SUBMIT_EXPRESSION.indexOf("checkValidity")).toBeLessThan(
      REQUEST_SUBMIT_EXPRESSION.indexOf("f.requestSubmit()"),
    );
  });

  test("falls back to focusing the password field then Enter when requestSubmit is unavailable", async () => {
    const { view, calls } = stubView({
      hasSubmit: false,
      requestSubmit: false,
    });
    const outcome = await loginF402(view, {
      credentials: resolveF402Credentials(TEST_CREDS),
      hydrationMs: 0,
      sleep: noSleep,
    });
    expect(outcome.usedSubmitButton).toBe(false);
    const clickPass = calls.indexOf(`click:${PASS_SELECTOR}`);
    const pressEnter = calls.indexOf("press:Enter");
    expect(clickPass).toBeGreaterThanOrEqual(0);
    expect(pressEnter).toBeGreaterThan(clickPass);
    expect(calls.indexOf("evaluate:requestSubmit")).toBeLessThan(clickPass);
  });

  test("honours selector overrides and reports a stuck form", async () => {
    const { view, calls } = stubView(
      {},
      {
        async evaluate() {
          return false; // form never disappears
        },
      },
    );
    await expect(
      loginF402(view, {
        credentials: resolveF402Credentials(TEST_CREDS),
        env: {
          F402_LOGIN_USER_SELECTOR: "#agent",
          F402_LOGIN_PASS_SELECTOR: "#pin",
        },
        timeoutMs: 5,
        pollMs: 1,
        hydrationMs: 0,
        sleep: noSleep,
      }),
    ).rejects.toThrow("password field still present");
    expect(calls).toContain("fill:#agent:agent-118");
    expect(calls).toContain("fill:#pin:<password>");
  });
});

describe("F402 credential sources", () => {
  const store = new Map<string, string>([
    [`${SECRETS_SERVICE}/${SECRET_NAMES.agentId}`, "keychain-agent"],
    [`${SECRETS_SERVICE}/${SECRET_NAMES.password}`, "keychain-secret"],
  ]);
  const secrets = {
    async get({ service, name }: { service: string; name: string }) {
      return store.get(`${service}/${name}`) ?? null;
    },
  };

  test("keychain wins over env without ALLOW flag", async () => {
    const credentials = await loadF402Credentials(
      {
        F402_AGENT_ID: "from-env",
        F402_PASSWORD: "env-secret",
      },
      secrets,
    );
    expect(credentials.agentId).toBe("keychain-agent");
    expect(credentials.password).toBe("keychain-secret");
  });

  test("deprecated env only when F402_ALLOW_ENV_CREDENTIALS=1", async () => {
    const credentials = await loadF402Credentials(
      {
        F402_ALLOW_ENV_CREDENTIALS: "1",
        F402_AGENT_ID: "from-env",
        F402_PASSWORD: "env-secret",
      },
      null,
    );
    expect(credentials.agentId).toBe("from-env");
    expect(credentials.password).toBe("env-secret");
  });

  test("treats a failing store as absent and never leaks values", async () => {
    await expect(
      loadF402Credentials(
        {},
        {
          async get() {
            throw new Error("keychain locked");
          },
        },
      ),
    ).rejects.toBeInstanceOf(MissingF402CredentialsError);

    await expect(loadF402Credentials({}, null)).rejects.toBeInstanceOf(
      MissingF402CredentialsError,
    );
  });
});
