/**
 * The backfill is what makes deferring embeddings safe: if it does not drain, imported
 * contacts are silently missing from search forever.
 *
 * Run: npx tsx scripts/smoke-embedding-backfill.ts
 */
import "./smoke/_env";

// Env reads in auth.ts and db/index.ts are lazy (inside functions), so setting these
// after dotenv but before the src/ imports below still lands before anything reads them.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-embedding-backfill";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-embedding-backfill";

import { and, count, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import type { createEmbeddingsBatch } from "../src/lib/ai";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, interactions, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { saveContactProfile } from "../src/lib/contact-profile";
import { runEmbeddingBackfill } from "../src/lib/embedding-backfill";
import { ensureUserSettings } from "../src/lib/user-settings";

const CLAIMABLE_USER = "smoke-embedding-backfill-claimable-user";
const DRAIN_USER = "smoke-embedding-backfill-drain-user";
const MEETING_USER = "smoke-embedding-backfill-meeting-user";
const PROFILE_USER = "smoke-embedding-backfill-profile-user";

function check(label: string, condition: boolean, detail?: string) {
  if (!condition) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

/**
 * The runner is required NOT to catch a provider failure — that is what leaves
 * `embedding_stale_at` set for the next pass to retry (see `embedding-backfill.ts`). With
 * no AI key configured anywhere in this environment, `createEmbeddingsBatch` always
 * rejects, so that rejection is expected to reach here on every local run. This is the
 * same shape as the `revalidatePath` invariant `smoke-import-engine.ts` tolerates: a real
 * environment gap, not a mock, and anything other than the specific expected message
 * still escapes and fails the run.
 */
async function attemptBackfill(userId: string) {
  try {
    return await runEmbeddingBackfill(userId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/API key configured for embeddings|Anthropic has no embeddings API/.test(message)) {
      return { embedded: 0, remaining: -1 };
    }
    throw err;
  }
}

async function staleCountFor(userId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), isNotNull(contacts.embeddingStaleAt)));
  return row?.value ?? 0;
}

/**
 * Section 1: no AI key configured anywhere in this environment, so the real
 * `createEmbeddingsBatch` always rejects (`resolveEmbeddingBackend` throws before any
 * network call). This covers the "provider fails, work stays claimable" property — a real,
 * separate guarantee from the drain path below, not a stand-in for it.
 */
async function testClaimableOnProviderFailure() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, CLAIMABLE_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, CLAIMABLE_USER));
  await ensureUserSettings(CLAIMABLE_USER);

  const now = new Date();
  await db.insert(contacts).values(
    Array.from({ length: 30 }, (_, i) => ({
      userId: CLAIMABLE_USER,
      fullName: `Stale Person ${i}`,
      company: `Company ${i % 5}`,
      title: `Title ${i % 3}`,
      embeddingStaleAt: now,
    }))
  );

  check("fixture starts stale", (await staleCountFor(CLAIMABLE_USER)) === 30);

  const first = await attemptBackfill(CLAIMABLE_USER);
  const remaining = await staleCountFor(CLAIMABLE_USER);

  // With no AI key configured, `createEmbeddingsBatch` throws and the runner must leave
  // the flags set so the next pass retries. With a key present it would drain instead.
  check(
    "backfill either drains or leaves the work claimable",
    remaining === 0 ? first.embedded === 30 : remaining === 30,
    `embedded ${first.embedded}, remaining ${remaining}`
  );

  if (remaining === 0) {
    const [row] = await db
      .select({ value: count() })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, CLAIMABLE_USER));
    check("one embedding row per contact", (row?.value ?? 0) === 30, `rows ${row?.value}`);

    const second = await runEmbeddingBackfill(CLAIMABLE_USER);
    check("second pass is a no-op", second.embedded === 0, JSON.stringify(second));
  } else {
    // Made explicit rather than silently skipped: without a live key, this branch never
    // runs locally, and a reader seeing only "ok" lines above could otherwise mistake the
    // claimable-branch pass for having exercised the drain checks too.
    console.log(
      "  skip  one embedding row per contact (no AI key locally; see drain section below)"
    );
    console.log(
      "  skip  second pass is a no-op (no AI key locally; see drain section below)"
    );
  }

  await db.delete(contacts).where(eq(contacts.userId, CLAIMABLE_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, CLAIMABLE_USER));
}

/** Deterministic stand-in for the provider, injected through the runner's `embed` seam. */
const stubEmbed: typeof createEmbeddingsBatch = async (_userId, texts) =>
  texts.map(() => Array(1536).fill(0.01));

/**
 * Section 2: the drain path, exercised for real via the `embed` seam instead of a live AI
 * key. This is the only place that runs the `ON CONFLICT ... DO UPDATE` upsert, the
 * `RETURNING id, contact_id` -> `idByContact` join, the chunked call into
 * `persistEmbeddingVectors`, the flag clear, and second-pass idempotence.
 *
 * The fixture is sized past both chunk boundaries on purpose: `EMBED_BATCH` is 200, so 220
 * embeddable contacts force the runner's per-slice loop to iterate twice (200 then 20)
 * instead of completing in one pass; `persistEmbeddingVectors`'s own `VECTOR_WRITE_CHUNK`
 * is 50, so a 200-row slice forces its internal chunking loop to iterate four times. (That
 * inner loop's actual SQL still short-circuits on this machine because pgvector has no
 * PGlite build — `isPgvectorAvailable()` is false for every local run, a pre-existing gap
 * that applies to every pgvector-backed path in this codebase, not something this test can
 * close. The seam does still prove the runner *reaches* that call with correctly-chunked,
 * correctly-mapped rows, which is everything the runner itself is responsible for.)
 *
 * Three contacts carry no embeddable text at all, to exercise the `emptyIds` path: if that
 * branch fails to clear a flag, the contact is re-claimed forever and the runner spends its
 * whole time budget doing nothing, on every future invocation.
 */
async function testDrainWithStubbedProvider() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, DRAIN_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, DRAIN_USER));
  await ensureUserSettings(DRAIN_USER);

  const now = new Date();
  const EMBEDDABLE_COUNT = 220;
  const EMPTY_COUNT = 3;

  await db.insert(contacts).values(
    Array.from({ length: EMBEDDABLE_COUNT }, (_, i) => ({
      userId: DRAIN_USER,
      fullName: `Drain Person ${i}`,
      company: `Company ${i % 7}`,
      title: `Title ${i % 4}`,
      embeddingStaleAt: now,
    }))
  );

  // `buildContactEmbeddingContent` reads fullName, preferredName, title, company,
  // location, email, phone, linkedinUrl, website, aiSummary, notes, metContext, dateMet,
  // howMet, keyFacts, opportunities, and tag names, then filters out falsy/empty entries.
  // `full_name` is NOT NULL in the schema, but an empty string satisfies that constraint
  // and is filtered out like every other field, so this fixture is genuinely
  // content-free — not just missing a name.
  const emptyContacts = await db
    .insert(contacts)
    .values(
      Array.from({ length: EMPTY_COUNT }, () => ({
        userId: DRAIN_USER,
        fullName: "",
        embeddingStaleAt: now,
      }))
    )
    .returning();
  const emptyIds = emptyContacts.map((c) => c.id);

  check(
    "drain fixture starts stale",
    (await staleCountFor(DRAIN_USER)) === EMBEDDABLE_COUNT + EMPTY_COUNT
  );

  const first = await runEmbeddingBackfill(DRAIN_USER, stubEmbed);
  check(
    "first pass embeds exactly the embeddable contacts",
    first.embedded === EMBEDDABLE_COUNT,
    JSON.stringify(first)
  );
  check("first pass drains all flags, embeddable and empty alike", first.remaining === 0);

  const [embRow] = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(eq(contactEmbeddings.userId, DRAIN_USER));
  check(
    "one embedding row per embeddable contact, none for the empty ones",
    (embRow?.value ?? 0) === EMBEDDABLE_COUNT,
    `rows ${embRow?.value}`
  );

  const clearedEmpties = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(inArray(contacts.id, emptyIds), isNull(contacts.embeddingStaleAt)));
  check(
    "empty-content contacts had their flag cleared",
    (clearedEmpties[0]?.value ?? 0) === EMPTY_COUNT
  );

  const emptyEmbeddingRows = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(inArray(contactEmbeddings.contactId, emptyIds));
  check(
    "no embedding row was written for any empty-content contact",
    (emptyEmbeddingRows[0]?.value ?? 0) === 0
  );

  const second = await runEmbeddingBackfill(DRAIN_USER, stubEmbed);
  check("second pass is a no-op", second.embedded === 0, JSON.stringify(second));

  await db.delete(contacts).where(eq(contacts.userId, DRAIN_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, DRAIN_USER));
}

/**
 * Section 3: the uniqueness key, and the meeting phase that depends on it.
 *
 * The key is `(user_id, contact_id, source_type, source_id)`. It was briefly created on
 * only the first three columns, which is destructive rather than merely imprecise: a
 * contact has MANY `'meeting'` rows, one per meeting, each with its own `source_id`. Under a
 * three-column key the migration's dedupe deletes every meeting embedding but the newest per
 * contact, and every subsequent meeting write raises a unique violation that
 * `upsertContactEmbedding`'s blanket `catch {}` swallows — so meeting embeddings silently
 * stop being written, with no error anywhere. That is what the first two checks pin.
 *
 * The rest exercises the meeting phase, which restores the per-meeting embedding the old
 * `confirmCalendarImport` wrote inline and moving calendar onto the engine dropped. It runs
 * through the same stubbed `embed` seam as section 2, so the upsert, the
 * `RETURNING source_id` join and the vector write all really execute.
 */
async function testMeetingEmbeddings() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, MEETING_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, MEETING_USER));
  await ensureUserSettings(MEETING_USER);

  const [attendee] = await db
    .insert(contacts)
    .values({ userId: MEETING_USER, fullName: "Meeting Attendee" })
    .returning();

  // Three meetings with ONE contact — the exact shape a three-column key cannot express.
  const MEETINGS = 3;
  await db.insert(interactions).values(
    Array.from({ length: MEETINGS }, (_, i) => ({
      userId: MEETING_USER,
      contactId: attendee.id,
      interactionType: "meeting",
      interactionDate: new Date(`2024-0${i + 1}-15T10:00:00Z`),
      source: "calendar_import",
      externalId: `cal:evt-${i}:${attendee.id}`,
      rawNotes: `Meeting: Sync ${i}\nLocation: Room ${i}`,
      aiSummary: `Sync ${i}`,
      topics: [`Sync ${i}`],
    }))
  );

  // A meeting from the live ICS subscription rather than a file import.
  //
  // This used to be asserted as OUT of scope, because `applyNetworkingEvents` embedded its
  // rows inline as it wrote them. That function is gone: the ICS subscription now writes
  // through the shared ingest path, which flags `embedding_stale_at` and leaves embedding to
  // this sweep rather than paying an AI round trip per row. So a `calendar_sync` meeting is
  // now IN scope, and if it ever falls out again its content becomes silently unsearchable —
  // which is the regression `PENDING_MEETINGS` records having already happened once.
  await db.insert(interactions).values({
    userId: MEETING_USER,
    contactId: attendee.id,
    interactionType: "meeting",
    interactionDate: new Date("2024-05-15T10:00:00Z"),
    source: "calendar_sync",
    externalId: `cal:evt-synced:${attendee.id}`,
    rawNotes: "Meeting: Synced",
  });

  // Three file-imported meetings plus the one written by the live ICS subscription.
  const SYNCED_MEETINGS = 1;
  const first = await runEmbeddingBackfill(MEETING_USER, stubEmbed);
  check(
    "meeting phase embeds every calendar meeting for one contact",
    first.embedded === MEETINGS + SYNCED_MEETINGS,
    JSON.stringify(first)
  );
  check("meeting phase leaves nothing pending", first.remaining === 0, JSON.stringify(first));

  const meetingRows = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, MEETING_USER),
        eq(contactEmbeddings.sourceType, "meeting")
      )
    );
  // The load-bearing number. Under the three-column key this is 1, not 3 — either because
  // the second and third inserts raised a swallowed unique violation, or because a dedupe
  // deleted them.
  check(
    "one 'meeting' embedding row per meeting, not one per contact",
    (meetingRows[0]?.value ?? 0) === MEETINGS + SYNCED_MEETINGS,
    `rows ${meetingRows[0]?.value}`
  );

  const synced = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, MEETING_USER),
        eq(contactEmbeddings.sourceId, `cal:evt-synced:${attendee.id}`)
      )
    );
  check(
    "the live-sync meeting is embedded by this sweep, not left behind",
    (synced[0]?.value ?? 0) === 1,
    `rows ${synced[0]?.value}`
  );

  const sample = await db.query.contactEmbeddings.findFirst({
    where: and(
      eq(contactEmbeddings.userId, MEETING_USER),
      eq(contactEmbeddings.sourceId, `cal:evt-0:${attendee.id}`)
    ),
  });
  // Same content shape the old per-row importer embedded (`fullName` + newline + note), so
  // meetings embedded before and after this change are indistinguishable to search.
  check(
    "meeting content is the contact's name plus the meeting note",
    sample?.content === "Meeting Attendee\nMeeting: Sync 0\nLocation: Room 0",
    JSON.stringify(sample?.content)
  );

  // Recovery: an embedding row that once existed and was DELETED is indistinguishable from
  // one that was never written, because pending-ness is a `NOT EXISTS` query rather than a
  // flag. That is what makes this phase a repair path and not just a first-write path — it
  // matters because the three-column index this branch replaced shipped with a dedupe that
  // deletes every meeting embedding but the newest per contact. Deleting two of the three
  // rows here reproduces exactly that damage.
  const survivor = `cal:evt-2:${attendee.id}`;
  await db
    .delete(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, MEETING_USER),
        eq(contactEmbeddings.sourceType, "meeting"),
        notInArray(contactEmbeddings.sourceId, [survivor])
      )
    );
  const afterDedupe = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, MEETING_USER),
        eq(contactEmbeddings.sourceType, "meeting")
      )
    );
  check(
    "dedupe damage reproduced: one meeting embedding left",
    (afterDedupe[0]?.value ?? 0) === 1,
    `rows ${afterDedupe[0]?.value}`
  );

  const repair = await runEmbeddingBackfill(MEETING_USER, stubEmbed);
  check(
    "the backfill re-embeds the deleted meetings, and only those",
    repair.embedded === MEETINGS + SYNCED_MEETINGS - 1,
    JSON.stringify(repair)
  );
  const afterRepair = await db
    .select({ value: count() })
    .from(contactEmbeddings)
    .where(
      and(
        eq(contactEmbeddings.userId, MEETING_USER),
        eq(contactEmbeddings.sourceType, "meeting")
      )
    );
  check(
    "every meeting embedding is back",
    (afterRepair[0]?.value ?? 0) === MEETINGS + SYNCED_MEETINGS,
    `rows ${afterRepair[0]?.value}`
  );

  // Idempotence, and the property that makes the route's re-kick loop terminate: a second
  // pass must find nothing pending. If the claim and the count could ever disagree, this is
  // where it shows up as `embedded > 0` forever.
  const second = await runEmbeddingBackfill(MEETING_USER, stubEmbed);
  check(
    "second pass re-embeds nothing and reports nothing remaining",
    second.embedded === 0 && second.remaining === 0,
    JSON.stringify(second)
  );

  await db.delete(contacts).where(eq(contacts.userId, MEETING_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, MEETING_USER));
}

/**
 * Section 4: the silent-failure guard. `buildContactEmbeddingContent` folding in `profile`
 * and `experiences` is worthless if the backfill's claim query never loads them — that
 * failure compiles clean, every other check here still passes, and nothing anywhere would
 * say so. This drives the real path end to end: `saveContactProfile` (the only writer)
 * flags the contact stale, `runEmbeddingBackfill`'s claim query (the one under test) must
 * `with:` in `profile` and `experiences`, and the resulting `contact_embeddings.content` is
 * inspected directly — not `buildContactEmbeddingContent` called by hand with data fetched
 * some other way, which would prove only the formatter and nothing about the claim query.
 */
async function testProfileFoldedIntoEmbeddingByBackfill() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, PROFILE_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, PROFILE_USER));
  await ensureUserSettings(PROFILE_USER);

  const [contact] = await db
    .insert(contacts)
    .values({ userId: PROFILE_USER, fullName: "Ex Employer Contact" })
    .returning();

  const saved = await saveContactProfile(PROFILE_USER, contact.id, {
    source: "extension",
    sourceUrl: "https://www.linkedin.com/in/ex-employer-contact",
    adapterVersion: "linkedin-2",
    capturedAt: new Date(),
    warnings: [],
    headline: "Distinctive Headline Text",
    about: "Distinctive About Paragraph",
    skills: [],
    certifications: [],
    volunteering: [],
    publications: [],
    experiences: [
      { kind: "role", organization: "Former Employer Corp", title: "Engineer",
        startYear: 2015, startMonth: null, endYear: 2019, endMonth: null,
        isCurrent: false, location: null, description: null, fieldOfStudy: null },
    ],
  });
  check("profile save reports written", saved.written && saved.reason === "saved");

  const [staleRow] = await db
    .select({ staleAt: contacts.embeddingStaleAt })
    .from(contacts)
    .where(eq(contacts.id, contact.id));
  check("saving the profile flags the contact stale", staleRow.staleAt !== null);

  const backfill = await runEmbeddingBackfill(PROFILE_USER, stubEmbed);
  check(
    "backfill embeds the flagged contact",
    backfill.embedded === 1,
    JSON.stringify(backfill)
  );

  const embeddingRow = await db.query.contactEmbeddings.findFirst({
    where: and(
      eq(contactEmbeddings.userId, PROFILE_USER),
      eq(contactEmbeddings.contactId, contact.id),
      eq(contactEmbeddings.sourceType, "profile")
    ),
  });
  // The load-bearing checks. If the claim query in embedding-backfill.ts is missing
  // `profile: true` / `experiences: true` in its `with:`, `contact.profile` and
  // `contact.experiences` are `undefined` when `buildContactEmbeddingContent` runs, and
  // none of this text reaches the stored content — while every check elsewhere in this
  // file, and the profile-save checks above, keep passing regardless.
  check(
    "the stored embedding content includes the profile headline",
    (embeddingRow?.content ?? "").includes("Distinctive Headline Text"),
    embeddingRow?.content ?? "no embedding row"
  );
  check(
    "the stored embedding content includes the profile about text",
    (embeddingRow?.content ?? "").includes("Distinctive About Paragraph"),
    embeddingRow?.content ?? "no embedding row"
  );
  check(
    "the stored embedding content includes the past employer via the career line",
    (embeddingRow?.content ?? "").includes("Former Employer Corp"),
    embeddingRow?.content ?? "no embedding row"
  );

  await db.delete(contacts).where(eq(contacts.userId, PROFILE_USER));
  await db.delete(userSettings).where(eq(userSettings.userId, PROFILE_USER));
}

async function main() {
  console.log("Embedding backfill (pglite)...");
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  console.log("\n-- provider-failure branch (no AI key) --");
  await testClaimableOnProviderFailure();

  console.log("\n-- drain branch (stubbed provider) --");
  await testDrainWithStubbedProvider();

  console.log("\n-- meeting phase and the four-column uniqueness key --");
  await testMeetingEmbeddings();

  console.log("\n-- profile text reaches the embedding via the claim query's with: --");
  await testProfileFoldedIntoEmbeddingByBackfill();

  console.log("\nBackfill checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
