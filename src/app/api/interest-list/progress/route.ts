import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom } from "@/lib/client-ip";
import { SHARE_TOKEN_MAX } from "@/lib/interest-list";
import { getProgressByShareToken } from "@/lib/interest-list-ticket";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

// Polled by the referral tracker on someone's own pass, which carries no session: the share
// token in the query is the credential, same as the pass page. It answers with the caller's
// own referral count, place and their friends' planets, and nothing else — no email, no
// name, no other row.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!token || token.length > SHARE_TOKEN_MAX) {
    return NextResponse.json({ ok: false }, { status: 404, headers: HEADERS });
  }

  try {
    await consumeBucket("interest.progress", clientIpFrom(request.headers), RATE_LIMITS.interestProgress);
  } catch (err) {
    // A limiter that cannot count is not a reason to run the line query unmetered.
    const limited = isRateLimitedError(err);
    if (!limited) console.error("[interest-list] progress limiter failed", err);
    return NextResponse.json({ ok: false }, { status: limited ? 429 : 503, headers: HEADERS });
  }

  const progress = await getProgressByShareToken(token);
  if (!progress) return NextResponse.json({ ok: false }, { status: 404, headers: HEADERS });
  return NextResponse.json({ ok: true, ...progress }, { headers: HEADERS });
}
