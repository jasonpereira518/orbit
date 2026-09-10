"use server";

import { headers } from "next/headers";
import { requireUserId } from "@/lib/auth";
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
      return { ok: false, message: "You've sent a few already — give it a minute." };
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
        message: `Screenshot ${index + 1} isn't a readable image. Remove it and try again.`,
      };
    }
    totalBytes += decoded.buf.byteLength;
    if (totalBytes > MAX_SUBMISSION_BYTES) {
      return {
        ok: false,
        message: "Those screenshots are too large together. Remove one and try again.",
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
      area: data.area ?? null,
      category: data.category ?? null,
      context,
      screenshots,
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
    return { ok: false, message: "Couldn't save that. Try again in a moment." };
  }
}
