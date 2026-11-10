import { NextResponse } from "next/server";
import { parseOwnLinkedInUrl } from "@/lib/about-you";
import { lookUpSelfForUser } from "@/lib/about-you-server";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The self-lookup is a web-searched brief (`webSearchJson` allows 120s), past a (main) server action's 60s.
export const maxDuration = 150;

/** A LinkedIn URL: far under this. */
const MAX_BODY_BYTES = 1_024;

/**
 * The onboarding "About you" step's self-lookup.
 *
 *   POST /api/onboarding/self-lookup   { linkedinUrl }
 *   x-orbit-research: 1
 *
 * A route rather than a server action: Next dispatches a client's server actions one at a
 * time, so a 20–120s lookup as an action would hold "Looks right" and the step's save behind
 * it. The custom header is the CSRF guard (see /api/research). No `page.find` gate: this is
 * the person looking up themselves during onboarding, on every plan.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (err) {
    return NextResponse.json({ error: friendlyError(err, "Sign in to continue") }, { status: 401 });
  }
  if (request.headers.get("x-orbit-research") !== "1") {
    return NextResponse.json({ error: "Missing research header" }, { status: 400 });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That request is too large." }, { status: 413 });
  }
  let linkedinUrl: unknown;
  try {
    linkedinUrl = (JSON.parse(text) as { linkedinUrl?: unknown } | null)?.linkedinUrl;
  } catch {
    return NextResponse.json({ error: "That request couldn't be read." }, { status: 400 });
  }

  const parsed = parseOwnLinkedInUrl(typeof linkedinUrl === "string" ? linkedinUrl.slice(0, 300) : "");
  if (!parsed.ok) return NextResponse.json({ status: "invalid", message: parsed.message });
  try {
    return NextResponse.json(await lookUpSelfForUser(userId, parsed.url));
  } catch (err) {
    // lookUpSelfForUser only throws before the search (the URL write): the step treats any
    // failure as "couldn't confirm", so the message is for logs and devtools only.
    return NextResponse.json({ error: friendlyError(err, "The lookup didn’t finish") }, { status: 502 });
  }
}
