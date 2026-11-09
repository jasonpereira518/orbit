import { authErrorResponse, rateLimitGuard } from "@/lib/api/route-error";
import { sameOriginGuard } from "@/lib/api/same-origin";
import { NextResponse } from "next/server";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { requireUserForSurface } from "@/lib/plan-guards";
import { RATE_LIMITS, consumeBucket } from "@/lib/rate-limit";

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
  } catch (err) {
    return authErrorResponse(err, "Sign in to refresh this");
  }

  // `Origin: null` (sandboxed frames, some redirects) is cross-origin, not a 500 — see same-origin.ts.
  const refused = sameOriginGuard(request, { message: "Cross-origin request refused", json: true });
  if (refused) return refused;

  const body = (await request.json().catch(() => null)) as { contactId?: unknown; force?: unknown } | null;
  const contactId = typeof body?.contactId === "string" ? body.contactId : "";
  if (!UUID.test(contactId)) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 });
  }

  const limited = await rateLimitGuard(() => consumeBucket("knowledgeRefresh", userId, RATE_LIMITS.knowledgeRefresh));
  if (limited) return limited;

  // Scoped to the caller inside: a contact that is not theirs reads as "not found" and no
  // model is asked.
  const out = await generateAndStoreContactBrief(userId, contactId, {
    force: body?.force === true,
    // Already metered by `knowledgeRefresh` above.
    meter: false,
  }).catch(() => null);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A forced refresh the AI gate refused stored the plain-language brief; say why, so the
  // click does not read as a fresh AI summary. Background refreshes stay quiet.
  if (out.aiError && body?.force === true) return NextResponse.json({ error: out.aiError }, { status: 409 });
  return NextResponse.json({ ok: true });
}
