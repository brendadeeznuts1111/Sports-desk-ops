import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The response shapes the server relies on. Timings live in
 * scripts/bench_server.ts: a µs threshold here measures the parallel runner,
 * not Bun.
 */

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("Server response shapes", () => {
  test("Response.json matches JSON.stringify + new Response", async () => {
    const payload = {
      status: "healthy",
      port: 4020,
      runtime: "Bun v1.4.4",
      accounts: Array.from({ length: 25 }, (_, i) => ({
        id: `ACC_${i}`,
        val: i * 100,
        active: i % 2 === 0,
      })),
    };

    const native = Response.json(payload);
    const manual = new Response(JSON.stringify(payload), {
      headers: { "Content-Type": "application/json" },
    });

    expect(native.status).toBe(200);
    expect(native.headers.get("content-type")).toStartWith("application/json");
    expect(await native.text()).toBe(await manual.text());
  });

  test("new Response(Bun.file) is a lazy handle, read when consumed", async () => {
    const root = mkdtempSync(join(tmpdir(), "bench-server-"));
    roots.push(root);
    const filePath = join(root, "page.html");
    await Bun.write(filePath, "<p>at construction</p>");

    const response = new Response(Bun.file(filePath));
    // Construction did not buffer the bytes: the body is whatever is on disk when it is read.
    await Bun.write(filePath, "<p>at consumption, longer</p>");
    expect(await response.text()).toBe("<p>at consumption, longer</p>");

    // A missing file is not an error until the body is consumed.
    expect(
      () => new Response(Bun.file(join(root, "absent.html"))),
    ).not.toThrow();
  });

  test("a Bun.file response serves the dashboard bytes unchanged", async () => {
    const filePath = resolve(
      import.meta.dir,
      "../static/customer-churn-simulation-dashboard.html",
    );
    const response = new Response(Bun.file(filePath));
    expect(await response.bytes()).toEqual(await Bun.file(filePath).bytes());
  });
});
