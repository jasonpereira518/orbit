/**
 * The backfill is what makes deferring embeddings safe: if it does not drain, imported
 * contacts are silently missing from search forever.
 *
 * Run: npx tsx scripts/smoke-embedding-backfill.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

// Env reads in auth.ts and db/index.ts are lazy (inside functions), so setting these
// after dotenv but before the src/ imports below still lands before anything reads them.
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ||= "pk_test_smoke-embedding-backfill";
process.env.CLERK_SECRET_KEY ||= "sk_test_smoke-embedding-backfill";
// This suite must run against the local per-worktree PGlite file, never a remote
// database: it hard-deletes a user's contacts, and .env.local gaining a DATABASE_URL
// (one `vercel env pull` away) would point that at shared data.
delete process.env.DATABASE_URL;

import { and, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { createEmbeddingsBatch } from "../src/lib/ai";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { runEmbeddingBackfill } from "../src/lib/embedding-backfill";
import { ensureUserSettings } from "../src/lib/user-settings";

const CLAIMABLE_USER = "smoke-embedding-backfill-claimable-user";
const DRAIN_USER = "smoke-embedding-backfill-drain-user";

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

async function main() {
  console.log("Embedding backfill (pglite)...");
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  console.log("\n-- provider-failure branch (no AI key) --");
  await testClaimableOnProviderFailure();

  console.log("\n-- drain branch (stubbed provider) --");
  await testDrainWithStubbedProvider();

  console.log("\nBackfill checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
