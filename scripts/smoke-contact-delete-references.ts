/**
 * Deleting a person leaves no reference to them, anywhere; reverting an import leaves nothing
 * of what it brought in searchable.
 *
 * Promoted from `privacy/probe-selective-deletion.ts`:
 *   S1 found a deleted contact's id surviving in five tables with no foreign key to cascade
 *      from, and a search passage of a group note still listing them, so chat could still
 *      surface the person.
 *   S3 found an import revert leaving the reverted messages' search passages (orphans, since
 *      `memory_chunks.source_id` has no foreign key) and the raw rows naming removed people.
 *
 * The id check is schema-wide: one row is seeded in every table (`privacy/lib/seed-everything`),
 * every reference column is pointed at the person, and after the delete no row of any table may
 * contain their id. A new table that holds contact ids without cleanup fails here.
 *
 * Run: npx tsx scripts/smoke-contact-delete-references.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { deleteContactForUser } from "../src/lib/contact-delete";
import { revertImport } from "../src/lib/import-revert";
import { pruneOrphanedMemoryChunksForAll } from "../src/lib/memory-backfill";
import { readCatalog } from "../privacy/lib/catalog";
import { scanFor, seedEverything } from "../privacy/lib/seed-everything";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function q<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const db = await getDb();
  return rowsOf<T>(await db.execute(query));
}
const n = async (query: ReturnType<typeof sql>) => Number((await q<{ n: number }>(query))[0]?.n ?? 0);

async function main() {
  const cat = await readCatalog();

  console.log("Delete one contact");
  {
    const U = "user_smoke_delrefs_a";
    const seed = await seedEverything(cat, U);
    const person = String(seed.seeded.get("contacts")!.id);
    const [{ id: other }] = await q<{ id: string }>(sql`INSERT INTO contacts (user_id, full_name) VALUES (${U}, 'Someone Else') RETURNING id`);

    // Every place an id can sit without a foreign key, pointed at the person (and, where it is
    // a list, at someone else too, who must survive the cleanup).
    await q(sql`UPDATE ai_suggestions SET related_contact_ids = ${JSON.stringify([person, other])}::jsonb WHERE user_id = ${U}`);
    await q(sql`UPDATE email_sends SET contact_ids = ${JSON.stringify([person, other])}::jsonb WHERE user_id = ${U}`);
    await q(sql`UPDATE capture_jobs SET seed_contact_id = ${person}::uuid WHERE user_id = ${U}`);
    await q(sql`UPDATE import_job_rows SET contact_id = ${person}::uuid WHERE user_id = ${U}`);
    // A group note filed under someone else that also names the person, plus a passage of
    // another kind that lists them.
    await q(sql`INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
                VALUES (${U}, 'interaction', ${randomUUID()}::uuid, ${other}::uuid, ARRAY[${other}::uuid, ${person}::uuid], 'Dinner with both of them', 'g1'),
                       (${U}, 'note_batch', ${randomUUID()}::uuid, ${other}::uuid, ARRAY[${other}::uuid, ${person}::uuid], 'Batch passage', 'g2')`);

    const before = await scanFor(cat, person);
    check("the setup references the person widely", before.size >= 20, String(before.size));
    const { deleted } = await deleteContactForUser(U, person);
    check("the contact is deleted", deleted);
    const after = await scanFor(cat, person);
    check("their id is in no table at all", after.size === 0, [...after.entries()].map(([t, v]) => `${t}[${v.columns.join(",")}]`).join("; "));
    check("the group note's passage that listed them is dropped (the sweep rebuilds it)",
      (await n(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE user_id = ${U} AND content_hash = 'g1'`)) === 0);
    check("a passage of another kind keeps its other people",
      (await n(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE user_id = ${U} AND content_hash = 'g2' AND contact_ids = ARRAY[${other}::uuid]`)) === 1);
    check("the suggestion keeps the other person",
      (await n(sql`SELECT count(*)::int AS n FROM ai_suggestions WHERE user_id = ${U} AND related_contact_ids = ${JSON.stringify([other])}::jsonb`)) === 1);
    check("the sent email keeps the other person (the email itself is the user's and stays)",
      (await n(sql`SELECT count(*)::int AS n FROM email_sends WHERE user_id = ${U} AND contact_ids = ${JSON.stringify([other])}::jsonb`)) === 1);
  }

  console.log("\nRevert an import");
  {
    const U = "user_smoke_delrefs_b";
    const seed = await seedEverything(cat, U);
    const importId = String(seed.seeded.get("imports")!.id);
    const created = String(seed.seeded.get("contacts")!.id);
    const interactionId = String(seed.seeded.get("interactions")!.id);
    const [{ id: existing }] = await q<{ id: string }>(sql`INSERT INTO contacts (user_id, full_name) VALUES (${U}, 'Existing Person') RETURNING id`);
    await q(sql`UPDATE imports SET status = 'completed', reverted_at = NULL WHERE id = ${importId}::uuid`);
    await q(sql`UPDATE contacts SET updated_at = created_at, full_name = 'Zelda Quixote' WHERE id = ${created}::uuid`);
    await q(sql`UPDATE import_job_rows SET contact_id = ${created}::uuid, outcome = 'created', status = 'done',
                  payload = ${JSON.stringify({ name: "Zelda Quixote", thread: "full message thread" })}::jsonb WHERE user_id = ${U}`);
    // A row that never produced a contact: the import's detail view still lists it.
    await q(sql`INSERT INTO import_job_rows (import_id, user_id, row_index, payload, status)
                VALUES (${importId}::uuid, ${U}, 99, ${JSON.stringify({ name: "Failed Row Person" })}::jsonb, 'failed')`);
    // An imported message logged against someone already in the network: deleted by import_id.
    await q(sql`UPDATE interactions SET import_id = ${importId}::uuid, contact_id = ${existing}::uuid WHERE id = ${interactionId}::uuid`);
    await q(sql`INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
                VALUES (${U}, 'interaction', ${interactionId}::uuid, ${existing}::uuid, ARRAY[${existing}::uuid], 'imported message passage', 'r1')`);

    const result = await revertImport(U, importId);
    check("the revert runs", result.ok, JSON.stringify(result));
    check("the created contact is gone", (await n(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${created}::uuid`)) === 0);
    check("the imported interaction is gone", (await n(sql`SELECT count(*)::int AS n FROM interactions WHERE id = ${interactionId}::uuid`)) === 0);
    check("...and its search passages with it", (await n(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE source_id = ${interactionId}::uuid`)) === 0);
    check("the removed person's raw row is cleared",
      (await n(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE user_id = ${U} AND payload::text LIKE '%Zelda Quixote%'`)) === 0);
    check("a failed row keeps its payload for the import's detail view",
      (await n(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE user_id = ${U} AND payload::text LIKE '%Failed Row Person%'`)) === 1);
    check("the person who was already there is untouched", (await n(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${existing}::uuid`)) === 1);
  }

  console.log("\nThe hourly orphan-passage backstop");
  {
    const U = "user_smoke_delrefs_c";
    const [{ id: c }] = await q<{ id: string }>(sql`INSERT INTO contacts (user_id, full_name) VALUES (${U}, 'Kept Person') RETURNING id`);
    const [{ id: live }] = await q<{ id: string }>(sql`INSERT INTO interactions (user_id, contact_id, interaction_type, raw_notes) VALUES (${U}, ${c}::uuid, 'note', 'kept note') RETURNING id`);
    await q(sql`INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
                VALUES (${U}, 'interaction', ${randomUUID()}::uuid, ${c}::uuid, ARRAY[${c}::uuid], 'a deleted note', 'o1'),
                       (${U}, 'interaction', ${live}::uuid, ${c}::uuid, ARRAY[${c}::uuid], 'kept note', 'o2')`);
    const pruned = await pruneOrphanedMemoryChunksForAll();
    check("a passage whose note is gone is pruned", pruned >= 1 && (await n(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE content_hash = 'o1'`)) === 0);
    check("a passage whose note exists stays", (await n(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE content_hash = 'o2'`)) === 1);
  }

  if (failures > 0) throw new Error(`${failures} contact-delete-reference check(s) failed`);
  console.log("\nAll contact-delete-reference checks passed.");
}

run(main);
