/**
 * The contact profile's reads were narrowed for row width; this proves each still returns
 * what the wide read returned.
 *
 * 1. Related people. `listRelatedContacts` reads the wide text columns (`notes`, `aiSummary`, `keyFacts`) only
 * for the rows that could need them, instead of for the whole network. That is only allowed
 * if the ranking is EXACTLY what scoring every contact's full text produced, so this runs
 * the previous full-text implementation (kept below as the oracle) and the real one over
 * the same adversarial fixture — mentions split across the corpus join, non-ASCII names,
 * U+0130 and U+212A (the two characters JS lowers to ASCII), LIKE metacharacters in names,
 * non-string jsonb, shared tags, goals on and off — for every contact as the source, and
 * requires byte-identical output.
 *
 * 2. Interaction history. The profile (`getContactForProfile`) loads the newest page of
 * interactions plus whole-history aggregates; every fact the page derives (last touch,
 * has-logged-touch, the 90-day frequency label, the timeline's chip counts) must match the
 * full list `getContact` returns, and `listContactTimelineInteractions` must hand the
 * timeline the rest in the same shape — and nothing for someone else's contact.
 *
 * 3. Triage. `getTriageCandidates` no longer scans `profile_image_url`; the selected rows'
 * avatars must be exactly what `ContactAvatar` drew from the stored value.
 *
 * Run: npx tsx scripts/smoke-contact-profile-reads.ts
 */
import "./smoke/_env";

// `requireUserId()` resolves to "demo-user" only in `isDemoMode()`, which is gated on
// `NODE_ENV === "development"`. @types/node marks `NODE_ENV` read-only; it is writable.
(process.env as Record<string, string>).NODE_ENV = "development";

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts, contactTags, interactions, tags, userGoals } from "../src/db/schema";
import {
  getContact,
  getContactForProfile,
  getTriageCandidates,
  listContactTimelineInteractions,
  listRelatedContacts,
} from "../src/actions/contacts";
import { formatInteractionFrequency } from "../src/lib/closeness";
import { clientContactAvatarUrl } from "../src/lib/contact-avatar-url";
import { isLoggedTouch, latestLoggedTouch } from "../src/lib/interaction-provenance";
import { clientAvatarUrlSql } from "../src/lib/contact-avatar-sql";
import { findRelatedContacts, mentionLikePatterns, type RelatedContact } from "../src/lib/related-contacts";
import { listActiveGoalTextsForUser } from "../src/lib/user-goals";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";

const USER = "demo-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

/** The implementation before the text columns were narrowed, verbatim in what it computes. */
async function legacyListRelatedContacts(contactId: string, limit = 6): Promise<RelatedContact[]> {
  const db = await getDb();
  const goals = await listActiveGoalTextsForUser(USER);
  const narrowRows = await db.query.contacts.findMany({
    where: eq(contacts.userId, USER),
    columns: {
      id: true,
      fullName: true,
      preferredName: true,
      company: true,
      companyId: true,
      school: true,
      howMet: true,
      notes: true,
      aiSummary: true,
      keyFacts: true,
      sharedInterests: true,
      relationshipScore: true,
    },
  });
  if (!narrowRows.some((r) => r.id === contactId)) return [];
  const sourceTagIds = (
    await db
      .select({ tagId: contactTags.tagId })
      .from(contactTags)
      .innerJoin(contacts, eq(contacts.id, contactTags.contactId))
      .where(and(eq(contactTags.contactId, contactId), eq(contacts.userId, USER)))
  ).map((r) => r.tagId);
  const shared = await db
    .select({ contactId: contactTags.contactId })
    .from(contactTags)
    .where(
      and(
        sql`${contactTags.tagId} in (
          select ct.tag_id from contact_tags ct join contacts c on c.id = ct.contact_id
           where ct.contact_id = ${contactId}::uuid and c.user_id = ${USER}
        )`,
        sql`${contactTags.contactId} <> ${contactId}::uuid`
      )
    )
    .groupBy(contactTags.contactId)
    .having(sql`count(*) >= 2`);
  const sharesTwoTags = new Set(shared.map((r) => r.contactId));
  const ranked = findRelatedContacts(
    contactId,
    narrowRows.map((r) => ({
      ...r,
      tags:
        r.id === contactId
          ? sourceTagIds.length > 0
            ? ["__shared__", "__shared__"]
            : []
          : sharesTwoTags.has(r.id)
            ? ["__shared__", "__shared__"]
            : [],
    })),
    limit,
    goals
  );
  if (ranked.length === 0) return ranked;
  const displayRows = await db.query.contacts.findMany({
    where: inArray(contacts.id, ranked.map((r) => r.id)),
    columns: { id: true, firstName: true, title: true, location: true, linkedinUrl: true, email: true, phone: true },
    extras: { profileImageUrl: clientAvatarUrlSql.as("profile_image_url") },
  });
  const displayById = new Map(displayRows.map((r) => [r.id, r]));
  return ranked.map((r) => ({ ...r, ...(displayById.get(r.id) ?? {}) }));
}

/** Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Seed = {
  fullName: string;
  preferredName?: string | null;
  company?: string | null;
  school?: string | null;
  howMet?: string | null;
  notes?: string | null;
  aiSummary?: string | null;
  keyFacts?: unknown;
  sharedInterests?: unknown;
  relationshipScore?: number | null;
  tagNames?: string[];
};

const NAMES = [
  "Ada Lovelace",
  "José Álvarez",
  "İlkay Demir",
  "Kate Bell",
  "Ann O_Neil",
  "Bo 100%",
  "Zoë Back\\slash",
  "Grace Hopper",
  "Li Wei",
  "Mary Somerville",
  "Charles Babbage",
  "Katherine Johnson",
  "Σοφία Παπαδοπούλου",
  "Straße Müller",
];

/** Ways a text can name someone, including the ones only JS lowering resolves. */
function variants(name: string): string[] {
  const out = [name, name.toUpperCase(), name.toLowerCase()];
  const last = name.split(/\s+/).pop()!;
  out.push(last, last.toUpperCase());
  // KELVIN SIGN for K, which JS lowers to "k".
  if (/k/i.test(name)) out.push(name.replace(/k/gi, "K"));
  // A dotted capital I, which JS lowers to "i" + U+0307 (so it matches only a name that
  // itself contains U+0130).
  if (/i/i.test(name)) out.push(name.replace(/i/gi, "İ"));
  return out;
}

function buildFixture(): Seed[] {
  const r = rng(20260926);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const companies = ["Analytical Engines", "analytical  engines ", "Acme", "ÉCOLE Corp", null];
  const schools = ["Somerville", "somerville", "MIT", "Straße Uni", null];
  const howMets = ["PyCon", "pycon", "YC Demo Day", "hi", null];
  const interests = ["chess", "poetry", "robotics", "Robotics", "sailing", "fintech"];
  const tagPool = ["mentor", "conference", "investor", "friend"];
  const fillers = ["met at a dinner", "robotics startup founder", "investor in fintech", "", "sailing on weekends", "ex-colleague"];

  const seeds: Seed[] = [];
  // Hand-written edge cases first.
  seeds.push(
    { fullName: "Ada Lovelace", preferredName: "Countess", company: "Analytical Engines", school: "Somerville", howMet: "PyCon", sharedInterests: ["chess", "poetry"], tagNames: ["mentor", "conference"] },
    // "ada" + " " + "lovelace" only meet across the aiSummary → keyFacts join.
    { fullName: "Split Mention", aiSummary: "Introduced by Ada", keyFacts: ["Lovelace fan"] },
    // …and across notes → sharedInterests.
    { fullName: "Split Two", notes: "Knows ADA", sharedInterests: ["LOVELACE", "chess"] },
    { fullName: "Kelvin Mention", notes: "Lunch with Kate Bell last week" },
    { fullName: "Dotted Mention", notes: "İLKAY DEMIR sends regards" },
    { fullName: "Metachar Mention", aiSummary: "Partner of ann o_neil" },
    { fullName: "Not Metachar", aiSummary: "Partner of ann oxneil" },
    { fullName: "Percent Mention", notes: "shares a desk with bo 100%" },
    { fullName: "Backslash Mention", notes: "zoë back\\slash knows everyone" },
    { fullName: "Scalar Facts", keyFacts: "Ada" },
    { fullName: "Number Facts", keyFacts: ["born 1815", 42, true, null], notes: "robotics" },
    { fullName: "Greek Mention", notes: "ΣΟΦΊΑ ΠΑΠΑΔΟΠΟΎΛΟΥ" },
    { fullName: "Goal Only", company: "Acme", notes: "raising for a robotics startup, fintech too" },
  );
  for (let i = 0; i < 90; i++) {
    const text = () =>
      Array.from({ length: Math.floor(r() * 3) }, () =>
        r() < 0.5 ? pick(variants(pick(NAMES))) : pick(fillers)
      ).join(pick([" ", ", ", "\n", ""]));
    seeds.push({
      fullName: r() < 0.25 ? pick(NAMES) : `Person ${i} ${pick(["Smith", "Lovelace", "Bell", "Müller", "Q"])}`,
      preferredName: r() < 0.1 ? pick(["Addy", "Jo", "Kat", "İz"]) : null,
      company: pick(companies),
      school: pick(schools),
      howMet: pick(howMets),
      notes: r() < 0.7 ? text() : null,
      aiSummary: r() < 0.5 ? text() : null,
      keyFacts: r() < 0.5 ? Array.from({ length: Math.floor(r() * 3) }, text) : null,
      sharedInterests: r() < 0.6 ? Array.from({ length: Math.floor(r() * 3) }, () => pick(interests)) : null,
      relationshipScore: r() < 0.8 ? Math.floor(r() * 5) + 1 : null,
      tagNames: Array.from({ length: Math.floor(r() * 3) }, () => pick(tagPool)),
    });
  }
  return seeds;
}

async function main() {
  const db = await getDb();
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  const tagIds = new Map<string, string>();
  for (const name of ["mentor", "conference", "investor", "friend"]) {
    const [t] = await db.insert(tags).values({ userId: USER, name }).returning();
    tagIds.set(name, t.id);
  }

  const ids: string[] = [];
  for (const s of buildFixture()) {
    const [row] = await db
      .insert(contacts)
      .values({
        userId: USER,
        fullName: s.fullName,
        preferredName: s.preferredName ?? null,
        company: s.company ?? null,
        school: s.school ?? null,
        howMet: s.howMet ?? null,
        notes: s.notes ?? null,
        aiSummary: s.aiSummary ?? null,
        ...(s.relationshipScore != null ? { relationshipScore: s.relationshipScore } : {}),
      })
      .returning();
    // Raw jsonb, so non-array / non-string values land as they would from a bad writer.
    await db.execute(sql`update contacts set
      key_facts = ${s.keyFacts === undefined ? null : JSON.stringify(s.keyFacts)}::jsonb,
      shared_interests = ${s.sharedInterests === undefined ? null : JSON.stringify(s.sharedInterests)}::jsonb
      where id = ${row.id}::uuid`);
    const uniqueTags = [...new Set(s.tagNames ?? [])];
    if (uniqueTags.length) {
      await db.insert(contactTags).values(uniqueTags.map((n) => ({ contactId: row.id, tagId: tagIds.get(n)! })));
    }
    ids.push(row.id);
  }

  check(
    "pattern escaping: LIKE metacharacters are literal, non-ASCII is one wildcard",
    JSON.stringify(mentionLikePatterns(["ann o_neil", "bo 100%", "zoë back\\slash", "ab"])) ===
      JSON.stringify(["%o\\_neil%", "%100\\%%", "%back\\\\slash%"]),
    JSON.stringify(mentionLikePatterns(["ann o_neil", "bo 100%", "zoë back\\slash", "ab"]))
  );

  async function compareAll(label: string) {
    let mismatches = 0;
    let firstDiff = "";
    let nonEmpty = 0;
    for (const id of ids) {
      // Every ranked row, not just the card's six: the six are a prefix of this.
      for (const limit of [1000]) {
        const [legacy, current] = await Promise.all([
          legacyListRelatedContacts(id, limit).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e: String(e) })
          ),
          listRelatedContacts(id, limit).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e: String(e) })
          ),
        ]);
        const a = JSON.stringify(legacy);
        const b = JSON.stringify(current);
        if (legacy.ok && legacy.v.length) nonEmpty++;
        if (a !== b) {
          mismatches++;
          if (!firstDiff) firstDiff = `source ${id} limit ${limit}\n       legacy:  ${a.slice(0, 600)}\n       current: ${b.slice(0, 600)}`;
        }
      }
    }
    check(`${label}: identical output for all ${ids.length} sources (every ranked row)`, mismatches === 0, firstDiff);
    check(`${label}: the fixture actually produces related people`, nonEmpty > ids.length / 2, `${nonEmpty} of ${ids.length}`);
  }

  await compareAll("no goals");

  await db.insert(userGoals).values([
    { userId: USER, text: "Find investors for my robotics startup" },
    { userId: USER, text: "Learn fintech from Ada" },
  ]);
  await compareAll("with goals");

  // A missing source and a malformed id read to [] exactly as before.
  check(
    "missing source reads to []",
    JSON.stringify(await listRelatedContacts("00000000-0000-4000-8000-000000000000")) === "[]"
  );

  // A contact whose keyFacts is an object made the old scoring throw for EVERY source (it
  // spread every contact's keyFacts). The narrowed read has to keep that, not hide it.
  const [bad] = await db.insert(contacts).values({ userId: USER, fullName: "Object Facts" }).returning();
  await db.execute(sql`update contacts set key_facts = '{"a":1}'::jsonb where id = ${bad.id}::uuid`);
  const legacyErr = await legacyListRelatedContacts(ids[0]).then(() => "resolved", (e: unknown) => String(e));
  const currentErr = await listRelatedContacts(ids[0]).then(() => "resolved", (e: unknown) => String(e));
  check("an object keyFacts row behaves as it did (rejects the same way)", legacyErr === currentErr, `${legacyErr} vs ${currentErr}`);
  await db.delete(contacts).where(eq(contacts.id, bad.id));

  // The point of the change: with no goals, the whole-network scan carries no text columns,
  // and the text read is filtered in SQL.
  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  startQueryCount();
  await listRelatedContacts(ids[0]);
  stopQueryCount();
  const textStatements = capturedQueries().filter(
    (s) => /^\s*select/i.test(s) && /from\s+"contacts"/i.test(s) && /"notes"/i.test(s)
  );
  check(
    "every statement reading notes is either the source row or the SQL-prefiltered subset",
    textStatements.length > 0 &&
      textStatements.every((s) => /like any/i.test(s) || /"contacts"\."id" = \$\d+ and "contacts"\."user_id" = \$\d+/i.test(s)),
    textStatements.find((s) => !/like any/i.test(s))?.slice(0, 300)
  );

  await db.delete(userGoals).where(eq(userGoals.userId, USER));
  await db.delete(tags).where(eq(tags.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, USER));

  await checkInteractionHistory();
  await checkTriageAvatars();

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll contact-profile read checks passed.");
  process.exit(0);
}

const DAY = 24 * 60 * 60 * 1000;

async function seedHistory(userId: string, fullName: string, count: number, opts: { aiDerivedNewest?: number } = {}) {
  const db = await getDb();
  const [c] = await db.insert(contacts).values({ userId, fullName }).returning();
  const types = ["note", "meeting", "linkedin_message", "email", "call", "coffee"];
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, i) => ({
    userId,
    contactId: c.id,
    interactionType: types[(i * 7) % types.length],
    // Newest first by index; pairs share a day (same timestamp, told apart by sameDayOrder),
    // and the spread crosses the 90-day frequency window.
    interactionDate: new Date(now - Math.floor(i / 2) * 1.7 * DAY - 60_000),
    sameDayOrder: i % 2,
    source: i < (opts.aiDerivedNewest ?? 0) ? "ai_derived" : i % 5 === 0 ? null : "manual",
    rawNotes: i % 3 === 0 ? `note ${i} ${"x".repeat(900)}` : null,
    aiSummary: i % 4 === 0 ? `summary ${i}` : null,
  }));
  for (let i = 0; i < rows.length; i += 50) await db.insert(interactions).values(rows.slice(i, i + 50));
  return c.id;
}

/** The facts `contacts/[id]/page.tsx` derives, from the full list (the old way). */
function factsFromFullList(list: Array<{ interactionType: string; interactionDate: Date; source: string | null }>) {
  const typeCounts: Record<string, number> = {};
  for (const i of list) typeCounts[i.interactionType] = (typeCounts[i.interactionType] ?? 0) + 1;
  return {
    total: list.length,
    typeCounts,
    hasLogged: list.some(isLoggedTouch),
    lastTouch: latestLoggedTouch(list)?.interactionDate?.toISOString() ?? null,
    frequency: formatInteractionFrequency(list.filter(isLoggedTouch).map((i) => i.interactionDate)),
  };
}

async function checkInteractionHistory() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));

  // Long history whose newest 70 rows are AI-derived: the last logged touch lies past the
  // loaded page, which only the aggregate can answer.
  for (const [label, count, aiDerivedNewest] of [
    ["long history", 150, 0],
    ["long history, newest page all AI-derived", 150, 70],
    ["exactly one page", 60, 0],
    ["one row past a page", 61, 0],
  ] as const) {
    const id = await seedHistory(USER, `History ${label}`, count, { aiDerivedNewest });
    const full = await getContact(id);
    const profile = await getContactForProfile(id);
    if (!full || !profile) {
      check(`${label}: both reads find the contact`, false);
      continue;
    }
    const expected = factsFromFullList(full.interactions);
    const h = profile.interactionHistory;
    const loaded = profile.interactions;
    const got = h
      ? {
          total: h.total,
          typeCounts: h.typeCounts,
          hasLogged: h.loggedCount > 0,
          lastTouch: (latestLoggedTouch(loaded)?.interactionDate ?? h.latestLoggedAt)?.toISOString() ?? null,
          frequency: formatInteractionFrequency(h.recentLoggedTimes.map((t) => new Date(t))),
        }
      : factsFromFullList(loaded);
    const sortKeys = (o: Record<string, number>) => JSON.stringify(Object.entries(o).sort());
    check(`${label}: loads at most 60 rows`, loaded.length === Math.min(60, count), String(loaded.length));
    check(
      `${label}: the loaded rows are the full list's newest, identical`,
      JSON.stringify(loaded) === JSON.stringify(full.interactions.slice(0, loaded.length))
    );
    check(`${label}: aggregates only when there is more than a page`, (h !== null) === count > 60);
    check(`${label}: total`, got.total === expected.total, `${got.total} vs ${expected.total}`);
    check(`${label}: type counts`, sortKeys(got.typeCounts) === sortKeys(expected.typeCounts));
    check(`${label}: has a logged touch`, got.hasLogged === expected.hasLogged);
    check(`${label}: last touch`, got.lastTouch === expected.lastTouch, `${got.lastTouch} vs ${expected.lastTouch}`);
    check(`${label}: frequency label`, got.frequency === expected.frequency, `${got.frequency} vs ${expected.frequency}`);
    if (count <= 60) {
      const { interactionHistory: _h, ...rest } = profile;
      check(`${label}: otherwise the same object getContact returns`, JSON.stringify(rest) === JSON.stringify(full));
    }

    const timeline = await listContactTimelineInteractions(id);
    check(
      `${label}: "show all" returns every row in the timeline's shape and order`,
      JSON.stringify(timeline) ===
        JSON.stringify(
          full.interactions.map((i) => ({
            id: i.id,
            interactionType: i.interactionType,
            interactionDate: i.interactionDate,
            sameDayOrder: i.sameDayOrder,
            notesPreview: i.notesPreview,
            aiSummary: i.aiSummary,
          }))
        )
    );
  }

  const foreign = await seedHistory("someone-else", "Not Yours", 5);
  check("\"show all\" reads nothing of another account's contact", (await listContactTimelineInteractions(foreign)).length === 0);
  check("the profile read finds nothing of another account's contact", (await getContactForProfile(foreign)) === null);
  await db.delete(contacts).where(eq(contacts.userId, "someone-else"));
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

async function checkTriageAvatars() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  const stored = [
    "https://media.licdn.com/dms/image/abc/photo.jpg",
    "  https://xyz.public.blob.vercel-storage.com/avatars/a.jpg  ",
    `data:image/jpeg;base64,${"A".repeat(4000)}`,
    "https://unavatar.io/linkedin/someone",
    "https://static.licdn.com/aero-v1/placeholder.png",
    "   ",
    null,
  ];
  const storedById = new Map<string, string | null>();
  for (let i = 0; i < 21; i++) {
    const value = stored[i % stored.length];
    const [c] = await db
      .insert(contacts)
      .values({ userId: USER, fullName: `Triage ${i}`, company: `Co ${i % 4}`, profileImageUrl: value })
      .returning();
    storedById.set(c.id, value);
  }
  startQueryCount();
  const picked = await getTriageCandidates();
  stopQueryCount();
  check("triage picks people", picked.length > 0, String(picked.length));
  const wrong = picked.find((p) => p.profileImageUrl !== clientContactAvatarUrl(p.id, storedById.get(p.id)));
  check(
    "each picked avatar is what ContactAvatar drew from the stored value",
    !wrong,
    wrong ? `${wrong.id}: ${wrong.profileImageUrl} vs ${clientContactAvatarUrl(wrong.id, storedById.get(wrong.id))}` : undefined
  );
  // Contacts statements only: the settings row has a `profile_image_url` of its own.
  const avatarStatements = capturedQueries().filter(
    (s) => /from\s+"contacts"/i.test(s) && /profile_image_url/i.test(s)
  );
  check(
    "only the by-id avatar read touches profile_image_url, and only through clientAvatarUrlSql",
    avatarStatements.length === 1 && avatarStatements.every((s) => /\/api\/avatars\//.test(s) && /"id" in \(/i.test(s)),
    avatarStatements.map((s) => s.slice(0, 200)).join("\n       ")
  );
  await db.delete(contacts).where(eq(contacts.userId, USER));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
