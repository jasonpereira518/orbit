/**
 * PROBE: selective deletion and undo, against a seeded throwaway PGlite database.
 *
 *   S1  Delete one contact (`deleteContactForUser`). What still references the person's id,
 *       and what free text still names them?
 *   S2  Delete one interaction (`deleteInteractionForUser`). Are its search passages gone?
 *   S3  Revert an import (`revertImport`). Are the reverted interactions' search passages and
 *       the raw import payload gone?
 *   S4  Delete "AI suggestions and search index" (insights purge), then undo an earlier merge
 *       (`unmergeContacts`). Does deleted derived data come back?
 *
 * Each scenario seeds its own fake user with lib/seed-everything.ts. Fake data only.
 * Run: npx tsx privacy/probe-selective-deletion.ts
 */
import "../scripts/smoke/_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { deleteContactForUser } from "../src/lib/contact-delete";
import { deleteInteractionForUser } from "../src/lib/contact-writes";
import { revertImport } from "../src/lib/import-revert";
import { mergeContacts, unmergeContacts } from "../src/lib/contact-merge";
import { purgeUserData } from "../src/lib/user-data";
import { readCatalog, PROSE_NAME, isTextish, type Catalog } from "./lib/catalog";
import { seedEverything, scanFor } from "./lib/seed-everything";
import { run } from "../scripts/smoke/_env";

const PERSON = "Zelda Quixote"; // the third party whose record gets deleted
const out: Record<string, unknown> = {};

async function one<T>(q: ReturnType<typeof sql>): Promise<T | undefined> {
  const db = await getDb();
  return rowsOf<T>(await db.execute(q))[0];
}
async function count(q: ReturnType<typeof sql>): Promise<number> {
  return Number((await one<{ n: number }>(q))?.n ?? 0);
}

/** Point every non-FK contact reference in `user`'s rows at `contactId`, and name the person in prose. */
async function aboutThePerson(cat: Catalog, user: string, contactId: string) {
  const db = await getDb();
  const fkCols = new Set(cat.fks.flatMap((f) => f.columns.map((c) => `${f.table}.${c}`)));
  for (const table of cat.tables) {
    const cols = cat.columns.get(table)!;
    if (!cols.some((c) => c.column === "user_id")) continue;
    for (const c of cols) {
      if (fkCols.has(`${table}.${c.column}`) || c.generated) continue;
      const id = sql.identifier(c.column);
      try {
        if (/contact_id$/.test(c.column) && c.type === "uuid") {
          await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${id} = ${contactId}::uuid WHERE user_id = ${user}`);
        } else if (/contact_ids$/.test(c.column) && c.type === "uuid[]") {
          await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${id} = ARRAY[${contactId}::uuid] WHERE user_id = ${user}`);
        } else if (/contact_ids$/.test(c.column) && c.type === "jsonb") {
          await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${id} = ${JSON.stringify([contactId])}::jsonb WHERE user_id = ${user}`);
        } else if (PROSE_NAME.test(c.column) && isTextish(c.type) && /^text$/.test(c.type)) {
          await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${id} = ${id} || ${" met " + PERSON} WHERE user_id = ${user} AND ${id} IS NOT NULL`);
        }
      } catch {
        // a CHECK on that column; leave it as seeded
      }
    }
  }
}

run(async () => {
  const cat = await readCatalog();
  const db = await getDb();

  // ------------------------------------------------------------------ S1 delete one contact
  {
    const U = "user_privS1aa01";
    const seed = await seedEverything(cat, U);
    const contactId = String(seed.seeded.get("contacts")!.id);
    await db.execute(sql`UPDATE contacts SET full_name = ${PERSON}, email = 'zelda@example.test' WHERE id = ${contactId}::uuid`);
    await aboutThePerson(cat, U, contactId);
    // A group note: the passage's primary subject is someone else, Zelda is only in contact_ids.
    await db.execute(sql`
      INSERT INTO contacts (user_id, full_name) VALUES (${U}, 'Other Person')`);
    const other = await one<{ id: string }>(sql`SELECT id FROM contacts WHERE user_id = ${U} AND full_name = 'Other Person'`);
    await db.execute(sql`
      INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
      VALUES (${U}, 'interaction', ${randomUUID()}::uuid, ${other!.id}::uuid, ARRAY[${other!.id}::uuid, ${contactId}::uuid],
              ${"Lunch with Other Person and " + PERSON + " — she is leaving her job in March"}, 'h')`);

    const idBefore = await scanFor(cat, contactId);
    const nameBefore = await scanFor(cat, PERSON);
    const res = await deleteContactForUser(U, contactId);
    const idAfter = await scanFor(cat, contactId);
    const nameAfter = await scanFor(cat, PERSON);
    out.S1_deleteContact = {
      deleted: res.deleted,
      tablesReferencingIdBefore: idBefore.size,
      tablesStillReferencingId: Object.fromEntries(idAfter),
      tablesNamingPersonBefore: nameBefore.size,
      tablesStillNamingPerson: Object.fromEntries(nameAfter),
    };
    console.log(`\n[S1] delete one contact: deleted=${res.deleted}`);
    console.log(`     tables referencing the contact id: before ${idBefore.size}, after ${idAfter.size}`);
    for (const [t, v] of idAfter) console.log(`       id survives in ${t} [${v.columns.join(", ")}]`);
    console.log(`     tables naming "${PERSON}" in text: before ${nameBefore.size}, after ${nameAfter.size}`);
    for (const [t, v] of nameAfter) console.log(`       name survives in ${t} [${v.columns.join(", ")}]`);
  }

  // ------------------------------------------------------------------ S2 delete one interaction
  {
    const U = "user_privS2bb02";
    const seed = await seedEverything(cat, U);
    const interactionId = String(seed.seeded.get("interactions")!.id);
    const contactId = String(seed.seeded.get("contacts")!.id);
    await db.execute(sql`
      INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
      VALUES (${U}, 'interaction', ${interactionId}::uuid, ${contactId}::uuid, ARRAY[${contactId}::uuid], 'passage of the deleted note', 'h2')`);
    const before = await count(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE source_id = ${interactionId}::uuid`);
    await deleteInteractionForUser(U, interactionId, { skipEmbedding: true, skipSummary: true, skipRevalidate: true } as never);
    const after = await count(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE source_id = ${interactionId}::uuid`);
    const otherKinds = rowsOf<{ source_kind: string; n: number }>(
      await db.execute(sql`SELECT source_kind, count(*)::int AS n FROM memory_chunks WHERE user_id = ${U} GROUP BY 1`)
    );
    out.S2_deleteInteraction = { passagesBefore: before, passagesAfter: after, remainingPassagesByKind: otherKinds };
    console.log(`\n[S2] delete one interaction: its search passages before=${before} after=${after}`);
  }

  // ------------------------------------------------------------------ S3 revert an import
  {
    const U = "user_privS3cc03";
    const seed = await seedEverything(cat, U);
    const importId = String(seed.seeded.get("imports")!.id);
    const contactId = String(seed.seeded.get("contacts")!.id);
    const interactionId = String(seed.seeded.get("interactions")!.id);
    await db.execute(sql`UPDATE imports SET status = 'completed', reverted_at = NULL WHERE id = ${importId}::uuid`);
    await db.execute(sql`UPDATE contacts SET updated_at = created_at, full_name = ${PERSON} WHERE id = ${contactId}::uuid`);
    await db.execute(sql`UPDATE import_job_rows SET contact_id = ${contactId}::uuid, outcome = 'created', status = 'done',
                           payload = ${JSON.stringify({ name: PERSON, email: "zelda@example.test" })}::jsonb WHERE user_id = ${U}`);
    // An imported interaction that is NOT tied to the created contact (e.g. a message thread
    // logged against an existing person) — deleted by import_id, not by cascade.
    await db.execute(sql`INSERT INTO contacts (user_id, full_name) VALUES (${U}, 'Existing Person')`);
    const existing = await one<{ id: string }>(sql`SELECT id FROM contacts WHERE user_id = ${U} AND full_name = 'Existing Person'`);
    await db.execute(sql`UPDATE interactions SET import_id = ${importId}::uuid, contact_id = ${existing!.id}::uuid WHERE id = ${interactionId}::uuid`);
    await db.execute(sql`
      INSERT INTO memory_chunks (user_id, source_kind, source_id, contact_id, contact_ids, content, content_hash)
      VALUES (${U}, 'interaction', ${interactionId}::uuid, ${existing!.id}::uuid, ARRAY[${existing!.id}::uuid],
              'imported message passage', 'h3')`);
    const result = await revertImport(U, importId);
    const interactionLeft = await count(sql`SELECT count(*)::int AS n FROM interactions WHERE id = ${interactionId}::uuid`);
    const passagesLeft = await count(sql`SELECT count(*)::int AS n FROM memory_chunks WHERE source_id = ${interactionId}::uuid`);
    const payloadLeft = await count(sql`SELECT count(*)::int AS n FROM import_job_rows WHERE user_id = ${U} AND payload::text LIKE ${"%" + PERSON + "%"}`);
    const contactLeft = await count(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${contactId}::uuid`);
    out.S3_revertImport = { result, createdContactLeft: contactLeft, importedInteractionLeft: interactionLeft, orphanPassagesLeft: passagesLeft, rawPayloadRowsNamingPersonLeft: payloadLeft };
    console.log(`\n[S3] revert import: ${JSON.stringify(result)}`);
    console.log(`     created contact left=${contactLeft}, imported interaction left=${interactionLeft}, ORPHAN passages left=${passagesLeft}, raw payload rows naming the person left=${payloadLeft}`);
  }

  // ------------------------------------------------------------------ S4 insights purge, then unmerge
  {
    const U = "user_privS4dd04";
    const seed = await seedEverything(cat, U);
    const winner = String(seed.seeded.get("contacts")!.id);
    const loser = randomUUID();
    await db.execute(sql`INSERT INTO contacts (id, user_id, full_name) VALUES (${loser}::uuid, ${U}, ${PERSON})`);
    // Give the loser its own derived rows by cloning the winner's seeded ones.
    const derived = ["contact_embeddings", "recommendations", "contact_briefs", "contact_signals", "relationship_digests"];
    const cloned: Record<string, boolean> = {};
    for (const t of derived) {
      const cols = cat.columns.get(t)!.filter((c) => !c.generated && !c.identity).map((c) => c.column);
      const pick = cols.map((c) => (c === "id" && cat.columns.get(t)!.find((x) => x.column === "id")?.type === "uuid" ? sql`gen_random_uuid()` : c === "contact_id" ? sql`${loser}::uuid` : sql.identifier(c)));
      try {
        await db.execute(sql`INSERT INTO ${sql.identifier(t)} (${sql.join(cols.map((c) => sql.identifier(c)), sql`, `)})
                             SELECT ${sql.join(pick, sql`, `)} FROM ${sql.identifier(t)} WHERE contact_id = ${winner}::uuid LIMIT 1`);
        cloned[t] = (await count(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE contact_id = ${loser}::uuid`)) > 0;
      } catch (err) {
        cloned[t] = false;
        console.log(`     (could not clone ${t}: ${(err as Error).message.split("\n")[0]})`);
      }
    }
    await db.execute(sql`UPDATE contact_briefs SET summary = ${"AI brief: " + PERSON + " is job hunting"} WHERE contact_id = ${loser}::uuid`).catch(() => {});

    const merge = await mergeContacts(U, winner, loser);
    const mergeRow = await one<{ id: string; deleted: unknown }>(sql`SELECT id, deleted FROM contact_merges WHERE user_id = ${U} ORDER BY merged_at DESC LIMIT 1`);
    const archivedKeys = Object.keys((mergeRow?.deleted as Record<string, unknown>) ?? {});

    await purgeUserData(U, { only: ["insights"] });
    const afterPurge: Record<string, number> = {};
    for (const t of derived) afterPurge[t] = await count(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE user_id = ${U}`);
    const archiveStillHolds = await count(sql`SELECT count(*)::int AS n FROM contact_merges WHERE user_id = ${U} AND deleted::text <> '{}'`);

    let unmerge: unknown;
    try {
      unmerge = await unmergeContacts(U, mergeRow!.id);
    } catch (err) {
      unmerge = { error: (err as Error).message.split("\n")[0] };
    }
    const afterUnmerge: Record<string, number> = {};
    for (const t of derived) afterUnmerge[t] = await count(sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE contact_id = ${loser}::uuid`);
    out.S4_insightsPurgeThenUnmerge = { cloned, merge, archivedKeys, afterInsightsPurgeRowsForUser: afterPurge, mergeArchivesHoldingDerivedRows: archiveStillHolds, unmerge, loserDerivedRowsAfterUnmerge: afterUnmerge };
    console.log(`\n[S4] merge archived derived rows: [${archivedKeys.join(", ")}]`);
    console.log(`     after insights purge (rows for user): ${JSON.stringify(afterPurge)}; merge archives still holding derived rows: ${archiveStillHolds}`);
    console.log(`     unmerge: ${JSON.stringify(unmerge)}`);
    console.log(`     loser's derived rows after unmerge (RESURRECTED if > 0 for a purged table): ${JSON.stringify(afterUnmerge)}`);
  }

  mkdirSync("privacy/out", { recursive: true });
  writeFileSync("privacy/out/selective-deletion.json", JSON.stringify(out, null, 2));
  console.log("\nwrote privacy/out/selective-deletion.json");
});
