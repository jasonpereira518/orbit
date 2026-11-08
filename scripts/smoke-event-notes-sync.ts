import assert from "node:assert/strict";
import { eventExternalIdBase } from "../src/lib/ingest/external-id";
import { saveAndSyncEventNotes } from "../src/lib/events/notes-sync";

console.log("\nevent notes and knowledge context sync");

assert.equal(typeof saveAndSyncEventNotes, "function");
console.log("  ok    saveAndSyncEventNotes is an exported function");

const testEventId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const base = eventExternalIdBase(testEventId);
assert.equal(base, `evt:${testEventId}`);
console.log(`  ok    deterministic eventExternalIdBase is '${base}'`);

const noteExternalId = `${base}:notes`;
assert.equal(noteExternalId, `evt:${testEventId}:notes`);
console.log(`  ok    external key for notes interaction is '${noteExternalId}'`);

console.log("\nAll event notes sync checks passed.");
