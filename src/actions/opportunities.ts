"use server";

/**
 * CRUD for typed opportunities on a contact.
 *
 * House conventions: every export is async, every one starts with `requireUserId()`, every
 * write is scoped by `(id, userId)` so an id from a browser cannot reach another account, and
 * validation is by hand — there is no zod in `src/actions`.
 *
 * No rate-limit bucket: nothing here calls a model or fans out. The brief regeneration each
 * write schedules is the only expensive thing, and it runs in `after()`.
 */
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contactOpportunities, type ContactOpportunity } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  insertOpportunities,
  listOpportunitiesForContact,
  syncContactOpportunityMirror,
} from "@/lib/contact-opportunities";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { friendlyError } from "@/lib/errors";
import {
  MAX_OPPORTUNITY_LABEL_CHARS,
  normalizeOpportunityDirection,
  normalizeOpportunityKind,
  normalizeOpportunityLabel,
  normalizeOpportunityStatus,
} from "@/lib/opportunity-kinds";
import { isoDayToLocalNoon } from "@/lib/suggested-reminder-utils";

type Fail = { ok: false; error: string };
type Ok = { ok: true; opportunity: ContactOpportunity };

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDueDate(iso: string | null | undefined): Date | null {
  if (!iso || !ISO_DAY_RE.test(iso)) return null;
  const d = isoDayToLocalNoon(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Refresh the parts of the app that read an opportunity.
 *
 * The brief runs in `after()` because it may call a model. It is regenerated on every write
 * for a reason worth stating: `isBriefStale` compares the brief's timestamp against
 * `lastInteractionAt`, and creating an opportunity by hand moves no interaction — so the card
 * would otherwise never notice. Widening the staleness check to `contacts.updatedAt` was the
 * alternative and is worse: that column moves on every edit, and the card would sit at
 * "Updating…" permanently. A write that leaves the brief's inputs as they were costs no
 * model call: the brief is keyed by what it was asked (`contact_briefs.input_hash`).
 */
async function afterWrite(userId: string, contactId: string) {
  await syncContactOpportunityMirror(userId, contactId);
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/dashboard");
  after(() => generateAndStoreContactBrief(userId, contactId).catch(() => null));
}

export async function listContactOpportunities(contactId: string): Promise<ContactOpportunity[]> {
  const userId = await requireUserId();
  if (typeof contactId !== "string" || !contactId.trim()) return [];
  return listOpportunitiesForContact(userId, contactId.trim());
}

export async function createOpportunity(input: {
  contactId: string;
  kind: string;
  label: string;
  direction?: string | null;
  dueDateIso?: string | null;
  status?: string;
}): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const contactId = typeof input.contactId === "string" ? input.contactId.trim() : "";
    if (!contactId) return { ok: false, error: "Pick a contact first" };

    const label = normalizeOpportunityLabel(input.label);
    if (!label) return { ok: false, error: "Give the opportunity a short label" };
    if (typeof input.label === "string" && input.label.trim().length > MAX_OPPORTUNITY_LABEL_CHARS) {
      // Not an error — the label is already truncated. Said out loud so a long paste does not
      // look like it saved whole.
      console.warn("opportunity label truncated");
    }

    const [row] = await insertOpportunities(userId, [
      {
        contactId,
        kind: normalizeOpportunityKind(input.kind),
        label,
        status: normalizeOpportunityStatus(input.status),
        direction: normalizeOpportunityDirection(input.direction),
        dueDate: parseDueDate(input.dueDateIso),
        createdBy: "user",
        // Hand-added rows carry no hash: there is no source note to dedupe against, and a
        // null hash can never collide under the partial unique index.
        itemHash: null,
      },
    ]);
    if (!row) return { ok: false, error: "Couldn’t add that opportunity — try again?" };
    await afterWrite(userId, contactId);
    return { ok: true, opportunity: row };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t add that opportunity — try again?") };
  }
}

export async function updateOpportunity(
  id: string,
  patch: {
    kind?: string;
    label?: string;
    direction?: string | null;
    dueDateIso?: string | null;
    status?: string;
  }
): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    if (typeof id !== "string" || !id.trim()) return { ok: false, error: "That opportunity is gone" };

    const set: Partial<typeof contactOpportunities.$inferInsert> = { updatedAt: new Date() };
    if (patch.kind !== undefined) set.kind = normalizeOpportunityKind(patch.kind);
    if (patch.label !== undefined) {
      const label = normalizeOpportunityLabel(patch.label);
      if (!label) return { ok: false, error: "Give the opportunity a short label" };
      set.label = label;
    }
    if (patch.direction !== undefined) set.direction = normalizeOpportunityDirection(patch.direction);
    if (patch.dueDateIso !== undefined) set.dueDate = parseDueDate(patch.dueDateIso);
    if (patch.status !== undefined) {
      const status = normalizeOpportunityStatus(patch.status);
      set.status = status;
      // Closing stamps the time; reopening clears it, so "closed on" never outlives the close.
      set.closedAt = status === "open" || status === "in_progress" ? null : new Date();
    }

    const db = await getDb();
    const [row] = await db
      .update(contactOpportunities)
      .set(set)
      .where(and(eq(contactOpportunities.id, id.trim()), eq(contactOpportunities.userId, userId)))
      .returning();
    if (!row) return { ok: false, error: "That opportunity is gone" };
    await afterWrite(userId, row.contactId);
    return { ok: true, opportunity: row };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t update that opportunity — try again?") };
  }
}

/** Shorthand for the status buttons, which are the common case. */
export async function setOpportunityStatus(id: string, status: string): Promise<Ok | Fail> {
  return updateOpportunity(id, { status });
}

/**
 * Delete, returning the row so the toast can offer Undo.
 *
 * A real delete rather than a status change: `dismissed` means "I looked at this and decided
 * against it", which is a fact worth keeping, whereas delete means "this should never have
 * been here". Conflating them would make the dismissed list a junk drawer.
 */
export async function deleteOpportunity(id: string): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    if (typeof id !== "string" || !id.trim()) return { ok: false, error: "That opportunity is gone" };
    const db = await getDb();
    const [row] = await db
      .delete(contactOpportunities)
      .where(and(eq(contactOpportunities.id, id.trim()), eq(contactOpportunities.userId, userId)))
      .returning();
    if (!row) return { ok: false, error: "That opportunity is gone" };
    await afterWrite(userId, row.contactId);
    return { ok: true, opportunity: row };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t delete that opportunity — try again?") };
  }
}

/**
 * Undo for the delete above.
 *
 * Re-inserts under a NEW id rather than restoring the old one, and drops the original
 * `itemHash`. Keeping the hash would let a restored row block a legitimate re-paste of the
 * note it came from; the row is back either way, which is what Undo promised.
 */
export async function restoreOpportunity(row: ContactOpportunity): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    if (!row || typeof row.contactId !== "string") return { ok: false, error: "Nothing to restore" };
    const [restored] = await insertOpportunities(userId, [
      {
        contactId: row.contactId,
        kind: normalizeOpportunityKind(row.kind),
        label: normalizeOpportunityLabel(row.label),
        status: normalizeOpportunityStatus(row.status),
        direction: normalizeOpportunityDirection(row.direction),
        sourceInteractionId: row.sourceInteractionId,
        noteBatchId: row.noteBatchId,
        sourceExcerpt: row.sourceExcerpt,
        dueDate: row.dueDate ? new Date(row.dueDate) : null,
        rawDatePhrase: row.rawDatePhrase,
        confidenceScore: row.confidenceScore,
        createdBy: row.createdBy,
        itemHash: null,
      },
    ]);
    if (!restored) return { ok: false, error: "Couldn’t restore that opportunity" };
    await afterWrite(userId, row.contactId);
    return { ok: true, opportunity: restored };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t restore that opportunity — try again?") };
  }
}
