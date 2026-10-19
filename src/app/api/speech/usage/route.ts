import { authErrorResponse } from "@/lib/api/route-error";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { DICTATION_SESSION_SECONDS, settleDictationGrants } from "@/lib/speech-quota";

export const dynamic = "force-dynamic";

/** The hard ceiling one beacon can report — one dictation session, never more. */
const MAX_REPORTABLE_SECONDS = DICTATION_SESSION_SECONDS;

/**
 * Where the chat mic reports the Deepgram seconds it actually streamed, once a session ends.
 *
 *   POST /api/speech/usage  {seconds: number, grants?: string[]}
 *
 * Sent by `navigator.sendBeacon` from `use-dictation.ts`'s `stop-recognition` and
 * `abort-recognition` effects, measured from the live socket's `openedAt`. A beacon fired
 * during page unload cannot read a response and is never retried, so this always resolves
 * quickly and a dropped beacon just under-counts one session — the safe direction to fail.
 *
 * Clamped to `MAX_SESSION_MS` seconds so a tampered client cannot claim more than one
 * session's worth no matter what number it sends.
 *
 * Since audit M-18 the seconds were already charged when each token was minted (a full
 * session per token, `chargeDictationGrant`); `grants` names those tokens and this LOWERS
 * them to what the session streamed (`settleDictationGrants`). It can never raise them, and
 * each grant settles once.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.chat");
  } catch (err) {
    return authErrorResponse(err, "Sign in to dictate");
  }

  const refused = sameOriginGuard(request, { message: "Cross-origin request refused", json: true });
  if (refused) return refused;

  const body = (await request.json().catch(() => null)) as { seconds?: unknown; grants?: unknown } | null;
  const raw = typeof body?.seconds === "number" && Number.isFinite(body.seconds) ? body.seconds : 0;
  const seconds = Math.max(0, Math.min(MAX_REPORTABLE_SECONDS, raw));
  const grants = Array.isArray(body?.grants)
    ? body.grants.filter((g): g is string => typeof g === "string")
    : [];

  await settleDictationGrants(userId, grants, seconds);

  return new NextResponse(null, { status: 204 });
}
