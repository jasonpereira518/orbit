import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { reminders } from "@/db/schema";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { requireUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * E2E ONLY (see seed-capture-job). Replaces the caller's reminders with `overdueFromNotes`
 * pending reminders from notes, due 10 days ago. A 404 unless `ORBIT_E2E_SEED=1`.
 */
export async function POST(request: Request) {
  // eslint-disable-next-line no-restricted-syntax -- test-only switch, deliberately outside env.ts
  if (process.env.ORBIT_E2E_SEED !== "1" || process.env.VERCEL_ENV) return new NextResponse(null, { status: 404 });
  const refused = sameOriginGuard(request);
  if (refused) return refused;
  const { overdueFromNotes } = (await request.json()) as { overdueFromNotes: number };
  if (!Number.isInteger(overdueFromNotes) || overdueFromNotes < 0 || overdueFromNotes > 200) {
    return NextResponse.json({ error: "overdueFromNotes must be 0-200" }, { status: 400 });
  }
  const userId = await requireUserId();
  const db = await getDb();
  await db.delete(reminders).where(eq(reminders.userId, userId));
  // Date-only convention: noon UTC keeps the same calendar day in any viewer zone.
  const due = new Date(`${new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)}T12:00:00Z`);
  if (overdueFromNotes > 0) {
    await db.insert(reminders).values(
      Array.from({ length: overdueFromNotes }, (_, i) => ({
        userId,
        title: `From notes ${i + 1}`,
        dueDate: due,
        status: "pending",
        reminderType: "extracted_date",
        createdBy: "ai",
      }))
    );
  }
  return NextResponse.json({ ok: true });
}
