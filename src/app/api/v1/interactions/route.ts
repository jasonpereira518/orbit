/**
 * The timeline, for tools that mirror it — the Obsidian plugin's incremental pull.
 *
 * `occurred_since` is what makes that pull incremental; without it every sync is a full
 * table scan on the client's side. It is named for exactly what it filters —
 * `interactions.interactionDate`, when the thing happened — and NOT `updated_since`,
 * because `interactions` has no `updatedAt` column at all. That means this is not a true
 * change-cursor: `updateInteraction` can rewrite `aiSummary`/`rawNotes` on a row without
 * touching `interactionDate`, and a note posted today about a meeting last month sets
 * `interactionDate` to last month, so a cursor from yesterday never sees it either way.
 * A real incremental-edits pull needs an `updatedAt` column on `interactions` — a schema
 * change (and a write-site audit) out of scope here, and arguably the plugin author's call
 * once they know which of "occurred" or "changed" they actually need.
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts, interactions } from "@/db/schema";
import { apiError, apiHandler, apiOk } from "@/lib/api/http";
import { interactionsQuery, parseQuery } from "@/lib/api/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (request, { caller }) => {
  const parsed = parseQuery(request.url, interactionsQuery);
  if (!parsed.ok) {
    return apiError({ code: "invalid_request", message: parsed.message, param: parsed.param });
  }
  const db = await getDb();
  const filters = [eq(interactions.userId, caller.userId)];
  if (parsed.data.occurred_since) {
    filters.push(gte(interactions.interactionDate, new Date(parsed.data.occurred_since)));
  }
  if (parsed.data.contactId) {
    filters.push(eq(interactions.contactId, parsed.data.contactId));
  }
  const rows = await db
    .select({
      id: interactions.id,
      contactId: interactions.contactId,
      contactName: contacts.fullName,
      type: interactions.interactionType,
      occurredAt: interactions.interactionDate,
      source: interactions.source,
      summary: interactions.aiSummary,
      topics: interactions.topics,
    })
    .from(interactions)
    // Scoped by userId too, not just resting on the NOT NULL FK: the one join in this
    // route should stand on a filter, not an invariant, even though `interactions.userId`
    // already bounds every row and `contactId` can never point at another user's row.
    .leftJoin(contacts, and(eq(contacts.id, interactions.contactId), eq(contacts.userId, caller.userId)))
    .where(and(...filters))
    .orderBy(desc(interactions.interactionDate))
    .limit(parsed.data.limit);

  return apiOk({
    interactions: rows.map((r) => ({
      ...r,
      occurredAt: r.occurredAt ? new Date(r.occurredAt).toISOString() : null,
    })),
  });
});
