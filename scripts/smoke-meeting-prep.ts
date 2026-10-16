/**
 * Before the meeting: company from a guest's email, on-demand guest lookup, notes and
 * due-before items in the meeting context, the due-before prep reason, and talking points.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-meeting-prep.ts
 */
import "./smoke/_env";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { aiResultCache, calendarEvents, calendarSources, contacts, memoryChunks, rateLimitBuckets, reminders } from "../src/db/schema";
import { companyFromEmail, lookUpGuestFor } from "../src/lib/guest-profiles";
import { getMeetingContext } from "../src/lib/meeting-context";
import { prepReasons } from "../src/lib/calendar-reminders";
import {
  generateTalkingPoints,
  heuristicTalkingPoints,
  parseTalkingPoints,
  talkingFacts,
} from "../src/lib/meeting-talking-points";
import type { PersonResearcher } from "../src/lib/web-research";

const USER = "smoke-meeting-prep-user";
const OTHER = "smoke-meeting-prep-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

async function main() {
  // --- company from email (pure) -----------------------------------------------------------
  check("work domain", companyFromEmail("sam@acme.io") === "Acme");
  check("hyphenated domain", companyFromEmail("p@harbor-health.com") === "Harbor Health");
  check("country second-level domain", companyFromEmail("x@mail.acme.co.uk") === "Acme");
  check("subdomain", companyFromEmail("x@eng.stripe.com") === "Stripe");
  check("public mailbox → none", companyFromEmail("someone@gmail.com") === null && companyFromEmail("a@outlook.com") === null);
  check("no domain → none", companyFromEmail("nobody") === null && companyFromEmail(null) === null);

  // --- setup ---------------------------------------------------------------------------
  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(calendarSources).where(eq(calendarSources.userId, u));
    await db.delete(contacts).where(eq(contacts.userId, u));
    await db.delete(aiResultCache).where(eq(aiResultCache.userId, u));
    await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.bucket, `web-research:${u}`));
  }
  const now = Date.now();
  const [priya] = await db
    .insert(contacts)
    .values({ userId: USER, fullName: "Priya Raman", email: "priya@acme.io" })
    .returning();
  const [source] = await db
    .insert(calendarSources)
    .values({ userId: USER, provider: "google", connectionId: randomUUID(), calendarId: "primary" })
    .returning();
  const start = new Date(now + 2 * 3_600_000);
  const [event] = await db
    .insert(calendarEvents)
    .values({
      userId: USER,
      sourceId: source.id,
      providerEventId: "prep-1",
      title: "Pilot sync",
      startAt: start,
      endAt: new Date(start.getTime() + 30 * 60_000),
      agenda: "- Pricing\n- Timeline",
      attendees: [
        { name: "Priya Raman", email: "priya@acme.io", contactId: priya.id },
        { name: "Sam Guest", email: "sam@acme.io", contactId: null },
        { name: "Gmail Person", email: "gp@gmail.com", contactId: null },
      ],
      attendeeCount: 3,
    })
    .returning();

  await db.insert(reminders).values([
    { userId: USER, contactId: priya.id, title: "Send the deck", status: "pending", dueDate: new Date(now + 3_600_000) },
    { userId: USER, contactId: priya.id, title: "Plan the offsite", status: "pending", dueDate: new Date(now + 9 * 86_400_000) },
  ]);
  const chunk = (content: string, daysAgo: number, kind: "interaction" | "brief" = "interaction") => ({
    userId: USER,
    sourceKind: kind,
    sourceId: randomUUID(),
    contactId: priya.id,
    contactIds: [priya.id],
    content,
    contentHash: randomUUID(),
    occurredAt: new Date(now - daysAgo * 86_400_000),
  });
  await db.insert(memoryChunks).values([
    chunk("Older note about the pilot budget", 20),
    chunk("Priya mentioned hiring two engineers for the payments team", 3),
    chunk("Generated brief text that must not show", 1, "brief"),
  ]);

  // --- meeting context -------------------------------------------------------------------------
  const ctx = await getMeetingContext(USER, { eventId: event.id }, new Date(now));
  const p = ctx?.people[0];
  check(
    "due before the meeting is split out",
    JSON.stringify(p?.dueBefore) === JSON.stringify(["Send the deck"]),
    JSON.stringify(p)
  );
  check("…and the later one stays in open", p?.open.includes("Plan the offsite") === true && !p.open.includes("Send the deck"));
  check(
    "notes: newest first, never the generated brief",
    p?.fromNotes[0]?.snippet.startsWith("Priya mentioned hiring") === true &&
      p.fromNotes.length === 2 &&
      !p.fromNotes.some((n) => n.snippet.includes("Generated brief")),
    JSON.stringify(p?.fromNotes)
  );
  const sam = ctx?.notInOrbit.find((g) => g.email === "sam@acme.io");
  check("a guest not in Orbit gets the company from their domain", sam?.company === "Acme" && sam.profile === null);
  check("a gmail guest gets none", ctx?.notInOrbit.find((g) => g.email === "gp@gmail.com")?.company === null);

  // --- prep reason ----------------------------------------------------------------------------
  const reasons = prepReasons(
    [{ contactId: priya.id, name: "Priya Raman" }],
    {
      lastTouch: new Map([[priya.id, new Date(now - 5 * 86_400_000)]]),
      open: new Map([[priya.id, 2]]),
      dueBefore: new Map([[priya.id, "Send the deck"]]),
    },
    new Date(now)
  );
  check(
    "a to-do due before the meeting is the prep reason",
    reasons[0]?.reason === "Due before the meeting: Send the deck",
    JSON.stringify(reasons)
  );

  // --- guest lookup (Find people's research) ----------------------------------------------
  let calls = 0;
  const researcher: PersonResearcher = async (_u, subject) => {
    calls++;
    check(
      "the lookup is the guest's name and their domain's company — never the address or its domain",
      subject.fullName === "Sam Guest" && subject.company === "Acme" && subject.domain === null && !JSON.stringify(subject).includes("@")
    );
    return {
      json: JSON.stringify({
        match: "confident",
        headline: "Head of Partnerships at Acme",
        current: { organization: "Acme", title: "Head of Partnerships" },
        location: null,
        summary: "Runs partnerships at Acme.",
        talkingPoints: [{ text: "Spoke at the Payments Summit last week", url: "https://example.com/talk" }],
        experiences: [],
      }),
      sources: [{ url: "https://www.linkedin.com/in/sam-guest", title: "Sam Guest" }],
    };
  };
  const found = await lookUpGuestFor(USER, event.id, "Sam@Acme.io", { researcher });
  check(
    "a confident lookup is a brief with a key Find people can open",
    found.status === "found" && found.brief.title === "Head of Partnerships" && /^[0-9a-f]{64}$/.test(found.brief.key),
    JSON.stringify(found)
  );
  const again = await lookUpGuestFor(USER, event.id, "sam@acme.io", { researcher });
  check("a second Look up reads the cached brief, with no new search", again.status === "found" && calls === 1);
  check("a gmail guest is not looked up", (await lookUpGuestFor(USER, event.id, "gp@gmail.com", { researcher })).status === "no_anchor");
  check(
    "an address not on the meeting is refused",
    (await lookUpGuestFor(USER, event.id, "ceo@acme.io", { researcher })).status === "not_a_guest"
  );
  check(
    "a known contact is not a guest to look up",
    (await lookUpGuestFor(USER, event.id, "priya@acme.io", { researcher })).status === "not_a_guest"
  );
  check(
    "another user cannot use this meeting",
    (await lookUpGuestFor(OTHER, event.id, "sam@acme.io", { researcher })).status === "not_a_guest"
  );
  const after = await getMeetingContext(USER, { eventId: event.id }, new Date(now));
  const samAfter = after?.notInOrbit.find((g) => g.email === "sam@acme.io");
  check(
    "the context reads the brief back by key, with its talking points",
    samAfter?.profile?.title === "Head of Partnerships" && samAfter.profile.talkingPoints.length === 1,
    JSON.stringify(samAfter)
  );

  // An unsure answer keeps nothing about them.
  await db.delete(aiResultCache).where(eq(aiResultCache.userId, USER));
  const unsure = await lookUpGuestFor(USER, event.id, "sam@acme.io", {
    researcher: async () => ({ json: JSON.stringify({ match: "unsure", headline: "Someone else" }), sources: [] }),
  });
  check("an unsure match is not shown as them", unsure.status === "not_sure");
  check(
    "…and the context shows no brief for them",
    (await getMeetingContext(USER, { eventId: event.id }, new Date(now)))?.notInOrbit.find((g) => g.email === "sam@acme.io")?.profile === null
  );

  // --- talking points --------------------------------------------------------------------------
  const facts = talkingFacts(
    {
      people: ctx!.people,
      lastTime: { day: "2026-10-06", decisions: [], actionItems: ["Share the questionnaire — Priya"] },
      agenda: "- Pricing",
    },
    {
      moves: new Map([[priya.id, "Joined Stripe as PM"]]),
      digests: new Map([[priya.id, { workingOn: "the Series A", openThreads: [{ text: "send the intro to Dana", owedBy: "me" }] }]]),
      goalFit: new Map(),
    }
  );
  const points = heuristicTalkingPoints(facts);
  check(
    "no key: points come from the facts, most pressing first",
    points[0]?.text.includes("Send the deck") === true &&
      points.some((x) => x.text === "You owe Priya: send the intro to Dana") &&
      points.some((x) => x.text.startsWith("Congratulate Priya")) &&
      points.length <= 5,
    JSON.stringify(points)
  );
  const withGuest = talkingFacts(
    {
      people: [],
      lastTime: null,
      agenda: null,
      notInOrbit: [
        {
          name: "Sam Guest",
          email: "sam@acme.io",
          company: "Acme",
          profile: { key: "k", title: null, company: "Acme", headline: null, summary: null, talkingPoints: [{ text: "Spoke at the Payments Summit", url: null }] },
        },
        { name: "Unknown", email: "u@acme.io", company: "Acme", profile: null },
      ],
    },
    { moves: new Map(), digests: new Map(), goalFit: new Map() }
  );
  check(
    "a looked-up guest's findings are facts too, and an un-looked-up guest adds none",
    withGuest.length === 1 && withGuest[0]!.kind === "web" && heuristicTalkingPoints(withGuest)[0]?.text === "Ask Sam about this: Spoke at the Payments Summit",
    JSON.stringify(withGuest)
  );
  const dueKey = facts.find((f) => f.kind === "due")!.key;
  const parsed = parseTalkingPoints(
    {
      points: [
        { text: "Close out the deck", basis: dueKey },
        { text: "Ask about their dog", basis: "f999" },
        { text: "No basis" },
      ],
    },
    facts
  );
  check(
    "a model point without a real fact is dropped",
    parsed.length === 1 && parsed[0]!.basis.includes("Send the deck"),
    JSON.stringify(parsed)
  );

  let prompt = "";
  const viaModel = await generateTalkingPoints(USER, ctx!, {
    canUseAi: async () => true,
    complete: (async (_u: string, input: { user: string }) => {
      prompt = input.user;
      return JSON.stringify({ points: [{ text: "Close out the deck before the call", basis: "f1" }] });
    }) as never,
  });
  check("with a key the model's grounded points are used", viaModel.source === "ai" && viaModel.points.length === 1);
  check(
    "the facts reach the model fenced",
    /FACTS:\n[\s\S]*UNTRUSTED/i.test(prompt) && prompt.includes("Send the deck"),
    prompt.slice(0, 300)
  );
  const noKey = await generateTalkingPoints(USER, ctx!, { canUseAi: async () => false });
  check("without a key it falls back to the facts", noKey.source === "facts" && noKey.points.length > 0);

  if (failures) {
    console.error(`\nsmoke-meeting-prep: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("\nsmoke-meeting-prep: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
