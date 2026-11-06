import { NextResponse } from "next/server";
import { friendlyError, isMissingAiApiKeyError, MISSING_AI_API_KEY_MESSAGE } from "@/lib/errors";
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { reportedFailure } from "@/lib/report-error";
import { discoverPeople, researchCompany, researchPerson } from "@/lib/web-research";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A web-searched answer runs several fetches before it writes a word (`webSearchJson`
// allows 120s), past the 60s a (main) server action gets.
export const maxDuration = 150;

/** A typed name, company, domain and LinkedIn link: far under this. */
const MAX_BODY_BYTES = 4_096;

/**
 * Brief someone who is not in the network yet.
 *
 *   POST /api/research   { kind: "person", fullName, company?, domain?, linkedinUrl?, fresh? }
 *                        { kind: "company", name, domain?, fresh? }
 *                        { kind: "discover", query, fresh? }
 *   x-orbit-research: 1
 *
 * A route rather than a server action for the time limit above. The custom header is the
 * CSRF guard: a cross-site form cannot set it, and a cross-site fetch that does is
 * preflighted and refused. `/find` ships coming-soon, so only a released page (or an
 * operator previewing unreleased pages) gets through.
 *
 * A company's homepage is read only here, and only for the domain the person typed — the
 * chat tools never pass `readTypedHomepage`, so no model ever picks a URL Orbit fetches.
 */
export async function POST(request: Request) {
  let userId: string;
  try {
    userId = await requireUserForReleasedSurface("page.find");
  } catch (err) {
    return NextResponse.json({ error: friendlyError(err, "Sign in to research people") }, { status: 401 });
  }
  if (request.headers.get("x-orbit-research") !== "1") {
    return NextResponse.json({ error: "Missing research header" }, { status: 400 });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That request is too large." }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "That request couldn't be read." }, { status: 400 });
  }

  try {
    const fresh = body.fresh === true;
    const result =
      body.kind === "discover"
        ? await discoverPeople(userId, body.query, { fresh }).then((r) => (r.ok ? { ...r, dossier: r.result } : r))
        : body.kind === "company"
          ? await researchCompany(userId, body, { fresh, readTypedHomepage: true })
          : await researchPerson(userId, body, { fresh });
    if (!result.ok) {
      const status = result.reason === "rate_limited" ? 429 : result.reason === "no_ai" ? 402 : 400;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }
    return NextResponse.json({ key: result.key, dossier: result.dossier });
  } catch (err) {
    if (isMissingAiApiKeyError(err instanceof Error ? err.message : null)) {
      return NextResponse.json({ error: MISSING_AI_API_KEY_MESSAGE, reason: "no_ai" }, { status: 402 });
    }
    const { error } = reportedFailure(err, "The search didn’t finish — try again in a moment", {
      where: "api.research",
      extra: { kind: body.kind === "company" || body.kind === "discover" ? body.kind : "person" },
      userId,
    });
    return NextResponse.json({ error }, { status: 502 });
  }
}
