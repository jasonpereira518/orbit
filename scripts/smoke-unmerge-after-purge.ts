/**
 * Deleted data must not come back through "undo merge".
 *
 * `privacy/probe-selective-deletion.ts` (S4) found that after "Delete AI suggestions and search
 * index", undoing an earlier merge re-inserted the loser's embeddings, Radar card and AI
 * brief — the merge archive held JSON copies, no purge touched them, and unmerge replayed
 * every archived table. Now:
 *   - a merge no longer archives derived rows (they are rebuilt);
 *   - unmerge restores only the person's own data, even from an archive written before that;
 *   - the insights, notes and tags purges strip their tables' copies from existing archives;
 *   - past `MERGE_UNDO_DAYS` the archive's copy of the person is cleared and undo refuses,
 *     while the merged-away id still resolves to the survivor.
 *
 * Run: npx tsx scripts/smoke-unmerge-after-purge.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  expireMergeArchives,
  isMergeUndoable,
  mergeContacts,
  resolveContactId,
  unmergeContacts,
} from "../src/lib/contact-merge";
import { MERGE_UNDO_DAYS } from "../src/lib/merge-archive";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-unmerge-after-purge";
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

async function contact(name: string): Promise<string> {
  return (await q<{ id: string }>(sql`INSERT INTO contacts (user_id, full_name) VALUES (${USER}, ${name}) RETURNING id`))[0].id;
}

/** The three derived rows a pre-change merge would have archived for `contactId`. */
async function derivedRows(contactId: string) {
  const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await q(sql`INSERT INTO contact_briefs (contact_id, user_id, standing) VALUES (${contactId}::uuid, ${USER}, 'AI brief: job hunting, do not share')`);
  await q(sql`INSERT INTO recommendations (user_id, contact_id, kind, score, bucket, expires_at, inputs_hash)
              VALUES (${USER}, ${contactId}::uuid, 'reconnect', 40, 'soon', ${expires}, 'h')`);
  await q(sql`INSERT INTO contact_embeddings (user_id, contact_id, source_type, embedding, content)
              VALUES (${USER}, ${contactId}::uuid, 'contact', '[0.1]'::jsonb, 'plaintext passage about the person')`);
}

const derivedCount = (contactId: string) =>
  n(sql`SELECT ((SELECT count(*) FROM contact_briefs WHERE contact_id = ${contactId}::uuid)
             + (SELECT count(*) FROM recommendations WHERE contact_id = ${contactId}::uuid)
             + (SELECT count(*) FROM contact_embeddings WHERE contact_id = ${contactId}::uuid))::int AS n`);

/** Rewrites a fresh archive to look like one written before this change. */
async function makeLegacyArchive(mergeId: string, loser: string) {
  const legacy = {
    contact_briefs: [{ contact_id: loser, user_id: USER, standing: "AI brief: job hunting, do not share", recent_discussions: [], generated_at: new Date().toISOString() }],
    recommendations: [{ id: crypto.randomUUID(), user_id: USER, contact_id: loser, kind: "reconnect", score: 40, bucket: "soon", expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), inputs_hash: "h" }],
    contact_embeddings: [{ id: crypto.randomUUID(), user_id: USER, contact_id: loser, source_type: "contact", source_id: null, embedding: [0.1], content: "plaintext passage about the person", created_at: new Date().toISOString() }],
  };
  await q(sql`UPDATE contact_merges SET deleted = deleted || ${JSON.stringify(legacy)}::jsonb WHERE id = ${mergeId}::uuid`);
}

async function main() {
  console.log("A new merge archives no derived rows");
  {
    const winner = await contact("Grace Hopper");
    const loser = await contact("Grace B. Hopper");
    await derivedRows(loser);
    const { mergeId } = await mergeContacts(USER, winner, loser);
    const [archive] = await q<{ deleted: Record<string, unknown> }>(sql`SELECT deleted FROM contact_merges WHERE id = ${mergeId}::uuid`);
    const keys = Object.keys(archive.deleted ?? {});
    check("no brief, Radar card or embedding copy in the archive", !keys.some((k) => ["contact_briefs", "recommendations", "contact_embeddings"].includes(k)), keys.join(","));
    await unmergeContacts(USER, mergeId);
    check("unmerge brings the person back", (await n(sql`SELECT count(*)::int AS n FROM contacts WHERE id = ${loser}::uuid`)) === 1);
    check("...without their derived rows (rebuilt, not restored)", (await derivedCount(loser)) === 0);
  }

  console.log("\nAn archive written before the change: unmerge restores only the person's own data");
  {
    const winner = await contact("Ada Lovelace");
    const loser = await contact("Augusta Ada King");
    const { mergeId } = await mergeContacts(USER, winner, loser);
    await makeLegacyArchive(mergeId, loser);
    await unmergeContacts(USER, mergeId);
    check("the legacy brief, card and embedding are not re-inserted", (await derivedCount(loser)) === 0, String(await derivedCount(loser)));
  }

  console.log("\nDelete AI data, then undo an older merge");
  {
    const winner = await contact("Katherine Johnson");
    const loser = await contact("Katherine G. Johnson");
    const { mergeId } = await mergeContacts(USER, winner, loser);
    await makeLegacyArchive(mergeId, loser);
    await purgeUserData(USER, { only: ["insights"] });
    const [archive] = await q<{ deleted: Record<string, unknown> }>(sql`SELECT deleted FROM contact_merges WHERE id = ${mergeId}::uuid`);
    const keys = Object.keys(archive.deleted ?? {});
    check("the insights purge strips the archived AI copies", !keys.some((k) => ["contact_briefs", "recommendations", "contact_embeddings"].includes(k)), keys.join(","));
    await unmergeContacts(USER, mergeId);
    check("undo after the purge resurrects nothing derived", (await derivedCount(loser)) === 0);
  }

  console.log("\nDelete tags, then undo: the archived tagging no longer breaks the undo");
  {
    const winner = await contact("Dorothy Vaughan");
    const loser = await contact("Dorothy J. Vaughan");
    const [tag] = await q<{ id: string }>(sql`INSERT INTO tags (user_id, name) VALUES (${USER}, 'nasa') RETURNING id`);
    await q(sql`INSERT INTO contact_tags (contact_id, tag_id) VALUES (${winner}::uuid, ${tag.id}::uuid), (${loser}::uuid, ${tag.id}::uuid)`);
    const { mergeId } = await mergeContacts(USER, winner, loser);
    const [before] = await q<{ deleted: Record<string, unknown> }>(sql`SELECT deleted FROM contact_merges WHERE id = ${mergeId}::uuid`);
    check("the colliding tagging was archived (the setup is real)", Array.isArray(before.deleted?.contact_tags));
    await purgeUserData(USER, { only: ["tags"] });
    const [after] = await q<{ deleted: Record<string, unknown> }>(sql`SELECT deleted FROM contact_merges WHERE id = ${mergeId}::uuid`);
    check("the tags purge strips the archived tagging", !("contact_tags" in (after.deleted ?? {})));
    let undone = true;
    try {
      await unmergeContacts(USER, mergeId);
    } catch {
      undone = false;
    }
    check("the undo still works", undone);
  }

  console.log(`\nPast ${MERGE_UNDO_DAYS} days: the copy is cleared, the alias stays, undo refuses`);
  {
    const winner = await contact("Mary Jackson");
    const loser = await contact("Mary W. Jackson");
    const { mergeId } = await mergeContacts(USER, winner, loser);
    await q(sql`UPDATE contact_merges SET merged_at = now() - interval '31 days' WHERE id = ${mergeId}::uuid`);
    const [row] = await q<{ merged_at: string; status: string }>(sql`SELECT merged_at, status FROM contact_merges WHERE id = ${mergeId}::uuid`);
    check("isMergeUndoable says no", !isMergeUndoable({ mergedAt: row.merged_at, status: row.status }));
    const expired = await expireMergeArchives({ now: new Date() });
    check("the hourly job expires it", expired >= 1);
    const [cleared] = await q<{ loser_snapshot: Record<string, unknown>; deleted: Record<string, unknown>; status: string }>(
      sql`SELECT loser_snapshot, deleted, status FROM contact_merges WHERE id = ${mergeId}::uuid`
    );
    check("the snapshot of the person is cleared", Object.keys(cleared.loser_snapshot).length === 0 && Object.keys(cleared.deleted).length === 0);
    check("the merged-away id still resolves to the survivor", (await resolveContactId(USER, loser)) === winner);
    let refused = false;
    try {
      await unmergeContacts(USER, mergeId);
    } catch (err) {
      refused = /can no longer be undone/.test((err as Error).message);
    }
    check("undo refuses with a clear message", refused);
    const recent = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM contact_merges WHERE user_id = ${USER} AND status = 'expired'`);
    check("running the job again expires nothing more", (await expireMergeArchives({ now: new Date() })) === 0 && recent[0].n === 1);
  }

  if (failures > 0) throw new Error(`${failures} unmerge-after-purge check(s) failed`);
  console.log("\nAll unmerge-after-purge checks passed.");
}

run(main);
