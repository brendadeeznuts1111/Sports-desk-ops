import { test, expect } from "bun:test";

test("fetch rejects with Malformed_HTTP_Response on bad CONNECT reply", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        // Malformed CONNECT response (not valid HTTP)
        socket.write("THIS IS NOT HTTP\r\n\r\n");
        socket.end();
      },
    },
  });

  const proxyUrl = `http://127.0.0.1:${server.port}`;
  let err: unknown;
  try {
    await fetch("https://example.com/", { proxy: proxyUrl });
  } catch (e) {
    err = e;
  } finally {
    server.stop(true);
  }

  const caughtErr = err instanceof Error ? err : new Error(String(err));
  const code = (err as { code?: unknown })?.code;
  console.log("caught:", caughtErr.name, code, caughtErr.message);
  expect(err).toBeTruthy();
  const text = `${caughtErr.message} ${String(code ?? "")}`;
  expect(text).toMatch(/Malformed|malformed|proxy/i);
});