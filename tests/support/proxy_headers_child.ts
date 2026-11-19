import { fetchWithProxyPolicy } from "../../lib/desk_fetch_proxy.ts";
import { startConnectProxy } from "./connect_proxy.ts";

/**
 * One Bun 1.4.4 `proxy.headers` probe per process, so env proxies and pools never leak.
 * argv: case, key, cert and CA paths for a `localhost` TLS target. Prints one JSON line.
 */
const PROXY_HEADER_CASES = [
  "object",
  "invalid-name",
  "invalid-name-with-auth",
  "crlf-value",
  "lf-value",
  "nul-value",
  "del-value",
  "latin1-value",
  "non-latin1-value",
  "padded-value",
  "headers-instance",
  "array",
  "array-invalid-name",
  "duplicate-object",
  "duplicate-headers",
  "duplicate-array",
  "empty-object",
  "empty-headers",
  "empty-array",
  "env-proxy",
  "env-proxy-userinfo",
  "url-userinfo-and-header",
  "policy-invalid-name",
] as const;

export type ProxyHeaderCase = (typeof PROXY_HEADER_CASES)[number];

export interface ProxyHeaderProbe {
  readonly thrown: {
    readonly name: string;
    readonly code: string | null;
    readonly message: string;
  } | null;
  readonly status: number | null;
  readonly connects: number;
  readonly connectHeaders: ReadonlyArray<readonly [string, string]>;
  readonly targetProxyAuthorization: string | null;
}

const AUTH = "Bearer probe-token";

function headersFor(name: ProxyHeaderCase): unknown {
  switch (name) {
    case "object":
      return { "Proxy-Authorization": AUTH, "X-Proxy-Region": "desk" };
    case "invalid-name":
      return { "bad name": "x" };
    case "invalid-name-with-auth":
      return { "Proxy-Authorization": AUTH, "X-Bad\u00e9": "x" };
    case "crlf-value":
      return { "X-Proxy-Region": "a\r\nX-Injected: 1" };
    case "lf-value":
      return { "X-Proxy-Region": "a\nX-Injected: 1" };
    case "nul-value":
      return { "X-Proxy-Region": "a\u0000b" };
    case "del-value":
      return { "X-Proxy-Region": "a\u007fb" };
    case "latin1-value":
      return { "X-Proxy-Region": "caf\u00e9" };
    case "non-latin1-value":
      return { "X-Proxy-Region": "\u20ac" };
    case "padded-value":
      return { "X-Proxy-Region": "  desk  " };
    case "headers-instance":
      return new Headers({ "Proxy-Authorization": AUTH });
    case "array":
      return [["Proxy-Authorization", AUTH]];
    case "array-invalid-name":
      return [["bad name", "x"]];
    case "duplicate-object":
      return {
        "Proxy-Authorization": "Bearer a",
        "proxy-authorization": "Bearer b",
      };
    case "duplicate-headers": {
      const headers = new Headers();
      headers.append("Proxy-Authorization", "Bearer a");
      headers.append("Proxy-Authorization", "Bearer b");
      return headers;
    }
    case "duplicate-array":
      return [
        ["Proxy-Authorization", "Bearer a"],
        ["Proxy-Authorization", "Bearer b"],
      ];
    case "empty-object":
      return {};
    case "empty-headers":
      return new Headers();
    case "empty-array":
      return [];
    default:
      return undefined;
  }
}

function parseConnectHead(head: string): Array<[string, string]> {
  return head
    .split("\r\n")
    .slice(1)
    .filter((line) => line !== "")
    .map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon), line.slice(colon + 1).trim()] as [
        string,
        string,
      ];
    });
}

const [caseName, keyPath, certPath, caPath] = Bun.argv.slice(2);
if (
  caseName === undefined ||
  keyPath === undefined ||
  certPath === undefined ||
  caPath === undefined
) {
  throw new Error("usage: proxy_headers_child.ts <case> <key> <cert> <ca>");
}
const probeCase = caseName as ProxyHeaderCase;
let targetProxyAuthorization: string | null = null;
const target = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  tls: {
    key: await Bun.file(keyPath).text(),
    cert: await Bun.file(certPath).text(),
  },
  fetch(request) {
    targetProxyAuthorization = request.headers.get("proxy-authorization");
    return new Response("ok");
  },
});
const url = `https://localhost:${target.port}/`;
const tls = { ca: await Bun.file(caPath).text() };
const proxy = await startConnectProxy();
const withUserinfo = (): string => {
  const proxyUrl = new URL(proxy.url);
  proxyUrl.username = "u";
  proxyUrl.password = "p";
  return proxyUrl.href;
};

function run(): Promise<Response> {
  switch (probeCase) {
    case "env-proxy":
      Reflect.set(Bun.env, "HTTPS_PROXY", proxy.url);
      return fetch(url, { tls });
    case "env-proxy-userinfo":
      Reflect.set(Bun.env, "HTTPS_PROXY", withUserinfo());
      return fetch(url, { tls });
    case "url-userinfo-and-header":
      return fetch(url, {
        tls,
        proxy: {
          url: withUserinfo(),
          headers: { "Proxy-Authorization": AUTH },
        },
      });
    case "policy-invalid-name":
      return fetchWithProxyPolicy(
        (input, init) => fetch(input, { ...init, tls }),
        url,
        {},
        { url: proxy.url, headers: { "bad name": "x" } },
      );
    default:
      return fetch(url, {
        tls,
        proxy: {
          url: proxy.url,
          headers: headersFor(probeCase) as Record<string, string>,
        },
      });
  }
}

let thrown: ProxyHeaderProbe["thrown"] = null;
let status: number | null = null;
try {
  const response = await run();
  status = response.status;
  await response.text();
} catch (error) {
  const err = error as Error & { code?: unknown };
  thrown = {
    name: err.name,
    code: typeof err.code === "string" ? err.code : null,
    message: err.message,
  };
}
const connectHeads = proxy.heads.filter((head) => head.startsWith("CONNECT "));
const probe: ProxyHeaderProbe = {
  thrown,
  status,
  connects: connectHeads.length,
  connectHeaders:
    connectHeads.length === 0 ? [] : parseConnectHead(connectHeads[0] ?? ""),
  targetProxyAuthorization,
};
proxy.close();
target.stop(true);
console.log(JSON.stringify(probe));
process.exit(0);
