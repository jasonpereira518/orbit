/**
 * PROBE: what a failed database write looks like by the time it reaches Sentry.
 *
 * Drizzle wraps every failed statement in `DrizzleQueryError("Failed query: <sql>\nparams:
 * <values>")`. This builds that error with realistic (fake) note text as a bound parameter,
 * runs the real `scrubSentryEvent`, and prints what survives. No network, no database.
 *
 * Run: npx tsx privacy/probe-log-scrub.ts
 */
import { DrizzleQueryError } from "drizzle-orm/errors";
import { mkdirSync, writeFileSync } from "node:fs";
import { scrubSentryEvent } from "../src/lib/sentry-scrub";

const note = "Coffee with Priya Raman (priya.raman@example.test, +1 415 555 0134) — she is interviewing at Stripe and asked me not to tell her manager";
const err = new DrizzleQueryError(
  'insert into "memory_chunks" ("user_id", "content") values ($1, $2)',
  ["user_2fakeUserId", note],
  new Error("duplicate key value violates unique constraint")
);

const event = {
  message: err.message,
  exception: { values: [{ type: err.name, value: err.message }] },
  extra: { params: err.params, where: "memory-chunks.write" },
  user: { id: "user_2fakeUserId" },
};
const scrubbed = scrubSentryEvent(structuredClone(event));
const value = scrubbed.exception?.values?.[0]?.value ?? "";
const result = {
  before: event.exception.values[0].value,
  after: value,
  emailRemoved: !value.includes("priya.raman@example.test"),
  phoneRemoved: !value.includes("415 555 0134"),
  nameRemoved: !value.includes("Priya Raman"),
  noteProseRemoved: !value.includes("interviewing at Stripe"),
  nonStringExtraAfter: (scrubbed as typeof event).extra?.params,
};
console.log(JSON.stringify(result, null, 2));
mkdirSync("privacy/out", { recursive: true });
writeFileSync("privacy/out/log-scrub.json", JSON.stringify(result, null, 2));
