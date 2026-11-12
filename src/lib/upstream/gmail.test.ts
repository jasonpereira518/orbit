import "../../../scripts/smoke/_env";
/**
 * P5.4: the Gmail / Google People schemas. Fixtures are written by hand from the documented
 * response shapes (users.messages.list / get, threads.get, people.connections.list, userinfo);
 * they were not recorded from live traffic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UpstreamShapeError, parseUpstream } from "@/lib/http/parse-response";
import {
  gmailMessageListSchema,
  gmailMessageSchema,
  gmailThreadSchema,
  googlePeoplePageSchema,
  googleUserInfoSchema,
} from "@/lib/upstream/gmail";

const message = {
  id: "m1",
  threadId: "t1",
  snippet: "Hi Ada",
  internalDate: "1760000000000",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Grace <grace@example.com>" },
      { name: "Subject", value: "Hello" },
    ],
    parts: [{ mimeType: "text/plain", body: { size: 3, data: "SGk" } }],
  },
};

describe("Gmail schemas accept documented responses", () => {
  it("userinfo", () => {
    assert.equal(parseUpstream(googleUserInfoSchema, { id: "1", email: "a@b.c", verified_email: true }, "t").email, "a@b.c");
    assert.equal(parseUpstream(googleUserInfoSchema, {}, "t").email, undefined);
  });
  it("message list, with and without a next page", () => {
    const page = parseUpstream(gmailMessageListSchema, { messages: [{ id: "m1", threadId: "t1" }], nextPageToken: "n", resultSizeEstimate: 1 }, "t");
    assert.deepEqual(page.messages, [{ id: "m1", threadId: "t1" }]);
    assert.equal(parseUpstream(gmailMessageListSchema, { resultSizeEstimate: 0 }, "t").messages, undefined);
  });
  it("a message with nested parts, keeping header names and values", () => {
    const m = parseUpstream(gmailMessageSchema, message, "t");
    assert.equal(m.payload?.headers?.[0].name, "From");
    assert.equal(m.payload?.parts?.[0].body?.data, "SGk");
  });
  it("a thread", () => {
    assert.equal(parseUpstream(gmailThreadSchema, { id: "t1", messages: [message, message] }, "t").messages?.length, 2);
  });
  it("a people page", () => {
    const page = parseUpstream(
      googlePeoplePageSchema,
      {
        connections: [
          {
            resourceName: "people/1",
            names: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
            organizations: [{ name: "Analytical Engines", title: "Countess" }],
            emailAddresses: [{ value: "ada@example.com" }],
            photos: [{ url: "https://x/p.jpg", default: true }],
          },
        ],
        nextPageToken: "n",
        totalItems: 1,
      },
      "t"
    );
    assert.equal(page.connections?.[0].names?.[0].displayName, "Ada Lovelace");
  });
});

describe("Gmail schemas on a response that is not the documented shape", () => {
  it("a list that is not a list is an UpstreamShapeError naming the path, not its value", () => {
    assert.throws(
      () => parseUpstream(gmailMessageListSchema, { messages: { id: "sk_live_secret" } }, "Gmail message list"),
      (err: unknown) =>
        err instanceof UpstreamShapeError && err.paths.join() === "messages" && !err.message.includes("sk_live_secret"),
    );
  });
  it("a body that is not an object is a (root) error", () => {
    for (const body of [null, "oops", 5, []]) {
      assert.throws(() => parseUpstream(gmailThreadSchema, body, "t"), UpstreamShapeError);
    }
  });
  it("one malformed entry costs that entry, not the page", () => {
    const page = parseUpstream(googlePeoplePageSchema, { connections: [null, { resourceName: "people/2" }, "x"] }, "t");
    assert.equal(page.connections?.length, 1);
    const msgs = parseUpstream(gmailMessageListSchema, { messages: [{ id: "m1" }, { id: "m2", threadId: "t2" }] }, "t");
    assert.deepEqual(msgs.messages, [{ id: "m2", threadId: "t2" }]);
  });
  it("a header without a name is dropped instead of crashing headerValue", () => {
    const m = parseUpstream(gmailMessageSchema, { payload: { headers: [{ value: "x" }, { name: "From", value: "a" }] } }, "t");
    assert.deepEqual(m.payload?.headers, [{ name: "From", value: "a" }]);
  });
  it("a wrongly typed scalar reads as absent", () => {
    const m = parseUpstream(gmailMessageSchema, { id: 5, snippet: { a: 1 }, internalDate: 7 }, "t");
    assert.equal(m.id, undefined);
    assert.equal(m.snippet, undefined);
    assert.equal(m.internalDate, undefined);
  });
});
