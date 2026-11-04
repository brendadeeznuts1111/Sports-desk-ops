import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/** Proxy environment belongs to each child, keeping the parent environment immutable. */
describe("Outbound Fetch Proxy Isolation (NO_PROXY Verification)", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeEach(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        return Response.json({
          status: "isolated",
          pathname: new URL(req.url).pathname,
        });
      },
    });
  });

  afterEach(() => server.stop(true));

  async function fetchWithProxyEnvironment(
    environment: Record<string, string | undefined>,
    proxy?: Bun.FetchProxyOption,
  ) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
        const proxy = JSON.parse(Bun.argv[2]);
        try {
          const response = await fetch(Bun.argv[1], {
            signal: AbortSignal.timeout(3000),
            ...(proxy === null ? {} : { proxy }),
          });
          console.log(JSON.stringify({ status: response.status, body: await response.json() }));
        } catch (error) {
          console.log(JSON.stringify({ trapped: true, code: error.code }));
        }
      `,
        `http://127.0.0.1:${server.port}/health`,
        JSON.stringify(proxy ?? null),
      ],
      {
        env: {
          ...Bun.env,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          NO_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
          no_proxy: undefined,
          ...environment,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result: unknown = JSON.parse(stdout);
    return result;
  }

  test("test_loopback_bypasses_proxy_when_no_proxy_configured", async () => {
    const result = await fetchWithProxyEnvironment({
      HTTP_PROXY: "http://127.0.0.1:59999",
      NO_PROXY: "127.0.0.1,localhost,::1",
    });
    expect(result).toMatchObject({
      status: 200,
      body: { status: "isolated", pathname: "/health" },
    });
  });

  test("test_loopback_is_trapped_when_no_proxy_is_missing", async () => {
    const result = await fetchWithProxyEnvironment({
      HTTP_PROXY: "http://127.0.0.1:59999",
    });
    expect(result).toMatchObject({ trapped: true, code: "ECONNREFUSED" });
  });

  test("test_explicit_proxy_false_bypasses_environment_proxy", async () => {
    const result = await fetchWithProxyEnvironment(
      { HTTP_PROXY: "http://127.0.0.1:59999" },
      false,
    );
    expect(result).toMatchObject({
      status: 200,
      body: { status: "isolated", pathname: "/health" },
    });
  });

  test("test_explicit_proxy_respects_no_proxy_by_default", async () => {
    const result = await fetchWithProxyEnvironment(
      { NO_PROXY: "127.0.0.1,localhost,::1" },
      "http://127.0.0.1:59999",
    );
    expect(result).toMatchObject({ status: 200, body: { status: "isolated" } });
  });

  test("test_respect_no_proxy_false_forces_proxy", async () => {
    const result = await fetchWithProxyEnvironment(
      { NO_PROXY: "127.0.0.1,localhost,::1" },
      {
        url: "http://127.0.0.1:59999",
        respectNoProxy: false,
      },
    );
    expect(result).toMatchObject({ trapped: true, code: "ECONNREFUSED" });
  });
});
