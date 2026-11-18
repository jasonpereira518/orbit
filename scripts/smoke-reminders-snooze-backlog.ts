/**
 * "Snooze everything overdue from notes" (`snoozeOverdueFromNotes`): moves only the notes
 * backlog that is overdue and not critical/high, for the signed-in user, and one undo token
 * puts every due date back (250 rows is more than one BULK_LIMIT batch).
 *
 * Run: npx tsx scripts/smoke-reminders-snooze-backlog.ts
 */
import "./smoke/_env";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { noteBatches, reminders, userSettings } from "../src/db/schema";
import { ensureUserSettings } from "../src/lib/user-settings";
import { snoozeOverdueFromNotes, undoSnoozeOverdueFromNotes } from "../src/actions/reminders";
import { checker } from "./smoke/check";

const t = checker();
const USER = "demo-user";
const OTHER = "other-user";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
const noon = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T12:00:00Z`);

async function main() {
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  (process.env as Record<string, string>).NODE_ENV = "development";

  const db = await getDb();
  for (const u of [USER, OTHER]) {
    await db.delete(reminders).where(eq(reminders.userId, u));
    await db.delete(noteBatches).where(eq(noteBatches.userId, u));
  }
  await db.delete(userSettings).where(inArray(userSettings.userId, [USER, OTHER]));
  await ensureUserSettings(USER);

  const batchId = randomUUID();
  await db.insert(noteBatches).values({ id: batchId, userId: USER, sourceHash: "h", sourceText: "x", anchorDate: new Date(), result: {} as never });

  const overdue = noon(day(-10));
  const base = { dueDate: overdue, status: "pending" as const };
  const notes = (priority: "normal" | "low" | "critical" | "high", n: number, user = USER) =>
    Array.from({ length: n }, (_, i) => ({
      ...base,
      userId: user,
      title: `n-${priority}-${i}`,
      priority,
      reminderType: "extracted_date",
      createdBy: "ai",
      noteBatchId: user === USER ? batchId : null,
    }));
  await db.insert(reminders).values([
    ...notes("normal", 125),
    ...notes("low", 125),
    ...notes("critical", 1),
    ...notes("high", 2),
    ...Array.from({ length: 4 }, (_, i) => ({ ...base, userId: USER, title: `mine-${i}`, reminderType: "manual" })),
    ...Array.from({ length: 5 }, (_, i) => ({
      userId: USER, title: `future-${i}`, status: "pending", dueDate: noon(day(10)),
      reminderType: "extracted_date", createdBy: "ai", noteBatchId: batchId,
    })),
    ...notes("normal", 3, OTHER),
    // Calendar-made and meeting reminders are not "from your notes".
    { ...base, userId: USER, title: "cal-0", priority: "normal", reminderType: "pre_meeting", createdBy: "calendar_sync", noteBatchId: null },
    { ...base, userId: USER, title: "cal-1", priority: "normal", reminderType: "extracted_date", createdBy: "calendar_sync", noteBatchId: null },
    { ...base, userId: USER, title: "cal-2", priority: "normal", reminderType: "post_meeting", createdBy: "ai", noteBatchId: null },
  ] as never);

  const target = day(6).toISOString().slice(0, 10);
  const res = await snoozeOverdueFromNotes({ toYmd: target });
  if (!res.ok) throw new Error(res.error);
  const result = res.value;
  t.check("count is 250", result.count === 250, String(result.count));
  t.check("not partial, nothing left", !result.partial && result.left === 0);

  const rows = await db.query.reminders.findMany();
  const byTitle = (p: string) => rows.filter((r) => r.title.startsWith(p));
  const ymd = (d: Date | null) => d?.toISOString().slice(0, 10);
  const snoozed = rows.filter((r) => r.userId === USER && (r.priority === "normal" || r.priority === "low") && r.title.startsWith("n-"));
  t.check("all 250 moved to the target day", snoozed.length === 250 && snoozed.every((r) => ymd(r.dueDate) === target));
  t.check("critical and high untouched", [...byTitle("n-critical"), ...byTitle("n-high")].every((r) => ymd(r.dueDate) === ymd(overdue)));
  t.check("calendar and meeting reminders untouched", byTitle("cal-").length === 3 && byTitle("cal-").every((r) => ymd(r.dueDate) === ymd(overdue)));
  t.check("user-created untouched", byTitle("mine-").length === 4 && byTitle("mine-").every((r) => ymd(r.dueDate) === ymd(overdue)));
  t.check("future untouched", byTitle("future-").every((r) => ymd(r.dueDate) === ymd(noon(day(10)))));
  t.check("another user's reminders untouched", rows.filter((r) => r.userId === OTHER).every((r) => ymd(r.dueDate) === ymd(overdue)));

  const undo = await undoSnoozeOverdueFromNotes(result.undoToken);
  t.check("undo reports restored", undo.restored);
  const after = await db.query.reminders.findMany({ where: eq(reminders.userId, USER) });
  t.check(
    "undo restores all 250 original due dates",
    after.filter((r) => r.title.startsWith("n-") && (r.priority === "normal" || r.priority === "low"))
      .every((r) => ymd(r.dueDate) === ymd(overdue))
  );

  // ---- Undo does not resurrect a reminder completed after the snooze. ----
  {
    const one = await snoozeOverdueFromNotes({ toYmd: target });
    t.check("one row snoozed", one.ok && one.value.count >= 1);
    const row = await db.query.reminders.findFirst({ where: eq(reminders.title, "n-normal-0") });
    await db.update(reminders).set({ status: "done" }).where(eq(reminders.id, row!.id));
    if (one.ok) await undoSnoozeOverdueFromNotes(one.value.undoToken);
    const doneRow = await db.query.reminders.findFirst({ where: eq(reminders.id, row!.id) });
    t.check("a row completed after the snooze stays done", doneRow?.status === "done" && ymd(doneRow.dueDate) === target);
  }

  // ---- Crafted tokens. ----
  {
    const foreign = await db.query.reminders.findFirst({ where: eq(reminders.userId, OTHER) });
    const snap = {
      reminderId: foreign!.id, snoozedTo: foreign!.dueDate!.toISOString(), previousDueDate: day(-99).toISOString(),
      previousStatus: "pending", contactId: null, previousNextFollowUpAt: null, previousFollowUpStatus: null,
    };
    await undoSnoozeOverdueFromNotes(JSON.stringify([{ op: "snooze", items: [snap] }]));
    const after2 = await db.query.reminders.findFirst({ where: eq(reminders.id, foreign!.id) });
    t.check("a token naming another user's row changes nothing", after2?.dueDate?.getTime() === foreign!.dueDate!.getTime());
    const rejects = async (token: string) => { try { await undoSnoozeOverdueFromNotes(token); return false; } catch { return true; } };
    t.check("a delete-op token is rejected", await rejects(JSON.stringify([{ op: "delete", items: [] }])));
    t.check("too many batches are rejected", await rejects(JSON.stringify(Array.from({ length: 6 }, () => ({ op: "snooze", items: [] })))));
    t.check("a malformed token is rejected", await rejects("{nope") && await rejects(JSON.stringify({ op: "snooze" })));
  }

  // ---- The cap, and a failing batch still returns an undo for what landed. ----
  {
    await db.delete(reminders).where(eq(reminders.userId, USER));
    await db.insert(reminders).values(notes("normal", 1005) as never);
    const capped = await snoozeOverdueFromNotes({ toYmd: target });
    t.check("one call moves at most 1000, and says 5 are left", capped.ok && capped.value.count === 1000 && capped.value.left === 5,
      capped.ok ? `${capped.value.count}/${capped.value.left}` : capped.error);

    await db.delete(reminders).where(eq(reminders.userId, USER));
    await db.insert(reminders).values(notes("normal", 450) as never);
    const ordered = await db.select({ id: reminders.id }).from(reminders).where(eq(reminders.userId, USER)).orderBy(reminders.dueDate, reminders.id);
    // Row 250 sits in the second batch of 200; its write fails.
    await db.update(reminders).set({ title: "boom" }).where(eq(reminders.id, ordered[250].id));
    await db.execute(sql`drop trigger if exists boom_guard_t on reminders`);
    await db.execute(sql`create or replace function boom_guard() returns trigger as $$ begin
      if new.title = 'boom' and new.due_date is distinct from old.due_date then raise exception 'boom'; end if; return new; end $$ language plpgsql`);
    await db.execute(sql`create trigger boom_guard_t before update on reminders for each row execute function boom_guard()`);
    let broken: Awaited<ReturnType<typeof snoozeOverdueFromNotes>>;
    try {
      broken = await snoozeOverdueFromNotes({ toYmd: target });
    } finally {
      await db.execute(sql`drop trigger if exists boom_guard_t on reminders`);
      await db.execute(sql`drop function if exists boom_guard()`);
    }
    t.check("a failing batch returns partial with a token", broken.ok && broken.value.partial && broken.value.count >= 200 && broken.value.count < 450,
      broken.ok ? String(broken.value.count) : broken.error);
    const moved = (await db.query.reminders.findMany({ where: eq(reminders.userId, USER) })).filter((r) => ymd(r.dueDate) === target);
    t.check("the count is what actually moved", broken.ok && moved.length === broken.value.count, String(moved.length));
    if (broken.ok) await undoSnoozeOverdueFromNotes(broken.value.undoToken);
    const left = (await db.query.reminders.findMany({ where: eq(reminders.userId, USER) })).filter((r) => ymd(r.dueDate) !== ymd(overdue));
    t.check("undo puts back everything that landed", left.length === 0, String(left.length));
  }

  t.done("reminders snooze-backlog smoke");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
