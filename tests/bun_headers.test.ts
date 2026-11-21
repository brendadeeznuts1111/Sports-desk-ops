import { describe, expect, test } from "bun:test";

/**
 * Bun's `Headers` extends the global class with `count`, `getAll()` and `toJSON()`
 * (`Bun.__internal.BunHeadersOverride`). `BunRequest.headers` and `Response.headers` are this type,
 * so route handlers and response builders get them.
 *
 * The 1.4.4 reference says `getAll()` with any name other than `set-cookie` returns an empty array.
 * It throws instead; the test pins the runtime, not the page.
 */
describe("Bun Headers extensions", () => {
  test("it is the global Headers class, not a wrapper", () => {
    const headers = new Headers({ "x-a": "1" });
    expect(headers instanceof Headers).toBe(true);
    expect(typeof headers.count).toBe("number");
    expect(typeof headers.getAll).toBe("function");
    expect(typeof headers.toJSON).toBe("function");
  });

  test("getAll reads every Set-Cookie value", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1");
    headers.append("Set-Cookie", "b=2");
    expect(headers.getAll("set-cookie")).toEqual(["a=1", "b=2"]);
    // get() joins them, which is lossy — that is why getAll exists.
    expect(headers.get("set-cookie")).toBe("a=1, b=2");
  });

  test("getAll throws for other names, despite the documented empty array", () => {
    const headers = new Headers({ "content-type": "text/html" });
    expect(() => headers.getAll("content-type" as "set-cookie")).toThrow(
      'Only "set-cookie" is supported.',
    );
  });

  test("count counts stored values, not distinct names", () => {
    const headers = new Headers();
    headers.set("a", "1");
    headers.append("a", "2");
    // A normal duplicate collapses: one entry, joined value.
    expect(headers.count).toBe(1);
    expect(headers.get("a")).toBe("1, 2");

    headers.append("set-cookie", "x=1");
    headers.append("set-cookie", "y=2");
    // set-cookie is the exception: each value is its own entry, and iteration shows it twice.
    expect(headers.count).toBe(3);
    expect(
      [...headers.keys()].filter((name) => name === "set-cookie"),
    ).toHaveLength(2);
  });

  test("getAll accepts the capitalised name too", () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "x=1");
    headers.append("Set-Cookie", "y=2");
    expect(headers.getAll("Set-Cookie")).toEqual(["x=1", "y=2"]);
  });

  test("toJSON and JSON.stringify match, and insertion order is preserved", () => {
    const headers = new Headers({
      "Content-Type": "text/html",
      "X-Custom": "1",
    });
    headers.append("set-cookie", "a=1");
    headers.append("set-cookie", "b=2");

    expect(headers.count).toBe(4);
    const json = headers.toJSON();
    // Names arrive lowercased. The reference says only well-known names are lowercased, but Headers
    // normalizes at insertion, so a custom "X-Custom" is stored and returned as "x-custom".
    expect(json["content-type"]).toBe("text/html");
    expect(json["x-custom"]).toBe("1");
    expect(Object.keys(json)).not.toContain("X-Custom");
    expect(json["set-cookie"]).toEqual(["a=1", "b=2"]);
    expect(JSON.stringify(headers)).toBe(JSON.stringify(json));

    const ordered = new Headers();
    ordered.append("z", "1");
    ordered.append("a", "2");
    ordered.append("m", "3");
    // The reference says insertion order is not preserved; it is, in this build.
    expect(Object.keys(ordered.toJSON())).toEqual(["z", "a", "m"]);
  });

  test("iteration methods sort non-cookie names, preserve duplicate set-cookie, and Object.fromEntries keeps only the last set-cookie", () => {
    const headers = new Headers([
      ["x-b", "2"],
      ["x-a", "1"],
    ]);
    headers.append("set-cookie", "s1=a");
    headers.append("set-cookie", "s2=b");

    const expectedPairs: [string, string][] = [
      ["x-a", "1"],
      ["x-b", "2"],
      ["set-cookie", "s1=a"],
      ["set-cookie", "s2=b"],
    ];
    expect([...headers]).toEqual(expectedPairs);
    expect([...headers.entries()]).toEqual(expectedPairs);
    expect([...headers.keys()]).toEqual([
      "x-a",
      "x-b",
      "set-cookie",
      "set-cookie",
    ]);
    expect([...headers.values()]).toEqual(["1", "2", "s1=a", "s2=b"]);

    const pairs: [string, string][] = [];
    headers.forEach((value, key) => {
      pairs.push([key, value]);
    });
    expect(pairs).toEqual(expectedPairs);

    expect(Object.fromEntries(headers)).toEqual({
      "x-a": "1",
      "x-b": "2",
      "set-cookie": "s2=b",
    });
    expect(headers.toJSON()["set-cookie"]).toEqual(["s1=a", "s2=b"]);
  });
});
