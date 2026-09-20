/**
 * Send a note into Orbit.
 *
 * Enqueues a capture job rather than writing contacts directly: extracting people, dates and
 * commitments is the app's AI pipeline, and a second implementation behind the API would
 * drift from it immediately. There is no endpoint to poll for the result — the note awaits
 * review in the app's own capture queue, the same place a note typed there would land; the
 * returned id is for reference only (support, logs), not for a follow-up GET.
 *
 * Three things this route has to get right that a same-account app write does not:
 *
 *   - AI spend: extraction is a model call, and the app's own Extract button spends against
 *     the `capture` bucket (30/min — see `RATE_LIMITS.capture`'s comment). Consuming only
 *     `apiWrite` (60/min, sized for cheap writes) would let a key run the parser at DOUBLE
 *     the in-app rate — for a BYOK user, on their own provider bill. Both buckets are
 *     consumed, because they guard different things: `apiWrite` bounds request volume,
 *     `capture` bounds model spend, and this route does both.
 *
 *   - Getting silently discarded by the user's own next capture: `queueCaptureJob`
 *     (src/actions/capture-jobs.ts) — the app's Extract action — discards every OTHER job of
 *     the account's sitting in `ready | reviewing | failed | transcribed` before starting a
 *     bare single-note Extract, so a person is never staring at two unrelated review cards.
 *     It exempts anything carrying a `batchGroupId`, on the theory that a grouped job is
 *     never a lone orphan — `CaptureQueuePanel` can always get back to it. A note that came
 *     in overnight from a Shortcut, still waiting on review, is not a "second Extract" the
 *     next-morning in-app one should be allowed to bulldoze — so it gets its own
 *     single-item `batchGroupId` for exactly this exemption, even though it is not really a
 *     batch of anything.
 *
 *   - Trusting a `contactId` that is not the caller's: it lands in `seedContactId`, which
 *     has no foreign key, so nothing downstream would ever notice — but it would be one
 *     account quietly attaching its capture to a stranger's contact row. Checked here.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { apiError, apiHandler, apiOk, readJson } from "@/lib/api/http";
import { noteBody } from "@/lib/api/schemas";
import { createCaptureJob } from "@/lib/capture-jobs";
import { runCaptureJobById } from "@/lib/capture-job-runner";
import { RATE_LIMITS, RateLimitedError, consumeBucket } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `noteBody.text` is bounded at 50,000 CHARACTERS, but `readJson`'s default cap
 * (`MAX_SMALL_BODY_BYTES`, 64,000) is in BYTES. UTF-8 is up to 4 bytes per character, so a
 * note that is entirely non-Latin script (Japanese, say) can be well under the documented
 * character limit and still be refused for size. 4 bytes/char is the safe ceiling for a
 * 50,000-character body; the odd extra bytes of JSON punctuation fit comfortably inside it.
 */
const NOTE_BODY_MAX_BYTES = 50_000 * 4;

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, noteBody, NOTE_BODY_MAX_BYTES);

  if (body.contactId) {
    const db = await getDb();
    const owned = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, body.contactId), eq(contacts.userId, caller.userId)),
      columns: { id: true },
    });
    if (!owned) {
      return apiError({ code: "invalid_request", message: "No such contact.", param: "contactId" });
    }
  }

  try {
    // Same budget the app's own Extract spends against — see the header comment.
    await consumeBucket("capture", caller.userId, RATE_LIMITS.capture);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return apiError({
        code: "rate_limited",
        message: "Too many notes submitted right now — try again shortly.",
        retryAfterSeconds: err.retryAfterSec,
      });
    }
    throw err;
  }

  const job = await createCaptureJob(caller.userId, {
    sourceKind: "messy",
    status: "queued",
    inputText: body.text,
    sourceLabel: body.sourceLabel ?? "API",
    seedContactId: body.contactId ?? null,
    // See the header comment: this is what keeps a later in-app Extract from discarding
    // this job while it is still awaiting review.
    batchGroupId: randomUUID(),
  });
  // Fire and forget: the drain and the app's own poller both resume a stalled job, so a
  // dropped kick costs latency and never the note.
  void runCaptureJobById(job.id).catch(() => null);
  return apiOk({ noteId: job.id, status: "queued" }, { status: 202 });
});
