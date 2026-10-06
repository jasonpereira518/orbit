/**
 * Email activity sync: what gets recorded, and — mostly — what does not.
 *
 * Orbit knew who you knew and not when you last spoke to them, unless you logged it by hand.
 * So `last_interaction_at` drifted, the dormancy and cadence queues nagged about people you
 * emailed last week, and "waiting on a reply" could only see follow-ups sent from inside the
 * app. A connected mailbox answers all three.
 *
 * It is also the feature with the most ways to be quietly wrong, so most of this file is
 * about restraint:
 *
 *   - It never creates contacts. A mailbox holds every newsletter, receipt and recruiter
 *     blast the user has ever received; a sync that created people would fill the network
 *     with strangers and, on a metered plan, bill for them.
 *   - It stores metadata only — participants, subject, date. Never a body, and deliberately
 *     never the snippet either, which is the first line of the message and the part most
 *     likely to be private. The check below reads the source to make sure no snippet can
 *     reach an interaction, because that is a leak nobody would notice from the UI.
 *   - A fourteen-person email is an announcement, not a conversation, and recording it as a
 *     touch with each recipient would reset the dormancy clock on a room full of people.
 *
 * The provider is injected, so everything except the live OAuth call is exercised here
 * against a fake Gmail.
 *
 * Run: npx tsx scripts/smoke-email-activity.ts
 */
import "./smoke/_env";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactIdentities, contacts, interactions, userSettings } from "../src/db/schema";
import {
  MAX_EMAIL_PARTICIPANTS,
  emailEventsFrom,
  isAutomatedAddress,
  normalizeEmail,
  parseAddressList,
} from "../src/lib/email-activity";
import {
  buildActivityQuery,
  syncEmailActivity,
} from "../src/lib/email-activity-server";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}
function section(name: string) {
  console.log(`\n${name}`);
}

const USER = "smoke-email-activity-user";
const ME = "me@orbit.test";
const SARAH = "sarah@stripe.com";
const STRANGER = "newsletter@somewhere.com";

const header = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "m1",
  threadId: "t1",
  from: `Me <${ME}>`,
  to: `Sarah Chen <${SARAH}>`,
  cc: "",
  subject: "The write-up you asked for",
  snippet: "Hi Sarah, attaching the one-pager and my bank details…",
  internalDate: Date.now() - 3 * 86_400_000,
  ...over,
});

function pureChecks() {
  section("Reading the headers");

  check(
    "an angled address parses to name and email",
    JSON.stringify(parseAddressList("Ada Lovelace <Ada@X.com>")) ===
      JSON.stringify([{ name: "Ada Lovelace", email: "ada@x.com" }])
  );
  check("a bare address parses", parseAddressList("ada@x.com")[0]?.email === "ada@x.com");
  check("a list splits", parseAddressList("a@x.com, B <b@x.com>").length === 2);
  check("quotes are stripped from the name", parseAddressList('"Ada" <a@x.com>')[0]?.name === "Ada");
  check("junk yields nothing", parseAddressList("not an address").length === 0);
  check("an empty header yields nothing", parseAddressList(null).length === 0);
  check("addresses normalize to lower case", normalizeEmail("  Ada@X.COM ") === "ada@x.com");
  check("a non-address is not an address", normalizeEmail("ada") === null);

  section("Machines are not correspondents");

  for (const local of ["noreply", "no-reply", "notifications", "mailer-daemon", "bounces"]) {
    check(`${local}@ is automated`, isAutomatedAddress(`${local}@x.com`));
  }
  check(
    "a plus tag does not disguise one",
    isAutomatedAddress("noreply+123@x.com"),
    "a tagged no-reply is still a no-reply"
  );
  check(
    "a real person whose name contains one is not",
    !isAutomatedAddress("arnoreply@x.com"),
    "substring matching would swallow real people; this matches the whole local-part"
  );
  check("an ordinary address is not", !isAutomatedAddress(SARAH));

  section("Which messages become activity");

  const selfEmails = new Set([ME]);
  const knownEmails = new Set([SARAH]);
  const run = (h: Record<string, unknown>) =>
    emailEventsFrom({ headers: [h as never], selfEmails, knownEmails });

  const sent = run(header());
  check("a message to a known contact is recorded", sent.length === 1);
  check("as outbound, because the user sent it", sent[0]?.direction === "out");
  check(
    "which is what feeds the waiting-on-a-reply queue",
    sent[0]?.direction === "out",
    "an unknown direction there means 'no evidence', so a synced mailbox would be invisible to it"
  );
  check("dated from the message", sent[0]?.timestamp instanceof Date);
  check(
    "carrying the subject and nothing else",
    sent[0]?.summary === "Sent: The write-up you asked for" && sent[0]?.notes === null,
    `got summary ${JSON.stringify(sent[0]?.summary)}, notes ${JSON.stringify(sent[0]?.notes)}`
  );
  check(
    "the snippet never reaches the event",
    !JSON.stringify(sent[0]).includes("bank details"),
    "the snippet is the first line of the message and is the part most likely to be private"
  );
  check(
    "the external id namespaces the message, not the contact",
    sent[0]?.externalIdBase === "gmail:m1",
    "ingest appends the contact id; doing it here collides two recipients of one message"
  );

  const received = run(header({ from: `Sarah <${SARAH}>`, to: `Me <${ME}>` }));
  check("a message from a contact is inbound", received[0]?.direction === "in");

  section("What is left alone");

  check(
    "a stranger produces nothing",
    run(header({ from: `X <${STRANGER}>`, to: `Me <${ME}>` })).length === 0,
    "this is what stops a mailbox filling the network with newsletters"
  );
  check(
    "a no-reply sender produces nothing",
    run(header({ from: "noreply@stripe.com", to: `Me <${ME}>` })).length === 0
  );
  check(
    "a mass email produces nothing",
    run(
      header({
        to: [
          ...Array.from({ length: MAX_EMAIL_PARTICIPANTS }, (_, i) => `p${i}@x.com`),
          SARAH,
        ].join(", "),
      })
    ).length === 0,
    "an announcement to a room is not a conversation with each person in it"
  );
  check(
    "a message with no date produces nothing",
    run(header({ internalDate: null })).length === 0,
    "an interaction with no timestamp would sort to the epoch and sit at the bottom of every timeline"
  );
  check(
    "mail to yourself produces nothing",
    emailEventsFrom({
      headers: [header({ to: `Me <${ME}>` }) as never],
      selfEmails,
      knownEmails,
    }).length === 0
  );

  section("Cc counts, and counts once");

  const ccd = run(header({ to: "someone@else.com", cc: `Sarah <${SARAH}>` }));
  check("a contact on Cc is a participant", ccd.length === 1);
  const both = run(header({ to: `Sarah <${SARAH}>`, cc: `Sarah <${SARAH}>` }));
  check(
    "on both To and Cc they appear once",
    both[0]?.participants.length === 1,
    `got ${both[0]?.participants.length} — two rows for one message breaks the external-id dedupe`
  );

  section("The provider query");

  const q = buildActivityQuery(new Date("2026-06-01T00:00:00Z"));
  check("anchored on a date", q.includes("after:1780272000"));
  check("chats are not mail", q.includes("-in:chats"));
  check("the bulk categories are dropped", q.includes("-category:promotions"));

  section("No body is ever requested");

  // Read the client rather than trust the comment: `format=metadata` with a named header
  // list is what makes this a metadata-only integration, and a later edit could widen it
  // without anything failing.
  const gmailSrc = readFileSync(join(__dirname, "..", "src/lib/gmail.ts"), "utf8");
  check(
    "headers are fetched with format=metadata",
    gmailSrc.includes("format=metadata"),
    "format=full returns the body"
  );
  check(
    "and only the four headers this needs",
    ["From", "To", "Cc", "Subject"].every((h) => gmailSrc.includes(`metadataHeaders=${h}`))
  );
  const activitySrc = readFileSync(
    join(__dirname, "..", "src/lib/email-activity.ts"),
    "utf8"
  );
  check(
    "the pure module cannot even see a snippet",
    !/snippet/i.test(
      activitySrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    ),
    "outside its comments, nothing in the mapping references a snippet"
  );
}

async function dbChecks() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const [sarah] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Sarah Chen", email: SARAH })
    .returning();
  await db
    .insert(contactIdentities)
    .values({ userId: USER, contactId: sarah.id, kind: "email", value: SARAH })
    .onConflictDoNothing();

  const messages = [
    header({ id: "a1" }),
    header({ id: "a2", from: `Sarah <${SARAH}>`, to: `Me <${ME}>`, subject: "Re: the write-up" }),
    header({ id: "a3", from: `X <${STRANGER}>`, to: `Me <${ME}>`, subject: "Weekly digest" }),
  ];

  const deps = {
    getAccessToken: async () => "fake-token",
    listPage: async () => ({
      messages: messages.map((m) => ({ id: m.id as string, threadId: "t" })),
      nextPageToken: null,
    }),
    fetchHeaders: async () => messages as never,
  };

  section("A pass over a fake mailbox");

  const first = await syncEmailActivity(
    USER,
    { selfEmail: ME, since: new Date(Date.now() - 30 * 86_400_000) },
    deps as never
  );
  check("three messages fetched", first.fetched === 3);
  check("two matched a contact", first.matched === 2, `got ${first.matched}`);
  check("two interactions logged", first.interactionsLogged === 2, `got ${first.interactionsLogged}`);
  check(
    "and no contact was created for the stranger",
    first.contactsCreated === 0,
    "createsContacts is false; a mailbox must never grow the network"
  );

  const rows = await db.query.interactions.findMany({
    where: eq(interactions.userId, USER),
  });
  check("both rows belong to the known contact", rows.every((r) => r.contactId === sarah.id));
  check(
    "direction is recorded on both",
    rows.filter((r) => r.direction === "out").length === 1 &&
      rows.filter((r) => r.direction === "in").length === 1,
    `got ${rows.map((r) => r.direction).join(",")}`
  );
  check(
    "no snippet was stored",
    rows.every((r) => !(r.rawNotes ?? "").includes("bank details")),
    "the fake messages carry a snippet with private-looking content precisely so this can fail"
  );
  check(
    "the subject is kept",
    rows.some((r) => (r.aiSummary ?? "").includes("The write-up you asked for"))
  );

  section("Running it again changes nothing");

  const second = await syncEmailActivity(
    USER,
    { selfEmail: ME, since: new Date(Date.now() - 30 * 86_400_000) },
    deps as never
  );
  const after = await db.query.interactions.findMany({
    where: eq(interactions.userId, USER),
  });
  check(
    "no duplicate interactions",
    after.length === rows.length,
    `${rows.length} before, ${after.length} after — the external id is what stops a re-sync doubling every conversation`
  );
  check("and the pass still reports what it saw", second.fetched === 3);

  section("An empty network short-circuits");

  await db.delete(contacts).where(eq(contacts.userId, USER));
  let called = false;
  const empty = await syncEmailActivity(
    USER,
    { selfEmail: ME, since: new Date() },
    {
      getAccessToken: async () => {
        called = true;
        return "fake";
      },
      listPage: deps.listPage,
      fetchHeaders: deps.fetchHeaders,
    } as never
  );
  check("nothing is logged", empty.interactionsLogged === 0);
  check(
    "and the provider is never called",
    !called,
    "no address in the network can match, so the request would be answered and thrown away"
  );

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
}

async function main() {
  pureChecks();
  await dbChecks();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll email-activity checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
