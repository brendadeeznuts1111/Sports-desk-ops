import { fetchWithProxyPolicy } from "../../lib/desk_fetch_proxy.ts";
import { startConnectProxy } from "./connect_proxy.ts";

/**
 * Runs in its own process so the env proxy it sets never leaks into other tests.
 * argv: key, cert and CA paths for two `localhost` TLS targets (fresh pools). Prints JSON.
 */
function setHttpsProxy(value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(Bun.env, "HTTPS_PROXY");
  else Reflect.set(Bun.env, "HTTPS_PROXY", value);
}

const [keyPath, certPath, caPath] = Bun.argv.slice(2);
if (keyPath === undefined || certPath === undefined || caPath === undefined) {
  throw new Error("usage: proxy_keepalive_child.ts <key> <cert> <ca>");
}
const seenPorts: number[] = [];
const key = await Bun.file(keyPath).text();
const cert = await Bun.file(certPath).text();
const serveTarget = () =>
  Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    tls: { key, cert },
    fetch(request, server) {
      seenPorts.push(server.requestIP(request)?.port ?? -1);
      return new Response("ok");
    },
  });
const first = serveTarget();
const second = serveTarget();
const a = `https://localhost:${first.port}`;
const b = `https://localhost:${second.port}`;
const tls = { ca: await Bun.file(caPath).text() };
const proxy = await startConnectProxy();
const connects = (): number =>
  proxy.heads.filter((head) => head.startsWith("CONNECT ")).length;

interface Step {
  readonly newConnects: number;
  readonly viaTunnel: boolean;
}
async function step(run: () => Promise<Response>): Promise<Step> {
  const before = connects();
  await (await run()).text();
  const port = seenPorts.at(-1) ?? -1;
  return {
    newConnects: connects() - before,
    viaTunnel: proxy.tunnelPorts.includes(port),
  };
}

const direct = await step(() => fetch(a, { tls, proxy: false }));
setHttpsProxy(proxy.url);
const envAfterDirect = await step(() => fetch(a, { tls }));
setHttpsProxy(undefined);

await step(() => fetch(b, { tls, proxy: false }));
const explicit = await step(() => fetch(b, { tls, proxy: proxy.url }));
setHttpsProxy(proxy.url);
const envAfterExplicit = await step(() => fetch(b, { tls }));
const directWithEnvSet = await step(() => fetch(b, { tls, proxy: false }));
const policyDefault = await step(() =>
  fetchWithProxyPolicy(
    (input, init) => fetch(input, { ...init, tls }),
    `${b}/policy`,
    {},
    undefined,
  ),
);
setHttpsProxy(undefined);

proxy.close();
first.stop(true);
second.stop(true);
console.log(
  JSON.stringify({
    direct,
    envAfterDirect,
    explicit,
    envAfterExplicit,
    directWithEnvSet,
    policyDefault,
  }),
);
process.exit(0);
