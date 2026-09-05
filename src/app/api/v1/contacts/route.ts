/**
 * Search and create contacts.
 *
 * `GET` doubles as Zapier's `performList` for the `contact.created` trigger, which is why its
 * item shape must stay byte-identical to the webhook payload's `data.object` — Zapier shows
 * the polled sample when someone builds a Zap, and a mismatch means the fields they map at
 * design time are not the fields they receive at run time.
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { apiError, apiHandler, apiOk, readJson, deferTelemetry } from "@/lib/api/http";
import { contactCreateBody, contactsQuery, parseQuery } from "@/lib/api/schemas";
import { hybridSearchContacts } from "@/lib/hybrid-search";
import { createContactForUser } from "@/lib/contact-writes";
import {
  DUPLICATE_MERGE_CONFIDENCE,
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  type DuplicateSubject,
} from "@/lib/duplicates";
import { enqueueWebhookEvent } from "@/lib/webhooks/dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const { q, limit } = parsed.data;

  if (q) {
    const ranked = await hybridSearchContacts(caller.userId, { query: q, limit });
    return apiOk({ contacts: ranked.map(publicContact) });
  }

  // No query: newest first, which is what a Zapier "new contact" trigger polls for.
  const db = await getDb();
  const rows = await db.query.contacts.findMany({
    where: eq(contacts.userId, caller.userId),
    orderBy: [desc(contacts.createdAt)],
    limit,
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
    },
  });
  return apiOk({ contacts: rows.map(publicContact) });
});

export const POST = apiHandler({ scope: "write", bucket: "apiWrite" }, async (request, { caller }) => {
  const body = await readJson(request, contactCreateBody);

  // Duplicate check before creating, unless explicitly overridden. An integration that
  // re-sends the same person on every run must not fork them into a dozen records — the
  // single most damaging thing a naive CRM connector does.
  if (!body.force) {
    const db = await getDb();
    const existing = (await db.query.contacts.findMany({
      where: eq(contacts.userId, caller.userId),
      columns: {
        id: true,
        fullName: true,
        email: true,
        linkedinUrl: true,
        xHandle: true,
        company: true,
        title: true,
      },
    })) as DuplicateSubject[];
    const [best] = findDuplicateCandidatesIndexed(buildDuplicateIndex(existing), {
      fullName: body.fullName,
      email: body.email ?? null,
      linkedinUrl: body.linkedinUrl ?? null,
      company: body.company ?? null,
      title: body.title ?? null,
    });
    if (best && best.confidence >= DUPLICATE_MERGE_CONFIDENCE) {
      return apiOk({
        created: false,
        matched: true,
        confidence: best.confidence,
        contact: publicContact(best.contact),
      });
    }
  }

  const created = await createContactForUser(caller.userId, {
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
  });

  const shaped = publicContact(created);
  deferTelemetry(() => enqueueWebhookEvent(caller.userId, "contact.created", shaped));
  return apiOk({ created: true, matched: false, contact: shaped }, { status: 201 });
});
