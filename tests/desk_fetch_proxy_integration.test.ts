import { expect, test } from "bun:test";
import {
  DeskNetworkError,
  DeskTimeoutError,
  fetchWithDeskPolicy,
  R2ProxyConfigError,
  R2ProxyTunnelError,
} from "../lib/desk_fetch_proxy.ts";
import { fetchPortalArtifactBytes } from "../lib/f402_portal_bundle_fetch.ts";
import { createF402ReplayTransport } from "../lib/f402_replay_transport.ts";

const url = "https://origin.invalid/data";
const value = "synthetic-canary";
const proxy = {
  url: "http://proxy.invalid",
  headers: { "Proxy-Authorization": value },
};

test("invalid proxy headers stay typed through both catch boundaries, even if canceled", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response();
  };
  const options = {
    proxy: { ...proxy, headers: { "Proxy-Authorization": value + "\r\n" } },
    fetchImpl,
  };
  const canceled = {
    ...options,
    signal: AbortSignal.abort(new Error("caller stopped")),
  };
  for (const result of [
    await fetchWithDeskPolicy(fetchImpl, url, {}, canceled).catch((e) => e),
    await fetchPortalArtifactBytes(url, canceled).catch((e) => e),
    await fetchWithDeskPolicy(fetchImpl, url, {}, options).catch((e) => e),
    await fetchPortalArtifactBytes(url, options).catch((e) => e),
  ]) {
    expect(result).toBeInstanceOf(R2ProxyConfigError);
    expect(result).toMatchObject({
      code: "ERR_R2_PROXY_CONFIG",
      reason: "header-value-crlf",
      index: 0,
    });
    expect(String(result) + JSON.stringify(result)).not.toContain(value);
    expect(result.cause).toBeUndefined();
  }
  expect(calls).toBe(0);
});

test("runtime proxy-header and tunnel errors survive a concurrent abort", async () => {
  for (const raw of [
    new TypeError("Header 'Proxy-Authorization' has invalid value"),
    Object.assign(new Error("CONNECT refused"), {
      code: "ERR_PROXY_TUNNEL",
      status: 407,
    }),
  ]) {
    const caller = new AbortController();
    const result = await fetchWithDeskPolicy(
      async () => {
        caller.abort();
        throw raw;
      },
      url,
      {},
      { proxy, signal: caller.signal },
    ).catch((e) => e);
    if (raw instanceof TypeError) {
      expect(result).toBeInstanceOf(R2ProxyConfigError);
      expect(result.reason).toBe("runtime");
      expect(result.cause).toBeUndefined();
    } else {
      expect(result).toBeInstanceOf(R2ProxyTunnelError);
      expect(result).toMatchObject({
        code: "ERR_R2_PROXY_TUNNEL",
        status: 407,
      });
    }
  }
});

test("deadline wins when caller aborts before fetch rejection is observed", async () => {
  const caller = new AbortController();
  const result = await fetchWithDeskPolicy(
    async (_, init) => {
      const signal = init.signal!;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            caller.abort(new Error("late cancellation"));
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    url,
    {},
    { signal: caller.signal, timeoutMs: 5 },
  ).catch((e) => e);
  expect(result).toBeInstanceOf(DeskTimeoutError);
  expect(result).toMatchObject({ code: "ERR_DESK_TIMEOUT", ms: 5 });
});

test("portal returns the caller's exact reason even if fetch rejects with AbortError", async () => {
  const reason = new Error("stop");
  const caller = new AbortController();
  const result = await fetchPortalArtifactBytes(url, {
    signal: caller.signal,
    fetchImpl: async () => {
      caller.abort(reason);
      throw new DOMException("aborted", "AbortError");
    },
  }).catch((e) => e);
  expect(result).toBe(reason);
});

test("replay honors either transport or per-call cancellation", async () => {
  for (const source of ["transport", "request"]) {
    const transport = new AbortController();
    const request = new AbortController();
    const reason = new Error(source);
    const replay = await createF402ReplayTransport({
      env: {},
      readSession: () => null,
      signal: transport.signal,
      fetchImpl: async (_, init) => {
        (source === "transport" ? transport : request).abort(reason);
        init.signal?.throwIfAborted();
        return new Response();
      },
    });
    try {
      expect(
        await replay.fetch(url, { signal: request.signal }).catch((e) => e),
      ).toBe(reason);
    } finally {
      await replay.close();
    }
  }
});

test("independent network failures retain their code and cause even during cancellation", async () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", null]) {
    const raw = Object.assign(new TypeError("wire failure"), { code });
    const caller = new AbortController();
    const result = await fetchWithDeskPolicy(
      async () => {
        caller.abort();
        throw raw;
      },
      url,
      {},
      { signal: caller.signal },
    ).catch((e) => e);
    expect(result).toBeInstanceOf(DeskNetworkError);
    expect(result).toMatchObject({ code, transient: code === "ECONNRESET" });
    expect(result.cause).toBe(raw);
  }
});

test("portal classifies TLS from the transport failure, even on a neutral URL", async () => {
  const outcome = await fetchPortalArtifactBytes(url, {
    fetchImpl: async () => {
      throw new TypeError("self signed certificate");
    },
  });
  expect(outcome.kind).toBe("tls_trust");
  const ordinary = await fetchPortalArtifactBytes(url + "/cert", {
    fetchImpl: async () => {
      throw new TypeError("connection refused");
    },
  });
  expect(ordinary.kind).toBe("network");
});
