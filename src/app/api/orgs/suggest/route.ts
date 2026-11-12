import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { MAX_QUERY_CHARS, suggestOrgs } from "@/lib/org-suggest";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// No maxDuration: a distinct value makes its own Vercel function, and Hobby caps a deployment
// at 12. The Wikidata call carries its own 1.5s timeout, so the default limit never binds.

/**
 * Organization suggestions as the person types (onboarding's dream companies & schools).
 *
 *   GET /api/orgs/suggest?q=goo   → { suggestions: OrgSuggestion[] }
 *
 * A route rather than a server action: Next runs a client's actions one at a time, so each
 * keystroke's lookup would queue behind the last. A read with no side effects beyond the
 * rate-limit counter, so no CSRF header. Over the limit it still answers, from local
 * sources only, rather than leaving the field with nothing.
 */
export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    return NextResponse.json({ error: friendlyError(err, "Sign in to continue") }, { status: 401 });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").slice(0, MAX_QUERY_CHARS);
  let localOnly = false;
  try {
    await consumeBucket("org-suggest", userId, RATE_LIMITS.orgSuggest);
  } catch (err) {
    if (!isRateLimitedError(err)) {
      return NextResponse.json({ error: friendlyError(err, "Suggestions aren’t available right now") }, { status: 500 });
    }
    localOnly = true;
  }

  const suggestions = await suggestOrgs(userId, q, { localOnly });
  return NextResponse.json({ suggestions }, { headers: { "Cache-Control": "private, max-age=300" } });
}
