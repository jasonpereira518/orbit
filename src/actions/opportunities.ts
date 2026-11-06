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
import { type ContactOpportunity } from "@/db/schema";
import { requireUserId } from "@/lib/auth";
import {
  createOpportunityForUser,
  deleteOpportunityForUser,
  restoreOpportunityForUser,
  updateOpportunityForUser,
} from "@/lib/contact-opportunities";
import { generateAndStoreContactBrief } from "@/lib/contact-brief";
import { friendlyError } from "@/lib/errors";
import { MAX_OPPORTUNITY_LABEL_CHARS } from "@/lib/opportunity-kinds";

type Fail = { ok: false; error: string };
type Ok = { ok: true; opportunity: ContactOpportunity };

/**
 * Refresh the parts of the app that read an opportunity. The writes themselves, and the
 * contact's mirror, are in `@/lib/contact-opportunities` (`*ForUser`), shared with chat.
 *
 * The brief runs in `after()` because it may call a model. It is regenerated on every write
 * for a reason worth stating: `isBriefStale` compares the brief's timestamp against
 * `lastInteractionAt`, and creating an opportunity by hand moves no interaction — so the card
 * would otherwise never notice. Widening the staleness check to `contacts.updatedAt` was the
 * alternative and is worse: that column moves on every edit, and the card would sit at
 * "Updating…" permanently. A write that leaves the brief's inputs as they were costs no
 * model call: the brief is keyed by what it was asked (`contact_briefs.input_hash`).
 */
function afterWrite(userId: string, contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/dashboard");
  after(() => generateAndStoreContactBrief(userId, contactId).catch(() => null));
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
    if (typeof input.label === "string" && input.label.trim().length > MAX_OPPORTUNITY_LABEL_CHARS) {
      // Not an error — the label is truncated. Said out loud so a long paste does not look
      // like it saved whole.
      console.warn("opportunity label truncated");
    }
    const row = await createOpportunityForUser(userId, input);
    afterWrite(userId, row.contactId);
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
    const changed = await updateOpportunityForUser(userId, id, patch);
    if (!changed) return { ok: false, error: "That opportunity is gone" };
    afterWrite(userId, changed.after.contactId);
    return { ok: true, opportunity: changed.after };
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
    const row = await deleteOpportunityForUser(userId, id);
    if (!row) return { ok: false, error: "That opportunity is gone" };
    afterWrite(userId, row.contactId);
    return { ok: true, opportunity: row };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t delete that opportunity — try again?") };
  }
}

/** Undo for the delete above — see `restoreOpportunityForUser` for why it gets a new id. */
export async function restoreOpportunity(row: ContactOpportunity): Promise<Ok | Fail> {
  try {
    const userId = await requireUserId();
    const restored = await restoreOpportunityForUser(userId, row);
    afterWrite(userId, restored.contactId);
    return { ok: true, opportunity: restored };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "Couldn’t restore that opportunity — try again?") };
  }
}
