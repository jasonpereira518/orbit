/**
 * Who the owner is, client side, once the preview has answered. Pure and browser-safe.
 */
import type { Conversation } from "@/lib/conversations/types";

/** The owner picker's "None of these": the owner wrote nothing here, so nobody is left out. */
export const NO_SELF = "__orbit_no_self__";

/**
 * Rule: WhatsApp exports name the owner by their own name, so a WhatsApp chat the preview
 * found no owner sign in asks. A one-sender chat asks too when its sender is not the person
 * the chat is titled after — that sender may well be the owner talking to no one; when the
 * sender IS the title, they are the other person and nothing needs asking.
 */
export function needsSelfPick(
  c: Pick<Conversation, "source" | "title" | "participants">,
  preview: { ownerKeys: string[] } | undefined,
): boolean {
  if (c.source !== "whatsapp" || !preview || preview.ownerKeys.length > 0) return false;
  const others = c.participants.filter((x) => !x.isSelf);
  if (others.length > 1) return true;
  const norm = (v: string) => v.replace(/\s+/g, " ").trim().toLowerCase();
  return others.length === 1 && norm(others[0].displayName) !== norm(c.title);
}
