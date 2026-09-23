import { NextResponse } from "next/server";
import { requireUserForSurface } from "@/lib/plan-guards";
import { isPaywallError } from "@/lib/entitlements";
import { friendlyError } from "@/lib/errors";
import { recordSpeechSeconds } from "@/lib/speech-quota";
import { MAX_SESSION_MS } from "@/lib/dictation";

export const dynamic = "force-dynamic";

/** The hard ceiling one beacon can report — one dictation session, never more. */
const MAX_REPORTABLE_SECONDS = MAX_SESSION_MS / 1000;

/**
 * Where the chat mic reports the Deepgram seconds it actually streamed, once a session ends.
 *
 *   POST /api/speech/usage  {seconds: number}
 *
 * Sent by `navigator.sendBeacon` from `use-dictation.ts`'s `stop-recognition` and
 * `abort-recognition` effects, measured from the live socket's `openedAt`. A beacon fired
 * during page unload cannot read a response and is never retried, so this always resolves
 * quickly and a dropped beacon just under-counts one session — the safe direction to fail.
 *
 * Clamped to `MAX_SESSION_MS` seconds so a tampered client cannot claim more than one
 * session's worth no matter what number it sends.
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

  const body = (await request.json().catch(() => null)) as { seconds?: unknown } | null;
  const raw = typeof body?.seconds === "number" && Number.isFinite(body.seconds) ? body.seconds : 0;
  const seconds = Math.max(0, Math.min(MAX_REPORTABLE_SECONDS, raw));

  await recordSpeechSeconds({ userId, kind: "shortform", seconds, source: "stream" });

  return new NextResponse(null, { status: 204 });
}
