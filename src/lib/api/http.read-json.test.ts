import "../../../scripts/smoke/_env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";

const schema = z.object({ name: z.string().min(1, "name is required"), n: z.number().optional() });

function req(body: string | ReadableStream | null, headers: Record<string, string> = {}) {
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
    return e as { name: string; code: string; message: string; param?: string };
  }
  assert.fail("expected rejection");
}

describe("api readJson (pinned envelope)", () => {
  it("returns parsed data for valid JSON", async () => {
    const { readJson } = await import("./http");
    assert.deepEqual(await readJson(req('{"name":"a"}'), schema), { name: "a" });
  });
  it("treats an empty body as {} (then schema decides)", async () => {
    const { readJson } = await import("./http");
    const e = await caught(readJson(req(""), schema));
    assert.equal(e.name, "ApiRequestError");
    assert.equal(e.code, "invalid_request");
    assert.equal(e.param, "name");
    assert.deepEqual(await readJson(req(""), z.object({}).passthrough()), {});
  });
  it("invalid JSON", async () => {
    const { readJson } = await import("./http");
    const e = await caught(readJson(req("{nope"), schema));
    assert.equal(e.name, "ApiRequestError");
    assert.equal(e.code, "invalid_request");
    assert.equal(e.message, "Request body is not valid JSON.");
    assert.equal(e.param, undefined);
  });
  it("too large by content-length", async () => {
    const { readJson } = await import("./http");
    const e = await caught(readJson(req('{"name":"a"}', { "content-length": "100" }), schema, 50));
    assert.equal(e.code, "payload_too_large");
    assert.equal(e.message, "Request body is too large.");
  });
  it("too large when streamed (no content-length)", async () => {
    const { readJson } = await import("./http");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"name":"'));
        c.enqueue(new TextEncoder().encode("a".repeat(100) + '"}'));
        c.close();
      },
    });
    const e = await caught(readJson(req(stream), schema, 50));
    assert.equal(e.code, "payload_too_large");
  });
  it("content-type is not checked", async () => {
    const { readJson } = await import("./http");
    assert.deepEqual(await readJson(req('{"name":"a"}', { "content-type": "text/plain" }), schema), { name: "a" });
  });
  it("schema failure carries first issue message and dotted path", async () => {
    const { readJson } = await import("./http");
    const e = await caught(readJson(req('{"name":""}'), schema));
    assert.equal(e.code, "invalid_request");
    assert.equal(e.message, "name is required");
    assert.equal(e.param, "name");
    const e2 = await caught(readJson(req('{"name":"a","n":"x"}'), schema));
    assert.equal(e2.param, "n");
  });
});
