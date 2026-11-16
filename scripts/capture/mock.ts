/**
 * Deterministic mock transport for tests and CI.
 *
 * Fixtures in `tests/fixtures/captures/` describe an observable request plus a
 * canned response (or `null` for the "response never arrived" negative case).
 * The mock path runs the exact same recorder/redaction/skeleton pipeline as a
 * live capture — it just never opens a socket or a browser. Records produced
 * this way carry `mode: "mock"` and can never upgrade an evidence tier.
 */

import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { canonicalJson, encodeUtf8, isPlainObject, sha256Hex } from "./json.ts";
import {
  assertReadOnly,
  opOperationId,
  opPath,
  type ReadOnlyOp,
} from "./allowlist.ts";
import type {
  CaptureRecord,
  HttpMethod,
  RawHttpRequest,
  RawHttpResponse,
} from "./types.ts";

export const MOCK_PORTAL_HOST = "mock.invalid";
export const MOCK_BASE_URL = `https://${MOCK_PORTAL_HOST}`;

export class MockTransportError extends Error {
  readonly code: "missing-fixture" | "missing-response";
  readonly path: string;

  constructor(
    code: "missing-fixture" | "missing-response",
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "MockTransportError";
    this.code = code;
    this.path = path;
  }
}

export interface MockFixtureResponse {
  status: number;
  contentType: string;
  headers?: Record<string, string>;
  /** Parsed JSON value or raw text; serialized deterministically. */
  body: unknown;
}

export interface MockFixtureRequest {
  contentType: string;
  headers?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
}

export interface MockFixture {
  fixtureVersion: 1;
  operation: {
    path: string;
    method: HttpMethod;
    operationId?: string;
  };
  capturedAt: string;
  request: MockFixtureRequest;
  /** `null` models a wire capture where no response was ever observed. */
  response: MockFixtureResponse | null;
  samples?: number;
}

/** Serialize a fixture body deterministically for hashing. */
export function encodeFixtureBody(
  body: unknown,
  contentType: string,
): Uint8Array {
  if (contentType.includes("json")) return encodeUtf8(canonicalJson(body));
  if (typeof body === "string") return encodeUtf8(body);
  return encodeUtf8(canonicalJson(body));
}

/** Serialize a fixture request form/JSON into the wire body string. */
export function encodeFixtureRequestBody(
  request: MockFixtureRequest,
): string | null {
  if (request.form !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(request.form)) {
      params.set(key, value);
    }
    return params.toString();
  }
  if (request.json !== undefined) return canonicalJson(request.json);
  return null;
}

export function buildMockRequest(fixture: MockFixture): RawHttpRequest {
  const body = encodeFixtureRequestBody(fixture.request);
  return {
    url: `${MOCK_BASE_URL}${fixture.operation.path}`,
    method: fixture.operation.method,
    headers: fixture.request.headers ?? {},
    ...(body === null ? {} : { body }),
    retryable: true,
    direct: true,
  };
}

function failFixture(file: string, field: string, expected: string): never {
  throw new Error(`mock fixture ${file}: ${field} must be ${expected}`);
}

function parseFixture(value: unknown, file: string): MockFixture {
  if (!isPlainObject(value)) failFixture(file, "root", "an object");
  if (value["fixtureVersion"] !== 1) failFixture(file, "fixtureVersion", "1");
  const rawOperation = value["operation"];
  if (!isPlainObject(rawOperation)) failFixture(file, "operation", "an object");
  const path = rawOperation["path"];
  const method = rawOperation["method"];
  if (typeof path !== "string") failFixture(file, "operation.path", "a string");
  if (method !== "GET" && method !== "POST") {
    failFixture(file, "operation.method", "GET or POST");
  }
  assertReadOnly(path);
  const operationId =
    typeof rawOperation["operationId"] === "string"
      ? rawOperation["operationId"]
      : undefined;
  if (typeof value["capturedAt"] !== "string") {
    failFixture(file, "capturedAt", "an ISO date string");
  }
  const rawRequest = value["request"];
  if (!isPlainObject(rawRequest)) failFixture(file, "request", "an object");
  const contentType = rawRequest["contentType"];
  if (typeof contentType !== "string")
    failFixture(file, "request.contentType", "a string");
  const headers: Record<string, string> = {};
  if (rawRequest["headers"] !== undefined) {
    if (!isPlainObject(rawRequest["headers"]))
      failFixture(file, "request.headers", "an object");
    for (const [name, headerValue] of Object.entries(rawRequest["headers"])) {
      if (typeof headerValue !== "string") {
        failFixture(file, `request.headers.${name}`, "a string");
      }
      headers[name] = headerValue;
    }
  }
  const request: MockFixtureRequest = { contentType };
  if (Object.keys(headers).length > 0) request.headers = headers;
  if (rawRequest["form"] !== undefined) {
    if (!isPlainObject(rawRequest["form"]))
      failFixture(file, "request.form", "an object");
    const form: Record<string, string> = {};
    for (const [key, formValue] of Object.entries(rawRequest["form"])) {
      if (typeof formValue !== "string") {
        failFixture(file, `request.form.${key}`, "a string");
      }
      form[key] = formValue;
    }
    request.form = form;
  }
  if (rawRequest["json"] !== undefined) request.json = rawRequest["json"];

  const rawResponse = value["response"];
  let response: MockFixtureResponse | null = null;
  if (rawResponse !== null) {
    if (!isPlainObject(rawResponse))
      failFixture(file, "response", "an object or null");
    const status = rawResponse["status"];
    if (typeof status !== "number" || !Number.isInteger(status)) {
      failFixture(file, "response.status", "an integer");
    }
    const responseContentType = rawResponse["contentType"];
    if (typeof responseContentType !== "string") {
      failFixture(file, "response.contentType", "a string");
    }
    const responseHeaders: Record<string, string> = {};
    if (rawResponse["headers"] !== undefined) {
      if (!isPlainObject(rawResponse["headers"])) {
        failFixture(file, "response.headers", "an object");
      }
      for (const [name, headerValue] of Object.entries(
        rawResponse["headers"],
      )) {
        if (typeof headerValue !== "string") {
          failFixture(file, `response.headers.${name}`, "a string");
        }
        responseHeaders[name] = headerValue;
      }
    }
    if (!("body" in rawResponse))
      failFixture(file, "response.body", "present (may be null)");
    response = {
      status,
      contentType: responseContentType,
      body: rawResponse["body"],
    };
    if (Object.keys(responseHeaders).length > 0) {
      response.headers = responseHeaders;
    }
  }

  const fixture: MockFixture = {
    fixtureVersion: 1,
    operation: { path, method },
    capturedAt: value["capturedAt"],
    request,
    response,
  };
  if (operationId !== undefined) fixture.operation.operationId = operationId;
  if (typeof value["samples"] === "number") {
    if (!Number.isInteger(value["samples"]) || value["samples"] < 1) {
      failFixture(file, "samples", "a positive integer");
    }
    fixture.samples = value["samples"];
  }
  return fixture;
}

/** Load and validate every `*.mock.json` fixture in a directory. */
export async function loadMockFixtures(
  directory: string,
): Promise<MockFixture[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mock.json"))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) {
    throw new Error(`no *.mock.json fixtures found in ${directory}`);
  }
  const fixtures: MockFixture[] = [];
  for (const file of files) {
    const text = await readFile(join(directory, file), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`mock fixture ${file} is not valid JSON`);
    }
    fixtures.push(parseFixture(parsed, file));
  }
  return fixtures;
}

/** Canned-response transport that fails exactly like a missing wire response. */
export class MockTransport {
  readonly kind = "mock" as const;
  private readonly fixtures: Map<string, MockFixture>;

  constructor(fixtures: readonly MockFixture[]) {
    this.fixtures = new Map(
      fixtures.map((fixture) => [
        fixtureKey(fixture.operation.path, fixture.operation.method),
        fixture,
      ]),
    );
  }

  fixtureFor(path: string, method: HttpMethod): MockFixture | undefined {
    return this.fixtures.get(fixtureKey(path, method));
  }

  async fetch(request: RawHttpRequest): Promise<RawHttpResponse> {
    const url = new URL(request.url);
    const fixture = this.fixtures.get(fixtureKey(url.pathname, request.method));
    if (fixture === undefined) {
      throw new MockTransportError(
        "missing-fixture",
        url.pathname,
        `no mock fixture for ${request.method} ${url.pathname}`,
      );
    }
    if (fixture.response === null) {
      throw new MockTransportError(
        "missing-response",
        url.pathname,
        `mock fixture for ${request.method} ${url.pathname} simulates a missing response`,
      );
    }
    const { response } = fixture;
    const bytes = encodeFixtureBody(response.body, response.contentType);
    const headers: Record<string, string> = { ...response.headers };
    headers["content-type"] = response.contentType;
    headers["content-length"] = String(bytes.length);
    return {
      status: response.status,
      headers,
      contentType:
        response.contentType.split(";")[0]?.trim().toLowerCase() ?? "",
      bytes,
    };
  }

  close(): void {
    // No resources to close.
  }
}

function fixtureKey(path: string, method: HttpMethod): string {
  return `${method} ${path}`;
}

export interface BuildRecordsOptions {
  fixtures: readonly MockFixture[];
  /** Subset of ops to build, in allowlist order; defaults to every fixture. */
  ops?: readonly ReadOnlyOp[];
  now?: () => Date;
}

export interface MockCapturePlan {
  op: ReadOnlyOp;
  fixture: MockFixture;
  request: RawHttpRequest;
  requestBodySha256: string;
  responseStatus: number | null;
}

/** Plan the mock run without writing anything (used by `--dry-run`). */
export function planMockCaptures(
  fixtures: readonly MockFixture[],
  ops?: readonly ReadOnlyOp[],
): MockCapturePlan[] {
  const byPath = new Map<string, MockFixture>();
  for (const fixture of fixtures) {
    byPath.set(fixture.operation.path, fixture);
  }
  const ordered: { op: ReadOnlyOp; fixture: MockFixture }[] = [];
  if (ops === undefined) {
    for (const fixture of fixtures) {
      ordered.push({ op: assertReadOnly(fixture.operation.path), fixture });
    }
  } else {
    for (const op of ops) {
      const fixture = byPath.get(opPath(op));
      if (fixture === undefined) {
        throw new MockTransportError(
          "missing-fixture",
          opPath(op),
          `no mock fixture for allowlisted op ${op}`,
        );
      }
      ordered.push({ op, fixture });
    }
  }
  const plans: MockCapturePlan[] = [];
  for (const { op, fixture } of ordered) {
    const request = buildMockRequest(fixture);
    const body = encodeFixtureRequestBody(fixture.request);
    plans.push({
      op,
      fixture,
      request,
      requestBodySha256: sha256Hex(
        body === null ? new Uint8Array(0) : encodeUtf8(body),
      ),
      responseStatus: fixture.response?.status ?? null,
    });
  }
  return plans;
}

/** Ensure every fixture belongs to the allowlist, and none claims a fake op id. */
export function assertFixtureOperations(
  fixtures: readonly MockFixture[],
): void {
  for (const fixture of fixtures) {
    const op = assertReadOnly(fixture.operation.path);
    const expectedPath = opPath(op);
    if (fixture.operation.path !== expectedPath) {
      throw new Error(
        `mock fixture path ${fixture.operation.path} does not match allowlisted path ${expectedPath}`,
      );
    }
    const expectedId = opOperationId(op);
    if (
      fixture.operation.operationId !== undefined &&
      fixture.operation.operationId !== expectedId
    ) {
      throw new Error(
        `mock fixture operationId ${fixture.operation.operationId} does not match ${expectedId}`,
      );
    }
  }
}

/** Small helper so callers can compare a record to the fixture that produced it. */
export function fixtureKeyForRecord(record: CaptureRecord): string {
  return fixtureKey(record.operation.path, record.operation.method);
}
