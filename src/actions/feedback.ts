"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { requireUserId } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { userSettings } from "@/db/schema";
import { MICROS_PER_CREDIT } from "@/lib/credits/grants";
import { getCreditBalance } from "@/lib/credits/ledger";
import { getEntitlements } from "@/lib/entitlements";
import { ERROR_SOURCES, recordErrorEvent } from "@/lib/error-events";
import {
  MAX_SUBMISSION_BYTES,
  createFeedbackSubmission,
  decodeScreenshot,
  feedbackSubmissionSchema,
  sanitizePath,
  type FeedbackScreenshotInput,
  type FeedbackSubmissionInput,
} from "@/lib/feedback-submission";
import { notifyFeedbackReply, notifyFeedbackSubmitted } from "@/lib/feedback-notify";
import { MAX_THREAD_MESSAGE } from "@/lib/feedback-report";
import {
  listMyFeedback,
  loadThread,
  markThreadRead,
  postThreadMessage,
  setTyping,
  unwrapThanks,
  type FeedbackThread,
  type MyFeedbackRow,
} from "@/lib/feedback-thread";
import { triageFeedback } from "@/lib/feedback-triage";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export type FeedbackSubmitResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

/**
 * Take one feedback submission from the widget.
 *
 * Returns a result shape rather than throwing, which is the opposite of every action in
 * `src/actions/admin.ts`. Those throw because `ConfirmActionDialog` treats any resolved
 * promise as success and surfaces only rejections. This one is submitted from an ordinary
 * form that renders its own inline error, and a thrown Server Action error in production is
 * reduced to an opaque digest the person cannot act on — "an error occurred in the Server
 * Components render" is not something to show someone who was trying to do you a favour.
 */
export async function submitFeedback(
  input: FeedbackSubmissionInput
): Promise<FeedbackSubmitResult> {
  const userId = await requireUserId();

  try {
    await consumeBucket("feedback", userId, RATE_LIMITS.feedback);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return { ok: false, message: err.message };
    }
    throw err;
  }

  const parsed = feedbackSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      message: first?.message ?? "That submission didn't look right. Please try again.",
    };
  }
  const data = parsed.data;

  // Decode every screenshot before writing anything. A failure aborts the WHOLE
  // submission: someone who attached three shots and silently got two has been lied to,
  // and they have no way to find out which one is missing.
  const screenshots: FeedbackScreenshotInput[] = [];
  let totalBytes = 0;
  for (const [index, shot] of data.screenshots.entries()) {
    const decoded = decodeScreenshot(shot.dataUrl);
    if (!decoded) {
      return {
        ok: false,
        message: `Screenshot ${index + 1} isn’t a readable image — remove it and try again`,
      };
    }
    totalBytes += decoded.buf.byteLength;
    if (totalBytes > MAX_SUBMISSION_BYTES) {
      return {
        ok: false,
        message: "Those screenshots are too large together — remove one and try again",
      };
    }
    screenshots.push({
      ...decoded,
      note: shot.note?.trim() || null,
      width: shot.width ?? null,
      height: shot.height ?? null,
    });
  }

  // What the server knows, which is the half of `context` worth trusting. `plan` in
  // particular: a spoofed value would corrupt the one question this table gets asked
  // ("what do paying users complain about"), and it is one already-cached read.
  const [{ plan }, requestHeaders] = await Promise.all([getEntitlements(userId), headers()]);

  const context: Record<string, unknown> = {
    plan,
    // Free on the server and spoofable on the client, so `navigator.userAgent` is not sent.
    userAgent: requestHeaders.get("user-agent")?.slice(0, 300) ?? null,
    // Set by `withPathname` in `src/proxy.ts`. Next posts Server Actions to the current
    // page URL and the proxy matcher covers those POSTs, so this is the live route. Kept
    // ALONGSIDE the client's `route` rather than instead of it: a mismatch between the two
    // is itself a signal worth seeing.
    serverRoute: requestHeaders.get("x-pathname"),
    // Not `NEXT_PUBLIC_`, so the client cannot read it. Compared against `clientBuildTime`
    // below, a mismatch means the reporter is running a stale JS chunk — a common and
    // otherwise invisible cause of "it's broken for me".
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    submittedAt: new Date().toISOString(),

    // What the client said, after validation. Deliberately NOT collected anywhere here:
    // IP address, geolocation, console or network logs. Nothing else in this codebase
    // gathers them, and the premise of this table is that it is the one place a person
    // speaks to Orbit rather than being measured by it.
    route: sanitizePath(data.path),
    viewport: data.viewport ?? null,
    devicePixelRatio: data.devicePixelRatio ?? null,
    theme: data.theme ?? null,
    timeZone: data.timeZone ?? null,
    clientBuildTime: data.clientBuildTime ?? null,
    contactOk: data.contactOk ?? false,
    screenshotCount: screenshots.length,
  };

  try {
    const created = await createFeedbackSubmission({
      userId,
      text: data.text,
      subject: data.subject,
      area: data.area ?? null,
      category: data.category ?? null,
      context,
      screenshots,
    });
    // After the response: the person's Send has already landed. Triage first so the DM can
    // lead with the summary line; a triage that fails returns null and the DM goes without it.
    after(async () => {
      const triage = await triageFeedback(created.id);
      await notifyFeedbackSubmitted({
        id: created.id,
        userId,
        plan,
        area: data.area ?? null,
        category: triage?.category ?? data.category ?? null,
        text: data.text,
        subject: data.subject,
        path: sanitizePath(data.path),
        screenshotCount: created.screenshotCount,
        triage,
      });
    });
    return { ok: true, id: created.id };
  } catch (err) {
    await recordErrorEvent({
      source: ERROR_SOURCES.feedbackSubmit,
      kind: "submit_failed",
      userId,
      message: err instanceof Error ? err.message : String(err),
      context: { screenshotCount: screenshots.length, totalBytes },
    });
    return { ok: false, message: "That didn’t save — try again in a moment" };
  }
}

/**
 * The reporter's side of a feedback conversation: read it (which marks it read), and reply.
 *
 * Read once when the feedback panel opens a conversation (the live stream takes over from
 * there, see `/api/feedback/[id]/stream`). Null when the report
 * isn't theirs — the page shows a 404 for that, never a "not yours".
 */
export async function getMyFeedbackThread(feedbackId: string): Promise<FeedbackThread | null> {
  const userId = await requireUserId();
  const thread = await loadThread(feedbackId, { userId });
  if (!thread) return null;
  // Only when there is something of the operator's to have seen, so opening a report nobody
  // has answered yet doesn't hide the NEXT reply's notification behind an early read stamp.
  if (thread.open) await markThreadRead(feedbackId, "user", userId);
  return thread;
}

export async function sendFeedbackMessage(
  feedbackId: string,
  body: string
): Promise<{ ok: true; thread: FeedbackThread } | { ok: false; message: string }> {
  const userId = await requireUserId();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write something before sending." };
  if (text.length > MAX_THREAD_MESSAGE) {
    return { ok: false, message: `Keep it under ${MAX_THREAD_MESSAGE} characters.` };
  }
  try {
    await consumeBucket("feedbackChat", userId, RATE_LIMITS.feedbackChat);
  } catch (err) {
    if (isRateLimitedError(err)) return { ok: false, message: err.message };
    throw err;
  }

  const posted = await postThreadMessage({ feedbackId, author: "user", body: text, userId });
  if (!posted) return { ok: false, message: "This conversation isn’t open yet." };
  after(() => notifyFeedbackReply({ feedbackId, userId, body: text }));

  const thread = await loadThread(feedbackId, { userId });
  return thread ? { ok: true, thread } : { ok: false, message: "That conversation is gone." };
}

/** The caller's own reports, for the feedback panel's "Your feedback" tab. */
export async function listMyFeedbackAction(): Promise<MyFeedbackRow[]> {
  const userId = await requireUserId();
  return listMyFeedback(userId);
}

/**
 * Unwrap the credit thank-you on one of your reports. Returns what it carried and your balance
 * after it, for the gift card's reveal. Idempotent; null when there's nothing to unwrap.
 */
export async function unwrapFeedbackThanks(
  feedbackId: string
): Promise<{ credits: number; balance: number | null } | null> {
  const userId = await requireUserId();
  const credits = await unwrapThanks(feedbackId, userId);
  if (credits == null) return null;
  // The same read the credits card makes (`getCreditsOverview`). A balance that can't be read
  // just isn't shown — the gift itself has already landed.
  let balance: number | null = null;
  try {
    const { plan } = await getEntitlements(userId);
    const db = await getDb();
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    const b = await getCreditBalance(userId, plan, row, new Date(), { ensure: false });
    balance = Math.floor(b.spendable / MICROS_PER_CREDIT);
  } catch {
    balance = null;
  }
  return { credits, balance };
}

/** The reporter is typing in one of their conversations — for the dots on the other side. */
export async function markFeedbackTyping(feedbackId: string): Promise<void> {
  const userId = await requireUserId();
  await setTyping(feedbackId, "user", userId);
}
