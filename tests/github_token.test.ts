import { describe, expect, test } from "bun:test";

import {
  GITHUB_TOKEN_SECRET,
  GITHUB_USER_URL,
  login,
  readStoredToken,
  replaceToken,
  whoami,
  type GithubFetch,
  type GithubTokenStore,
} from "../lib/github_token.ts";

const GOOD = "ghp_good_token_value";
const BAD = "ghp_bad_token_value";

interface MemoryStore extends GithubTokenStore {
  value: string | null;
  readonly calls: string[];
  readonly persists: (string | undefined)[];
}

function memoryStore(
  initial: string | null = null,
  failGet = false,
): MemoryStore {
  const store: MemoryStore = {
    value: initial,
    calls: [],
    persists: [],
    async get() {
      store.calls.push("get");
      if (failGet) throw new Error("keychain locked");
      return store.value;
    },
    async set(options) {
      store.calls.push("set");
      store.persists.push(options.persist);
      expect(options.service).toBe(GITHUB_TOKEN_SECRET.service);
      expect(options.name).toBe(GITHUB_TOKEN_SECRET.name);
      store.value = options.value;
    },
    async delete() {
      store.calls.push("delete");
      store.value = null;
      return true;
    },
  };
  return store;
}

/** A fake GitHub that accepts only GOOD and records each request. */
function fakeGithub(): { fetchImpl: GithubFetch; seen: Request[] } {
  const seen: Request[] = [];
  const fetchImpl: GithubFetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    return request.headers.get("authorization") === `Bearer ${GOOD}`
      ? Response.json({ login: "octocat" })
      : new Response("Bad credentials", { status: 401 });
  };
  return { fetchImpl, seen };
}

const never = async (): Promise<string | null> => {
  throw new Error("must not ask for a token");
};

describe("whoami", () => {
  test("sends a Bearer token and the headers GitHub requires, and returns the login", async () => {
    const { fetchImpl, seen } = fakeGithub();
    expect(await whoami(GOOD, fetchImpl)).toEqual({
      status: "ok",
      login: "octocat",
    });
    expect(seen[0]!.url).toBe(GITHUB_USER_URL);
    expect(seen[0]!.headers.get("user-agent")).toBe("sportsdesk-ops");
    expect(seen[0]!.headers.get("accept")).toBe("application/vnd.github+json");
  });

  test("401 is unauthorized; other statuses and bad bodies are errors without the token", async () => {
    const { fetchImpl } = fakeGithub();
    expect(await whoami(BAD, fetchImpl)).toEqual({ status: "unauthorized" });

    const serverError: GithubFetch = async () =>
      new Response("boom", { status: 503, statusText: "Service Unavailable" });
    expect(await whoami(GOOD, serverError)).toEqual({
      status: "error",
      message: "GitHub answered 503 Service Unavailable",
    });

    const html: GithubFetch = async () => new Response("<html>");
    expect(await whoami(GOOD, html)).toMatchObject({ status: "error" });

    const noLogin: GithubFetch = async () => Response.json({ id: 1 });
    expect(await whoami(GOOD, noLogin)).toEqual({
      status: "error",
      message: "GitHub response had no login",
    });
  });

  test("a network failure reports the error name, never the token", async () => {
    const offline: GithubFetch = async () => {
      throw new TypeError(`connect failed for Bearer ${GOOD}`);
    };
    const result = await whoami(GOOD, offline);
    expect(result).toEqual({
      status: "error",
      message: "GitHub request failed (TypeError)",
    });
    expect(JSON.stringify(result)).not.toContain(GOOD);
  });
});

describe("login", () => {
  test("a stored, valid token is used as is: no prompt, no write", async () => {
    const store = memoryStore(GOOD);
    const { fetchImpl } = fakeGithub();
    expect(await login({ store, readNewToken: never, fetchImpl })).toEqual({
      status: "ok",
      login: "octocat",
      source: "keychain",
    });
    expect(store.calls).toEqual(["get"]);
  });

  test("a missing token is asked for, verified, then stored locally", async () => {
    const store = memoryStore();
    const { fetchImpl } = fakeGithub();
    const result = await login({
      store,
      readNewToken: async () => `  ${GOOD}\n`,
      fetchImpl,
    });
    expect(result).toEqual({ status: "ok", login: "octocat", source: "new" });
    expect(store.value).toBe(GOOD);
    expect(store.calls).toEqual(["get", "set"]);
    expect(store.persists).toEqual(["local"]);
  });

  test("a token GitHub rejects is never stored", async () => {
    const store = memoryStore();
    const { fetchImpl } = fakeGithub();
    const result = await login({
      store,
      readNewToken: async () => BAD,
      fetchImpl,
    });
    expect(result).toEqual({ status: "unauthorized", source: "new" });
    expect(store.value).toBeNull();
    expect(store.calls).toEqual(["get"]);
  });

  test("an empty or absent answer is no-token and writes nothing", async () => {
    for (const answer of [null, "", "  \n"]) {
      const store = memoryStore();
      const result = await login({
        store,
        readNewToken: async () => answer,
        fetchImpl: fakeGithub().fetchImpl,
      });
      expect(result).toEqual({ status: "no-token" });
      expect(store.calls).toEqual(["get"]);
    }
  });

  test("a stored token GitHub rejects is reported, not silently replaced", async () => {
    const store = memoryStore(BAD);
    const result = await login({
      store,
      readNewToken: never,
      fetchImpl: fakeGithub().fetchImpl,
    });
    expect(result).toEqual({ status: "unauthorized", source: "keychain" });
    expect(store.value).toBe(BAD);
  });

  test("a locked keychain is an error: it never prompts or overwrites", async () => {
    const store = memoryStore(GOOD, true);
    const result = await login({
      store,
      readNewToken: never,
      fetchImpl: fakeGithub().fetchImpl,
    });
    expect(result).toEqual({
      status: "error",
      message: "keychain is unavailable or locked",
    });
    expect(store.calls).toEqual(["get"]);
  });

  test("a GitHub outage with a stored token is an error and leaves the entry alone", async () => {
    const store = memoryStore(GOOD);
    const down: GithubFetch = async () => new Response("", { status: 502 });
    const result = await login({ store, readNewToken: never, fetchImpl: down });
    expect(result.status).toBe("error");
    expect(store.value).toBe(GOOD);
  });
});

describe("replaceToken", () => {
  test("a valid token overwrites the stored one", async () => {
    const store = memoryStore(BAD);
    const result = await replaceToken({
      store,
      readNewToken: async () => GOOD,
      fetchImpl: fakeGithub().fetchImpl,
    });
    expect(result).toEqual({ status: "ok", login: "octocat", source: "new" });
    expect(store.value).toBe(GOOD);
  });

  test("a rejected token leaves the old entry in place", async () => {
    const store = memoryStore(GOOD);
    const result = await replaceToken({
      store,
      readNewToken: async () => BAD,
      fetchImpl: fakeGithub().fetchImpl,
    });
    expect(result).toEqual({ status: "unauthorized", source: "new" });
    expect(store.value).toBe(GOOD);
    expect(store.calls).toEqual([]);
  });
});

describe("readStoredToken", () => {
  test("ok, absent and locked are three different answers", async () => {
    expect(await readStoredToken(memoryStore(` ${GOOD} `))).toEqual({
      status: "ok",
      token: GOOD,
    });
    expect(await readStoredToken(memoryStore(null))).toEqual({
      status: "absent",
    });
    expect(await readStoredToken(memoryStore("   "))).toEqual({
      status: "absent",
    });
    expect(await readStoredToken(memoryStore(GOOD, true))).toEqual({
      status: "error",
      message: "keychain is unavailable or locked",
    });
  });
});
