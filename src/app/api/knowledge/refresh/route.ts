import { NextResponse } from "next/server";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket, isRateLimitedError } from "@/lib/rate-limit";

/** A brief is one model call, but a slow provider should not be cut off at the layout's 60. */
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rebuild one person's brief for the Knowledge page's dossier.
 *
 * A route handler, not a server action, on purpose. It runs when a dossier is opened on a
 * brief that is out of date, and it can take as long as a model call: as an action it would
 * queue every other action in the tab behind it, and its response could snap the router back
 * to the person the user had already clicked away from.
 *
 * Without `force`, this is `generateAndStoreContactBrief`'s ordinary path, so an unchanged
 * input is free (hash reuse) and a decision model can still say "nothing new". `force` is the
 * Refresh button and always asks the model.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForSurface("page.knowledge");
  } catch {
    return NextResponse.json({ error: "Sign in to refresh this" }, { status: 401 });
  }

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as { contactId?: unknown; force?: unknown } | null;
  const contactId = typeof body?.contactId === "string" ? body.contactId : "";
  if (!UUID.test(contactId)) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  try {
    await consumeBucket("knowledgeRefresh", userId, RATE_LIMITS.knowledgeRefresh);
  } catch (err) {
    if (isRateLimitedError(err)) {
      return NextResponse.json(
        { error: err.message },
        { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } }
      );
    }
    throw err;
  }

  // Scoped to the caller inside: a contact that is not theirs reads as "not found" and no
  // model is asked.
  const out = await generateAndStoreContactBrief(userId, contactId, { force: body?.force === true }).catch(() => null);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
