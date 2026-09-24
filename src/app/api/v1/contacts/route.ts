/**
 * Search and create contacts.
 *
 * `GET` doubles as Zapier's `performList` for the `contact.created` trigger, which is why its
 * item shape must stay byte-identical to the webhook payload's `data.object` — Zapier shows
 * the polled sample when someone builds a Zap, and a mismatch means the fields they map at
 * design time are not the fields they receive at run time.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { apiError, apiHandler, apiOk, readJson, deferTelemetry } from "@/lib/api/http";
import { contactCreateBody, contactsQuery, parseQuery } from "@/lib/api/schemas";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { createContactForUser } from "@/lib/contact-writes";
import { DUPLICATE_MERGE_CONFIDENCE } from "@/lib/duplicates";
import { findConfidentDuplicate } from "@/lib/contact-resolve";
import { enqueueWebhookEvent } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `(createdAt, id)` packed into one opaque string, `id` breaking ties so the order is total
 * — a bulk import commonly writes many rows with the identical `createdAt`, and without a
 * tiebreaker a page boundary landing inside that tie would skip or repeat rows.
 */
function encodeCursor(row: { createdAt: Date | null; id: string }): string {
  return Buffer.from(`${(row.createdAt ?? new Date(0)).toISOString()}|${row.id}`).toString(
    "base64url"
  );
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const createdAt = new Date(iso);
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** The one contact shape the API returns, shared by search, create and webhook payloads. */
function publicContact(c: {
  id: string;
  fullName: string;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  location?: string | null;
  linkedinUrl?: string | null;
  closenessTier?: string | null;
  lastInteractionAt?: Date | string | null;
}) {
  return {
    id: c.id,
    name: c.fullName,
    company: c.company ?? null,
    title: c.title ?? null,
    email: c.email ?? null,
    location: c.location ?? null,
    linkedinUrl: c.linkedinUrl ?? null,
    closenessTier: c.closenessTier ?? null,
    lastInteractionAt: c.lastInteractionAt
      ? new Date(c.lastInteractionAt).toISOString()
      : null,
  };
}

export const GET = apiHandler({ scope: "read", bucket: "apiRead" }, async (request, { caller }) => {
  const parsed = parseQuery(request.url, contactsQuery);
  if (!parsed.ok) {
    return apiError({ code: "invalid_request", message: parsed.message, param: parsed.param });
  }
  const { q, limit, cursor } = parsed.data;

  if (q) {
    const ranked = await hybridSearchContacts(caller.userId, { query: q, limit });
    return apiOk({ contacts: ranked.map(publicContact) });
  }

  let after: { createdAt: Date; id: string } | null = null;
  if (cursor) {
    after = decodeCursor(cursor);
    if (!after) {
      return apiError({ code: "invalid_request", message: "Invalid cursor", param: "cursor" });
    }
  }

  // No query: newest first, which is what a Zapier "new contact" trigger polls for. The
  // schema has always validated `cursor` (Zapier's own pagination contract requires it) but
  // this handler never read it, so a caller with more than `limit` contacts could never see
  // page two — fetch one extra row to know whether there is one, without a second query.
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: after
      ? and(
          eq(contacts.userId, caller.userId),
          sql`(${contacts.createdAt}, ${contacts.id}) < (${after.createdAt}, ${after.id}::uuid)`
        )
      : eq(contacts.userId, caller.userId),
    orderBy: [desc(contacts.createdAt), desc(contacts.id)],
    limit: limit + 1,
    columns: {
      id: true,
      fullName: true,
      company: true,
      title: true,
      email: true,
      location: true,
      linkedinUrl: true,
      closenessTier: true,
      lastInteractionAt: true,
      createdAt: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return apiOk({
    contacts: page.map(publicContact),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  });
});

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, contactCreateBody);

  // Duplicate check before creating, unless explicitly overridden. An integration that
  // re-sends the same person on every run must not fork them into a dozen records — the
  // single most damaging thing a naive CRM connector does.
  //
  // Bounded the same way the rest of the app's write paths are (`resolveOrCreateContact`):
  // an indexed `contact_identities` lookup for the identifier tiers, then a narrow by-name
  // scan — never a `findMany` of every contact on the account, which this used to be, on
  // every single POST.
  if (!body.force) {
    const best = await findConfidentDuplicate(caller.userId, {
      fullName: body.fullName,
      email: body.email,
      linkedinUrl: body.linkedinUrl,
      company: body.company,
      title: body.title,
    });
    // Anything the app is confident about — every identifier tier, plus name+company and
    // name+title. A bare full-name match (0.60) falls through and creates a contact, because
    // two different people can share a name and this caller has nobody to ask.
    if (best && best.confidence >= DUPLICATE_MERGE_CONFIDENCE) {
      return apiOk({
        created: false,
        matched: true,
        confidence: best.confidence,
        contact: publicContact(best.contact),
      });
    }
  }

  const created = await createContactForUser(
    caller.userId,
    {
      fullName: body.fullName,
      email: body.email,
      company: body.company,
      title: body.title,
      linkedinUrl: body.linkedinUrl,
      phone: body.phone,
      location: body.location,
      notes: body.notes,
      howMet: body.howMet,
      source: `api:${caller.prefix}`,
    },
    // Same as the events-ingest path (`src/lib/ingest/events.ts`): a server-to-server call
    // has no page for `revalidatePath("/contacts")` etc. to usefully invalidate, and the
    // `(app)` route group is already force-dynamic. Skipping it also avoids throwing when
    // this runs outside a real Next.js request's revalidation context.
    { skipRevalidate: true }
  );

  const shaped = publicContact(created);
  deferTelemetry(() => enqueueWebhookEvent(caller.userId, "contact.created", shaped));
  return apiOk({ created: true, matched: false, contact: shaped }, { status: 201 });
});
