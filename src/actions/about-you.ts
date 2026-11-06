"use server";

/**
 * The onboarding "About you" step's two doors. Input is checked here, at the trust boundary;
 * the work is in `src/lib/about-you-server.ts`.
 *
 * No `revalidatePath`: the step navigates on its own after a save, and a revalidating action
 * can undo that client navigation.
 */
import { requireUserId } from "@/lib/auth";
import { parseOwnLinkedInUrl } from "@/lib/about-you";
import {
  lookUpSelfForUser,
  parseAboutConfirm,
  saveAboutYouForUser,
  type AboutConfirm,
  type AboutLookup,
} from "@/lib/about-you-server";
import { friendlyError } from "@/lib/errors";

export async function lookUpMyself(
  linkedinUrl: string,
): Promise<AboutLookup | { status: "invalid"; message: string }> {
  const userId = await requireUserId();
  const parsed = parseOwnLinkedInUrl(typeof linkedinUrl === "string" ? linkedinUrl.slice(0, 300) : "");
  if (!parsed.ok) return { status: "invalid", message: parsed.message };
  return lookUpSelfForUser(userId, parsed.url);
}

export async function saveAboutYou(input: AboutConfirm): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await requireUserId();
  const parsed = parseAboutConfirm(input);
  if (!parsed) return { ok: false, error: "Something in your answers didn’t look right. Try again." };
  try {
    await saveAboutYouForUser(userId, parsed);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err, "We couldn’t save that. Try again.") };
  }
}
