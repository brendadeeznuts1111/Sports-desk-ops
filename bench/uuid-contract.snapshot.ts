// Run from the repository root with its pinned Bun runtime.
import assert from "node:assert/strict";

const pin = (await Bun.file(new URL("../.bun-version", import.meta.url)).text()).trim();
assert.equal(Bun.version, pin, "Use the repository's pinned Bun version");
const name = "www.example.com";
const namespaces = {
  dns: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  url: "6ba7b811-9dad-11d1-80b4-00c04fd430c8",
  oid: "6ba7b812-9dad-11d1-80b4-00c04fd430c8",
  x500: "6ba7b814-9dad-11d1-80b4-00c04fd430c8",
};
const timestampMs = 1700000000000;
type Encoding = "default" | "hex" | "base64" | "base64url" | "buffer";

function observe(version: number, encoding: Encoding, value: string | Buffer) {
  const bytes = Buffer.isBuffer(value) ? value
    : encoding === "base64" || encoding === "base64url" ? Buffer.from(value, encoding)
    : Buffer.from(value.replaceAll("-", ""), "hex");
  assert.equal(bytes.length, 16);
  assert.equal(bytes[6]! >>> 4, version);
  assert.equal(bytes[8]! >>> 6, 2);
  const hex = bytes.toString("hex");
  const canonical = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  if (encoding === "buffer") assert.ok(Buffer.isBuffer(value));
  else if (encoding === "base64" || encoding === "base64url") assert.equal(value, bytes.toString(encoding));
  else assert.equal(value, canonical);
  if (version === 7) assert.equal(bytes.readUIntBE(0, 6), timestampMs);
  return {
    version, variantBits: "10", encoding, jsType: typeof value,
    objectClass: Buffer.isBuffer(value) ? "Buffer" : null,
    stringLength: typeof value === "string" ? value.length : null, byteLength: bytes.length,
    returnedString: typeof value === "string" ? value : null, bytesHex: hex,
  };
}

const namespaceChecks = Object.entries(namespaces).map(([alias, namespaceUUID]) => {
  const namespaceBytes = Buffer.from(namespaceUUID.replaceAll("-", ""), "hex");
  const uuid = Bun.randomUUIDv5(name, alias);
  assert.equal(Bun.randomUUIDv5(name, namespaceUUID), uuid);
  assert.equal(Bun.randomUUIDv5(name, namespaceBytes), uuid);
  assert.equal(Bun.randomUUIDv5(Buffer.from(name), alias), uuid);
  return { alias, namespaceUUID, namespaceBytesHex: namespaceBytes.toString("hex"), uuid };
});
const encodings = ["default", "hex", "base64", "base64url", "buffer"] as const;
const v5 = encodings.map((encoding) => {
  const value = encoding === "buffer" ? Bun.randomUUIDv5(name, "dns", "buffer")
    : encoding === "default" ? Bun.randomUUIDv5(name, "dns") : Bun.randomUUIDv5(name, "dns", encoding);
  return observe(5, encoding, value);
});
assert.equal(new Set(v5.map((row) => row.bytesHex)).size, 1);
assert.equal(v5[0]!.returnedString, "2ed6657d-e927-568b-95e1-2665a8aea6a2");

const v7 = encodings.map((encoding) => {
  const value = encoding === "buffer" ? Bun.randomUUIDv7("buffer", timestampMs)
    : Bun.randomUUIDv7(encoding === "default" ? undefined : encoding, timestampMs);
  return observe(7, encoding, value);
});
const dateSample = observe(7, "default", Bun.randomUUIDv7(undefined, new Date(timestampMs)));
const ordered = [...v7, dateSample].map((row) => row.bytesHex);
assert.equal(new Set(ordered).size, ordered.length);
assert.deepEqual(ordered, [...ordered].sort());

const href = URL.createObjectURL(new Blob(["Hello, World!"], { type: "text/plain" }));
try {
  const url = new URL(href);
  assert.equal(url.protocol, "blob:");
  assert.equal(await (await fetch(url)).text(), "Hello, World!");
  const snapshot = {
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    runtime: { name: "Bun", version: Bun.version, revision: Bun.revision, platform: process.platform, arch: process.arch },
    command: "bun --no-env-file run bench/uuid-contract.snapshot.ts",
    v4: { api: "crypto.randomUUID", sample: observe(4, "default", crypto.randomUUID()) },
    v5: { api: "Bun.randomUUIDv5", name, namespace: "dns", namespaceChecks, encodings: v5 },
    v7: { api: "Bun.randomUUIDv7", timestampMs, timestampISO: new Date(timestampMs).toISOString(),
      encodings: v7, dateSample, distinctIncreasingSamples: ordered.length },
    blobURL: { api: "URL.createObjectURL", scheme: "blob", protocol: url.protocol, href,
      pathname: url.pathname, observedIdentifier: observe(4, "default", url.pathname) },
  };
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  URL.revokeObjectURL(href);
}
