"use server";

/**
 * Compose's server actions. The composer's are gated on `feature.compose` (hidden while Compose
 * is coming-soon); the pending-sends ones at the bottom are not. All take the user from the
 * session only and wrap a request-free function in `src/lib/email/compose.ts`.
 */
import { getCurrentUserProfile } from "@/lib/auth";
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
import { requireUserForReleasedSurface } from "@/lib/plan-guards";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";
import { listActiveGoalTextsForUser } from "@/lib/user-goals";
import { loadWritingInstructions } from "@/lib/writing-instructions-store";
import { z } from "zod";
import { defineAction, failMessage } from "@/lib/input/action";

// Argument shapes, generated from the handlers' parameter types.
const AttachmentInputSchema = z.looseObject({ pathname: z.string(), filename: z.string() });

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export const getComposeContextAction = defineAction(
  { auth: { surface: COMPOSE_SURFACE_KEY }, schema: z.tuple([z.string().nullable()]) },
  async (userId, contactId: string | null): Promise<ComposeContext | null> => {
    return getComposeContext(userId, typeof contactId === "string" ? contactId : null);
  }
);

export const searchRecipientsAction = defineAction(
  { auth: { surface: COMPOSE_SURFACE_KEY }, schema: z.tuple([z.string()]) },
  async (userId, q: string): Promise<ComposeRecipient[]> => {
    return searchRecipients(userId, typeof q === "string" ? q.slice(0, 100) : "");
  }
);

export const sendComposedEmail = defineAction(
  { auth: { surface: COMPOSE_SURFACE_KEY }, schema: z.tuple([z.looseObject({ contactId: z.string().nullable(), subject: z.string(), body: z.string(), scheduledFor: z.string().optional(), provider: z.enum(["gmail", "outlook"]).optional(), to: z.array(z.string()), cc: z.array(z.string()), bcc: z.array(z.string()), attachments: z.array(AttachmentInputSchema).optional(), replyTo: z.string().optional() })]) },
  async (userId, input: Omit<ComposeInput, "fromName">): Promise<ComposeResult> => {
    const profile = await getCurrentUserProfile().catch(() => null);
    const result = await sendComposed(userId, {
      to: strings(input?.to),
      cc: strings(input?.cc),
      bcc: strings(input?.bcc),
      subject: typeof input?.subject === "string" ? input.subject : "",
      body: typeof input?.body === "string" ? input.body : "",
      contactId: typeof input?.contactId === "string" ? input.contactId : null,
      fromName: profile?.name?.trim() || null,
      provider: input?.provider === "gmail" || input?.provider === "outlook" ? input.provider : undefined,
      attachments: Array.isArray(input?.attachments)
        ? input.attachments
            .slice(0, 11)
            .filter((a) => a && typeof a.pathname === "string" && typeof a.filename === "string")
            .map((a) => ({ pathname: a.pathname, filename: a.filename }))
        : undefined,
      scheduledFor: typeof input?.scheduledFor === "string" ? input.scheduledFor : undefined,
      replyTo: typeof input?.replyTo === "string" && input.replyTo.length <= 600 ? input.replyTo : undefined,
    });
    // A scheduled send is the drain's to deliver; after() would sleep until then inside this action.
    if (result.ok && !result.scheduled) scheduleDispatch(result.sendId, new Date(result.sendAt));
    return result;
  }
);

/** A first draft for this contact, from the same drafter follow-ups use. Body only. */
export const draftComposeWithAi = defineAction(
  { auth: () => requireUserForReleasedSurface(COMPOSE_SURFACE_KEY), schema: z.tuple([z.string()]), invalid: failMessage },
  async (userId, contactId: string): Promise<{ ok: true; body: string } | { ok: false; message: string }> => {
    try {
      const [goals, writingInstructions] = await Promise.all([
        listActiveGoalTextsForUser(userId),
        loadWritingInstructions(userId),
      ]);
      const draft = await generateContactFollowUpDraft(userId, String(contactId), goals, {
        channel: "email",
        meter: "compose",
        writingInstructions,
      });
      return { ok: true, body: draft.body };
    } catch (err) {
      return { ok: false, message: friendlyError(err, "Couldn’t draft that — write it yourself or try again?") };
    }
  }
);

// The contact page's in-progress and failed sends. Gated on the user only, NOT on Compose:
// failed Chat and follow-up sends from P1 show here too, whether or not Compose is released.

export const listContactPendingSendsAction = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, contactId: string): Promise<PendingSend[]> => {
    return listContactPendingSends(userId, String(contactId));
  }
);

export const retryFailedSendAction = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, sendId: string): Promise<ComposeResult> => {
    const profile = await getCurrentUserProfile().catch(() => null);
    const result = await retryFailedSend(userId, String(sendId), profile?.name?.trim() || null);
    if (result.ok) scheduleDispatch(result.sendId, new Date(result.sendAt));
    return result;
  }
);

export const dismissFailedSendAction = defineAction(
  { schema: z.tuple([z.string()]) },
  async (userId, sendId: string): Promise<{ dismissed: boolean }> => {
    return { dismissed: await dismissFailedSend(userId, String(sendId)) };
  }
);
