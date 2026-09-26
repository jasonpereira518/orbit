/**
 * Reading and writing typed opportunities, and keeping the legacy mirror in step.
 *
 * Auth-free, like `note-batch-save.ts` next door, so `scripts/smoke-opportunities.ts` can
 * drive it against PGlite; `src/actions/opportunities.ts` is the thin `"use server"` wrapper
 * that adds `requireUserId()`.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "@/db";
import { contactOpportunities, contacts, type ContactOpportunity } from "@/db/schema";
import {
  OPEN_OPPORTUNITY_STATUSES,
  looksLikeReferral,
  normalizeOpportunityKind,
  normalizeOpportunityLabel,
  opportunityMirrorLabels,
  type OpportunityKind,
} from "@/lib/opportunity-kinds";

/**
 * Idempotency for opportunities written by a note paste.
 *
 * Mirrors `buildSuggestionItemHash`, but keyed on the CONTACT and KIND rather than a due
 * date: an opportunity has no date to key on and often no date at all, whereas the same
 * note re-pasted for the same person naming the same thing is unambiguously the same row.
 * Re-pasting a note to fix a typo must not duplicate somebody's pipeline.
 */
export function buildOpportunityItemHash(
  sourceHash: string,
  contactId: string,
  kind: string,
  label: string
): string {
  return createHash("sha256")
    .update(`${sourceHash}|${contactId}|${kind}|${label.trim().toLowerCase()}`)
    .digest("hex");
}

/**
 * Rewrite `contacts.opportunities` from the live rows.
 *
 * **This is the ONLY writer of that column** (with its set-based form,
 * `syncContactOpportunityMirrors`). Every path that touches an opportunity calls one of them
 * afterwards — the capture save, undo, and each of the CRUD actions.
 *
 * The column is kept because four readers predate this table and none of them should have to
 * join to stay working: `conversation-starters.ts` (which already turns an opportunity into
 * "you flagged X — still on the table?"), the contact embedding in `search.ts`, the browser
 * extension's contact panel, and the admin read-only view.
 *
 * DERIVED, never appended. It used to be written directly by the capture save, which passed
 * the whole array to `updateContactForUser` — an outright overwrite — so a second note about
 * the same person deleted the first note's opportunities without a trace. Deriving makes that
 * class of bug unreachable: there is one statement, and it always reflects the rows.
 *
 * Also stamps `embeddingStaleAt`, because `buildContactEmbeddingContent` reads this column
 * and a stale embedding would keep answering searches with opportunities that are closed.
 */
export async function syncContactOpportunityMirror(
  userId: string,
  contactId: string
): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({
      kind: contactOpportunities.kind,
      label: contactOpportunities.label,
      status: contactOpportunities.status,
    })
    .from(contactOpportunities)
    .where(
      and(
        eq(contactOpportunities.userId, userId),
        eq(contactOpportunities.contactId, contactId),
        inArray(contactOpportunities.status, [...OPEN_OPPORTUNITY_STATUSES])
      )
    )
    .orderBy(asc(contactOpportunities.createdAt));

  const labels = opportunityMirrorLabels(rows);
  await db
    .update(contacts)
    .set({ opportunities: labels, embeddingStaleAt: new Date() })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));
  return labels;
}

/**
 * Re-derive the mirror for several contacts. Used after a batch save touches many people.
 *
 * The set-based form of `syncContactOpportunityMirror` — same rows, same order, same label
 * function, same stamp — as one read and one write instead of two statements per contact.
 * Every contact passed in gets a VALUES row, so one whose last open opportunity just closed
 * is rewritten to `[]` exactly as the single-contact form would.
 */
export async function syncContactOpportunityMirrors(
  userId: string,
  contactIds: readonly string[]
): Promise<void> {
  const ids = [...new Set(contactIds)];
  if (!ids.length) return;
  const db = await getDb();
  const rows = await db
    .select({
      contactId: contactOpportunities.contactId,
      kind: contactOpportunities.kind,
      label: contactOpportunities.label,
      status: contactOpportunities.status,
    })
    .from(contactOpportunities)
    .where(
      and(
        eq(contactOpportunities.userId, userId),
        inArray(contactOpportunities.contactId, ids),
        inArray(contactOpportunities.status, [...OPEN_OPPORTUNITY_STATUSES])
      )
    )
    .orderBy(asc(contactOpportunities.createdAt));

  const rowsByContact = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByContact.get(row.contactId) ?? [];
    list.push(row);
    rowsByContact.set(row.contactId, list);
  }

  const values = ids.map(
    (id) =>
      sql`(${id}::uuid, ${JSON.stringify(opportunityMirrorLabels(rowsByContact.get(id) ?? []))}::jsonb)`
  );
  await db.execute(sql`
    UPDATE contacts AS c
       SET opportunities = v.opportunities,
           embedding_stale_at = ${new Date()}
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, opportunities)
     WHERE c.id = v.id AND c.user_id = ${userId}
  `);
}

export async function listOpportunitiesForContact(
  userId: string,
  contactId: string
): Promise<ContactOpportunity[]> {
  const db = await getDb();
  return db
    .select()
    .from(contactOpportunities)
    .where(
      and(eq(contactOpportunities.userId, userId), eq(contactOpportunities.contactId, contactId))
    )
    .orderBy(
      // Open work first, then newest. The profile section renders in exactly this order, so
      // sorting here rather than in the component keeps the two from drifting.
      sql`case when ${contactOpportunities.status} in ('open','in_progress') then 0 else 1 end`,
      desc(contactOpportunities.createdAt)
    );
}

export type NewOpportunity = {
  contactId: string;
  kind: OpportunityKind;
  label: string;
  status?: ContactOpportunity["status"];
  direction?: ContactOpportunity["direction"];
  sourceInteractionId?: string | null;
  noteBatchId?: string | null;
  sourceExcerpt?: string | null;
  dueDate?: Date | null;
  rawDatePhrase?: string | null;
  confidenceScore?: number | null;
  createdBy?: "ai" | "user";
  itemHash?: string | null;
};

/**
 * Insert opportunities, skipping any whose `itemHash` this user already has.
 *
 * Returns only the rows actually written, so a caller can report "3 opportunities" and mean
 * it after a re-paste that created none. The mirror is NOT synced here — a batch save writes
 * for many contacts and syncs once per contact at the end, and syncing per row would rewrite
 * the same column N times.
 */
export async function insertOpportunities(
  userId: string,
  rows: readonly NewOpportunity[]
): Promise<ContactOpportunity[]> {
  if (!rows.length) return [];
  const db = await getDb();
  return db
    .insert(contactOpportunities)
    .values(
      rows.map((r) => ({
        userId,
        contactId: r.contactId,
        kind: r.kind,
        label: r.label,
        status: r.status ?? ("open" as const),
        direction: r.direction ?? null,
        sourceInteractionId: r.sourceInteractionId ?? null,
        noteBatchId: r.noteBatchId ?? null,
        sourceExcerpt: r.sourceExcerpt ?? null,
        dueDate: r.dueDate ?? null,
        rawDatePhrase: r.rawDatePhrase ?? null,
        confidenceScore: r.confidenceScore ?? null,
        createdBy: r.createdBy ?? ("user" as const),
        itemHash: r.itemHash ?? null,
      }))
    )
    .onConflictDoNothing({
      target: [contactOpportunities.userId, contactOpportunities.itemHash],
    })
    .returning();
}

/**
 * Turn the legacy free-text `contacts.opportunities` strings into typed drafts.
 *
 * Lives here rather than in `scripts/backfill-opportunities.ts` so the conversion is testable
 * without driving the whole backfill — and because getting the kind wrong here is silent: the
 * text survives either way, so nothing fails loudly if everything lands as `other`.
 *
 * `looksLikeReferral` runs FIRST, before the kind vocabulary, for the same reason it does in
 * the extractor: a legacy line saying "can refer me to the infra team" is a referral whatever
 * else it resembles, and referral is the label people search for.
 *
 * The hash is derived from a fixed synthetic source (`legacy-backfill`) plus the contact and
 * the text, so re-running the backfill produces identical hashes and writes nothing.
 */
export function legacyOpportunityDrafts(
  contactId: string,
  labels: readonly string[]
): NewOpportunity[] {
  const out: NewOpportunity[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = normalizeOpportunityLabel(raw);
    if (!label) continue;
    const kind = legacyOpportunityKind(label);
    const key = `${kind}|${label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      contactId,
      kind,
      label,
      createdBy: "ai",
      itemHash: buildOpportunityItemHash(LEGACY_SOURCE_HASH, contactId, kind, label),
    });
  }
  return out;
}

export const LEGACY_SOURCE_HASH = "legacy-backfill";

/**
 * A kind read back out of prose that never had one.
 *
 * Some revisions of the old capture save wrote a "Kind — label" shape, so a leading segment
 * before a dash is tried as a kind first; otherwise the whole string is scanned. Anything
 * unrecognisable becomes `other`, which is honest — the text is preserved and re-filing it is
 * one click.
 */
export function legacyOpportunityKind(text: string): OpportunityKind {
  if (looksLikeReferral(text)) return "referral";
  const parts = text.split(/\s+[—–-]\s+/);
  if (parts.length > 1) {
    const fromHead = normalizeOpportunityKind(parts[0]);
    if (fromHead !== "other") return fromHead;
  }
  return normalizeOpportunityKind(text);
}

/**
 * Undo for a note paste: close what that batch opened, without deleting it.
 *
 * Marked `dismissed` rather than removed, for the same reason `undoNoteBatchForUser` dismisses
 * reminders instead of deleting them — the `item_hash` has to keep blocking, or re-pasting the
 * same note would recreate everything the person just undid.
 *
 * Only rows still open are touched: an opportunity the person has since marked `landed` is a
 * decision they made after the save, and undo does not own it.
 */
export async function dismissOpportunitiesForBatch(
  userId: string,
  noteBatchId: string
): Promise<ContactOpportunity[]> {
  const db = await getDb();
  return db
    .update(contactOpportunities)
    .set({ status: "dismissed", closedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(contactOpportunities.userId, userId),
        eq(contactOpportunities.noteBatchId, noteBatchId),
        inArray(contactOpportunities.status, [...OPEN_OPPORTUNITY_STATUSES])
      )
    )
    .returning();
}
