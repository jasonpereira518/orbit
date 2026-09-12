/**
 * Asserts that saving a contact no longer waits on the embedding provider.
 *
 * Every create, update and logged interaction used to `await` a semantic-embedding call
 * on the request path — an external API round trip (300–800 ms, unbounded on a slow
 * provider) inside the most-felt latency in the product. The write now marks the row
 * `embedding_stale_at` in the same statement and defers the rebuild to after the
 * response; the hourly backfill is the backstop if the deferred task never runs.
 *
 * Pinned by counting the statements issued BEFORE the write returns: none may touch
 * `contact_embeddings`, and the stale marker must be set. Keyword search never regresses
 * (it reads the row, not the embedding), which is what makes the deferral acceptable.
 *
 * Runs against a throwaway PGlite database. Run: npx tsx scripts/smoke-write-path.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import {
  createContactForUser,
  logInteractionForUser,
  updateContactForUser,
} from "../src/lib/contact-writes";
import { capturedQueries, startQueryCount, stopQueryCount } from "../src/lib/query-counter";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-write-path-user";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const touchesEmbeddings = (statements: string[]) =>
  statements.filter((s) => /contact_embeddings/i.test(s));

async function staleAt(id: string) {
  const db = await getDb();
  const row = await db.query.contacts.findFirst({ where: eq(contacts.id, id), columns: { embeddingStaleAt: true } });
  return row?.embeddingStaleAt ?? null;
}

async function main() {
  const db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await ensureUserSettings(USER);

  console.log("Create...");
  startQueryCount();
  // `skipRevalidate` / `skipSummary`: revalidatePath and the person-summary `after()` both
  // need a request scope, which a script has none of. The embedding deferral must not.
  const created = await createContactForUser(USER, { fullName: "Ada Lovelace", company: "Analytical Engines" }, { skipRevalidate: true, skipSummary: true });
  stopQueryCount();
  let hits = touchesEmbeddings(capturedQueries());
  check("create issues no contact_embeddings statement before returning", hits.length === 0, hits[0]?.slice(0, 120));
  check("create marks the row stale for the deferred rebuild", (await staleAt(created.id)) !== null);

  console.log("\nUpdate...");
  await db.update(contacts).set({ embeddingStaleAt: null }).where(eq(contacts.id, created.id));
  startQueryCount();
  await updateContactForUser(USER, created.id, { title: "Mathematician" }, { skipRevalidate: true, skipSummary: true });
  stopQueryCount();
  hits = touchesEmbeddings(capturedQueries());
  check("update issues no contact_embeddings statement before returning", hits.length === 0, hits[0]?.slice(0, 120));
  check("update marks the row stale", (await staleAt(created.id)) !== null);

  console.log("\nLog an interaction...");
  await db.update(contacts).set({ embeddingStaleAt: null }).where(eq(contacts.id, created.id));
  startQueryCount();
  await logInteractionForUser(USER, { contactId: created.id, rawNotes: "Talked about the engine over coffee." }, { skipRevalidate: true, skipSummary: true });
  stopQueryCount();
  hits = touchesEmbeddings(capturedQueries());
  check("logging notes issues no contact_embeddings statement before returning", hits.length === 0, hits[0]?.slice(0, 120));
  check("logging notes marks the row stale", (await staleAt(created.id)) !== null);

  // Let any deferred work settle before the database goes away.
  await new Promise((r) => setTimeout(r, 200));
  await db.delete(contacts).where(eq(contacts.userId, USER));
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll write-path checks passed.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
