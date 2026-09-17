/**
 * Convert the free-text `contacts.opportunities` array into typed `contact_opportunities`
 * rows, before anything re-derives that column and throws the old text away.
 *
 * THIS MUST RUN BEFORE THE FEATURE IS USED IN ANGER, and the reason is a data-loss window.
 * `contacts.opportunities` used to be written directly by the capture save as whatever prose
 * the model produced ("intro to Raj", "hiring for infra"). It is now a MIRROR derived from
 * `contact_opportunities` by `syncContactOpportunityMirror`. The first time anything touches
 * an opportunity for a contact — a new capture, or any CRUD action — that sync rewrites the
 * column from the typed rows, and a contact with legacy prose but no typed rows loses it.
 *
 * So: every legacy string becomes a row first. Kind is inferred, not guessed at random —
 * `looksLikeReferral` runs over the text, then `normalizeOpportunityKind`, then `other`.
 *
 * Idempotent. Each legacy string gets a deterministic `item_hash` derived from the contact
 * and the text, and the insert is `ON CONFLICT DO NOTHING` on `(user_id, item_hash)`, so a
 * second run writes nothing. Safe to run repeatedly and safe to run while the app is up.
 *
 * Run: npx tsx scripts/backfill-opportunities.ts [--dry]
 */
import "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import {
  insertOpportunities,
  legacyOpportunityDrafts,
  syncContactOpportunityMirror,
} from "../src/lib/contact-opportunities";

const BATCH = 500;

async function main() {
  const dry = process.argv.includes("--dry");
  const db = await getDb();

  let offset = 0;
  let contactsSeen = 0;
  let rowsWritten = 0;
  let contactsTouched = 0;
  const byKind = new Map<string, number>();

  for (;;) {
    const result = await db.execute(sql`
      select id, user_id, opportunities
      from contacts
      where opportunities is not null
        and jsonb_typeof(opportunities) = 'array'
        and jsonb_array_length(opportunities) > 0
      order by id
      limit ${BATCH} offset ${offset}
    `);
    const rows = rowsOf<{ id: string; user_id: string; opportunities: unknown }>(result);
    if (!rows.length) break;
    offset += rows.length;

    for (const row of rows) {
      const legacy = Array.isArray(row.opportunities) ? (row.opportunities as unknown[]) : [];
      const labels = legacy.filter((v): v is string => typeof v === "string");
      if (!labels.length) continue;
      contactsSeen += 1;

      const drafts = legacyOpportunityDrafts(row.id, labels);
      for (const d of drafts) byKind.set(d.kind, (byKind.get(d.kind) ?? 0) + 1);

      if (dry) {
        rowsWritten += drafts.length;
        continue;
      }

      const inserted = await insertOpportunities(row.user_id, drafts);
      rowsWritten += inserted.length;
      if (inserted.length) {
        contactsTouched += 1;
        // Re-derive immediately, so the column now reflects the rows rather than the prose it
        // was built from. Without this the contact stays in the pre-migration state until
        // something else happens to touch it.
        await syncContactOpportunityMirror(row.user_id, row.id);
      }
    }
  }

  const kinds = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  console.log(
    `${dry ? "[dry] " : ""}contacts with legacy opportunities: ${contactsSeen}; ` +
      `rows ${dry ? "would be written" : "written"}: ${rowsWritten}; ` +
      `contacts re-mirrored: ${contactsTouched}`
  );
  if (kinds) console.log(`  kinds: ${kinds}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
