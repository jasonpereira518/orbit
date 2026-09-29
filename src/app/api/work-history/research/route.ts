import { NextResponse, after } from "next/server";
import { isInternalRequest } from "@/lib/internal-auth";
import { kickEmbeddingBackfill } from "@/lib/embedding-backfill";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { reportError } from "@/lib/report-error";
import {
  contactsNeedingWorkHistory,
  MAX_RESEARCH_PER_KICK,
  researchWorkHistories,
} from "@/lib/work-history-research";

export const maxDuration = 300;

/**
 * Stop STARTING people this long into the invocation. A web-searched answer can take up to
 * `WEB_SEARCH_TIMEOUT_MS` (120s) and the brief rebuild runs after it, so the last person
 * begun must have that much room left under `maxDuration`.
 */
const START_DEADLINE_MS = 150_000;

/**
 * Research the work history of contacts a LinkedIn pull just saved.
 *
 * Internal kick target (`kickWorkHistoryResearch`), not user-facing: fail-closed shared
 * secret, see internal-auth.ts. Answers at once; the searching happens in `after()`.
 */
export async function POST(request: Request) {
  if (!isInternalRequest(request)) {
    return new NextResponse(null, { status: 401 });
  }
  const started = Date.now();

  const body = (await request.json().catch(() => null)) as
    | { userId?: unknown; contactIds?: unknown }
    | null;
  const userId = typeof body?.userId === "string" ? body.userId : null;
  const contactIds = Array.isArray(body?.contactIds)
    ? body.contactIds.filter((id): id is string => typeof id === "string").slice(0, MAX_RESEARCH_PER_KICK)
    : [];
  if (!userId || !contactIds.length) {
    return NextResponse.json({ error: "userId and contactIds required" }, { status: 400 });
  }

  after(async () => {
    try {
      const due = await contactsNeedingWorkHistory(userId, contactIds);
      const { saved } = await researchWorkHistories(userId, due, {
        deadline: started + START_DEADLINE_MS,
      });
      if (!saved.length) return;
      // The history changes the search text (career line) and the brief's prompt.
      await kickEmbeddingBackfill(userId);
      for (const id of saved) {
        await generateAndStoreContactBrief(userId, id).catch(() => null);
      }
    } catch (err) {
      reportError(err, { where: "job.work-history", userId, level: "warning" });
    }
  });

  return NextResponse.json({ ok: true });
}
