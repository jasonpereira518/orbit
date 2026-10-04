"use server";

/**
 * Compose's server actions. The composer's are gated on `feature.compose` (hidden while Compose
 * is coming-soon); the pending-sends ones at the bottom are not. All take the user from the
 * session only and wrap a request-free function in `src/lib/email/compose.ts`.
 */
import { getCurrentUserProfile, requireUserId } from "@/lib/auth";
import {
  dismissFailedSend,
  getComposeContext,
  listContactPendingSends,
  retryFailedSend,
  searchRecipients,
  sendComposed,
  type ComposeContext,
  type PendingSend,
  type ComposeInput,
  type ComposeRecipient,
  type ComposeResult,
} from "@/lib/email/compose";
import { scheduleDispatch } from "@/lib/email/schedule";
import { friendlyError } from "@/lib/errors";
import { generateContactFollowUpDraft } from "@/lib/follow-up-drafts";
import { requireUserForSurface } from "@/lib/plan-guards";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export async function getComposeContextAction(contactId: string | null): Promise<ComposeContext | null> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  return getComposeContext(userId, typeof contactId === "string" ? contactId : null);
}

export async function searchRecipientsAction(q: string): Promise<ComposeRecipient[]> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  return searchRecipients(userId, typeof q === "string" ? q.slice(0, 100) : "");
}

export async function sendComposedEmail(input: Omit<ComposeInput, "fromName">): Promise<ComposeResult> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  const profile = await getCurrentUserProfile().catch(() => null);
  const result = await sendComposed(userId, {
    to: strings(input?.to),
    cc: strings(input?.cc),
    bcc: strings(input?.bcc),
    subject: typeof input?.subject === "string" ? input.subject : "",
    body: typeof input?.body === "string" ? input.body : "",
    contactId: typeof input?.contactId === "string" ? input.contactId : null,
    fromName: profile?.name?.trim() || null,
  });
  if (result.ok) scheduleDispatch(result.sendId, new Date(result.sendAt));
  return result;
}

/** A first draft for this contact, from the same drafter follow-ups use. Body only. */
export async function draftComposeWithAi(
  contactId: string
): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
  const userId = await requireUserForSurface(COMPOSE_SURFACE_KEY);
  try {
    const [goals, writingInstructions] = await Promise.all([
      listActiveGoalTextsForUser(userId),
      loadWritingInstructions(userId),
    ]);
    const draft = await generateContactFollowUpDraft(userId, String(contactId), goals, {
      channel: "email",
      writingInstructions,
    });
    return { ok: true, body: draft.body };
  } catch (err) {
    return { ok: false, message: friendlyError(err, "Couldn’t draft that — write it yourself or try again?") };
  }
}

// The contact page's in-progress and failed sends. Gated on the user only, NOT on Compose:
// failed Chat and follow-up sends from P1 show here too, whether or not Compose is released.

export async function listContactPendingSendsAction(contactId: string): Promise<PendingSend[]> {
  const userId = await requireUserId();
  return listContactPendingSends(userId, String(contactId));
}

export async function retryFailedSendAction(sendId: string): Promise<ComposeResult> {
  const userId = await requireUserId();
  const profile = await getCurrentUserProfile().catch(() => null);
  const result = await retryFailedSend(userId, String(sendId), profile?.name?.trim() || null);
  if (result.ok) scheduleDispatch(result.sendId, new Date(result.sendAt));
  return result;
}

export async function dismissFailedSendAction(sendId: string): Promise<{ dismissed: boolean }> {
  const userId = await requireUserId();
  return { dismissed: await dismissFailedSend(userId, String(sendId)) };
}
