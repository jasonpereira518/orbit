/**
 * "Changed by Orbit" and field suggestions (contact-info accuracy plan, PR 3): reading
 * `contact_changes` for the review page, and the three answers a person can give.
 *
 *   undo     an applied change: the old value goes back, as the person's own (stamped user).
 *   accept   a suggestion: the offered value is written, as the person's own.
 *   dismiss  a suggestion: nothing is written; a newer offer may ask again.
 *
 * Undo refuses when the field has moved on since (someone or something wrote over it), so it
 * never puts an old value over a newer one. A company and title that changed or were offered
 * together are answered together.
 */
import { and, desc, eq, gte, or } from "drizzle-orm";
import { getDb } from "@/db";
import { contactChanges, contacts } from "@/db/schema";
import { FIELD_KEYS, type FieldKey } from "@/lib/contact-fields";
import { updateContactForUser } from "@/lib/contact-writes";
import { UserFacingError } from "@/lib/errors";

export type ContactChangeRow = {
  id: string;
  contactId: string;
  contactName: string;
  field: FieldKey;
  before: string | null;
  after: string | null;
  source: string | null;
  status: "applied" | "suggested";
  createdAt: string;
};

/** How far back "Changed by Orbit" looks. Suggestions are listed whatever their age. */
const RECENT_DAYS = 30;

const isField = (f: string | null): f is FieldKey => FIELD_KEYS.includes(f as FieldKey);
const asText = (v: unknown) => (typeof v === "string" ? v : null);

export async function listContactChangesForUser(userId: string, limit = 50) {
  const db = await getDb();
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: contactChanges.id,
      contactId: contactChanges.contactId,
      contactName: contacts.fullName,
      field: contactChanges.field,
      before: contactChanges.before,
      after: contactChanges.after,
      source: contactChanges.source,
      status: contactChanges.status,
      createdAt: contactChanges.createdAt,
    })
    .from(contactChanges)
    .innerJoin(contacts, eq(contacts.id, contactChanges.contactId))
    .where(
      and(
        eq(contactChanges.userId, userId),
        eq(contactChanges.kind, "field"),
        or(
          eq(contactChanges.status, "suggested"),
          and(eq(contactChanges.status, "applied"), gte(contactChanges.createdAt, since))
        )
      )
    )
    .orderBy(desc(contactChanges.createdAt))
    .limit(Math.min(Math.max(Math.trunc(limit), 1), 200));

  const out: ContactChangeRow[] = [];
  for (const r of rows) {
    if (!isField(r.field) || (r.status !== "applied" && r.status !== "suggested")) continue;
    out.push({ ...r, field: r.field, status: r.status, before: asText(r.before), after: asText(r.after), createdAt: r.createdAt.toISOString() });
  }
  return {
    suggestions: out.filter((r) => r.status === "suggested"),
    applied: out.filter((r) => r.status === "applied"),
  };
}

async function currentValue(userId: string, contactId: string, field: FieldKey) {
  const db = await getDb();
  const [row] = await db
    .select({ value: contacts[field] })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
    .limit(1);
  return row?.value ?? null;
}

export async function resolveContactChangeForUser(
  userId: string,
  changeId: string,
  action: "undo" | "accept" | "dismiss"
): Promise<{ contactId: string }> {
  const db = await getDb();
  const [change] = await db
    .select()
    .from(contactChanges)
    .where(and(eq(contactChanges.id, changeId), eq(contactChanges.userId, userId)))
    .limit(1);
  if (!change || !isField(change.field)) throw new UserFacingError("That change is no longer here");
  const wanted = action === "undo" ? "applied" : "suggested";
  if (change.status !== wanted) throw new UserFacingError("That change was already handled");
  if (action === "undo" && (await currentValue(userId, change.contactId, change.field)) !== asText(change.after)) {
    throw new UserFacingError("That field has changed since, so there’s nothing to undo");
  }

  // The partner half of a company/title pair: changed in the same write, or offered still.
  const group = [change];
  if (change.field === "company" || change.field === "title") {
    const [partner] = await db
      .select()
      .from(contactChanges)
      .where(
        and(
          eq(contactChanges.userId, userId),
          eq(contactChanges.contactId, change.contactId),
          eq(contactChanges.field, change.field === "company" ? "title" : "company"),
          eq(contactChanges.status, wanted),
          ...(action === "undo" ? [eq(contactChanges.createdAt, change.createdAt)] : [])
        )
      )
      .limit(1);
    if (partner && isField(partner.field)) {
      const stillThere = action !== "undo" || (await currentValue(userId, partner.contactId, partner.field)) === asText(partner.after);
      if (stillThere) group.push(partner);
    }
  }

  if (action !== "dismiss") {
    const patch: Record<string, string> = {};
    for (const c of group) patch[c.field as FieldKey] = asText(action === "undo" ? c.before : c.after) ?? "";
    // "" clears the field (parseContactPatch). Either way the value is now the person's.
    await updateContactForUser(userId, change.contactId, patch, { by: "user", skipRevalidate: true });
  }
  const status = action === "undo" ? "undone" : action === "accept" ? "accepted" : "dismissed";
  for (const c of group) {
    await db
      .update(contactChanges)
      .set({ status, resolvedAt: new Date() })
      .where(and(eq(contactChanges.id, c.id), eq(contactChanges.userId, userId)));
  }
  return { contactId: change.contactId };
}
