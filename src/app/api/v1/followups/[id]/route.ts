/**
 * Complete or snooze one follow-up.
 *
 * The write half of `GET /v1/followups`, and what makes the Apple Shortcut a round trip
 * rather than a one-way mirror: ticking the reminder off in Reminders comes back here.
 *
 * Reading the id: this Next.js passes route params as `context.params` (a Promise — see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md`),
 * but `apiHandler` (src/lib/api/http.ts) wraps every handler behind a fixed
 * `(request: Request) => Promise<Response>` signature — it does not accept or forward a second
 * argument, so Next's `context` never reaches this function. `webhook-endpoints/[id]/route.ts`
 * hit the same wall and reads the id out of the URL instead; this route follows that existing
 * precedent rather than inventing a second convention. `pathname.split("/").filter(Boolean).pop()`
 * is robust to a trailing slash (an empty last segment is filtered out) and to a query string
 * (`URL#pathname` never includes one) — but NOT to `/followups/` with nothing after it, where
 * `.pop()` returns the literal path segment `"followups"` rather than an empty string.
 *
 * That is why the id is also shape-checked against the same uuid pattern every id in this API
 * already carries, before it ever reaches a query: `completeReminder`/`snoozeReminderTo` hand
 * it straight to a `uuid` column comparison, and Postgres throws on an invalid uuid literal
 * rather than just finding no rows — which, uncaught, is a client-caused 500 into the same
 * funnel real server faults use. A malformed id is treated exactly like a wrong-owner one
 * (`not_found`), on purpose: telling the two apart would let a caller distinguish "no such id"
 * from "not shaped like an id", which is enumeration information this API has no reason to hand
 * out.
 */
import { z } from "zod";
import { apiError, apiHandler, apiOk, readJson } from "@/lib/api/http";
import { followupPatchBody } from "@/lib/api/schemas";
import { completeReminder, snoozeReminderTo } from "@/lib/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidShape = z.string().uuid();

export const PATCH = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const id = new URL(request.url).pathname.split("/").filter(Boolean).pop();
  if (!id || !uuidShape.safeParse(id).success) {
    return apiError({ code: "not_found", message: "No such follow-up." });
  }
  const body = await readJson(request, followupPatchBody);

  if (body.status === "complete") {
    const snapshot = await completeReminder(caller.userId, id);
    // `null` means the id does not exist or belongs to someone else — either way, this
    // caller touched nothing, and reporting success would be a lie a Shortcut cannot detect.
    if (!snapshot) {
      return apiError({ code: "not_found", message: "No such follow-up." });
    }
    return apiOk({ id, status: "complete" });
  }

  const snoozed = await snoozeReminderTo(caller.userId, id, new Date(body.dueAt!));
  if (!snoozed) {
    return apiError({ code: "not_found", message: "No such follow-up." });
  }
  return apiOk({ id, status: "snoozed", dueAt: body.dueAt });
});
