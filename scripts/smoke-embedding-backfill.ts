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

import { and, count, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../src/db";
import { contactEmbeddings, contacts, userSettings } from "../src/db/schema";
import { isClerkConfigured, isDemoMode } from "../src/lib/auth";
import { runEmbeddingBackfill } from "../src/lib/embedding-backfill";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-embedding-backfill-user";

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

async function staleCount() {
  const db = await getDb();
  const [row] = await db
    .select({ value: count() })
    .from(contacts)
    .where(and(eq(contacts.userId, USER), isNotNull(contacts.embeddingStaleAt)));
  return row?.value ?? 0;
}

async function main() {
  console.log("Embedding backfill (pglite)...");
  check("running with Clerk configured", isClerkConfigured() === true);
  check("running outside demo mode", isDemoMode() === false);

  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  await ensureUserSettings(USER);

  const now = new Date();
  await db.insert(contacts).values(
    Array.from({ length: 30 }, (_, i) => ({
      userId: USER,
      fullName: `Stale Person ${i}`,
      company: `Company ${i % 5}`,
      title: `Title ${i % 3}`,
      embeddingStaleAt: now,
    }))
  );

  check("fixture starts stale", (await staleCount()) === 30);

  const first = await attemptBackfill(USER);
  const remaining = await staleCount();

  // With no AI key configured, `createEmbeddingsBatch` throws and the runner must leave
  // the flags set so the next pass retries. With a key present it drains. Both are
  // correct; clearing flags for work that did not happen is not.
  check(
    "backfill either drains or leaves the work claimable",
    remaining === 0 ? first.embedded === 30 : remaining === 30,
    `embedded ${first.embedded}, remaining ${remaining}`
  );

  if (remaining === 0) {
    const [row] = await db
      .select({ value: count() })
      .from(contactEmbeddings)
      .where(eq(contactEmbeddings.userId, USER));
    check("one embedding row per contact", (row?.value ?? 0) === 30, `rows ${row?.value}`);

    // Idempotence: nothing is stale, so a second pass must be a no-op, not a re-embed.
    const second = await runEmbeddingBackfill(USER);
    check("second pass is a no-op", second.embedded === 0, JSON.stringify(second));
  }

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(userSettings).where(eq(userSettings.userId, USER));
  console.log("\nBackfill checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nFAILED:", e);
    process.exit(1);
  });
