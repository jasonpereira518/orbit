import { authErrorResponse, rateLimitGuard, routeError } from "@/lib/api/route-error";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { deepgramKeyterms, mintStreamToken } from "@/lib/deepgram";
import { deepgramOpenFor } from "@/lib/speech-credit";
import { shortformTag } from "@/lib/deepgram-params";
import { speechTagIdFor } from "@/lib/speech-tag-id";
import { loadNetworkVocabulary } from "@/lib/transcription-vocabulary";
import { chargeDictationGrant, speechAllowance, voidDictationGrant } from "@/lib/speech-quota";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";
import { recordGateRefusal } from "@/lib/gate-refusal";

export const dynamic = "force-dynamic";

/**
 * A 30-second Deepgram token for the chat mic. The browser opens its own connection with it,
 * so Orbit's key never reaches a client and a leaked token buys one short session.
 *
 *   POST /api/speech/token
 *
 * Responses: 200 {accessToken, expiresIn, keyterms, remainingSeconds, tag, grantId}, 401/403 not
 * signed in or the surface is off, 402 this month's shortform allowance is gone, 429 with
 * Retry-After, 503 Deepgram itself is off, 502 the grant call failed.
 *
 * `tag` is `shortform:<speechTagId>`, which the browser puts on its Deepgram connection.
 * Dictation seconds reach `speech_usage` only as a best-effort `sendBeacon` from a closing
 * tab, so without the tag a blocked beacon is spend nothing can even notice; with it, the
 * nightly reconciliation job (`/api/ops/speech-usage`) compares Deepgram's own per-account
 * total against what was recorded. The browser is not trusted to invent it — it is minted
 * here, beside the token it belongs to.
 *
 * The id in that tag is the account's opaque `speechTagId`, never its user id: the tag
 * outlives the request inside Deepgram's usage records, which their zero-retention flag does
 * not cover. See `src/lib/speech-tag-id.ts`.
 *
 * Server-side accounting (audit M-18): every token is charged one full dictation session
 * (`MAX_SESSION_MS`) against the month's allowance as it is minted — `grantId` names that
 * charge — and `/api/speech/usage` lowers it to what the session really streamed. So a beacon
 * that never arrives costs the account its session, not Orbit; the allowance check below sees
 * every token minted, not only the ones the browser chose to report. The mint rate is also
 * tighter than the shared `speechToken` bucket: `dictationToken`, 12 per 5 minutes.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.chat");
  } catch (err) {
    return authErrorResponse(err, "Sign in to dictate");
  }

  const refused = sameOriginGuard(request, { message: "Cross-origin request refused" });
  if (refused) return refused;

  // The error's own message carries the bucket's label and the wait; `rateLimitGuard` keeps it.
  const limited = await rateLimitGuard(async () => {
    await consumeBucket("speechToken", userId, RATE_LIMITS.speechToken);
    await consumeBucket("dictationToken", userId, RATE_LIMITS.dictationToken);
  });
  if (limited) return limited;

  // Off, or the Deepgram credit has reached this plan's rung (`speech-cost.ts`). Either way the
  // chat mic falls back to the browser's own recogniser, which costs Orbit nothing.
  if (!(await deepgramOpenFor(userId, "shortform"))) {
    return NextResponse.json({ error: "Live transcription is unavailable right now" }, { status: 503 });
  }

  const allowance = await speechAllowance(userId, "shortform");
  if (allowance.exhausted) {
    // The monthly shortform allowance is a wall: recorded (throttled), then refused as before.
    await recordGateRefusal(userId, "speechShortform", { surface: "web", route: "/api/speech/token" });
    return NextResponse.json(
      { error: "You’ve used this month’s transcription minutes" },
      { status: 402 },
    );
  }

  let grantId: string | null = null;
  try {
    grantId = await chargeDictationGrant(userId);
    const [{ accessToken, expiresIn }, vocabulary, speechTagId] = await Promise.all([
      mintStreamToken(),
      loadNetworkVocabulary(userId),
      speechTagIdFor(userId),
    ]);
    return NextResponse.json(
      {
        accessToken,
        expiresIn,
        keyterms: deepgramKeyterms(vocabulary),
        remainingSeconds: allowance.remaining,
        tag: shortformTag(speechTagId),
        grantId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    // No token reached the browser, so nothing was spent: take the session's charge back.
    if (grantId) await voidDictationGrant(userId, grantId).catch(() => {});
    return routeError(err, { fallback: "Couldn’t start dictation", where: "route.speech-token", userId, faultStatus: 502 });
  }
}
