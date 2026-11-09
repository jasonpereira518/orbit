"use server";

/**
 * The onboarding "About you" step's save. Input is checked here, at the trust boundary; the
 * work is in `src/lib/about-you-server.ts`. The self-lookup is a route
 * (`/api/onboarding/self-lookup`): as an action it would hold this save behind a web search.
 *
 * No `revalidatePath`: the step navigates on its own after a save, and a revalidating action
 * can undo that client navigation.
 */
import { requireUserId } from "@/lib/auth";
import { parseAboutConfirm, saveAboutYouForUser, type AboutConfirm } from "@/lib/about-you-server";
import { friendlyError } from "@/lib/errors";

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
