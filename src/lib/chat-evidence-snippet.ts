/**
 * The snippet behind one `[eN]` citation, read live and scoped to the user.
 *
 * `getEvidenceSnippet` (the server action in `src/actions/chat.ts`) finds the stored source
 * for a citation id and calls this. It is separate so the smoke can drive it without a session,
 * and so a new kind of source is one branch here rather than another stretch of the action.
 *
 * Nothing about a source is stored with the answer, only its id, so this always reads what the
 * record says now: an edited note shows its new text, a deleted one reads as removed.
 *
 * ## An email event is only shown while the feature is on
 *
 * Switching Email insights off removes the mail from chat search, and a citation in an older
 * answer must not keep showing it. The read joins the account's opt-in, and a dismissed event
 * or one of kind `other` reads as removed, exactly as search treats them.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { contacts, interactions } from "@/db/schema";
import type { EvidenceSource } from "@/lib/chat-evidence";

const SNIPPET_CHARS = 600;

export type EvidenceSnippet =
  | { found: false }
  | { found: true; kind: "contact"; contactId: string; contactName: string; snippet: string }
  | {
      found: true;
      kind: "interaction";
      interactionId: string;
      contactId: string;
      contactName: string | null;
      interactionType: string;
      date: string;
      snippet: string;
    }
  | {
      found: true;
      kind: "email_event";
      contactId: string | null;
      contactName: string | null;
      date: string;
      /** The model's one-line summary of the email. */
      snippet: string;
      /** The short quote copied from the mail as evidence, or null. */
      quote: string | null;
    };

type EmailEventRow = { summary: string; evidence_quote: string; occurred_at: string | Date; contact_id: string | null };

export async function loadEvidenceSnippet(userId: string, source: EvidenceSource): Promise<EvidenceSnippet> {
  const db = await getDb();

  if (source.kind === "contact") {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.id, source.contactId), eq(contacts.userId, userId)),
      columns: { id: true, fullName: true, preferredName: true, aiSummary: true, notes: true },
    });
    if (!contact) return { found: false };
    return {
      found: true,
      kind: "contact",
      contactId: contact.id,
      contactName: contact.preferredName || contact.fullName,
      snippet: (contact.aiSummary || contact.notes || "").trim().slice(0, SNIPPET_CHARS),
    };
  }

  if (source.kind === "email_event") {
    let row: EmailEventRow | undefined;
    try {
      [row] = rowsOf<EmailEventRow>(
        await db.execute(sql`
          select e.summary, e.evidence_quote, e.occurred_at,
                 (select m.contact_id
                    from memory_chunks m
                   where m.user_id = ${userId} and m.source_kind = 'email_event' and m.source_id = e.id
                   order by m.chunk_index
                   limit 1) as contact_id
            from email_events e
            join user_settings s on s.user_id = e.user_id and s.email_intel_enabled = 1
           where e.id = ${source.sourceId}::uuid
             and e.user_id = ${userId}
             and e.dismissed_at is null
             and e.kind <> 'other'
        `)
      );
    } catch {
      // A stored id that is not a uuid cannot be a live event.
      return { found: false };
    }
    if (!row) return { found: false };
    const contact = row.contact_id
      ? await db.query.contacts.findFirst({
          where: and(eq(contacts.id, row.contact_id), eq(contacts.userId, userId)),
          columns: { id: true, fullName: true, preferredName: true },
        })
      : undefined;
    return {
      found: true,
      kind: "email_event",
      contactId: contact?.id ?? null,
      contactName: contact ? contact.preferredName || contact.fullName : null,
      date: new Date(row.occurred_at).toISOString().slice(0, 10),
      snippet: row.summary.trim().slice(0, SNIPPET_CHARS),
      quote: row.evidence_quote.trim() ? row.evidence_quote.trim().slice(0, 240) : null,
    };
  }

  const row = await db.query.interactions.findFirst({
    where: and(eq(interactions.id, source.sourceId), eq(interactions.userId, userId)),
    columns: { contactId: true, interactionType: true, interactionDate: true, aiSummary: true, rawNotes: true },
  });
  if (!row) return { found: false };
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, row.contactId), eq(contacts.userId, userId)),
    columns: { id: true, fullName: true, preferredName: true },
  });
  return {
    found: true,
    kind: "interaction",
    interactionId: source.sourceId,
    contactId: contact?.id ?? row.contactId,
    contactName: contact ? contact.preferredName || contact.fullName : null,
    interactionType: row.interactionType,
    date: row.interactionDate.toISOString().slice(0, 10),
    snippet: (row.aiSummary || row.rawNotes || "").trim().slice(0, SNIPPET_CHARS),
  };
}
