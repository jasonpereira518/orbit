/**
 * Input extremes against the lib write paths every server action and route funnels into.
 *
 * Each `finding` is a property the current code SHOULD satisfy. A `BUG` line is a
 * confirmed failure: the exact input, what happened, and the function responsible are
 * printed beside it.
 *
 *   npx tsx stress-tests/input-extremes.ts
 */
import { check, errorText, finding, rejects, run, summary } from "./_harness";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, interactions, reminders } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { createContactForUser, logInteractionForUser, updateContactForUser } from "../src/lib/contact-writes";
import { createReminderForUser } from "../src/lib/reminder-writes";
import { createEventForUser } from "../src/lib/events/store";

const USER = "stress-input-extremes";

run(async () => {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.delete(reminders).where(eq(reminders.userId, USER));
  await db.delete(interactions).where(eq(interactions.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const base = await createContactForUser(USER, { fullName: "Baseline Person" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true });
  check("baseline contact can be created", Boolean(base?.id));

  console.log("\nDates handed to `new Date()` without validation...");
  for (const bad of ["not-a-date", "2024-13-45", "99999999999999999", "", "Invalid"]) {
    if (bad === "") continue;
    const r = await rejects(() => createReminderForUser(USER, { title: "t", dueDate: bad }));
    finding(
      "EC-DATE-1",
      `createReminderForUser rejects dueDate=${JSON.stringify(bad)} with a user-facing error, not a RangeError/DB error`,
      r.threw && !/RangeError|Invalid time value|invalid input syntax|toISOString/i.test(errorText(r.error)) ,
      r.threw ? errorText(r.error) : "accepted and stored"
    );
  }
  {
    const r = await rejects(() =>
      logInteractionForUser(USER, { contactId: base.id, rawNotes: "x", interactionDate: "2024-02-30T25:61:00" }, { skipEmbedding: true, skipRevalidate: true })
    );
    check(
      "logInteractionForUser falls back to now() for an invalid interactionDate (does not crash)",
      !r.threw,
      r.threw ? errorText(r.error) : ""
    );
  }
  {
    const r = await rejects(() =>
      createEventForUser(USER, { title: "Ev", startsAt: new Date("garbage") } as never)
    );
    finding(
      "EC-DATE-2",
      "createEventForUser refuses an Invalid Date startsAt (the action does `new Date(input.startsAt)` unchecked)",
      r.threw && !/RangeError|Invalid time value|invalid input syntax|toISOString/i.test(errorText(r.error)),
      r.threw ? errorText(r.error) : "accepted"
    );
  }

  console.log("\nNull bytes and control characters...");
  {
    const r = await rejects(() =>
      createContactForUser(USER, { fullName: "Null\u0000Byte" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true })
    );
    finding(
      "EC-NUL-1",
      "a NUL byte in a contact name is stripped or rejected with a friendly error (Postgres refuses \\u0000 in text)",
      !r.threw || !/0x00|invalid byte|unsupported Unicode|\\u0000|22021/i.test(errorText(r.error)),
      r.threw ? errorText(r.error) : "stored"
    );
  }
  {
    const r = await rejects(() =>
      createReminderForUser(USER, { title: "Call\u0000Them" })
    );
    finding(
      "EC-NUL-2",
      "a NUL byte in a reminder title is stripped or rejected with a friendly error",
      !r.threw || !/0x00|invalid byte|unsupported Unicode|\\u0000|22021/i.test(errorText(r.error)),
      r.threw ? errorText(r.error) : "stored"
    );
  }
  {
    const r = await rejects(() =>
      logInteractionForUser(USER, { contactId: base.id, rawNotes: "note\u0000with nul" }, { skipEmbedding: true, skipRevalidate: true })
    );
    finding(
      "EC-NUL-3",
      "a NUL byte in interaction notes is stripped or rejected with a friendly error",
      !r.threw || !/0x00|invalid byte|unsupported Unicode|\\u0000|22021/i.test(errorText(r.error)),
      r.threw ? errorText(r.error) : "stored"
    );
  }

  console.log("\nUnbounded lengths (schema columns are `text` with no cap)...");
  {
    const huge = "A".repeat(1_000_000);
    const r = await rejects(() => createReminderForUser(USER, { title: huge, description: huge }));
    const row = r.threw ? null : await db.query.reminders.findFirst({ where: eq(reminders.userId, USER), orderBy: (t, { desc }) => [desc(t.createdAt)] });
    finding(
      "EC-LEN-1",
      "reminder title/description are length-capped (1 MB each accepted otherwise)",
      r.threw || (row?.title.length ?? 0) < 10_000,
      r.threw ? errorText(r.error) : `stored title length ${row?.title.length}`
    );
  }
  {
    const huge = "N".repeat(2_000_000);
    const r = await rejects(() =>
      logInteractionForUser(USER, { contactId: base.id, rawNotes: huge, aiSummary: huge, topics: Array.from({ length: 10_000 }, (_, i) => `t${i}`) }, { skipEmbedding: true, skipRevalidate: true })
    );
    finding(
      "EC-LEN-2",
      "interaction rawNotes/aiSummary/topics are length-capped (2 MB notes + 10k topics accepted otherwise)",
      r.threw,
      r.threw ? errorText(r.error) : "stored 2 MB note with 10,000 topics"
    );
  }
  {
    // notes / howMet / keyFacts are outside the strict zod shape in contact-input.ts
    const huge = "H".repeat(1_000_000);
    const r = await rejects(() =>
      createContactForUser(USER, { fullName: "Long Notes", notes: huge, howMet: huge, keyFacts: Array.from({ length: 5_000 }, (_, i) => `fact ${i} ` + "x".repeat(500)) } as never, { skipEmbedding: true, skipRevalidate: true, skipSummary: true })
    );
    finding(
      "EC-LEN-3",
      "contact notes/howMet/keyFacts are length-capped at write (strict schema only checks name/company/title/… )",
      r.threw,
      r.threw ? errorText(r.error) : "stored 1 MB notes + 5,000 keyFacts"
    );
  }

  console.log("\nUnicode: bidi overrides, zero-width, emoji, RTL...");
  {
    const name = "Al‮ecila‬ Smith"; // RLO reverses rendering
    const r = await rejects(() => createContactForUser(USER, { fullName: name, title: "​​​hidden" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    const stored = r.threw ? null : (r as never) ;
    const row = await db.query.contacts.findFirst({ where: sql`${contacts.userId} = ${USER} and ${contacts.fullName} like 'Al%'` });
    finding(
      "EC-UNI-1",
      "bidi override / zero-width characters are stripped from manually created contact fields (sanitizeAgentText only runs for agent/API writes)",
      Boolean(row) && !/[‪-‮​-‏]/.test(`${row?.fullName}${row?.title}`),
      row ? `stored name has bidi=${/[‪-‮]/.test(row.fullName)} title has ZW=${/[​-‏]/.test(row.title ?? "")}` : errorText(r.error)
    );
    void stored;
  }
  {
    const r = await rejects(() => createContactForUser(USER, { fullName: "🚀🚀🚀 מישהו Ünïcødé 名字" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    check("emoji + RTL + CJK name is accepted", !r.threw, r.threw ? errorText(r.error) : "");
  }

  console.log("\nURLs and emails on the strict path...");
  {
    const r = await rejects(() => createContactForUser(USER, { fullName: "JS Site", website: "javascript:alert(document.cookie)" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    const row = await db.query.contacts.findFirst({ where: sql`${contacts.userId} = ${USER} and ${contacts.fullName} = 'JS Site'` });
    finding(
      "EC-URL-1",
      "website refuses non-http(s) schemes on the manual/strict path (strict schema only caps length)",
      r.threw || !row?.website?.startsWith("javascript:"),
      r.threw ? errorText(r.error) : `stored website=${row?.website}`
    );
  }
  {
    const r = await rejects(() => createContactForUser(USER, { fullName: "Odd Email", email: "a@b" }, { skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    check("email a@b handling (zod .email() decides)", true, r.threw ? "rejected: " + errorText(r.error) : "accepted");
  }
  {
    const r = await rejects(() => updateContactForUser(USER, base.id, { linkedinUrl: "https://evil.example/x?u=linkedin.com/in/" } as never, { skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    check("linkedinUrl refuses a non-linkedin host even when the path mentions linkedin.com", r.threw, r.threw ? errorText(r.error) : "accepted");
  }

  console.log("\nClient-controlled write options...");
  {
    // `ContactWriteOptions.entitlements` is accepted straight through the server action's
    // `options` parameter: createContact(input, options) → createContactForUser(userId, input, options)
    const forged = { plan: "max", contactLimit: null, canUseApi: true, canUseMcp: true } as never;
    const r = await rejects(() => createContactForUser(USER, { fullName: "Forged Entitlements" }, { entitlements: forged, skipEmbedding: true, skipRevalidate: true, skipSummary: true }));
    finding(
      "AZ-OPT-1",
      "createContactForUser does not accept caller-supplied `entitlements` (a client can pass `options` to the createContact server action)",
      r.threw,
      r.threw ? errorText(r.error) : "forged entitlements object was used for the headroom check"
    );
  }

  summary();
});
