/**
 * The timeline, for tools that mirror it — the Obsidian plugin's incremental pull.
 *
 * `updated_since` is what makes that pull incremental; without it every sync is a full
 * table scan on the client's side.
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
  if (parsed.data.updated_since) {
    filters.push(gte(interactions.interactionDate, new Date(parsed.data.updated_since)));
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
    .leftJoin(contacts, eq(contacts.id, interactions.contactId))
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
