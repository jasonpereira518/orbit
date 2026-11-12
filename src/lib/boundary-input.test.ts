import "../../scripts/smoke/_env";
/**
 * P5.5: the two request bodies that were cast rather than checked.
 *   - `readInternalUserId`: the `{ userId }` body of the internal kick routes.
 *   - `captureMediaFilesSchema`: the photos the phone posts to `/api/scan/[token]/pages`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readInternalUserId } from "@/lib/internal-auth";
import { captureMediaFilesSchema } from "@/lib/capture-media-input";

const post = (body: BodyInit | null) => new Request("http://localhost/api/x", { method: "POST", body });

describe("readInternalUserId", () => {
  it("returns a non-empty string userId", async () => {
    assert.equal(await readInternalUserId(post(JSON.stringify({ userId: "user_1" }))), "user_1");
  });
  it("returns null for anything else", async () => {
    for (const body of [
      JSON.stringify({}),
      JSON.stringify({ userId: "" }),
      JSON.stringify({ userId: 7 }),
      JSON.stringify({ userId: { $ne: null } }),
      JSON.stringify({ userId: ["user_1"] }),
      JSON.stringify(null),
      JSON.stringify("user_1"),
      JSON.stringify([{ userId: "user_1" }]),
      "not json",
      "",
    ]) {
      assert.equal(await readInternalUserId(post(body)), null, body);
    }
  });
  it("returns null with no body at all", async () => {
    assert.equal(await readInternalUserId(post(null)), null);
  });
});

describe("captureMediaFilesSchema", () => {
  const photo = { filename: "page-1.jpg", mimeType: "image/jpeg", base64: "AAAA" };
  it("accepts the photos the scan page sends, and drops unknown keys", () => {
    assert.deepEqual(captureMediaFilesSchema.parse([photo, { ...photo, extra: 1 }]), [photo, photo]);
    assert.deepEqual(captureMediaFilesSchema.parse([]), []);
  });
  it("rejects a file the route would have thrown on", () => {
    for (const bad of [
      [{ ...photo, base64: 5 }],
      [{ filename: "a", mimeType: "image/jpeg" }],
      [{ ...photo, mimeType: null }],
      [null],
      ["AAAA"],
      { 0: photo },
    ]) {
      assert.equal(captureMediaFilesSchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
  });
});
