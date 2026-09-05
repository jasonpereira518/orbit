/**
 * Who to follow up with.
 *
 * Reads through `getDashboardData`, deliberately NOT `generateDueFollowUps` — that one
 * *creates* reminders as a side effect, and a GET that writes is exactly how a polling
 * integration silently fills someone's reminder list.
 *
 * Returns the people, not reminder rows: "who has gone cold" is the question an integration
 * wants to act on, and it is the same list the dashboard shows.
 */
import { apiError, apiHandler, apiOk } from "@/lib/api/http";
import { followupsQuery, parseQuery } from "@/lib/api/schemas";
import { getDashboardData } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (request, { caller }) => {
  const parsed = parseQuery(request.url, followupsQuery);
  if (!parsed.ok) {
    return apiError({ code: "invalid_request", message: parsed.message, param: parsed.param });
  }
  const data = await getDashboardData(caller.userId);
  // `getDashboardData` already caps its own slice, so `limit` narrows rather than widens.
  const due = data.dueFollowUps.slice(0, parsed.data.limit);
  return apiOk({
    followups: due.map((c) => ({
      contactId: c.id,
      name: c.fullName,
      company: c.company ?? null,
      title: c.title ?? null,
      email: c.email ?? null,
      dueAt: c.nextFollowUpAt ? new Date(c.nextFollowUpAt).toISOString() : null,
      lastInteractionAt: c.lastInteractionAt
        ? new Date(c.lastInteractionAt).toISOString()
        : null,
      closenessTier: data.closenessById.get(c.id)?.tier ?? null,
    })),
  });
});
