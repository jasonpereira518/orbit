import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { isPaywallError } from "@/lib/entitlements";
import { friendlyError } from "@/lib/errors";
import { deepgramEnabled, mintStreamToken } from "@/lib/deepgram";
import { keytermsFor } from "@/lib/deepgram-params";
import { loadNetworkVocabulary } from "@/lib/transcription-vocabulary";
import { speechAllowance } from "@/lib/speech-quota";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { reportedFailure } from "@/lib/report-error";

export const dynamic = "force-dynamic";

/**
 * A 30-second Deepgram token for the chat mic. The browser opens its own connection with it,
 * so Orbit's key never reaches a client and a leaked token buys one short session.
 *
 *   POST /api/speech/token
 *
 * Responses: 200 {accessToken, expiresIn, keyterms, remainingSeconds}, 401/403 not signed
 * in or the surface is off, 402 this month's shortform allowance is gone, 429 with
 * Retry-After, 503 Deepgram itself is off, 502 the grant call failed.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.chat");
  } catch (err) {
    const status = isPaywallError(err) ? 403 : 401;
    return NextResponse.json({ error: friendlyError(err, "Sign in to dictate") }, { status });
  }

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  try {
    await consumeBucket("speechToken", userId, RATE_LIMITS.speechToken);
  } catch (err) {
    if (isRateLimitedError(err)) {
      // Matches every other rate-limited route (see meetings/[id]/chunks): the error's own
      // message already carries the bucket's label and the wait, and friendlyError would
      // just discard both in favor of a generic fallback since RateLimitedError isn't one
      // of its recognized "own words".
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } },
      );
    }
    throw err;
  }

  if (!deepgramEnabled()) {
    return NextResponse.json({ error: "Live transcription is unavailable right now" }, { status: 503 });
  }

  const allowance = await speechAllowance(userId, "shortform");
  if (allowance.exhausted) {
    return NextResponse.json(
      { error: "You’ve used this month’s transcription minutes" },
      { status: 402 },
    );
  }

  try {
    const [{ accessToken, expiresIn }, vocabulary] = await Promise.all([
      mintStreamToken(),
      loadNetworkVocabulary(userId),
    ]);
    return NextResponse.json(
      { accessToken, expiresIn, keyterms: keytermsFor(vocabulary), remainingSeconds: allowance.remaining },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const failure = reportedFailure(err, "Couldn’t start dictation", { where: "route.speech-token", userId });
    return NextResponse.json({ error: failure.error, ref: failure.ref }, { status: 502 });
  }
}
