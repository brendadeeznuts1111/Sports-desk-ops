import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A local CA + server certificate for tests that need a trusted TLS listener.
 * Returns null when `openssl` is not installed, so callers can skip instead of failing CI.
 */
export interface TlsFixture {
  readonly dir: string;
  readonly caPath: string;
  readonly keyPath: string;
  readonly certPath: string;
  cleanup(): void;
}

export async function createTlsFixture(
  hostname: string,
): Promise<TlsFixture | null> {
  if (Bun.which("openssl") === null) return null;
  const dir = mkdtempSync(join(tmpdir(), "tls-fixture-"));
  const run = (args: string[]): void => {
    const proc = Bun.spawnSync(["openssl", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(
        `openssl ${args[0] ?? ""} failed: ${proc.stderr.toString()}`,
      );
    }
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
      `/CN=${hostname}`,
    ]);
    await Bun.write(join(dir, "ext.cnf"), `subjectAltName=DNS:${hostname}\n`);
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
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    dir,
    caPath: join(dir, "ca.crt"),
    keyPath: join(dir, "server.key"),
    certPath: join(dir, "server.crt"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
