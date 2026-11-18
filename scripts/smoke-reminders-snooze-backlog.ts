/**
 * "Snooze everything overdue from notes" (`snoozeOverdueFromNotes`): moves only the notes
 * backlog that is overdue and not critical/high, for the signed-in user, and one undo token
 * puts every due date back (250 rows is more than one BULK_LIMIT batch).
 *
 * Run: npx tsx scripts/smoke-reminders-snooze-backlog.ts
 */
import "./smoke/_env";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
  ] as never);

  const target = day(6).toISOString().slice(0, 10);
  const result = await snoozeOverdueFromNotes({ toYmd: target });
  t.check("count is 250", result.count === 250, String(result.count));

  const rows = await db.query.reminders.findMany();
  const byTitle = (p: string) => rows.filter((r) => r.title.startsWith(p));
  const ymd = (d: Date | null) => d?.toISOString().slice(0, 10);
  const snoozed = rows.filter((r) => r.userId === USER && (r.priority === "normal" || r.priority === "low") && r.title.startsWith("n-"));
  t.check("all 250 moved to the target day", snoozed.length === 250 && snoozed.every((r) => ymd(r.dueDate) === target));
  t.check("critical and high untouched", [...byTitle("n-critical"), ...byTitle("n-high")].every((r) => ymd(r.dueDate) === ymd(overdue)));
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

  t.done("reminders snooze-backlog smoke");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
