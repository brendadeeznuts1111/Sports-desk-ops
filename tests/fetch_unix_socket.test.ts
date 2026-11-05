import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `fetch(..., { unix })` keeps a connection alive like TCP, resolves a relative socket path
 * against the current cwd, and honours `tls.ca` for a TLS listener on the socket.
 */

describe("fetch over a unix socket", () => {
  test("reuses one connection for three requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-unix-"));
    const unix = join(dir, "app.sock");
    let opens = 0;
    let requests = 0;
    const server = Bun.listen({
      unix,
      socket: {
        open() {
          opens += 1;
        },
        data(socket) {
          requests += 1;
          socket.write(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok",
          );
        },
      },
    });
    try {
      for (let index = 0; index < 3; index++) {
        const response = await fetch("http://localhost/x", { unix });
        expect(await response.text()).toBe("ok");
      }
      expect(opens).toBe(1);
      expect(requests).toBe(3);
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resolves a relative unix path against the current cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fetch-unix-cwd-"));
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    const serverA = Bun.serve({
      unix: join(dir, "a", "app.sock"),
      fetch: () => new Response("A"),
    });
    const serverB = Bun.serve({
      unix: join(dir, "b", "app.sock"),
      fetch: () => new Response("B"),
    });
    const cwd = process.cwd();
    try {
      // Bun.serve creates the parent directories for an absolute unix path; mkdir is only for
      // the chdir targets.
      const responseA = await fetch("http://localhost/", {
        unix: join(dir, "a", "app.sock"),
      });
      expect(await responseA.text()).toBe("A");

      process.chdir(join(dir, "a"));
      const relativeA = await fetch("http://localhost/", { unix: "app.sock" });
      expect(await relativeA.text()).toBe("A");

      process.chdir(join(dir, "b"));
      const relativeB = await fetch("http://localhost/", { unix: "app.sock" });
      expect(await relativeB.text()).toBe("B");
    } finally {
      process.chdir(cwd);
      serverA.stop(true);
      serverB.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses tls.ca for a TLS listener on a unix socket", async () => {
    if (Bun.which("openssl") === null) return;
    const dir = mkdtempSync(join(tmpdir(), "fetch-unix-tls-"));
    const run = (args: string[]) => {
      const proc = Bun.spawnSync(["openssl", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    };
    try {
      run([
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.crt",
        "-days",
        "2",
        "-subj",
        "/CN=Test CA",
      ]);
      run([
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "server.key",
        "-out",
        "server.csr",
        "-subj",
        "/CN=localhost",
      ]);
      await Bun.write(
        join(dir, "ext.cnf"),
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
      );
      run([
        "x509",
        "-req",
        "-in",
        "server.csr",
        "-CA",
        "ca.crt",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "server.crt",
        "-days",
        "2",
        "-extfile",
        "ext.cnf",
      ]);

      const unix = join(dir, "tls.sock");
      const server = Bun.serve({
        unix,
        tls: {
          key: await Bun.file(join(dir, "server.key")).text(),
          cert: await Bun.file(join(dir, "server.crt")).text(),
        },
        fetch: () => new Response("tls-ok"),
      });
      try {
        const response = await fetch("https://localhost/", {
          unix,
          tls: { ca: await Bun.file(join(dir, "ca.crt")).text() },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("tls-ok");
      } finally {
        server.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
