import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { captureJobs } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import type { CaptureJobResult } from "@/lib/capture/types";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * E2E ONLY. Playwright cannot write to the dev server's single-writer PGlite, so it asks the
 * server to: replaces the caller's capture jobs with one `ready` meeting job, zero people,
 * last touched `ageMs` ago. A 404 unless `ORBIT_E2E_SEED=1`, which only playwright.config.ts sets.
 */
export async function POST(request: Request) {
  // eslint-disable-next-line no-restricted-syntax -- test-only switch, deliberately outside env.ts
  if (process.env.ORBIT_E2E_SEED !== "1") return new NextResponse(null, { status: 404 });
  const { ageMs } = (await request.json()) as { ageMs: number };
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs)) return NextResponse.json({ error: "ageMs must be a number" }, { status: 400 });
  // Deletes ALL of the caller's capture jobs; only runs behind ORBIT_E2E_SEED=1.
  const userId = await requireUserId();
  const db = await getDb();
  await db.delete(captureJobs).where(eq(captureJobs.userId, userId));
  const result: CaptureJobResult = {
    items: [],
    sharedNotes: [],
    interactionDate: "2026-11-12",
    interactionType: "meeting_note",
    anchorIso: "2026-11-12",
    anchorBasis: "note",
    hints: {},
    suggestedReminders: [],
    suggestionsSkipped: { relative: 0, unverifiable: 0, past: 0 },
    mentions: [],
    mentionedOnly: [],
  };
  const at = new Date(Date.now() - ageMs);
  const [job] = await db
    .insert(captureJobs)
    .values({ userId, sourceKind: "meeting", status: "ready", inputText: "Standup", result, createdAt: at, updatedAt: at })
    .returning();
  return NextResponse.json({ id: job.id });
}
