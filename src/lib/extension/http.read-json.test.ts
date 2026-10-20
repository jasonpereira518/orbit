import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const schema = z.object({ name: z.string().min(1, "must not be empty"), n: z.number().optional() });

function req(body: string | ReadableStream, headers: Record<string, string> = {}) {
  return new Request("http://x.test/", {
    method: "POST",
    body,
    headers,
    // @ts-expect-error node fetch needs duplex for stream bodies
    duplex: "half",
  });
}

async function caught(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  assert.fail("expected rejection");
}

describe("extension readJsonBody (pinned envelope)", () => {
  it("valid JSON", async () => {
    const { readJsonBody } = await import("./http");
    assert.deepEqual(await readJsonBody(req('{"name":"a"}'), schema), { name: "a" });
  });
  it("empty body is invalid JSON (unlike the v1 reader)", async () => {
    const { readJsonBody } = await import("./http");
    const e = await caught(readJsonBody(req(""), schema));
    assert.equal(e.constructor.name, "InvalidRequestError");
    assert.equal(e.message, "Request body is not valid JSON.");
  });
  it("invalid JSON", async () => {
    const { readJsonBody } = await import("./http");
    const e = await caught(readJsonBody(req("{nope"), schema));
    assert.equal(e.constructor.name, "InvalidRequestError");
    assert.equal(e.message, "Request body is not valid JSON.");
  });
  it("too large by content-length", async () => {
    const { readJsonBody } = await import("./http");
    const { MAX_BODY_BYTES } = await import("./contract.schema");
    const e = await caught(readJsonBody(req('{"name":"a"}', { "content-length": String(MAX_BODY_BYTES + 1) }), schema));
    assert.equal(e.constructor.name, "PayloadTooLargeError");
    assert.equal(e.message, "Request body is too large.");
  });
  it("too large when streamed", async () => {
    const { readJsonBody } = await import("./http");
    const { MAX_BODY_BYTES } = await import("./contract.schema");
    const big = "a".repeat(MAX_BODY_BYTES + 10);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"name":"${big}"}`));
        c.close();
      },
    });
    const e = await caught(readJsonBody(req(stream), schema));
    assert.equal(e.constructor.name, "PayloadTooLargeError");
  });
  it("content-type is not checked", async () => {
    const { readJsonBody } = await import("./http");
    assert.deepEqual(await readJsonBody(req('{"name":"a"}', { "content-type": "text/plain" }), schema), { name: "a" });
  });
  it("schema failure prefixes the dotted path", async () => {
    const { readJsonBody } = await import("./http");
    const e = await caught(readJsonBody(req('{"name":""}'), schema));
    assert.equal(e.constructor.name, "InvalidRequestError");
    assert.equal(e.message, "name: must not be empty");
    const root = await caught(readJsonBody(req("[]"), schema));
    assert.equal(root.message, "Invalid input: expected object, received array");
    const rootLevel = await caught(readJsonBody(req('"s"'), z.never()));
    assert.equal(rootLevel.constructor.name, "InvalidRequestError");
  });
});
