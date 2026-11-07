/**
 * "Met or talked with": the rule behind every unprompted alert, as a truth table, with the
 * pure function and its SQL twin held equal, and the two alert gates built on it exercised
 * through the bell (`loadNotificationPanel`).
 *
 * Runs against a throwaway PGlite. Run: npx tsx scripts/smoke-met-contact.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "../src/db";
import { hasMetOrConversed, metContactIds, metContactSql, type MetSignals } from "../src/lib/met-contact";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { ensureUserSettings } from "../src/lib/user-settings";

const USER = "smoke-met-contact";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const NONE: MetSignals = { pin: null, pastEncounters: 0, noteInteractions: 0, messageInbound: 0, messageOutbound: 0 };

type Row = { type: string; direction?: "in" | "out" | null; source?: string | null; when?: string };
type Case = { name: string; met: boolean; signals: Partial<MetSignals>; pin?: "in" | "out"; rows?: Row[]; notes?: string };

const PAST = "now() - interval '3 days'";
const CASES: Case[] = [
  { name: "address-book import, nothing else", met: false, signals: {} },
  { name: "contacts.notes prose only", met: false, signals: {}, notes: "Added from outreach campaign" },
  { name: "pinned in, no evidence", met: false, signals: { pin: "in" }, pin: "in" },
  { name: "past meeting", met: true, signals: { pastEncounters: 1 }, rows: [{ type: "meeting", when: PAST }] },
  { name: "past in-person", met: true, signals: { pastEncounters: 1 }, rows: [{ type: "in_person", when: PAST }] },
  { name: "past call", met: true, signals: { pastEncounters: 1 }, rows: [{ type: "call", when: PAST }] },
  { name: "past event (spoke to them)", met: true, signals: { pastEncounters: 1 }, rows: [{ type: "event", when: PAST }] },
  { name: "future calendar meeting only", met: false, signals: {}, rows: [{ type: "meeting", when: "now() + interval '3 days'" }] },
  { name: "past meeting, ai_derived", met: false, signals: {}, rows: [{ type: "meeting", source: "ai_derived", when: PAST }] },
  { name: "note interaction", met: true, signals: { noteInteractions: 1 }, rows: [{ type: "note" }] },
  { name: "meeting note interaction", met: true, signals: { noteInteractions: 1 }, rows: [{ type: "meeting_note" }] },
  { name: "ai_derived note", met: false, signals: {}, rows: [{ type: "note", source: "ai_derived" }] },
  {
    name: "messages one way (they never replied)",
    met: false,
    signals: { messageOutbound: 3 },
    rows: Array.from({ length: 3 }, () => ({ type: "linkedin_message", direction: "out" as const })),
  },
  {
    name: "inbound only (cold recruiter)",
    met: false,
    signals: { messageInbound: 2 },
    rows: [{ type: "linkedin_message", direction: "in" }, { type: "email", direction: "in" }],
  },
  {
    name: "ten undirected messages",
    met: false,
    signals: {},
    rows: Array.from({ length: 10 }, () => ({ type: "linkedin_message", direction: null })),
  },
  {
    name: "one message each way",
    met: true,
    signals: { messageInbound: 1, messageOutbound: 1 },
    rows: [{ type: "email", direction: "in" }, { type: "email", direction: "out" }],
  },
  { name: "pinned out, past meeting", met: false, signals: { pin: "out", pastEncounters: 1 }, pin: "out", rows: [{ type: "meeting", when: PAST }] },
];

run(async () => {
  const db = await getDb();
  await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  await ensureUserSettings(USER);

  console.log("Truth table: pure rule and SQL twin");
  const ids = new Map<string, string>();
  for (const c of CASES) {
    const id = rowsOf<{ id: string }>(
      await db.execute(sql`
        INSERT INTO contacts (user_id, full_name, constellation_pin, notes)
        VALUES (${USER}, ${c.name}, ${c.pin ?? null}, ${c.notes ?? null}) RETURNING id::text AS id`)
    )[0]!.id;
    ids.set(c.name, id);
    for (const r of c.rows ?? []) {
      await db.execute(sql`
        INSERT INTO interactions (user_id, contact_id, interaction_type, direction, source, interaction_date)
        VALUES (${USER}, ${id}::uuid, ${r.type}, ${r.direction ?? null}, ${r.source ?? null},
                ${sql.raw(r.when ?? "now()")})`);
    }
    check(`pure: ${c.name}`, hasMetOrConversed({ ...NONE, ...c.signals }) === c.met);
  }

  const bySql = rowsOf<{ id: string; met: boolean }>(
    await db.execute(sql`
      SELECT c.id::text AS id, ${metContactSql(sql`c.id`, USER)} AS met
        FROM contacts c WHERE c.user_id = ${USER}`)
  );
  const sqlMet = new Map(bySql.map((r) => [r.id, r.met]));
  for (const c of CASES) check(`sql: ${c.name}`, sqlMet.get(ids.get(c.name)!) === c.met);

  const everyone = [...ids.values()];
  const expected = CASES.filter((c) => c.met).map((c) => ids.get(c.name)!).sort();
  const listed = [...(await metContactIds(USER))].sort();
  check("metContactIds() with no ids is the same set", JSON.stringify(listed) === JSON.stringify(expected), `${listed.length} vs ${expected.length}`);
  const given = [...(await metContactIds(USER, everyone))].sort();
  check("metContactIds(ids) is the same set", JSON.stringify(given) === JSON.stringify(expected));
  check("metContactIds([]) is empty", (await metContactIds(USER, [])).size === 0);

  console.log("\nThe bell: who may alert");
  const stranger = ids.get("address-book import, nothing else")!;
  const friend = ids.get("past meeting")!;
  const now = new Date();
  const past = new Date(now.getTime() - 86_400_000);
  const insertReminder = async (contactId: string | null, title: string, createdBy: string) => {
    await db.execute(sql`
      INSERT INTO reminders (user_id, contact_id, title, due_date, status, created_by)
      VALUES (${USER}, ${contactId}::uuid, ${title}, ${past}, 'pending', ${createdBy})`);
  };
  await insertReminder(stranger, "own reminder, never met", "user");
  await insertReminder(stranger, "generated, never met", "system");
  await insertReminder(stranger, "calendar, never met", "calendar_sync");
  await insertReminder(friend, "generated, met", "system");
  await insertReminder(null, "generated, about nobody", "ai");

  const reminderTitles = async () =>
    (await loadNotificationPanel(USER, now, { withAlerts: false })).items
      .filter((i) => i.kind === "reminder")
      .map((i) => i.title)
      .sort();
  const got = await reminderTitles();
  check(
    "own reminder alerts for a stranger; generated ones do not",
    JSON.stringify(got) === JSON.stringify(["generated, about nobody", "generated, met", "own reminder, never met"]),
    JSON.stringify(got)
  );

  console.log("\nThe bell: contact follow-up rows");
  const otherStranger = ids.get("future calendar meeting only")!;
  await db.execute(
    sql`UPDATE contacts SET next_follow_up_at = ${past} WHERE id IN (${stranger}::uuid, ${otherStranger}::uuid, ${friend}::uuid)`
  );
  const panel = await loadNotificationPanel(USER, now, { withAlerts: false });
  const followUps = panel.items.filter((i) => i.kind === "follow_up").map((i) => i.contactId).sort();
  check(
    "a due follow-up shows for the met contact and for the stranger the user set a reminder for, not the other stranger",
    JSON.stringify(followUps) === JSON.stringify([friend, stranger].sort()),
    JSON.stringify(followUps)
  );
  check("the badge counts only what may alert", panel.dueCount === panel.items.filter((i) => i.urgency === "due").length);

  await db.execute(sql`DELETE FROM reminders WHERE user_id = ${USER}`);
  await db.execute(sql`DELETE FROM contacts WHERE user_id = ${USER}`);
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll met-contact checks passed");
});
