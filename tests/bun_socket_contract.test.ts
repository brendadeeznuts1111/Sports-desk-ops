import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("write returns -1 on a closed socket", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  try {
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {}, connectError() {} },
    });
    socket.close();
    expect(socket.write("x")).toBe(-1);
  } finally {
    server.stop(true);
  }
});

test("connectError suppresses unhandled rejection; promise still rejects", async () => {
  let called = false;
  await expect(
    Bun.connect({
      hostname: "127.0.0.1",
      port: 1,
      socket: {
        data() {},
        connectError(_socket, _error) {
          called = true;
        },
      },
    }),
  ).rejects.toBeDefined();
  expect(called).toBe(true);
});

test("binaryType uint8array delivers Uint8Array to the data handler", async () => {
  let resolveData!: (data: unknown) => void;
  const received = new Promise<unknown>((resolve) => {
    resolveData = resolve;
  });
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      binaryType: "uint8array",
      data(_socket, data) {
        resolveData(data);
      },
    },
  });
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });
  try {
    client.write(new Uint8Array([1, 2, 3]));
    const data = await Promise.race([
      received,
      Bun.sleep(1_000).then(() => {
        throw new Error("no socket data within 1s");
      }),
    ]);
    expect(data).toBeInstanceOf(Uint8Array);
  } finally {
    client.close();
    server.stop(true);
  }
});

test("socket.reload swaps handlers through the nested socket option", async () => {
  const events: string[] = [];
  let resolveOld!: () => void;
  let resolveNew!: () => void;
  const oldData = new Promise<void>((resolve) => {
    resolveOld = resolve;
  });
  const newData = new Promise<void>((resolve) => {
    resolveNew = resolve;
  });
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.write("pong");
      },
    },
  });
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: {
      data() {
        events.push("old");
        resolveOld();
      },
    },
  });
  try {
    client.write("one");
    await oldData;
    client.reload({
      socket: {
        data() {
          events.push("new");
          resolveNew();
        },
      },
    });
    client.write("two");
    await Promise.race([
      newData,
      Bun.sleep(1_000).then(() => {
        throw new Error("reloaded socket handler did not receive data");
      }),
    ]);
    expect(events).toEqual(["old", "new"]);
  } finally {
    client.close();
    server.stop(true);
  }
});

test("socket.reload rejects the direct-handler shape on 1.4.4", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });
  try {
    // The docs example passes handlers directly; the pinned 1.4.4 runtime
    // requires the nested `{ socket: ... }` shape.
    expect(() => client.reload({ data() {} } as never)).toThrow(
      /Expected "socket" option/,
    );
  } finally {
    client.close();
    server.stop(true);
  }
});

const OPENSSL = Bun.which("openssl");

test.skipIf(OPENSSL === null)(
  "TLS self-signed without ca opens unauthorized and closes without data",
  async () => {
    const openssl = OPENSSL;
    if (openssl === null) return;
    const dir = mkdtempSync(join(tmpdir(), "bun-tls-contract-"));
    try {
      const certPath = join(dir, "cert.pem");
      const keyPath = join(dir, "key.pem");
      const generated = Bun.spawnSync({
        cmd: [
          openssl,
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(generated.exitCode, generated.stderr.toString()).toBe(0);

      const server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        tls: {
          cert: await Bun.file(certPath).text(),
          key: await Bun.file(keyPath).text(),
        },
        socket: { data() {} },
      });
      const events: string[] = [];
      const client = await Bun.connect({
        hostname: "127.0.0.1",
        port: server.port,
        tls: { servername: "localhost" },
        socket: {
          open(socket) {
            events.push(`open:${socket.authorized}`);
          },
          data() {
            events.push("data");
          },
          error(_socket, error) {
            events.push(`error:${error.message}`);
          },
          close() {
            events.push("close");
          },
        },
      });
      try {
        await Bun.sleep(250);
        expect(events).toContain("open:false");
        expect(events).not.toContain("data");
      } finally {
        client.end();
        server.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
