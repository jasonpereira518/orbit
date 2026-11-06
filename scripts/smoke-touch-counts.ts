/**
 * `contact_touch_counts` stays equal to a live recount of `interactions` through every kind
 * of write: single and bulk inserts, AI-derived rows (never counted), re-typing,
 * re-directing and re-sourcing, a no-op update, moving rows to another contact, deletes,
 * deleting the contact itself, and the app's own paths (logging, deleting, merging).
 *
 * The triggers are `TOUCH_COUNT_DDL` in `src/db/index.ts`; the dashboard reads the table in
 * place of aggregating every interaction (`src/lib/dashboard-network.ts`).
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-touch-counts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { contactTouchCounts } from "../src/db/schema";
import { deleteInteractionForUser, logInteractionForUser } from "../src/lib/contact-writes";
import { mergeContacts } from "../src/lib/contact-merge";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-touch-counts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await ensureUserSettings(USER);

  /** Contacts whose stored tallies differ from a recount, for this user. */
  const drift = async () =>
    rowsOf<{ contact_id: string }>(
      await db.execute(sql`
        with live as (
          select contact_id,
            count(*) filter (where interaction_type in ('note','meeting_note'))::int a,
            count(*) filter (where interaction_type in ('meeting','in_person','call'))::int b,
            count(*) filter (where interaction_type in ('linkedin_message','email','message') and direction = 'in')::int c,
            count(*) filter (where interaction_type in ('linkedin_message','email','message') and direction = 'out')::int d,
            count(*) filter (where interaction_type in ('linkedin_message','email','message') and direction is null)::int e,
            count(*)::int f
          from interactions
          where user_id = ${USER} and (source is null or source <> 'ai_derived')
          group by contact_id)
        select coalesce(live.contact_id, s.contact_id)::text as contact_id
          from live full join (select * from contact_touch_counts where user_id = ${USER}) s
            on s.contact_id = live.contact_id
         where coalesce(live.a, 0) <> coalesce(s.note_interactions, 0)
            or coalesce(live.b, 0) <> coalesce(s.meeting_interactions, 0)
            or coalesce(live.c, 0) <> coalesce(s.message_inbound, 0)
            or coalesce(live.d, 0) <> coalesce(s.message_outbound, 0)
            or coalesce(live.e, 0) <> coalesce(s.message_undirected, 0)
            or coalesce(live.f, 0) <> coalesce(s.total, 0)`)
    );
  const agrees = async (label: string) => {
    const d = await drift();
    check(label, d.length === 0, d.length ? `${d.length} contact(s) drifted` : "");
  };
  const contact = async (name: string) =>
    rowsOf<{ id: string }>(
      await db.execute(sql`INSERT INTO contacts (user_id, full_name) VALUES (${USER}, ${name}) RETURNING id::text AS id`)
    )[0]!.id;

  const a = await contact("Ada Touch");
  const b = await contact("Ben Touch");
  const c = await contact("Cy Touch");
  await agrees("no interactions, no drift");

  console.log("\nInserts");
  await db.execute(sql`INSERT INTO interactions (user_id, contact_id, interaction_type) VALUES (${USER}, ${a}::uuid, 'note')`);
  await agrees("one note");
  await db.execute(sql`
    INSERT INTO interactions (user_id, contact_id, interaction_type, direction, source)
    SELECT ${USER}, (array[${a}::uuid, ${b}::uuid, ${c}::uuid])[1 + g % 3],
           (array['note','meeting_note','meeting','in_person','call','email','message','linkedin_message','other'])[1 + g % 9],
           (array['in','out',null])[1 + g % 3],
           (array[null,'gmail','ai_derived','linkedin'])[1 + g % 4]
      FROM generate_series(1, 400) g`);
  await agrees("400 mixed rows in one statement, AI-derived among them");
  const [aRow] = await db.select().from(contactTouchCounts).where(sql`${contactTouchCounts.contactId} = ${a}::uuid`);
  check("AI-derived rows are not counted", (aRow?.total ?? 0) < 1 + 400 / 3, JSON.stringify(aRow));

  console.log("\nUpdates");
  await db.execute(sql`UPDATE interactions SET interaction_type = 'meeting' WHERE user_id = ${USER} AND interaction_type = 'note'`);
  await agrees("re-typed notes to meetings");
  await db.execute(sql`UPDATE interactions SET direction = 'out' WHERE user_id = ${USER} AND direction IS NULL AND interaction_type = 'email'`);
  await agrees("re-directed undirected email");
  await db.execute(sql`UPDATE interactions SET source = 'ai_derived' WHERE user_id = ${USER} AND source = 'gmail'`);
  await agrees("re-sourced rows to AI-derived");
  await db.execute(sql`UPDATE interactions SET source = NULL WHERE user_id = ${USER} AND source = 'ai_derived' AND interaction_type = 'call'`);
  await agrees("and some back");
  const before = await db.select().from(contactTouchCounts).where(sql`${contactTouchCounts.userId} = ${USER}`);
  await db.execute(sql`UPDATE interactions SET same_day_order = same_day_order + 1 WHERE user_id = ${USER}`);
  const after = await db.select().from(contactTouchCounts).where(sql`${contactTouchCounts.userId} = ${USER}`);
  check("an update that changes no tally changes nothing", JSON.stringify(before) === JSON.stringify(after));
  await db.execute(sql`UPDATE interactions SET contact_id = ${c}::uuid WHERE user_id = ${USER} AND contact_id = ${b}::uuid AND interaction_type = 'email'`);
  await agrees("moved one contact's email to another");

  console.log("\nDeletes");
  await db.execute(sql`DELETE FROM interactions WHERE user_id = ${USER} AND interaction_type = 'linkedin_message'`);
  await agrees("deleted every LinkedIn message");
  await db.execute(sql`DELETE FROM contacts WHERE id = ${c}::uuid`);
  await agrees("deleted a contact (its interactions cascade)");
  check(
    "its counts row went with it",
    (await db.select().from(contactTouchCounts).where(sql`${contactTouchCounts.contactId} = ${c}::uuid`)).length === 0
  );

  console.log("\nThe app's own paths");
  // `revalidatePath` needs a Next.js request; outside one it throws after the write is done.
  const tolerate = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (!String(err instanceof Error ? err.message : err).startsWith("Invariant: static generation store missing")) throw err;
      return null;
    }
  };
  await tolerate(() => logInteractionForUser(USER, { contactId: b, interactionType: "call", rawNotes: "Caught up" }));
  await agrees("logInteractionForUser");
  const [call] = rowsOf<{ id: string }>(
    await db.execute(sql`SELECT id::text AS id FROM interactions WHERE contact_id = ${b}::uuid AND raw_notes = 'Caught up'`)
  );
  check("the logged call is there", Boolean(call));
  await tolerate(() => deleteInteractionForUser(USER, call!.id));
  await agrees("deleteInteractionForUser");
  await tolerate(() => mergeContacts(USER, a, b, { reason: "smoke", confidence: 1 }));
  await agrees("mergeContacts moves the loser's interactions to the winner");

  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  check(
    "nothing left behind for the user",
    (await db.select().from(contactTouchCounts).where(sql`${contactTouchCounts.userId} = ${USER}`)).length === 0
  );
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nTouch count checks passed.");
});
