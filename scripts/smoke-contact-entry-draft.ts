import assert from "node:assert/strict";
import { test } from "node:test";
import { contactEntryDraftKey, readContactEntryDraft, saveContactEntryDraft } from "../src/lib/contact-entry-draft";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test("manual entry survives navigation without crossing account or entry context", () => {
  const storage = memoryStorage();
  const key = contactEntryDraftKey("account:a", "new");
  const form = { fullName: "Alex", notes: "Met at an event", relationshipScore: 4, strengthRated: true };
  saveContactEntryDraft(storage, key, form);
  assert.deepEqual(readContactEntryDraft(storage, key, { fullName: "", notes: "", relationshipScore: 2, strengthRated: false }), form);
  assert.equal(readContactEntryDraft(storage, contactEntryDraftKey("account:b", "new"), form), null);
  assert.equal(readContactEntryDraft(storage, contactEntryDraftKey("account:a", "meeting"), form), null);
  assert.notEqual(contactEntryDraftKey("a:b", "c"), contactEntryDraftKey("a", "b:c"));
});

test("stale, future and malformed draft data cannot replace contact fields", () => {
  const storage = memoryStorage();
  const defaults = { fullName: "", relationshipScore: 2 };
  storage.setItem("stale", JSON.stringify({ savedAt: 1, form: { fullName: "Old" } }));
  assert.equal(readContactEntryDraft(storage, "stale", defaults, 2 * 24 * 60 * 60 * 1000), null);
  assert.equal(storage.getItem("stale"), null);
  storage.setItem("future", JSON.stringify({ savedAt: 200, form: { fullName: "Future" } }));
  assert.equal(readContactEntryDraft(storage, "future", defaults, 100), null);
  storage.setItem("invalid", "not json");
  assert.equal(readContactEntryDraft(storage, "invalid", defaults), null);
  storage.setItem("types", JSON.stringify({ savedAt: 100, form: { fullName: 123, relationshipScore: "five", unknown: true } }));
  assert.deepEqual(readContactEntryDraft(storage, "types", defaults, 101), defaults);
});

test("empty entries clear the draft and unavailable storage does not block entry", () => {
  const storage = memoryStorage();
  saveContactEntryDraft(storage, "draft", { fullName: "Alex" });
  saveContactEntryDraft(storage, "draft", { fullName: "", score: 2, strengthRated: false });
  assert.equal(storage.getItem("draft"), null);
  const blocked = { getItem: () => { throw new Error("Storage denied"); }, setItem: () => { throw new Error("Storage full"); }, removeItem: () => { throw new Error("Storage denied"); } };
  assert.equal(readContactEntryDraft(blocked, "draft", { fullName: "" }), null);
  assert.doesNotThrow(() => saveContactEntryDraft(blocked, "draft", { fullName: "Alex" }));
});
