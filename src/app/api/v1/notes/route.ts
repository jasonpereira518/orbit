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
 *     bare single-note Extract, so a person is never staring at two unrelated review cards
 *     with no way back to the one that got bumped. A note that came in overnight from a
 *     Shortcut, still waiting on review, is not the "second Extract" that rule is about — the
 *     person never displaced it themselves, so it gets no chance to come back the way an
 *     ordinary bumped card does. `queueCaptureJob` exempts it specifically by `sourceKind`
 *     (`"api"`, set only here — see the type's own comment in src/lib/capture/types.ts for
 *     why that is safe to key an exemption on). Deliberately NOT `batchGroupId`: a fabricated
 *     single-item "batch" would make this job invisible to `CaptureQueuePanel` (which only
 *     renders for more than one job in a group) while still LOOKING like a batch member to
 *     any code that keys off that column — worse than not being in a batch at all. This job
 *     is not part of any batch, and does not claim to be.
 *
 *   - Trusting a `contactId` that is not the caller's: it lands in `seedContactId`, which
 *     has no foreign key, so nothing downstream would ever notice — but it would be one
 *     account quietly attaching its capture to a stranger's contact row. Checked here.
 */
import { and, eq } from "drizzle-orm";
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
    // See the header comment: this is what keeps a later in-app Extract from discarding
    // this job while it is still awaiting review. Not a real distinction from "messy" in
    // content terms — an API note IS free text, same as a typed one — but the discard
    // exemption needs a signal only this route can produce, and `sourceKind` is it.
    sourceKind: "api",
    status: "queued",
    inputText: body.text,
    sourceLabel: body.sourceLabel ?? "API",
    seedContactId: body.contactId ?? null,
  });
  // Fire and forget: the drain and the app's own poller both resume a stalled job, so a
  // dropped kick costs latency and never the note.
  void runCaptureJobById(job.id).catch(() => null);
  return apiOk({ noteId: job.id, status: "queued" }, { status: 202 });
});
