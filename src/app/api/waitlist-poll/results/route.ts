import { NextResponse, type NextRequest } from "next/server";
import { clientIpFrom, ipBucketKey } from "@/lib/client-ip";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";
import { readPollResults } from "@/lib/waitlist-poll-votes";
import { reportError } from "@/lib/report-error";

// Polled by the waitlist's feature poll while a tab is open and visible, so the tallies move
// while someone watches. Public: it answers with star totals per option and a voter count,
// which is what the page already shows every visitor — nothing about any one voter.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function GET(request: NextRequest) {
  try {
    await consumeBucket("poll.results", ipBucketKey(clientIpFrom(request.headers)), RATE_LIMITS.pollResults);
  } catch (err) {
    // A limiter that cannot count is not a reason to run the tally unmetered.
    const limited = isRateLimitedError(err);
    if (!limited) reportError(err, { where: "waitlist.poll.results.limiter", level: "warning" });
    return NextResponse.json({ ok: false }, { status: limited ? 429 : 503, headers: HEADERS });
  }
  try {
    const { counts, voters } = await readPollResults();
    return NextResponse.json({ ok: true, counts, voters }, { headers: HEADERS });
  } catch (err) {
    reportError(err, { where: "waitlist.poll.results", level: "warning" });
    return NextResponse.json({ ok: false }, { status: 503, headers: HEADERS });
  }
}
