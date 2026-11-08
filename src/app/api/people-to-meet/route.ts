import { NextResponse } from "next/server";
import { requireUserId } from "@/lib/auth";
import { friendlyError } from "@/lib/errors";
import { loadPeopleToMeet } from "@/lib/people-to-meet";
import { isSurfaceLive } from "@/lib/surface-visibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// The weekly discovery run is a web search (`webSearchJson` allows 120s), past a (main) server action's 60s.
export const maxDuration = 150;

/**
 * The dashboard's "People to meet" (at most 2), loaded client-side after the page renders.
 *
 *   POST /api/people-to-meet   x-orbit-research: 1   →  { people, canResearch }
 *
 * A route rather than a server action: Next dispatches a client's actions one at a time, so a
 * slow weekly search as an action would hold every other dashboard action behind it. POST with
 * the custom header (the CSRF guard, as in /api/research) because a run spends the week's
 * search. `{ people: [] }` whenever the card should stay empty — the gates live in
 * `loadPeopleToMeet`, because this card is free on every plan.
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
  const people = await loadPeopleToMeet(userId); // never throws: a failure is reported and is []
  // Save/Brief go through /find's gate (plan feature, tier rules, admin/demo exemption), which the
  // card itself does not enforce: let the server say whether those buttons would be accepted.
  return NextResponse.json({ people, canResearch: people.length > 0 && (await isSurfaceLive(userId, "page.find")) });
}
